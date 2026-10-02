/**
 * 启动安全测试：证明本插件的 apply() **在任何情况下都不会打崩 dsh**。
 *
 * 为什么必须有它（2026-10-02 事故）：
 *   `dsh-token-broadcast` 在 apply 的同步头里访问了**未注入**的服务属性 `ctx.connection`。
 *   cordis 4 对未注入服务的属性访问不是返回 undefined，而是**直接抛错**：
 *     cannot get property "connection" without inject
 *   抛错变成 unhandled rejection → dsh 判定为致命加载失败 →
 *   `dsh web` 一句 "fatal load failure" 直接起不来（用户那天只能靠别的工具救回来）。
 *
 * 本测试用 **Proxy 造一个"恶意 ctx"**：任何服务属性访问都抛错、get() 永远返回 undefined、
 * inject() 什么都不给。真实 cordis 的两种失败姿态都被模拟到了：
 *   ① 属性访问抛错（触发 2026-10-02 那次崩溃）
 *   ② 服务永远拿不到（inject 回调不触发）
 * 要求：apply 不抛错、不产生 unhandledRejection（两者都会让 dsh 起不来）。
 *
 * 运行：node E:\DSH\dsh-token-broadcast\tests\hostile-ctx.test.mjs
 */

import { register } from "node:module";
import { existsSync } from "node:fs";

// 默认路径**不要写死用户名**（2026-10-02：这份测试会随仓库发布，
// 硬编码用户目录等于把本机用户名带出去）。用 APPDATA 推导；
// 推导不到的机器上用 DSH_SCHEMASTERY_PATH 显式指定，两者都没有就跳过。
const APPDATA = process.env.APPDATA ?? "";
const SCHEMASTERY = process.env.DSH_SCHEMASTERY_PATH
	|| (APPDATA ? `${APPDATA}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\schemastery\\lib\\index.mjs` : "");
if (!SCHEMASTERY || !existsSync(SCHEMASTERY)) {
	console.log("找不到真实 schemastery（可用 DSH_SCHEMASTERY_PATH 指定），跳过");
	process.exit(0);
}
const LOADER = `const REAL = ${JSON.stringify(new URL(`file:///${SCHEMASTERY.replace(/\\/g, "/")}`).href)};
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@deepseek-ai/schemastery") return { url: REAL, shortCircuit: true, format: "module" };
	return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(LOADER)}`, import.meta.url);

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `（${detail}）` : ""}`);
	if (!ok) failures += 1;
};

const rejections = [];
process.on("unhandledRejection", (error) => rejections.push(error?.message ?? String(error)));

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
check("模块导出 name/apply", typeof plugin.apply === "function" && Boolean(plugin.name));

/** 恶意 ctx：服务属性访问抛错（cordis 4 的真实行为），get() 永远 undefined，inject() 不给服务。 */
function hostileCtx() {
	return new Proxy({}, {
		get(_target, prop) {
			if (prop === "logger") return { info() {}, warn() {}, error() {} };
			if (prop === "effect") return (fn) => fn();
			if (prop === "get") return () => undefined;
			if (prop === "inject") return () => {};
			if (prop === "on" || prop === "emit") return () => {};
			if (prop === "then") return undefined; // 别让 Proxy 被当成 thenable
			throw new Error(`cannot get property "${String(prop)}" without inject`);
		}
	});
}

let syncThrow = "";
try {
	plugin.apply(hostileCtx(), { authCode: "", waitMs: 1200, pushServiceUrl: "http://127.0.0.1:1/none" });
} catch (error) {
	syncThrow = error?.message ?? String(error);
}
check("apply 在恶意 ctx 下**没有同步抛错**", syncThrow === "", syncThrow || "0 throw");

// 等一段时间：插件内部的 async 流程（含 token 抓取超时路径）必须自己吞掉异常
await new Promise((resolve) => setTimeout(resolve, 4000));
check("没有逃逸的 unhandledRejection", rejections.length === 0, rejections.join(" | ") || "0 个");

// 正常的（宽松）ctx 也要能跑：拿不到服务时应优雅退化，而不是抛错
const lenient = {
	logger: { info() {}, warn() {} },
	effect(fn) { return fn(); },
	get: () => undefined,
	inject: () => {}
};
let normalThrow = "";
try {
	plugin.apply(lenient, { authCode: "", waitMs: 800, pushServiceUrl: "http://127.0.0.1:1/none" });
} catch (error) {
	normalThrow = error?.message ?? String(error);
}
await new Promise((resolve) => setTimeout(resolve, 2500));
check("普通 ctx（无服务可用）下也不抛错", normalThrow === "" && rejections.length === 0, normalThrow || "ok");

console.log(failures === 0 ? "\n启动安全测试：全部通过 ✅" : `\n启动安全测试：失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
