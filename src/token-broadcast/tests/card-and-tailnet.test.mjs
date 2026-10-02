/**
 * 自测：卡片文案（2026-09-30 用户定稿）+ "tailnet 先未连接、连上后补推"时序 + 网关注册。
 *
 * 四个用例：
 *   1. 启动时 tailnet 未连接 → 先推一张"未连接"，连上后补推一张"已连接"（含补注册本机网关）；
 *   2. 启动瞬间 tailnet 已连上、本机网关也在服务 → 只推一张，不重复补推；
 *   3. tailnet 一直不连上 → 只有第一张卡片，超时后不再补推；
 *   4. tailnet 已连上但本机 8443 网关没在服务 → 补推一张更正卡片（地址通 ≠ 入口能用）。
 *
 * 为什么要这么一个测试：
 *   1. 卡片文案是用户**逐字指定**的，改错一个字用户就会看到错卡片；
 *   2. 补推逻辑依赖"启动时没 tailnet、几秒后有 tailnet"这个时序，真实网卡切不动，
 *      只能给插件塞一个受控的 tailnet 探测函数（插件导出的 __setTailnetProbe）；
 *   3. 网关注册走的是真 HTTPS（自签证书，插件对它固定 rejectUnauthorized=false），
 *      这里用本机 127.0.0.1 冒充 tailnet 地址 + 仓库里现成的自签证书，端到端跑真协议，
 *      不做 fetch/请求层打桩。
 *
 * 运行（不需要 dsh 在跑，也不需要真网卡）：
 *     node E:\DSH\dsh-token-broadcast\tests\card-and-tailnet.test.mjs
 *
 * 产物隔离：插件的 `register-status.json` 与 `cards.jsonl` 默认写在
 * ~/.dsh/lan/token-broadcast/（verify-gateway.mjs 读那里），测试通过配置项
 * `statusDir` 把它们重定向到临时目录，绝不动线上的那份。
 */

import { register } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ----------------------------------------------------------------- 1) 桩掉 schemastery
// 插件用 `import z from "@deepseek-ai/schemastery"` 声明 Config；真实运行时由 dsh 提供，
// 独立跑测试时解析不到，用 loader hook 换成一个"什么方法都能链式调用"的 Proxy 桩。
// 注意：注册进 register() 的必须是**带 resolve 的 loader 模块**，桩本身只是它返回的目标
// （2026-09-30 踩过：直接把桩当 loader 注册，resolve 没被接管，报 ERR_MODULE_NOT_FOUND）。
const Z_STUB_URL = "data:text/javascript," + encodeURIComponent(
	`const chain = () => { const f = () => chain(); return new Proxy(f, { get: () => chain() }); };
const z = new Proxy({}, { get: () => () => chain() });
export default z;
export { z };
`
);
const LOADER = `const STUB = ${JSON.stringify(Z_STUB_URL)};
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@deepseek-ai/schemastery") return { url: STUB, shortCircuit: true, format: "module" };
	return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(LOADER)}`, import.meta.url);

const PLUGIN = new URL("../lib/index.js", import.meta.url);
const plugin = await import(PLUGIN.href);

// ----------------------------------------------------------------- 2) 断言小工具
let failures = 0;
function check(name, ok, detail = "") {
	if (ok) {
		console.log(`  ✅ ${name}${detail ? `（${detail}）` : ""}`);
	} else {
		failures += 1;
		console.log(`  ❌ ${name}${detail ? `（${detail}）` : ""}`);
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, cond, timeoutMs = 15000) {
	const stop = Date.now() + timeoutMs;
	while (Date.now() < stop) {
		if (cond()) return true;
		await sleep(100);
	}
	console.log(`  ⏳ 等待超时：${label}`);
	return false;
}

// ----------------------------------------------------------------- 3) 本地桩：负一屏 + 本机网关
const TOKEN = "TEST_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const pushed = [];
/**
 * 桩按**路径**决定失败次数，这样每个用例的"坏窗口"互不干扰、完全确定性：
 *   /push              → 永远 200
 *   /push-fail1        → 对该路径的第 1 个请求 404，之后 200（测"两条传输"）
 *   /push-fail5        → 对该路径的前 5 个请求 404，之后 200（测"送卡兜底"）
 * 2026-09-30 踩过：早期版本用全局计数器，前面用例的实例把计数吃掉，
 * 结果两个用例随机失败 —— 测试的隔离性比断言本身更容易出问题。
 */
const pathHits = new Map();
let pushRequests = 0;
const failRule = (path) => {
	if (path === "/push-fail1") return 1;
	// 一次"尝试"最多会打 3 个请求：fetch → https.request → 钉地址重试。
	// 要让首轮两次尝试**全部**打光、把兜底逼出来，就得让前 9 个请求都 404。
	if (path === "/push-fail9") return 9;
	return 0;
};
const pushStub = createHttpServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		pushRequests += 1;
		const path = (req.url ?? "/").split("?")[0];
		const hits = (pathHits.get(path) ?? 0) + 1;
		pathHits.set(path, hits);
		if (hits <= failRule(path)) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "Not Found" }));
			return;
		}
		try {
			pushed.push(JSON.parse(body).data.msgContent[0]);
		} catch {
			pushed.push({ parseError: body });
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ code: "0000000000" }));
	});
});
await new Promise((r) => pushStub.listen(0, "127.0.0.1", r));
const pushPort = pushStub.address().port;

const registered = [];
let healthHits = 0;
const PKI = "E:\\DSH\\dsh-tunnel\\pki";
const certPath = join(PKI, "tailnet-chain.crt");
const keyPath = join(PKI, "tailnet.key");
if (!existsSync(certPath) || !existsSync(keyPath)) {
	console.log(`缺少自签证书 ${certPath} / ${keyPath}，无法做 HTTPS 端到端自测`);
	process.exit(2);
}
const gatewayStub = createHttpsServer(
	{ cert: readFileSync(certPath), key: readFileSync(keyPath) },
	(req, res) => {
		if (req.url === "/__gw_health") {
			healthHits += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			try {
				registered.push(JSON.parse(body));
			} catch {
				registered.push({ parseError: body });
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	}
);
await new Promise((r) => gatewayStub.listen(0, "127.0.0.1", r));
const gatewayPort = gatewayStub.address().port;

// ----------------------------------------------------------------- 4) 临时 state / key / 状态备份
const work = mkdtempSync(join(tmpdir(), "tb-test-"));
const statePath = join(work, "web-state.json");
const keyFile = join(work, "gw-register-key.txt");
writeFileSync(keyFile, "test-register-key\n", "utf8");
// startedAt=now、pid=0（falsy → 跳过 pid 比对），等价于"本次运行刚写的"。
writeFileSync(statePath, JSON.stringify({ token: TOKEN, pid: 0, startedAt: new Date().toISOString() }), "utf8");

const statusPath = join(work, "status", "register-status.json");
const cardsPath = join(work, "status", "cards.jsonl");
const readStatus = () => (existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : undefined);
const readCards = () => (existsSync(cardsPath)
	? readFileSync(cardsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
	: []);

function makeCtx() {
	const disposers = [];
	const logs = [];
	return {
		logs,
		disposers,
		ctx: {
			logger: {
				info: (...a) => logs.push(["info", a.map(String).join(" ")]),
				warn: (...a) => logs.push(["warn", a.map(String).join(" ")])
			},
			effect(fn) {
				const d = fn();
				disposers.push(typeof d === "function" ? d : () => {});
				return d;
			}
		}
	};
}

const baseConfig = {
	authCode: "test-auth-code",
	statePath,
	pushServiceUrl: `http://127.0.0.1:${pushPort}/push`,
	statusDir: join(work, "status"),
	// 文档用地址（RFC 5737 TEST-NET-2 / RFC 1918），**不要**写本机真实地址：
	// 这份测试会随仓库发布，真实公网/局域网地址等于泄露家庭网络结构。
	gatewayHost: "198.51.100.10:18443",
	lanIp: "192.168.0.5",
	lanPort: 3081,
	tailnetGatewayPort: gatewayPort,
	registerLocalGatewayPort: gatewayPort,
	registerKeyPath: keyFile,
	registerInsecure: true,
	waitMs: 5000,
	pollMs: 200,
	registerRetryMs: 500,
	gatewayWaitMs: 5000,
	tailnetWaitMs: 20000,
	tailnetPollMs: 500
};

try {
	// ============================================================ 用例 1：先"未连接"，连上后补推
	console.log("\n=== 用例 1：启动时 tailnet 未连接 → 连上后补推一张 ===");
	let tailnetUp = false;
	plugin.__setTailnetProbe(() => (tailnetUp ? "127.0.0.1" : ""));
	const a = makeCtx();
	plugin.apply(a.ctx, { ...baseConfig });

	check("第一张卡片已推送", await waitFor("card#1", () => pushed.length >= 1));
	const first = pushed[0] ?? {};
	check("① 外层一行 = DeepSeek Harness本次启动地址",
		first.scheduleTaskName === "DeepSeek Harness本次启动地址" && first.summary === "DeepSeek Harness本次启动地址",
		`name=${JSON.stringify(first.scheduleTaskName)}`);
	check("② 正文顶部标题 = # DeepSeek Harness本次token",
		String(first.content).startsWith("# DeepSeek Harness本次token"), String(first.content).split("\n")[0]);
	check("③ 小节标题已去掉括号说明（## 三个入口）",
		String(first.content).includes("\n## 三个入口\n") && !String(first.content).includes("顺序固定"),
		"含「顺序固定」=" + String(first.content).includes("顺序固定"));
	check("④ 第一张卡片如实写 tailnet 未连接",
		String(first.content).includes("未连上 tailnet"), "");
	check("三段入口顺序为 局域网 → 阿里云 → Tailscale",
		String(first.content).indexOf("1. **局域网**") < String(first.content).indexOf("2. **阿里云**") &&
		String(first.content).indexOf("2. **阿里云**") < String(first.content).indexOf("3. **Tailscale**"), "");
	check("免 token 入口只推短地址（阿里云/局域网行外不出现 token 拼接）",
		String(first.content).includes("https://198.51.100.10:18443/") &&
		!String(first.content).includes("198.51.100.10:18443/?token="), "");
	check("scheduleTaskId 非空（否则负一屏不渲染正文）", Boolean(first.scheduleTaskId), first.scheduleTaskId);

	// tailnet 未连接 → 第一步的注册目标里没有本机网关（只有 0 个目标）
	check("tailnet 未连接时先记下「没有可注册目标」",
		await waitFor("status#1", () => readStatus()?.reason === "no-targets") && readStatus()?.ok === false,
		`reason=${JSON.stringify(readStatus()?.reason ?? null)}`);

	// 现在把 tailnet "接上"
	tailnetUp = true;
	const gotSecond = await waitFor("card#2", () => pushed.length >= 2);
	check("⑤ tailnet 连上后补推了第二张卡片", gotSecond, `推送数=${pushed.length}`);
	const second = pushed[1] ?? {};
	check("补推卡片写的是连通后的真实地址",
		String(second.content).includes(`https://127.0.0.1:${gatewayPort}/`) &&
		!String(second.content).includes("未连上 tailnet"), "");
	check("补推卡片明确说明「这是连上之后自动补推」",
		String(second.content).includes("自动补推") && String(second.content).includes("以此为准"), "");
	check("补推卡片沿用了同一套文案（外层一行 + 顶部标题）",
		second.scheduleTaskName === "DeepSeek Harness本次启动地址" &&
		String(second.content).startsWith("# DeepSeek Harness本次token"), "");
	check("两张卡片 msgId 不同（否则负一屏会去重）",
		Boolean(first.msgId) && first.msgId !== second.msgId, `${first.msgId} / ${second.msgId}`);
	check("补注册给本机网关成功（token + key 都对）",
		registered.length === 1 && registered[0].token === TOKEN && registered[0].key === "test-register-key",
		JSON.stringify(registered[0] ?? null));
	check("补推前确认过本机网关在服务（/__gw_health 被访问）", healthHits >= 1, `health=${healthHits}`);
	check("注册状态落盘为成功、且记下了 tailnet 信息",
		await waitFor("status#2", () => readStatus()?.tailnet?.ip === "127.0.0.1") &&
		readStatus()?.ok === true && readStatus()?.tailnet?.gatewayReady === true,
		JSON.stringify(readStatus()?.tailnet ?? null));
	a.disposers.forEach((d) => d());

	// ============================================================ 用例 2：启动即连上 → 只推一张
	console.log("\n=== 用例 2：启动瞬间 tailnet 已连上 → 不重复补推 ===");
	const pushedBefore = pushed.length;
	plugin.__setTailnetProbe(() => "127.0.0.1");
	const b = makeCtx();
	plugin.apply(b.ctx, { ...baseConfig });
	check("第一张卡片已推送", await waitFor("card#3", () => pushed.length > pushedBefore));
	const third = pushed[pushedBefore] ?? {};
	check("卡片直接带上 tailnet 地址（不写未连接）",
		String(third.content).includes(`https://127.0.0.1:${gatewayPort}/`) &&
		!String(third.content).includes("未连上 tailnet"), "");
	await sleep(2500);
	check("没有多余的补推卡片", pushed.length === pushedBefore + 1, `本用例推送数=${pushed.length - pushedBefore}`);
	b.disposers.forEach((d) => d());

	// ============================================================ 用例 3：tailnet 一直不来 → 只有一张
	console.log("\n=== 用例 3：tailnet 始终不连上 → 只保留第一张卡片 ===");
	const pushedBefore3 = pushed.length;
	plugin.__setTailnetProbe(() => "");
	const c = makeCtx();
	plugin.apply(c.ctx, { ...baseConfig, tailnetWaitMs: 2000 });
	check("第一张卡片已推送", await waitFor("card#4", () => pushed.length > pushedBefore3));
	await sleep(3500);
	check("超时后不再补推（且日志说明原因）",
		pushed.length === pushedBefore3 + 1 &&
		c.logs.some(([, line]) => line.includes("仍未连上 tailnet")), `推送数=${pushed.length - pushedBefore3}`);
	c.disposers.forEach((d) => d());

	// ============================================================ 用例 4：tailnet 通、但本机网关没起来
	// 这正是 2026-09-30 本机的真实状态：tailnet 已连上，8443 网关进程却没在跑。
	// 卡片不能只说"免 token，输密码即可"，必须更正成"网关没在服务"。
	console.log("\n=== 用例 4：tailnet 已连上但本机网关没在服务 → 补推更正卡片 ===");
	await new Promise((r) => gatewayStub.close(r));
	const pushedBefore4 = pushed.length;
	plugin.__setTailnetProbe(() => "127.0.0.1");
	const d = makeCtx();
	plugin.apply(d.ctx, { ...baseConfig, gatewayWaitMs: 1500 });
	check("第一张卡片已推送", await waitFor("card#5", () => pushed.length > pushedBefore4));
	const fourth = pushed[pushedBefore4] ?? {};
	check("第一张卡片照旧写 tailnet 地址（抢时间，不等网关）",
		String(fourth.content).includes(`https://127.0.0.1:${gatewayPort}/`), "");
	check("随后补推一张更正卡片，说明网关没在服务",
		await waitFor("card#6", () => pushed.length > pushedBefore4 + 1) &&
		String(pushed[pushedBefore4 + 1]?.content).includes("免 token 网关**当前没有在服务**"), "");
	d.disposers.forEach((d) => d());

	// ============================================================ 用例 5：首轮请求 404，阶梯把它吸收掉
	console.log("\n=== 用例 5：一次 404 → 投递阶梯照常送达 ===");
	const pushedBefore5 = pushed.length;
	const auditBefore5 = readCards().length;
	plugin.__setTailnetProbe(() => "");
	const e = makeCtx();
	plugin.apply(e.ctx, {
		...baseConfig,
		pushServiceUrl: `http://127.0.0.1:${pushPort}/push-fail1`,
		tailnetWaitMs: 1500
	});
	check("重试后卡片仍然推成功",
		await waitFor("card#7", () => pushed.length > pushedBefore5) &&
		String(pushed[pushedBefore5]?.content).startsWith("# DeepSeek Harness本次token"), "");
	// 审计要等插件写下去，所以先等"本次新增里出现成功记录"再断言。
	await waitFor("audit#5", () => readCards().slice(auditBefore5).some((c) => c.ok === true));
	const newAudit5 = readCards().slice(auditBefore5);
	// 投递阶梯的第一优先现在是"独立进程 helper"；helper 会先吃掉那次 404，随后进程内
	// fetch 成功。所以这里断言**结果与可追溯性**，不写死哪条传输胜出
	// （写死过一次，改了顺序就误报 —— 见 2026-09-30 的这次改动）。
	check("卡片送达，且审计写明胜出的通道（首轮 404 被阶梯吸收）",
		newAudit5.some((c) => c.ok === true && ["fetch", "https.request", "helper-process"].includes(String(c.transport))),
		newAudit5.map((c) => `ok=${c.ok} transport=${c.transport} status=${c.status}`).join(" | ") || "(无新增)");
	e.disposers.forEach((d) => d());

	// ============================================================ 用例 6：坏窗口把首轮重试全打光 → 兜底送达
	// 线上实测：端点有坏窗口（连续 6 次 404，两分钟后同样的字节 200）。
	// 这里让该路径连失败 9 次（首轮 2 次尝试 × 三条传输全部打光），兜底循环必须继续送到。
	console.log("\n=== 用例 6：首轮重试全打光 → 送卡兜底仍然送达 ===");
	const pushedBefore6 = pushed.length;
	const auditBefore6 = readCards().length;
	plugin.__setTailnetProbe(() => "127.0.0.1");
	const f = makeCtx();
	plugin.apply(f.ctx, {
		...baseConfig,
		pushServiceUrl: `http://127.0.0.1:${pushPort}/push-fail9`,
		pushAttempts: 2,
		pushRetryMs: 200,
		cardRetryMs: 400,
		cardRetryMinutes: 1,
		gatewayWaitMs: 1500,
		// 关掉 tailnet 跟进，才能把"送卡兜底"单独测出来：
		// 否则 tailnet 已连上时，5a 的"网关未就绪更正"卡片会先推成功，
		// cardDelivered 变 true，兜底就（正确地）不跑了 —— 第一次跑这个用例就踩了这个。
		tailnetWatch: false
	});
	check("兜底重试最终把卡片送达",
		await waitFor("card#8", () => pushed.length > pushedBefore6, 30000) &&
		String(pushed[pushedBefore6]?.content).startsWith("# DeepSeek Harness本次token"), "");
	await waitFor("audit#6", () => readCards().slice(auditBefore6).some((c) => c.ok === true));
	const newAudit6 = readCards().slice(auditBefore6);
	check("首轮每次尝试都留了失败记录，且最终那张的 tag 带「兜底重试」",
		newAudit6.filter((c) => c.ok === false).length >= 2 &&
		newAudit6.some((c) => c.ok === true && String(c.tag).includes("兜底重试")),
		newAudit6.map((c) => `ok=${c.ok} tag=${c.tag}`).join(" | ") || "(无新增)");
	f.disposers.forEach((d) => d());

	// ============================================================ 审计文件总体检查
	console.log("\n=== 汇总：cards.jsonl 审计 ===");
	const cards = readCards();
	check("每次推送都有审计记录，且 tag 能区分卡片种类",
		cards.length >= 5 &&
		cards.some((c) => String(c.tag).includes("首次推送")) &&
		cards.some((c) => String(c.tag).includes("补推")) &&
		cards.some((c) => String(c.tag).includes("更正")),
		`共 ${cards.length} 行：${cards.map((c) => c.tag).join(" | ")}`);
	check("审计里不出现 token 全文（只留尾部 8 位）",
		!readFileSync(cardsPath, "utf8").includes(TOKEN) && cards.every((c) => typeof c.tokenTail === "string"),
		`tokenTail 示例=${cards[0]?.tokenTail}`);
	check("审计里带文案指纹（重启自检据此断言新文案）",
		cards.filter((c) => c.ok).every((c) => c.head === "# DeepSeek Harness本次token" && c.section === "## 三个入口" && c.legacyWording === false),
		`head=${JSON.stringify(cards.find((c) => c.ok)?.head)} section=${JSON.stringify(cards.find((c) => c.ok)?.section)}`);

	console.log("\n=== 结果 ===");
	console.log(failures === 0 ? "全部通过 ✅" : `失败 ${failures} 项 ❌`);
} finally {
	plugin.__setTailnetProbe(undefined);
	pushStub.close();
	gatewayStub.close();
	rmSync(work, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
