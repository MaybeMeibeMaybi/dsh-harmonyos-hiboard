/**
 * dsh-token-broadcast - dsh 每次启动时，把本次会话 token 与三个入口推到手机负一屏。
 *
 * 为什么需要它：dsh 的会话 token 只在启动时打印一次到 stdout，不落盘；
 * 而用户经常需要在手机上用它（首次建立浏览器会话），手工去日志里翻很麻烦，
 * 所以做成"随 dsh 启动自动推送一张含 token 与三个入口地址的卡片"。
 *
 * 行为：
 *   1. 等启动器把**本次**运行的 token 写进 <用户目录>/.dsh/lan/web-state.json（最多等 120 秒）
 *   2. 用 patch 配置里的 authCode 调 HIBoard 接口推一张卡片
 *   3. 卡片**必须带非空 scheduleTaskId**，否则负一屏只显示标题、正文不渲染
 *   4. 卡片文案（用户 2026-09-30 定稿，改文案只改下面三个常量）：
 *        CARD_NAME           负一屏卡片**外层那一行**（scheduleTaskName / summary）
 *        CARD_TITLE          卡片**正文顶部标题**
 *        CARD_ENTRY_HEADING  入口小节标题（**不带括号说明**）
 *   5. Tailscale 是**随 dsh 同步启动**的（dsh-companion-startup），启动瞬间常常还没连上：
 *      第一张卡片允许先写"未连上 tailnet"（用户 2026-09-30 明确允许），之后本插件
 *      **继续盯住 tailnet**，连上以后**再补推一张已连接的卡片**，并把 token 补注册给
 *      本机 8443 网关 —— 推第一张卡片时还探测不到 tailnet 地址，那一次的注册目标里
 *      没有本机网关（不补注册的话 tailnet 入口即使连上也进不去）。
 *      另外：地址通 ≠ 入口能用，所以卡片里写了 tailnet 地址之后还会**核对本机 8443
 *      网关是否真在监听**（GET /__gw_health），没在监听就补推一张更正卡片。
 *   6. 推卡片**带完整投递阶梯**（2026-09-30 血泪）：华为端点的行为在实测中很不稳定 ——
 *      同一分钟内、同一条 payload，插件发出去会连续 404（`server: elb`），而换一条传输、
 *      或者把连接钉到该域名的另一个 A 记录上就立刻 200；也见过 fetch 那条路直接超时。
 *      所以每次尝试按 **fetch → https.request → 逐个钉住解析到的地址** 依次升级，
 *      之间按指数退避；只要卡片始终没送达，还会每分钟再走一遍这条阶梯
 *      （上限 cardRetryMinutes，默认 15 分钟）。每次尝试都写进 cards.jsonl 审计。
 *      顺序也调整为**先注册网关、再推卡片**：注册是远程入口可用的前提，不能被推卡的坏运气拖住。
 *
 * 卡片里的地址必须写**真实 IP**（用户 2026-09-27 明确要求，原来写的是
 * `<服务器IP>` / `<电脑IP>` 占位符，等于没用）：
 *   - 网关主机名默认从网关注册地址（registerUrl）的 host 推导，可用 gatewayHost 显式覆盖；
 *   - 局域网地址里的本机 IP 每次启动**动态探测**：DHCP 换网就会变，
 *     写死必然过期（2026-09-27 实测同一个上午就从 192.168.0.x 段换到了 192.168.3.x 段）。
 *
 * 可选：如果 PC 上存在网关注册密钥文件，还会把 token 注册给 HTTPS 网关，
 *       这样浏览器登录后无需手工粘贴 token（见 registerKeyPath 配置）。
 *
 * `Config` 必须是 schemastery schema（cordis 4 会调 Config["~standard"].validate）。
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import z from "@deepseek-ai/schemastery";

/**
 * 模块级证据（2026-10-02 事故后加的）：只要模块被 import 就写一行，带上真实路径。
 * 放在文件**最前面**，这样"没被加载"与"加载时报错"能区分开。
 * 配套地，apply 里还会写一行 —— 两行合起来就能判断插件到底有没有跑起来。
 */
try {
	appendFileSync(
		join(homedir(), ".dsh", "lan", "token-broadcast-import.log"),
		`${new Date().toISOString()} imported pid=${process.pid} url=${import.meta.url}\n`
	);
} catch {
	// 日志失败不影响任何事
}

/**
 * **第三路 token 抓取（2026-10-02 23:1x 新增）：嗅 dsh 自己打印的那行启动地址。**
 *
 * 为什么还需要它：本次 launchToken 只存在于 `connection` 服务里
 * （`HostConnectionService.browserAuth.launchToken`），而服务对本插件可见与否取决于
 * cordis 的作用域规则 —— 22:24 实测里静态 `inject: ["connection"]` 甚至让整个插件
 * pending（一个产物都没有）。所以除了"拿服务"，再加一条**完全不依赖服务**的路：
 * dsh-web-app 在 `ctx.inject(["connection"], …)` 回调里会打印
 * `dsh web: <带 ?token= 的根地址> (LAN: <局域网同款地址>)`（dsh-web-app/lib/index.js:203），
 * 那行字符串必然经过 `process.stdout.write`；而本模块是在 apply 之前几秒被 import 的。
 *
 * 钩子必须**完全透明**：原样转发参数、原样返回原函数返回值、异常一律吞掉。
 * 嗅到的候选**不当真**：它可能来自上一次启动的终端输出，必须再回环验证（见 verifyToken）。
 */
const sniffedTokens = [];
const SNIFF_LIMIT = 8;
function installStdoutSniff() {
	try {
		const original = process.stdout.write;
		if (typeof original !== "function" || original.__dshTokenSniff === true) return;
		const wrapped = function (chunk, encoding, callback) {
			try {
				const text = typeof chunk === "string"
					? chunk
					: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
				for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+\?token=([A-Za-z0-9_-]{16,})/g)) {
					const seen = match[1];
					if (!sniffedTokens.includes(seen) && sniffedTokens.length < SNIFF_LIMIT) sniffedTokens.push(seen);
				}
			} catch {
				// 嗅探失败绝不影响输出
			}
			return original.call(this, chunk, encoding, callback);
		};
		wrapped.__dshTokenSniff = true;
		process.stdout.write = wrapped;
	} catch {
		// 挂不上钩子只是少一条路，不影响其它两条
	}
}
installStdoutSniff();

export const name = "token-broadcast";

/**
 * **刻意不声明静态 `inject`**（2026-10-02 22:24 实测教训）。
 *
 * 救援那天给本插件加过 `export const inject = ["connection"]`（为了让 `ctx.get("connection")`
 * 可见，那一步本身没错）。但静态 inject 是**整个插件的激活开关**：这个服务一旦在当前
 * 作用域里没被满足，插件就永远 pending —— **推卡片、网关注册、token 抓取全部静默不执行**。
 * 实测：22:24 那次 `dsh web` 启动，entry-startup 正常拉起全部五个组件，而本插件
 * **一个产物都没有**（cards.jsonl / register-status.json / capture.log 全是旧的）。
 * 等于"为了修一个崩溃，把插件整个关掉了"。
 *
 * 所以：**服务在内部按需获取**（见 connectionOf 与 captureLaunchToken：get 与 inject 两条路），
 * 插件本体永远先 apply —— 即使连接服务来晚了，卡片与网关注册也照常工作。
 *
 * 但绝不能再用 `ctx.connection` 这种**未注入服务的属性访问**：cordis 4 会直接抛错
 * （2026-10-02 上午就是这样把 dsh 启动打崩的）。只允许 `ctx.get()`（拿不到返回 undefined）
 * 与 `ctx.inject()`；这一点由 tests/hostile-ctx.test.mjs 守着。
 */

/**
 * 卡片文案（2026-09-30 用户定稿）。
 *
 * 抽成常量而不是散在模板字符串里，是因为这三行是**用户逐字指定**的：
 * 外层那行在 payload 里出现两次（scheduleTaskName + summary），
 * 改文案时在一大段模板里找很容易改漏一处。
 */
const CARD_NAME = "DeepSeek Harness本次启动地址"; // 外层一行 = scheduleTaskName / summary
const CARD_TITLE = "# DeepSeek Harness本次token"; // 正文顶部标题
const CARD_ENTRY_HEADING = "## 三个入口"; // 入口小节标题（不带括号说明）

// 默认值必须写成常量并在 apply 里兜底：schemastery 的 .default() 只在通过
// Config(...) 走校验时才填值，直接 `{...Config}` 展开是拿不到的（踩过）。
const DEFAULTS = {
	scheduleId: "dsh_token_notice",
	waitMs: 120000,
	pollMs: 1000,
	registerInsecure: false,
	pushServiceUrl: "https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/claw/msg/upload",
	tailnetWatch: true,
	tailnetWaitMs: 300000,
	tailnetPollMs: 5000,
	gatewayWaitMs: 90000,
	pushAttempts: 3,
	pushRetryMs: 3000,
	cardRetryMinutes: 15,
	cardRetryMs: 60000
};

export const Config = z.object({
	enabled: z.boolean().default(true),
	/** 负一屏授权码；留空则尝试从环境变量 DSH_HIBOARD_AUTH_CODE 读取。 */
	authCode: z.string().default(""),
	/** 卡片正文的 scheduleTaskId。必须非空，否则负一屏不渲染正文。 */
	scheduleId: z.string().default(DEFAULTS.scheduleId),
	/** 启动器写 token 的位置，留空表示 <用户目录>/.dsh/lan/web-state.json */
	statePath: z.string().default(""),
	/** 等 token 出现的最长时间（毫秒） */
	waitMs: z.number().default(DEFAULTS.waitMs),
	/** 轮询间隔（毫秒） */
	pollMs: z.number().default(DEFAULTS.pollMs),
	/** 可选：网关注册密钥文件路径（文件内容即密钥） */
	registerKeyPath: z.string().default(""),
	/**
	 * 本插件自己产物的目录：`register-status.json`（注册结果）与 `cards.jsonl`（推卡审计）。
	 * 留空 = <用户目录>/.dsh/lan/token-broadcast —— **线上就是这个路径**，
	 * `verify-gateway.mjs` 也读它，所以在线上不要改这个值；测试用它把产物写进临时目录。
	 */
	statusDir: z.string().default(""),
	/** 可选：网关注册地址 */
	registerUrl: z.string().default(""),
	/**
	 * 可选：**额外的**网关注册地址（数组）。
	 * 为什么需要：现在同时存在两个网关——服务器上的 HTTPS 网关（外网）与本机
	 * tailnet 上的本地网关（100.x:8443，免 token 入口）。每次 dsh 启动必须把
	 * 本次 token 同时注册给两者，否则本地网关会停留在"未注册"状态。
	 */
	registerUrls: z.array(z.string()).default([]),
	/** 可选：卡片里显示的网关主机（形如 1.2.3.4:18443）；留空则从 registerUrl 推导。 */
	gatewayHost: z.string().default(""),
	/** 可选：卡片里显示的本机局域网 IP；留空则每次启动动态探测。 */
	lanIp: z.string().default(""),
	/** 局域网入口端口（卡片里拼 http://<lanIp>:<port>/?token=...） */
	lanPort: z.number().default(3081),
	/** 可选：卡片里显示的 tailnet(100.64/10) 地址；留空则每次启动动态探测。 */
	tailnetIp: z.string().default(""),
	/** tailnet 上免 token 网关的端口（卡片里推 https://<tailnetIp>:<port>/）。 */
	tailnetGatewayPort: z.number().default(8443),
	/**
	 * 本机 tailnet 网关的注册端口。填了就**自动**把
	 * `https://<本次探测到的 tailnet 地址>:<端口>/__gw_register` 加入注册目标——
	 * 这样 Path B 切换（地址从 100.x 变成 100.64.x）后不需要改配置。
	 */
	registerLocalGatewayPort: z.number().default(8443),
	/** 网关注册失败时的重试次数（网关把 token 存在内存里，漏注册会导致远程端连不上）。 */
	registerAttempts: z.number().default(3),
	/** 网关注册重试间隔（毫秒）。 */
	registerRetryMs: z.number().default(5000),
	/**
	 * 是否"盯 tailnet"：启动时没探测到 tailnet 地址时继续轮询，连上后补推卡片
	 * 并补注册本机网关（用户 2026-09-30 要求；Tailscale 随 dsh 同步启动，
	 * 第一张卡片几乎总是抢在它连上之前推出去）。
	 * 已连上 tailnet 时也会核对本机网关是否在监听，没在监听同样补推更正卡片。
	 */
	tailnetWatch: z.boolean().default(DEFAULTS.tailnetWatch),
	/** 盯 tailnet 的最长时间（毫秒）；超时则只保留第一张卡片。 */
	tailnetWaitMs: z.number().default(DEFAULTS.tailnetWaitMs),
	/** 盯 tailnet 的轮询间隔（毫秒）。 */
	tailnetPollMs: z.number().default(DEFAULTS.tailnetPollMs),
	/**
	 * tailnet 连上后，等本机免 token 网关就绪的最长时间（毫秒）。
	 * 为什么要等：网关由 Start-LocalGateway.ps1 监督，它每 30 秒才检查一次端口，
	 * 所以 tailnet 起来之后网关通常还要再等一会儿才开始监听；
	 * 不等就推卡片，用户点进去只会看到"打不开"。
	 */
	gatewayWaitMs: z.number().default(DEFAULTS.gatewayWaitMs),
	/**
	 * 推卡片的尝试次数。
	 *
	 * 为什么需要重试（2026-09-30 实测）：华为这个端点有**坏窗口** —— 同一份字节、
	 * 同一个进程，10:36:50 起连续 6 次请求全 404，10:38 同样的字节立刻 200。
	 * 没有重试的话，卡片就这么静默丢了，而这张卡片是手机上拿地址/token 的唯一入口。
	 */
	pushAttempts: z.number().default(DEFAULTS.pushAttempts),
	/**
	 * 重试间隔基数（毫秒）。第 n 次失败后等 `基数 × 2^(n-1)`，封顶 60 秒
	 * （默认 3 次 → 3s / 6s，够快；把 pushAttempts 调大就能覆盖更长的坏窗口）。
	 */
	pushRetryMs: z.number().default(DEFAULTS.pushRetryMs),
	/**
	 * 送卡兜底时长（分钟）：只要卡片**始终没成功推出去**，就每分钟再试一次，直到这个
	 * 上限。为什么要有它：坏窗口可能长到几十秒甚至几分钟，而"卡片没送到"是用户唯一
	 * 能感知的故障 —— 每分钟重试一次的成本远低于让用户手机上什么都不更新。
	 */
	cardRetryMinutes: z.number().default(DEFAULTS.cardRetryMinutes),
	/** 送卡兜底的重试间隔（毫秒，默认一分钟）；测试用它把兜底循环跑快。 */
	cardRetryMs: z.number().default(DEFAULTS.cardRetryMs),
	pushServiceUrl: z.string().default(DEFAULTS.pushServiceUrl)
});

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 探测本机局域网地址（**必须排除 Tailscale 的 100.64/10 与虚拟网卡**）。
 *
 * 2026-09-27 真实事故：装上 Tailscale 之后，`100.x` 常常排在 `os.networkInterfaces()`
 * 的第一位，任何"取第一个非内部 IPv4"的写法都会把 tailnet 地址当成局域网地址——
 * 入口代理因此在局域网里整条不可达。卡片里也会推错地址。判定逻辑与
 * dsh-entry-proxy.mjs / dsh-entry-startup 保持一致。
 */
const VIRTUAL_ADAPTER = /virtual|vmware|vbox|hyper-?v|wsl|tailscale|zerotier|docker|loopback|bluetooth|tap|tun|vpn|radmin|hamachi|npcap/i;

function isTailnetAddress(address) {
	if (!address.startsWith("100.")) return false;
	const second = Number(address.split(".")[1]);
	return second >= 64 && second <= 127;
}

function lanRank(address) {
	if (address.startsWith("192.168.")) return 0;
	if (address.startsWith("10.")) return 1;
	const [first, second] = address.split(".").map(Number);
	if (first === 172 && second >= 16 && second <= 31) return 2;
	return 3;
}

function detectLanIp() {
	const candidates = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		if (VIRTUAL_ADAPTER.test(name)) continue;
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			if (address.address.startsWith("169.254.")) continue;
			if (isTailnetAddress(address.address)) continue;
			candidates.push(address.address);
		}
	}
	candidates.sort((a, b) => lanRank(a) - lanRank(b));
	return candidates[0] ?? "";
}

/** 探测 Tailscale 地址（100.64.0.0/10）；没装/未登录时返回空串。 */
function detectTailnetIp() {
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		if (!/tailscale/i.test(name)) continue;
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && isTailnetAddress(address.address)) return address.address;
		}
	}
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && isTailnetAddress(address.address)) return address.address;
		}
	}
	return "";
}

/**
 * tailnet 探测的**注入点，只为自测**：真实网卡状态在测试里切不动，而
 * "启动时没连上 → 若干秒后连上"正是 2026-09-30 新增逻辑的关键路径，
 * 必须能确定性复现。测试用 __setTailnetProbe 塞一个受控探测函数进来。
 */
let tailnetProbe = detectTailnetIp;

/** 仅供测试：替换 tailnet 探测实现；传非函数则恢复真实探测。 */
export function __setTailnetProbe(probe) {
	tailnetProbe = typeof probe === "function" ? probe : detectTailnetIp;
}

/**
 * 仅供测试：把内部读 token 的两条路暴露出来。
 * 2026-10-02 的教训是"隔离测试用假 ctx 无条件返回对象，恰好掩盖了真实环境里读不到"，
 * 所以这两个口子**不模拟环境**，只暴露纯函数，测试用真实的 dsh 侧对象形状（含 browserAuth）来喂。
 */
export function __launchTokenOf(connection) {
	return launchTokenOf(connection);
}

/** 仅供测试：回环验证（测试里对手搓的 http 桩用）。 */
export function __verifyToken(token, port) {
	return verifyToken(token, port);
}

/** 仅供测试：嗅探缓冲区的只读快照。 */
export function __sniffedTokens() {
	return [...sniffedTokens];
}

/**
 * 记一行"本次 token 是怎么来的"到 capture.log（只记 token 尾部 8 位，不记全文）。
 *
 * 为什么需要：2026-10-02 我声称"token 抓取已验证"，其实只验证了假 ctx；真实启动里它
 * 到底走没走到、是插件抓的还是启动器写的，事后无从查证。有了这个文件，下次启动
 * 一眼就能看出 `source=plugin` 还是 `source=launcher`。
 */
function auditCapture(statePath, record) {
	try {
		// 2026-10-02 23:1x 修正：这里用了 dirname() 却**没有 import 它**（只 import 了 join），
		// 于是 auditCapture 每次都抛 ReferenceError 被自己的 catch 静默吞掉 —— 所谓
		// "抓取审计"从来没落过盘，这也是我当时没法从证据里看出"token 到底抓没抓到"的原因。
		const file = join(dirname(statePath), "token-broadcast", "capture.log");
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`, "utf8");
	} catch {
		// 审计写不了不影响任何事
	}
}

/** 从网关注册地址推导卡片里显示的网关主机（host:port），失败返回空串。 */function gatewayHostFrom(url) {
	try {
		const parsed = new URL(String(url));
		return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
	} catch {
		return "";
	}
}

/**
 * 读取 token **及其新鲜度标记**。
 *
 * web-state.json 不会在 dsh 退出时删除，所以上一次运行留下的 token 会一直躺在里面。
 * 如果本插件抢在本次启动器写文件之前读到它，就会把**已经失效的旧 token** 推给用户
 * ——比不推更糟（用户会拿着旧 token 反复试）。因此这里同时读出 pid/startedAt，
 * 与当前进程比对，只有确认是"本次运行写的"才算数。
 */
function readState(path) {
	try {
		const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(text);
		const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
		if (!token) return undefined;
		return {
			token,
			pid: Number(parsed?.pid) || 0,
			startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : ""
		};
	} catch {
		return undefined;
	}
}

/**
 * 把本次启动的 token 抄进 web-state.json —— **不管 dsh 是怎么启动的**。
 *
 * 依据：dsh-client-connection 的服务类把 `launchToken` 作为公开字段持有
 * （`launchToken;` / `this.launchToken = processLaunchToken(processOwner)`），
 * 而 cordis 的 connection 服务能给出该实例。服务是异步就绪的，所以这里轮询等待。
 *
 * **必须两条路都走（2026-10-02 实测教训）**：cordis 4 的 `ctx.get(name)` 只返回
 * **当前作用域可见**的服务；本插件没声明 inject，于是真实环境里 `ctx.get("connection")`
 * 拿到 undefined —— 只用它时 token 抓取完全没生效（web-state.json 里还是上一次运行的 pid），
 * 而我的隔离测试因为假 ctx 无条件返回对象，恰好掩盖了这一点。
 * 官方自己的写法就是先 get、拿不到再 inject（dsh-client-modules：
 * `if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], registerWebCarrier);`），
 * 这里照做：两条路都试。
 *
 * 写盘内容与启动器写的那份**同形**（外加 source 字段便于区分是谁写的），
 * 于是 token-broadcast 自己的 isFresh()、8443 看门狗、以及任何读这个文件的人
 * 都能拿到本次有效 token。
 */
function connectionOf(scope) {
	if (!scope || typeof scope.get !== "function") return undefined;
	try {
		// **只走 ctx.get()**：这是唯一安全的读法（拿不到就返回 undefined）。
		// 绝对不要写 `scope.connection` —— cordis 4 对未注入服务的**属性访问会直接抛错**
		// （"cannot get property \"connection\" without inject"），2026-10-02 就是这一行
		// 把 dsh 的启动打崩的（unhandled rejection → fatal load failure）。
		// 需要 connection 时靠插件顶部的 `export const inject = ["connection"]` 声明。
		return scope.get("connection") ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 在 `ctx.inject(["connection"], scope => …)` 的回调里取服务实例。
 *
 * 回调里依赖已被注入，读属性是合法的；但依然"先 get 再属性、且包 try"：本函数跑在
 * dsh 的启动路径上，宁可少拿一次服务，也不能再抛一次错（2026-10-02 的崩溃教训）。
 */
function serviceFrom(scope) {
	const viaGet = connectionOf(scope);
	if (viaGet) return viaGet;
	try {
		return scope?.connection ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从 connection 服务里读**本次** launchToken；读不到返回空串。
 *
 * **2026-10-02 23:1x 修正的真正根因**：以前这里读的是 `connection.launchToken`，
 * 但 dsh-client-connection 的实现里 token 并不在服务本身上 —— 它在
 * `HostConnectionService.browserAuth.launchToken`（`browserAuth` 是公开字段），
 * 服务类对外只暴露 `authenticatedUrl()` / `authorizeIndex()` 等方法。
 * 于是**即使服务拿到了，`connection.launchToken` 也永远是 undefined**，抓取必然超时
 * （23:05 那次启动的 cards.jsonl 里就写着"抓不到 token 的告警"）。
 * 现在按"公开 API → 内部公开字段 → 兼容直读"的顺序取。
 */
function launchTokenOf(connection) {
	if (!connection) return "";
	// 1) 公开 API：authenticatedUrl(任意 baseUrl) 返回带 ?token= 的根地址（dsh-web-app 用的就是它）
	try {
		if (typeof connection.authenticatedUrl === "function") {
			const url = new URL(connection.authenticatedUrl("http://dsh.invalid/"));
			const token = url.searchParams.get("token");
			if (token && token.trim()) return token.trim();
		}
	} catch {
		// 走下一条
	}
	// 2) 当前实现的真实位置：browserAuth.launchToken
	try {
		const nested = connection.browserAuth;
		if (nested && typeof nested.launchToken === "string" && nested.launchToken.trim()) {
			return nested.launchToken.trim();
		}
	} catch {
		// 走下一条
	}
	// 3) 万一将来把它摊平到服务自身
	try {
		if (typeof connection.launchToken === "string" && connection.launchToken.trim()) {
			return connection.launchToken.trim();
		}
	} catch {
		// 没有就没有
	}
	return "";
}

/** 本机 dsh 的 HTTP 端口（回环验证用）；拿不到就按 3080。 */
function webPortOf(ctx) {
	try {
		const port = Number(typeof ctx?.get === "function" ? ctx.get("webServer")?.port : 0);
		return port > 0 ? port : 3080;
	} catch {
		return 3080;
	}
}

/**
 * 回环自证：只有 dsh 自己认这个 token（`GET /` → 303 + Set-Cookie）才算数。
 *
 * 为什么必须验证：卡片上的地址是**给用户照着粘贴**的，错一个字符就是 401；
 * 而嗅探来的候选可能来自上一次启动的终端历史输出。验证一次几十毫秒，值得。
 */
function verifyToken(token, port) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const req = httpRequest({
				host: "127.0.0.1",
				port,
				method: "GET",
				path: `/?token=${encodeURIComponent(token)}`,
				headers: { host: `127.0.0.1:${port}` },
				timeout: 5000
			}, (res) => {
				res.resume();
				done(res.statusCode === 303 || res.statusCode === 302);
			});
			req.on("error", () => done(false));
			req.on("timeout", () => {
				try {
					req.destroy();
				} catch {
					// 已经断了
				}
				done(false);
			});
			req.end();
		} catch {
			done(false);
		}
	});
}

async function captureLaunchToken(ctx, statePath, waitMs) {
	try {
		return await captureLaunchTokenInner(ctx, statePath, waitMs);
	} catch (error) {
		// 兜底（2026-10-02 事故）：这个函数在插件 apply 的**同步头**里被调用，
		// 一旦抛错会变成 unhandled rejection，dsh 会当成致命错误拒绝启动。
		try {
			ctx?.logger?.warn?.("[token-broadcast] 抓 token 抛错（已兜住）：%s", error?.stack ?? String(error));
		} catch {
			// 日志失败也不能再抛
		}
		return false;
	}
}

async function captureLaunchTokenInner(ctx, statePath, waitMs) {
	const deadline = Date.now() + Math.max(5000, Number(waitMs) || 120000);
	let injected;
	let injectRequested = false;
	let injectFired = false;
	let lastNote = "";
	for (;;) {
		const connection = injected ?? connectionOf(ctx);
		if (!connection && !injectRequested && typeof ctx?.inject === "function") {
			injectRequested = true;
			try {
				ctx.inject(["connection"], (scope) => {
					injectFired = true;
					injected = serviceFrom(scope) ?? injected;
				});
			} catch (error) {
				lastNote = `ctx.inject 抛错：${error?.message ?? String(error)}`;
			}
		}
		// 服务给的 token 是权威值；嗅探来的候选必须回环验证（它可能是上一次启动的输出）。
		let token = launchTokenOf(connection);
		let route = token ? "connection-service" : "";
		if (!token && sniffedTokens.length > 0) {
			for (const candidate of [...sniffedTokens]) {
				if (await verifyToken(candidate, webPortOf(ctx))) {
					token = candidate;
					route = "stdout-sniff+loopback-303";
					break;
				}
			}
		}
		if (token) {
			const current = readState(statePath);
			if (current && current.token === token && current.pid === process.pid) {
				auditCapture(statePath, { ok: true, note: "state 已是最新（启动器写的就是本次 token）", route: "state-already-fresh", tokenTail: token.slice(-8) });
				return true;
			}
			try {
				const port = webPortOf(ctx);
				// 服务给的 token 顺手回环验证一次：结果只记录，不用它否决权威值。
				const verified = route === "connection-service" ? await verifyToken(token, port) : true;
				writeFileSync(statePath, JSON.stringify({
					ok: true,
					pid: process.pid,
					token,
					guiUrl: `http://127.0.0.1:${port}/?token=${token}`,
					startedAt: new Date().toISOString(),
					source: "plugin:token-broadcast",
					route,
					verified
				}, null, 2), "utf8");
				ctx?.logger?.info?.("[token-broadcast] 已抓到本次 token（路：%s）并写入 %s（不再依赖启动器）", route, statePath);
				auditCapture(statePath, {
					ok: true,
					note: "由插件自己抓到并写入 web-state.json",
					route,
					verified,
					injectFired,
					sniffed: sniffedTokens.length,
					tokenTail: token.slice(-8)
				});
				return true;
			} catch (error) {
				ctx?.logger?.warn?.("[token-broadcast] 写 %s 失败：%s", statePath, error?.message ?? String(error));
				auditCapture(statePath, { ok: false, note: `写盘失败：${error?.message ?? String(error)}`, route });
				return false;
			}
		}
		if (Date.now() >= deadline) {
			// 2026-10-02 23:1x：超时这一支必须把"三条路各自走到哪一步"写清楚 ——
			// 上一版只有一句"超时拿不到"，客服不了"到底是服务不可见、还是字段读错了"。
			ctx?.logger?.warn?.("[token-broadcast] 拿不到 launchToken（%d 秒超时；服务可见=%s，inject 已注册=%s 已触发=%s，嗅到候选=%d%s），退回等启动器写 %s",
				Math.round((Math.max(5000, Number(waitMs) || 120000)) / 1000),
				Boolean(connection),
				injectRequested,
				injectFired,
				sniffedTokens.length,
				lastNote ? `；${lastNote}` : "",
				statePath);
			auditCapture(statePath, {
				ok: false,
				note: `超时拿不到 launchToken${lastNote ? `；${lastNote}` : ""}`,
				serviceVisible: Boolean(connection),
				injectRequested,
				injectFired,
				sniffed: sniffedTokens.length,
				routesTried: ["ctx.get(connection)", "ctx.inject([connection])", "stdout-sniff"]
			});
			return false;
		}
		await sleep(500);
	}
}

/** 状态文件是否属于当前 dsh 进程：pid 一致优先，其次比对启动时间。 */function isFresh(state) {
	if (!state) return false;
	if (state.pid && state.pid !== process.pid) return false;
	const startedMs = Date.parse(state.startedAt);
	if (!Number.isFinite(startedMs)) return true; // 老格式没有 startedAt：pid 能对上就用
	// 进程启动时间不可能晚于状态文件写入时间；给 5 分钟容差防止时钟抖动误判。
	return startedMs >= Date.now() - 5 * 60 * 1000;
}

/** POST JSON，返回 { ok, status, body }。不抛出，交给调用方判断。
 *  insecure 仅用于我们自己的网关（自签证书）；对华为负一屏一律保持严格校验。
 *  带 http 分支：一是与 dsh-push-guard 保持一致，二是**能对着本地桩做端到端自测**
 *  （之前只支持 https，导致自测时桩收不到请求、误判成插件逻辑有问题）。 */
function postJson(url, payload, insecure = false, pinIp = "") {
	return new Promise((resolve) => {
		let target;
		try {
			target = new URL(url);
		} catch (error) {
			resolve({ ok: false, status: 0, body: `无效 URL: ${error.message}` });
			return;
		}
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		// x-trace-id 是 HIBoard 的必填请求头，缺了会返回 0000500001
		// ("Parameter x-trace-id is empty")。格式与官方客户端一致。
		const traceId = traceIdFor();
		const secure = target.protocol !== "http:";
		const request = secure ? httpsRequest : httpRequest;
		const options = {
			hostname: target.hostname,
			port: target.port || (secure ? 443 : 80),
			path: target.pathname + target.search,
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-length": String(body.length),
				"x-trace-id": traceId
			},
			timeout: 15000,
			rejectUnauthorized: !insecure
		};
		// pinIp：把连接钉到指定地址（Host/SNI 仍是域名）。只有主机名才需要钉，
		// 本来就写 IP 的（自测桩、内网网关）直接跳过。
		if (pinIp && !isIP(target.hostname)) {
			options.lookup = (_hostname, lookupOptions, callback) => {
				// Node 20+ 的 Happy Eyeballs 会用 all:true 调 lookup，那时必须回数组。
				if (lookupOptions && lookupOptions.all) callback(null, [{ address: pinIp, family: 4 }]);
				else callback(null, pinIp, 4);
			};
		}
		const req = request(
			options,
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => resolve({
					ok: (res.statusCode ?? 0) < 400,
					status: res.statusCode ?? 0,
					// 带上响应头：404/5xx 时靠 `server` 之类的头才能判断到底是谁在回，
					// 2026-09-30 排查过一次"插件 404 而同端点的其它客户端 200"，当时没有头可看。
					headers: res.headers,
					body: data.slice(0, 300)
				}));
			}
		);
		req.on("error", (error) => resolve({ ok: false, status: 0, body: error.message }));
		req.on("timeout", () => {
			req.destroy();
			resolve({ ok: false, status: 0, body: "请求超时" });
		});
		req.write(body);
		req.end();
	});
}

/** HIBoard 要求的 x-trace-id；格式与官方客户端一致。 */
function traceIdFor() {
	return `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`;
}

/**
 * 用 fetch（undici）推卡片。
 *
 * 为什么要第二条传输（2026-09-30 实测）：**同一条 payload、同一分钟内**，
 * https.request 从插件里发出去会连续 404 `{"message":"Not Found"}`（server: elb），
 * 而 dsh 自己的 hiboard_push 工具（用 fetch）一直成功，我手写的 fetch 请求也稳定 200。
 * 到底是服务端负载均衡把某些连接钉在坏后端、还是两种客户端在头部细节上有差异，
 * 没能坐实；但"多一条传输就多一次机会"是实证有效的，所以每次尝试**先 fetch**，
 * 失败再退回 https.request（后者对自签网关仍是必需的，见 postJson 的 insecure）。
 */
async function postCardViaFetch(url, payload, timeoutMs = 15000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8", "x-trace-id": traceIdFor() },
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: text.slice(0, 300),
			transport: "fetch"
		};
	} catch (error) {
		return { ok: false, status: 0, headers: {}, body: `fetch 失败：${error?.message ?? String(error)}`, transport: "fetch" };
	} finally {
		clearTimeout(timer);
	}
}

/** 推一次卡片：先 fetch，不成功再 https.request；返回结果里带上是哪条传输的结果。 */
async function pushOnce(url, payload) {
	const viaFetch = await postCardViaFetch(url, payload);
	if (viaFetch.ok && /"code"\s*:\s*"(0{10}|0)"/.test(viaFetch.body)) return viaFetch;
	const viaRequest = await postJson(url, payload);
	if (viaRequest.ok && /"code"\s*:\s*"(0{10}|0)"/.test(viaRequest.body)) {
		return { ...viaRequest, transport: "https.request" };
	}
	// 两条都没成：把更有信息量的那条（有 HTTP 状态码 / server 头）报上去
	const informative = viaRequest.status ? { ...viaRequest, transport: "https.request" } : viaFetch;
	return { ...informative, fetchBody: viaFetch.body.slice(0, 120) };
}

/**
 * 解析主机名的全部 IPv4 地址；失败返回空数组。
 *
 * 为什么需要（2026-09-30 实测）：该域名有**两个 A 记录**（华为侧的两台公网入口，地址会变，
 * 所以这里不写死；用 `node -e "require('dns').lookup(...)"` 或 `nslookup` 自己看），
 * 而"同一个进程、同一分钟"里，走默认解析的请求会连续 404（`server: elb`），
 * 而把连接**钉到其中一个地址**的请求立刻 200 —— 像是某些边缘地址对这条路径不正常。
 * 所以失败后升级为"逐个地址钉住重试"，把"运气"变成"遍历"。
 */
async function resolveAddresses(hostname) {
	try {
		const list = await dnsLookup(hostname, { all: true, family: 4 });
		return list.map((item) => item.address);
	} catch {
		return [];
	}
}

/**
 * 最后一级投递：把 payload 写成临时文件，交给**独立进程**（lib/push-once.mjs）去发。
 *
 * 依据见 push-once.mjs 顶部：插件进程内怎么发都 404，而同一份字节换个新进程就 200。
 * 兜底阶段才用它（正常尝试先走进程内的 fetch / https.request / 钉地址），
 * 这样既不影响常规路径，又给"进程内怎么都不行"的情况留一条真的能落地的路。
 */
function pushViaHelper(url, payload) {
	return new Promise((resolve) => {
		const helper = fileURLToPath(new URL("./push-once.mjs", import.meta.url));
		let file = "";
		try {
			file = join(tmpdir(), `dsh-card-${process.pid}-${Date.now()}.json`);
			writeFileSync(file, JSON.stringify(payload), "utf8");
		} catch (error) {
			resolve({ ok: false, status: 0, body: `写临时 payload 失败：${error?.message ?? String(error)}` });
			return;
		}
		execFile(process.execPath || "node", [helper, url, file], { timeout: 60000, windowsHide: true }, (error, stdout) => {
			try {
				unlinkSync(file);
			} catch {
				// 临时文件清理失败不影响结果
			}
			const text = String(stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
			try {
				const parsed = JSON.parse(text);
				resolve({ ok: Boolean(parsed.ok), status: Number(parsed.status) || 0, body: String(parsed.body ?? ""), headers: {} });
			} catch {
				resolve({ ok: false, status: 0, body: `helper 无有效输出：${error?.message ?? ""} ${text}`.trim(), headers: {} });
			}
		});
	});
}

/**
 * 探本机 tailnet 网关是否**已经在服务**（GET /__gw_health）。
 *
 * 只用于我们自己的网关，所以 rejectUnauthorized 固定 false（自签证书）；
 * 对华为负一屏的推送依旧严格校验，两者不要混。
 */
function probeLocalGateway(ip, port, timeoutMs = 4000) {
	return new Promise((resolve) => {
		if (!ip) {
			resolve(false);
			return;
		}
		const req = httpsRequest(
			{
				hostname: ip,
				port,
				path: "/__gw_health",
				method: "GET",
				rejectUnauthorized: false,
				timeout: timeoutMs
			},
			(res) => {
				res.resume();
				resolve(true);
			}
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

export function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config ?? {}) };
	// apply 证据（与模块级 import 行配对）：有 import 行没有这一行 = 插件被加载但没被激活
	try {
		appendFileSync(
			join(homedir(), ".dsh", "lan", "token-broadcast-apply.log"),
			`${new Date().toISOString()} apply pid=${process.pid} keys=[${config && typeof config === "object" ? Object.keys(config).join(",") : String(config)}] enabled=${settings.enabled !== false}\n`
		);
	} catch {
		// 日志失败不影响任何事
	}
	if (settings.enabled === false) return;

	const authCode = String(settings.authCode || process.env.DSH_HIBOARD_AUTH_CODE || "").trim();
	const statePath = settings.statePath || join(homedir(), ".dsh", "lan", "web-state.json");
	const scheduleId = String(settings.scheduleId || DEFAULTS.scheduleId);
	const pushUrl = String(settings.pushServiceUrl || DEFAULTS.pushServiceUrl);
	/** 插件产物的落盘目录（见 Config.statusDir 的说明）。 */
	const statusDir = String(settings.statusDir || "").trim() || join(homedir(), ".dsh", "lan", "token-broadcast");

	ctx.effect(() => {
		let cancelled = false;
		/** 本次运行已推卡片数：负一屏按 msgId 去重，两张卡片的 msgId 必须不同。 */
		let pushed = 0;
		/** token 尾部 8 位，只用于审计（**绝不把 token 全文写进日志或审计**）。 */
		let tokenTail = "";
		/** 最近一次尝试推送的卡片（送卡兜底重试要用它重发同一张）。 */
		let lastCard = { content: "", tag: "" };
		/** 卡片是否已经成功送达（送达后兜底循环就不用跑了）。 */
		let cardDelivered = false;

		/**
		 * 推卡审计：每推一张（含失败与重试）追加一行 JSON 到 cards.jsonl。
		 *
		 * 为什么需要：dsh 自己的插件日志在 web profile 里**不落盘**（隐藏窗口，看不到），
		 * 于是"卡片到底推出去没有、推的是哪一张"事后无从查证，重启自检也没东西可断言。
		 * 这里只记元信息（tag / 结果 / msgId / token 尾部 8 位）。
		 *
		 * 注意：它必须定义在 pushCard **之前**的同一个作用域里 —— 2026-09-30 把它写在
		 * 下面的异步 IIFE 里，pushCard 就看不到它（ReferenceError: auditCard is not defined）。
		 */
		const auditCard = (record) => {
			try {
				mkdirSync(statusDir, { recursive: true });
				const file = join(statusDir, "cards.jsonl");
				if (existsSync(file) && statSync(file).size > 262144) {
					const kept = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-200).join("\n");
					writeFileSync(file, `${kept}\n`, "utf8");
				}
				appendFileSync(file, `${JSON.stringify({
					at: new Date().toISOString(),
					scheduleTaskName: CARD_NAME,
					tokenTail,
					...record
				})}\n`, "utf8");
			} catch (error) {
				ctx.logger?.warn?.("[token-broadcast] 写 cards.jsonl 失败：%s", error?.message ?? String(error));
			}
		};

		/**
		 * 推一张卡片（失败按 pushAttempts 重试）；tag 只进日志，用于区分"首次"与"tailnet 连上后补推"。
		 * escalate=true 时（送卡兜底那一段）会启用最后一级：**换个独立进程发**
		 * —— 见 lib/push-once.mjs 顶部说明（插件进程内怎么发都 404，新进程一发就 200）。
		 */
		const pushCard = async (content, tag, { escalate = false } = {}) => {
			if (!authCode) {
				ctx.logger?.warn?.("[token-broadcast] 未配置 authCode，跳过负一屏推送");
				return undefined;
			}
			pushed += 1;
			const sec = Math.floor(Date.now() / 1000);
			const payload = {
				data: {
					authCode,
					msgContent: [
						{
							msgId: `dsh_token_${sec}_${pushed}`,
							scheduleTaskId: scheduleId,
							scheduleTaskName: CARD_NAME,
							summary: CARD_NAME,
							result: "已更新",
							content,
							source: "OpenClaw",
							taskFinishTime: sec
						}
					]
				}
			};
			// 端点会进入"坏窗口"（见 Config.pushAttempts 的说明），所以这里必须重试：
			// 卡片丢了用户就没有地址和 token，比多花几十秒严重得多。
			// 间隔按 基数 × 2^(n-1) 递增、封顶 60 秒，这样少数几次尝试就能跨过
			// 几十秒量级的坏窗口，而不会在坏窗口里把 3 次机会在 9 秒内全打光。
			lastCard = { content, tag };
			const maxAttempts = Math.max(1, Number(settings.pushAttempts) || DEFAULTS.pushAttempts);
			const baseDelay = Math.max(500, Number(settings.pushRetryMs) || DEFAULTS.pushRetryMs);
			let result;
			for (let attempt = 1; attempt <= maxAttempts && !cancelled; attempt += 1) {
				// **第一优先：独立进程投递**（2026-09-30 实测数据决定的顺序）。
				// 今天 134 条审计里，dsh 进程内的 fetch/https.request 对华为端点
				// **107 次尝试 0 成功**（全是 404 server: elb），而"换个新进程发同一份
				// payload"每次都 200（看门狗补发 5/5、人工补发 6/6）。
				// 所以主路直接走 helper，进程内那两条降级为后备 —— 否则每次启动都要
				// 先白等 90 秒兜底窗口，用户手机上才出现卡片。
				let matched = false;
				const viaHelperFirst = await pushViaHelper(pushUrl, payload);
				if (viaHelperFirst.ok && /"code"\s*:\s*"(0{10}|0)"/.test(viaHelperFirst.body)) {
					result = { ...viaHelperFirst, transport: "helper-process" };
					matched = true;
				} else {
					result = await pushOnce(pushUrl, payload);
					matched = /"code"\s*:\s*"(0{10}|0)"/.test(result.body);
					result = { ...result, helperBody: viaHelperFirst.body.slice(0, 120) };
				}
				// 升级一步：默认解析失败时，把连接**逐个钉到该域名的各个地址**再试。
				// 依据见 resolveAddresses 的注释（同进程同分钟里，"钉住地址"的请求 200、
				// 走默认解析的连续 404）。
				if ((!result.ok || !matched) && !cancelled) {
					const host = (() => { try { return new URL(pushUrl).hostname; } catch { return ""; } })();
					for (const address of await resolveAddresses(host)) {
						if (cancelled) break;
						const pinned = await postJson(pushUrl, payload, false, address);
						if (pinned.ok && /"code"\s*:\s*"(0{10}|0)"/.test(pinned.body)) {
							result = { ...pinned, transport: `https.request@pinned:${address}` };
							matched = true;
							break;
						}
						result = { ...result, pinnedTried: `${result.pinnedTried ? `${result.pinnedTried},` : ""}${address}:${pinned.status}` };
					}
				}
				// escalate 保留原语义（兜底阶段再补一次 helper），现在它几乎不会用到，
				// 因为 helper 已经是第一优先。
				if (escalate && (!result.ok || !matched) && !cancelled) {
					const viaHelper = await pushViaHelper(pushUrl, payload);
					if (viaHelper.ok && /"code"\s*:\s*"(0{10}|0)"/.test(viaHelper.body)) {
						result = { ...viaHelper, transport: "helper-process" };
						matched = true;
					} else {
						result = { ...result, helperBody: viaHelper.body.slice(0, 120) };
					}
				}
				if (result.ok && matched) {
					cardDelivered = true;
					ctx.logger?.info?.("[token-broadcast] 卡片已推送到负一屏（%s%s，传输 %s）",
						tag, attempt > 1 ? `，第 ${attempt} 次尝试` : "", result.transport ?? "?");
					auditCard({
						tag, ok: true, attempt, status: result.status, transport: result.transport ?? "",
						msgId: payload.data.msgContent[0].msgId,
						contentBytes: Buffer.byteLength(content, "utf8"),
						// 文案指纹：重启自检靠它证明"推出去的确实是新文案"，
						// 而不是只看"推成功了"（成功了也可能推的是旧文案）。
						head: content.split("\n")[0],
						section: (content.match(/^## .+$/m) ?? [""])[0],
						legacyWording: content.includes("顺序固定")
					});
					return result;
				}
				ctx.logger?.warn?.("[token-broadcast] 推送失败（%s，第 %d/%d 次，HTTP %s，server=%s，传输 %s）：%s",
					tag, attempt, maxAttempts, result.status, result.headers?.server ?? "-", result.transport ?? "?", result.body);
				// 把 helper 那条腿的失败原因也落进审计：2026-09-30 就是因为没记它，
				// 才分不清"helper 也失败了"和"helper 根本没跑起来"。
				if (result.helperBody) ctx.logger?.warn?.("[token-broadcast] 其中独立进程那一路：%s", result.helperBody);
				auditCard({
					tag, ok: false, attempt, status: result.status, server: result.headers?.server ?? "",
					transport: result.transport ?? "", pinnedTried: result.pinnedTried ?? "",
					helperBody: (result.helperBody ?? "").slice(0, 160),
					msgId: payload.data.msgContent[0].msgId, body: result.body.slice(0, 120)
				});
				if (attempt < maxAttempts) await sleep(Math.min(60000, baseDelay * 2 ** (attempt - 1)));
			}
			return result;
		};

		// 2026-10-02 事故教训：这里原来写的是 `(async () => { ... })();` —— 一个**无人接管的
		// promise**。IIFE 里第一轮循环同步访问了未注入的服务属性而抛错，抛错变成
		// unhandled rejection，dsh 把它当成致命错误 → `dsh web` 直接起不来
		// （"fatal load failure: cannot get property \"connection\" without inject"）。
		// 现在：整段启动流程包成具名 async 函数，**显式 catch 并只记日志**，
		// 任何异常都不可能再冒到 cordis / dsh 的启动路径上。
		const startup = async () => {
			// 0) **自己抓本次启动的 token 并落盘**（2026-09-30 用户要求的核心修复）。
			//
			// 为什么必须由插件来做：dsh 的会话 token 只在启动时打印一次到 stdout，
			// **不落盘**；过去只有启动器（dsh-start.ps1）会把它抄进 web-state.json。
			// 于是"用 `dsh web` 直接启动"（桌面 dsh.bat 就是这句）时，token 谁都不知道：
			// 卡片推不出去、两个网关拿不到 token、局域网地址一打开就是"要求重新认证"。
			//
			// 现在：cordis 的 connection 服务把 launchToken 作为**公开字段**暴露
			// （dsh-client-connection 的 `launchToken;`），插件在进程内直接读它并写
			// web-state.json —— 于是**无论用什么方式启动 dsh，配套组件都能拿到 token**。
			await captureLaunchToken(ctx, statePath, settings.waitMs);
			if (cancelled) return;

			// 1) 等**本次运行**的 token（旧文件里的陈旧 token 不算数）。
			//    上面那步通常已经写好了；没写成（老版本没有该字段）就退回等启动器。
			const deadline = Date.now() + Math.max(5000, Number(settings.waitMs) || 120000);
			let state;
			let sawStale = false;
			while (!cancelled && Date.now() < deadline) {
				const candidate = readState(statePath);
				if (candidate && isFresh(candidate)) {
					state = candidate;
					break;
				}
				if (candidate) sawStale = true;
				await sleep(Math.max(200, Number(settings.pollMs) || 1000));
			}
			if (cancelled) return;
			if (!state) {
				ctx.logger?.warn?.(
					"[token-broadcast] 等不到本次运行的 token（%s%s），本次不推送",
					statePath,
					sawStale ? "；文件里只有上一次运行的旧 token" : " 里没有"
				);
				// 2026-10-02：拿不到 token 是"三个远程入口全废"的根因，不能只写进看不见的
				// 日志里。这里直接推一张**不含 token 的告警卡片**（内容不需要 token），
				// 明确告诉用户发生了什么、以及怎么恢复。
				const staleTail = sawStale ? readState(statePath)?.token?.slice(-8) ?? "" : "";
				await pushCard([
					"# ⚠️ 本次启动没能拿到 dsh token",
					"",
					"这张卡片**不含地址与 token**，因为它没拿到 —— 三个远程入口此刻都不可用。",
					"",
					"## 发生了什么",
					"",
					`- 插件读到的 ${statePath} ${sawStale ? `里只有**上一次运行**的旧 token（尾 \`${staleTail || "?"}\`）` : "里没有 token"}；`,
					"- 也就是说：**本次 dsh 启动的 token 谁都不知道**（它只在启动时打印一次，不落盘）。",
					"",
					"## 怎么恢复（任选其一）",
					"",
					"1. 用桌面 **`dsh-hiboard.cmd`**（或 `dsh.bat`）重新启动 dsh —— 启动器会抄下 token 并重新推卡片；",
					"2. 或者保留当前 dsh，稍后由 8443 看门狗/下次启动自动补推。",
					"",
					"> 本卡片由 token-broadcast 插件在「抓不到 token」时主动发出，用于把静默失败变成可见告警。"
				].join("\n"), "⚠️ 抓不到 token 的告警");
				auditCapture(statePath, { ok: false, note: "推了「抓不到 token」告警卡片" });
				return;
			}
			const token = state.token;
			tokenTail = token.slice(-8);
			ctx.logger?.info?.("[token-broadcast] 已取到本次 token（%d 字符）", token.length);

			// 2) 这些值**必须在最外层作用域算好**：
			// 推卡片（最多两次）与写注册状态都要用它们。
			// 2026-09-27 的 bug 就是把它们声明在了 `else {}` 块里，
			// 导致后面 writeStatus 引用 gatewayHost 时抛 ReferenceError，
			// 又被那个"安静吞掉"的 catch 吃掉 —— 结果 register-status.json 永远不生成，
			// 排查了半天。教训：跨步骤共用的值放外层；catch 里别只写注释。
			const registerUrl = String(settings.registerUrl || "");
			const gatewayHost =
				String(settings.gatewayHost || "").trim() || gatewayHostFrom(registerUrl) || "<网关未配置>";
			const lanIp = String(settings.lanIp || "").trim() || detectLanIp();
			const lanPort = Number(settings.lanPort) > 0 ? Number(settings.lanPort) : 3081;
			const tailnetGatewayPort = Number(settings.tailnetGatewayPort) > 0 ? Number(settings.tailnetGatewayPort) : 8443;
			const localGatewayPort = Number(settings.registerLocalGatewayPort) > 0 ? Number(settings.registerLocalGatewayPort) : 8443;
			const keyPath = String(settings.registerKeyPath || "");
			/** 配置里写死了就用写死的；否则每次重新探测（地址会变）。 */
			const fixedTailnetIp = String(settings.tailnetIp || "").trim();
			const detectTailnet = () => fixedTailnetIp || tailnetProbe();

			/** 本机免 token 网关的注册地址（没有 tailnet 地址时是空串）。 */
			const localRegisterUrlFor = (ip) => (ip ? `https://${ip}:${localGatewayPort}/__gw_register` : "");

			/** 注册状态落盘（verify-gateway.mjs 会读它）。 */
			const writeStatus = (record) => {
				try {
					mkdirSync(statusDir, { recursive: true });
					const failed = (record.targets ?? []).find((item) => !item.ok);
					writeFileSync(join(statusDir, "register-status.json"), JSON.stringify({
						at: new Date().toISOString(),
						tokenTail: token.slice(-8),
						gatewayHost,
						// 顶层 status/body 是 verify-gateway.mjs 用来打印失败原因的字段，
						// 取第一个失败目标的响应（全都成功时留空）。
						status: failed?.status,
						body: failed?.body,
						...record
					}, null, 2), "utf8");
				} catch (error) {
					// 不要在这里只写一句"不影响主流程"就完事：上面那次 ReferenceError
					// 就是这样被吞掉、查了半天的。失败必须留痕。
					ctx.logger?.warn?.("[token-broadcast] 写 register-status.json 失败：%s", error?.message ?? String(error));
				}
			};

			/**
			 * 拼卡片正文。三段入口的顺序是用户定的：局域网 → 阿里云 → Tailscale；
			 * **已经是免 token 的入口只推短地址**，不再把 token 拼进 URL。
			 * notes 追加到页脚引用块，补推卡片用它说明"这张是后推的、以它为准"。
			 */
			const cardContent = ({ tailnetIp, notes }) => {
				const lanLine = lanIp
					? `1. **局域网**：\`http://${lanIp}:${lanPort}/?token=${token}\``
					: `1. **局域网**：本机当前无局域网 IPv4 地址`;
				// 阿里云网关持有 dsh 会话，只输密码 → 推短地址，不写 token
				const gatewayLine = gatewayHost.startsWith("<")
					? `2. **阿里云**：未配置（registerUrl / gatewayHost 都为空）`
					: `2. **阿里云**：\`https://${gatewayHost}/\`（免 token，输密码即可）`;
				// Tailscale 侧同样优先免 token 的本机网关；没有 tailnet 地址时如实写"未连上"，
				// 并告诉用户会补推——不要瞎写地址，也不要让人以为这张就是最终结果。
				const tailnetLine = tailnetIp
					? `3. **Tailscale**：\`https://${tailnetIp}:${tailnetGatewayPort}/\`（免 token，输密码即可）`
					: `3. **Tailscale**：未连上 tailnet（Tailscale 随 dsh 同步启动，连上后会自动补推一张卡片）`;
				return [
					CARD_TITLE,
					"",
					`\`${token}\``,
					"",
					CARD_ENTRY_HEADING,
					"",
					lanLine,
					gatewayLine,
					tailnetLine,
					"",
					"> 局域网入口需要 token（上面的值）；阿里云与 Tailscale 两个网关都持有 dsh 会话，只输密码。",
					"> token 每次重启 dsh 都会更换，本卡片自动更新。",
					`> 本机地址：局域网 \`${lanIp || "未探测到"}\` ｜ tailnet \`${tailnetIp || "未连接"}\``,
					// 卡片自证"我是哪一次启动的"：手机上可能同时躺着好几张卡片（今天重启了多次），
					// 点错卡片就会看到 "authentication required" —— 因为那是上一轮的 token。
					`> 本卡片生成于 ${new Date().toLocaleString("zh-CN", { hour12: false })}，对应本次启动（token 尾 \`${token.slice(-6)}\`）。`,
					...(notes ?? []).map((line) => `> ${line}`)
				].join("\n");
			};

			/** 网关注册：逐个目标有限重试，返回每个目标的结果（网关把 token 存内存，漏注册远程端就连不上）。 */
			const registerToGateways = async (targets, key) => {
				const maxAttempts = Math.max(1, Number(settings.registerAttempts) || 3);
				const results = [];
				for (const target of targets) {
					let registered = false;
					let last = { status: 0, body: "" };
					for (let attempt = 1; attempt <= maxAttempts && !cancelled; attempt += 1) {
						last = await postJson(target, { token, key }, settings.registerInsecure === true);
						if (last.ok && /"ok"\s*:\s*true/.test(last.body)) {
							registered = true;
							ctx.logger?.info?.("[token-broadcast] 已把 token 注册给网关 %s（第 %d 次尝试，浏览器免粘贴）", target, attempt);
							break;
						}
						ctx.logger?.warn?.("[token-broadcast] 网关注册失败 %s（第 %d/%d 次，HTTP %s）：%s",
							target, attempt, maxAttempts, last.status, last.body);
						if (attempt < maxAttempts) await sleep(Math.max(500, Number(settings.registerRetryMs) || 5000));
					}
					if (!registered) {
						ctx.logger?.warn?.("[token-broadcast] ❌ 网关 %s 注册最终失败——该入口会显示“网关尚未收到本次启动的 token”；" +
							"可执行 node E:\\DSH\\dsh-tunnel\\verify-gateway.mjs 复查并补注册", target);
					}
					results.push({ url: target, ok: registered, status: last.status, body: last.body.slice(0, 200) });
				}
				return results;
			};

			/** 等本机 tailnet 网关开始监听（监督脚本每 30 秒才查一次端口，所以必须等）。 */
			const waitForLocalGateway = async (ip, port) => {
				const budget = Math.max(0, Number(settings.gatewayWaitMs) || DEFAULTS.gatewayWaitMs);
				const stop = Date.now() + budget;
				for (;;) {
					if (await probeLocalGateway(ip, port)) return true;
					if (cancelled || Date.now() >= stop) return false;
					await sleep(3000);
				}
			};

			// 3) 读注册密钥，**先把 token 注册给网关**，再推卡片。
			// 顺序是 2026-09-30 有意调换的：推卡端点会进"坏窗口"（见 pushAttempts 的说明），
			// 重试可能拖上一两分钟；而网关注册是**远程入口能不能用**的前提，不能被推卡的
			// 坏运气拖住。这一步比"推卡片"更关键：网关把 token 存在**进程内存**里，
			// 只要没收到注册，远程端登录时会一直显示"网关尚未收到本次启动的 token"。
			// 2026-09-27 就发生过：dsh 卡死后手工重启，卡片推到了、注册没成，
			// 远程端彻底连不上，只能人工排查。所以：重试 + 结果落盘，失败不静默。
			let tailnetIp = detectTailnet();
			if (!lanIp) ctx.logger?.warn?.("[token-broadcast] 探测不到 LAN IP，卡片将省略局域网地址");
			let key = "";
			let registerReason = "";
			if (!keyPath || !existsSync(keyPath)) {
				registerReason = "not-configured";
				ctx.logger?.warn?.("[token-broadcast] 未配置网关注册（registerKeyPath=%s），远程端需要手工粘贴 token", keyPath || "空");
			} else {
				try {
					key = readFileSync(keyPath, "utf8").trim();
				} catch (error) {
					registerReason = "key-unreadable";
					ctx.logger?.warn?.("[token-broadcast] 读不到注册密钥 %s：%s", keyPath, error?.message ?? String(error));
				}
				if (!key && !registerReason) registerReason = "key-empty";
			}
			let registrations = [];
			if (key) {
				// 注册目标 = registerUrl + registerUrls + 本机 tailnet 网关。
				// 本机网关地址**动态推导**、不写死：Path B（自建 Headscale）切换后 tailnet 地址会变，
				// 写死旧地址会让本地网关永远收不到 token。
				const targets = [...new Set(
					[registerUrl, ...(Array.isArray(settings.registerUrls) ? settings.registerUrls : []), localRegisterUrlFor(tailnetIp)]
						.map((value) => String(value || "").trim())
						.filter(Boolean)
				)];
				if (targets.length === 0) {
					registerReason = "no-targets";
					ctx.logger?.warn?.("[token-broadcast] 本次没有可注册的网关目标（tailnet 未连接 → 本机网关地址未知），等 tailnet 连上后补注册");
				}
				registrations = await registerToGateways(targets, key);
				writeStatus({
					ok: registrations.length > 0 && registrations.every((item) => item.ok),
					reason: registrations.length === 0 ? registerReason : "",
					targets: registrations
				});
			} else {
				writeStatus({ ok: false, reason: registerReason, targets: [] });
			}
			if (cancelled) return;

			// 4) **第一张卡片：不延迟、不等 tailnet**。
			// 用户 2026-09-30 明确允许"初次启动先推一次 tailnet 未连接"：局域网入口带 token，
			// 越早推到手机上越好；tailnet 那一路等连上以后再补一张（第 5 步）。
			if (!tailnetIp) ctx.logger?.warn?.("[token-broadcast] 探测不到 tailnet 地址（Tailscale 随 dsh 同步启动，通常稍后才连上），先推一张「未连接」卡片");
			await pushCard(cardContent({ tailnetIp }), `首次推送（tailnet ${tailnetIp || "未连接"}）`);
			if (cancelled) return;

			/**
			 * 5) 盯 tailnet（用户 2026-09-30 要求）：启动时没连上 → 继续探测；连上后
			 * **补推一张已连接的卡片**，并把 token 补注册给本机 8443 网关（第 3 步那次
			 * 注册目标里没有它）。包成函数是为了让下面第 6 步的"送卡兜底"无论如何都能跑到
			 * —— 之前这些分支各自 `return`，兜底会被跳过。
			 */
			const runTailnetFollowUp = async () => {
				// 5a) 第一张卡片里已经有 tailnet 地址 = 启动瞬间就连上了。
				//     但"连上 tailnet"不等于"入口能用"：本机 8443 得真有网关进程在监听。
				//     第一张卡片是抢时间推的（没等网关），所以这里补一次核对：
				//     网关在服务 → 卡片没错，什么都不做；网关一直没起来 → 补推一张更正卡片，
				//     别让用户拿着"免 token，输密码即可"去点一个打不开的地址。
				if (tailnetIp) {
					if (await waitForLocalGateway(tailnetIp, tailnetGatewayPort)) {
						ctx.logger?.info?.("[token-broadcast] tailnet %s 的本机网关已在服务，卡片无需更正", tailnetIp);
						return;
					}
					if (cancelled) return;
					ctx.logger?.warn?.("[token-broadcast] tailnet %s 已连上，但本机 %s 网关未就绪，补推一张更正卡片", tailnetIp, tailnetGatewayPort);
					await pushCard(cardContent({
						tailnetIp,
						notes: [`⚠️ 本机 ${tailnetGatewayPort} 免 token 网关**当前没有在服务**（监督脚本 Start-LocalGateway.ps1 每 30 秒自动重试）；在此之前 Tailscale 入口点开会失败，可先用局域网或阿里云入口。`]
					}), `本机网关未就绪更正（${tailnetIp}）`);
					return;
				}

				const watchMs = Math.max(0, Number(settings.tailnetWaitMs) || DEFAULTS.tailnetWaitMs);
				const pollMs = Math.max(500, Number(settings.tailnetPollMs) || DEFAULTS.tailnetPollMs);
				const watchStop = Date.now() + watchMs;
				ctx.logger?.info?.("[token-broadcast] tailnet 未连接：盯 %s 秒（每 %s 毫秒探测一次），连上后补推卡片",
					Math.round(watchMs / 1000), pollMs);
				while (!cancelled && !tailnetIp && Date.now() < watchStop) {
					await sleep(pollMs);
					tailnetIp = detectTailnet();
				}
				if (cancelled) return;
				if (!tailnetIp) {
					ctx.logger?.warn?.("[token-broadcast] 等了 %s 秒仍未连上 tailnet（Tailscale 未登录/被关闭？），保留第一张卡片，不再补推",
						Math.round(watchMs / 1000));
					return;
				}
				ctx.logger?.info?.("[token-broadcast] tailnet 已连上（%s）：补注册本机网关 + 补推卡片", tailnetIp);
				const gatewayReady = await waitForLocalGateway(tailnetIp, tailnetGatewayPort);
				if (cancelled) return;
				let lateRegistrations = [];
				if (key) {
					const localUrl = localRegisterUrlFor(tailnetIp);
					if (localUrl) lateRegistrations = await registerToGateways([localUrl], key);
				}
				if (cancelled) return;
				const notes = [`✅ Tailscale 已连上 tailnet（\`${tailnetIp}\`）—— 这是**连上之后自动补推**的卡片，入口以此为准。`];
				if (!gatewayReady) {
					notes.push(`⚠️ 本机 ${tailnetGatewayPort} 免 token 网关还没确认就绪（监督脚本每 30 秒自动重试，稍后可用）。`);
				}
				await pushCard(cardContent({ tailnetIp, notes }), `tailnet 连上后补推（${tailnetIp}）`);
				if (cancelled) return;
				const allTargets = [...registrations, ...lateRegistrations];
				writeStatus({
					ok: allTargets.length > 0 && allTargets.every((item) => item.ok),
					reason: allTargets.length === 0 ? registerReason || "no-targets" : "",
					targets: allTargets,
					tailnet: {
						ip: tailnetIp,
						gatewayReady,
						register: lateRegistrations.map((item) => ({ url: item.url, ok: item.ok }))
					}
				});
			};
			if (settings.tailnetWatch === false) {
				ctx.logger?.info?.("[token-broadcast] tailnetWatch=false，不盯 tailnet、不补推");
			} else {
				await runTailnetFollowUp();
			}
			if (cancelled) return;

			// 6) 送卡兜底：端点进坏窗口时上面那几次尝试可能全打光，而**卡片到达用户手机**
			//    才是这一切的目的。所以只要还没成功送达，就每分钟用最后一张卡片的内容再试，
			//    直到 cardRetryMinutes 上限（默认 15 分钟）。每次尝试都会进 cards.jsonl 审计。
			if (!cardDelivered && lastCard.content) {
				const guardMinutes = Math.max(0, Number(settings.cardRetryMinutes) || DEFAULTS.cardRetryMinutes);
				const guardMs = Math.max(500, Number(settings.cardRetryMs) || DEFAULTS.cardRetryMs);
				const guardStop = Date.now() + guardMinutes * 60000;
				ctx.logger?.warn?.("[token-broadcast] 卡片还没送达，进入兜底重试（最多 %s 分钟，每 %s 毫秒一次）", guardMinutes, guardMs);
				while (!cancelled && !cardDelivered && Date.now() < guardStop) {
					await sleep(guardMs);
					if (cancelled || cardDelivered) break;
					// 兜底阶段启用最后一级：换独立进程发（见 pushViaHelper 的说明）。
					await pushCard(lastCard.content, `${lastCard.tag}·兜底重试`, { escalate: true });
				}
				if (!cardDelivered) {
					ctx.logger?.warn?.("[token-broadcast] ❌ 卡片在 %s 分钟内始终没送达（端点一直坏？见 cards.jsonl）", guardMinutes);
				}
			}
		};
		// 显式捕获：本插件的任何异常都**不允许**影响 dsh 启动（2026-10-02 的教训）。
		startup().catch((error) => {
			try {
				ctx.logger?.warn?.("[token-broadcast] 启动流程抛错（已兜住，不影响 dsh 启动）：%s", error?.stack ?? String(error));
			} catch {
				// 连日志都失败也不能再抛
			}
		});
		return () => {
			cancelled = true;
		};
	}, "token-broadcast: push token card on startup");
}
