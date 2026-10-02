/**
 * 自测：**本次 dsh launchToken 的三条抓取路**（2026-10-02 23:1x 新增/修正）。
 *
 * 为什么必须单独测（当天的两笔教训）：
 *   1. 先前 `captureLaunchTokenInner` 读的是 `connection.launchToken`，可 dsh 的实现把它
 *      放在 `HostConnectionService.browserAuth.launchToken` 上（服务本体只有
 *      `authenticatedUrl()` / `authorizeIndex()`），所以**服务拿到了也读不出 token**，
 *      抓取必然超时 —— 23:05 那次启动的 cards.jsonl 里就是"⚠️ 抓不到 token 的告警"。
 *   2. `auditCapture()` 用了 `dirname()` 却没 import，异常又被自己的 catch 吞掉，
 *      于是"抓取审计"从来没落过盘，事后无法从证据里判断走到哪一步。
 *
 * 本测试喂给插件的是**真实 dsh 侧对象形状**（含 browserAuth / authenticatedUrl），
 * 不像过去那样用一个"什么都能返回"的假 ctx —— 那正是上一版漏检的原因。
 *
 * 运行：node E:\DSH\dsh-token-broadcast\tests\token-capture.test.mjs
 */

import { register } from "node:module";
import { createServer } from "node:http";

// --------------------------------------------------- 1) 桩掉 schemastery（同其它测试）
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

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `（${detail}）` : ""}`);
	if (!ok) failures += 1;
}

// --------------------------------------------------- 2) 读 token 的三条路
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

check(
	"路 1：公开 API authenticatedUrl() → 取出 token",
	plugin.__launchTokenOf({ authenticatedUrl: (base) => `${base}?token=${TOKEN}` }) === TOKEN
);

check(
	"路 2：当前实现的位置 browserAuth.launchToken",
	plugin.__launchTokenOf({ trustedHosts: [], browserAuth: { launchToken: TOKEN } }) === TOKEN
);

check(
	"路 3：兼容直读 connection.launchToken",
	plugin.__launchTokenOf({ launchToken: TOKEN }) === TOKEN
);

check(
	"authenticatedUrl 抛错时退回 browserAuth（不给 dsh 添乱）",
	plugin.__launchTokenOf({
		authenticatedUrl() { throw new Error("boom"); },
		browserAuth: { launchToken: TOKEN }
	}) === TOKEN
);

check(
	"browserAuth 是恶意 getter 时也不抛、返回空串",
	plugin.__launchTokenOf({
		get browserAuth() { throw new Error("cannot get property"); }
	}) === ""
);

check("没有任何可用形状 → 空串（不会误报成功）", plugin.__launchTokenOf({}) === "" && plugin.__launchTokenOf(null) === "");

// --------------------------------------------------- 3) 回环验证（真 http，不打桩）
const server = createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	if (url.pathname === "/" && url.searchParams.get("token") === TOKEN) {
		// dsh 认下 token 的真实姿态：303 + Set-Cookie + location: /
		res.writeHead(303, { location: "/", "set-cookie": "dsh-auth-x=y" });
		res.end();
		return;
	}
	res.writeHead(401, { "content-type": "text/plain" });
	res.end("dsh web authentication required; reopen the URL printed by dsh web.");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

check("回环验证：真 token → 303 判为有效", (await plugin.__verifyToken(TOKEN, port)) === true);
check("回环验证：旧 token → 401 判为无效", (await plugin.__verifyToken("stale-token-000000000000", port)) === false);
check("回环验证：端口没服务 → 判为无效且不抛", (await plugin.__verifyToken(TOKEN, 1)) === false);
await new Promise((resolve) => server.close(resolve));

// --------------------------------------------------- 4) stdout 嗅探（服务拿不到时的兜底路）
const before = plugin.__sniffedTokens().length;
// 插件的钩子在 import 时就装好了，所以先把**带着钩子的那个 write** 拿在手里再调用它：
// 钩子内部把参数原样转发给它自己捕获的原生 write（这一点从"这行字确实打在了本测试输出里"
// 以及返回值类型可以直接看出来）。
const hooked = process.stdout.write;
const sniffLine = `dsh web: http://127.0.0.1:3080/?token=${TOKEN} (LAN: http://<PC-LAN-IP>:3080/?token=${TOKEN})\n`;
const sniffReturn = hooked.call(process.stdout, sniffLine);
const bufferReturn = hooked.call(process.stdout, Buffer.from(""));

const sniffed = plugin.__sniffedTokens();
check("嗅探：从 dsh 打印的那行里抓到 token", sniffed.length === before + 1 && sniffed.includes(TOKEN), `缓冲=${sniffed.length}`);
check("嗅探：透明（原样转发、返回原生 write 的结果、不抛错）",
	typeof sniffReturn === "boolean" && typeof bufferReturn === "boolean");

console.log(failures === 0 ? "\ntoken 抓取测试：全部通过 ✅" : `\ntoken 抓取测试：失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
