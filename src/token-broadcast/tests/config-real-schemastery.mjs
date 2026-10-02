/**
 * 用**真实** schemastery 校验插件的 `Config`。
 *
 * 为什么单独一个检查：插件在 dsh 里被加载时，cordis 会调
 * `Config["~standard"].validate(config)`；schema 写错（字段名、方法链、类型）会让
 * **dsh 启动直接失败**。另一个自测文件里的 z 是"什么都能链式调用"的 Proxy 桩，
 * 恰好测不出这类错误，所以这里必须用真实的库跑一遍。
 *
 * 真实库从 dsh 安装目录取（可用 DSH_SCHEMASTERY_PATH 覆盖）；找不到就跳过（退出码 0），
 * 不让这个检查变成环境相关的硬失败。
 *
 * 运行：node E:\DSH\dsh-token-broadcast\tests\config-real-schemastery.mjs
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// **不要写死用户名**（2026-10-02：这份测试随仓库发布，硬编码用户目录会把本机用户名带出去）。
// 用 %APPDATA% 推导；推导不到就用 DSH_SCHEMASTERY_PATH 指定；都没有就跳过。
const APPDATA = process.env.APPDATA ?? "";
const candidates = [
	process.env.DSH_SCHEMASTERY_PATH,
	APPDATA ? `${APPDATA}\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\schemastery\\lib\\index.mjs` : ""
].filter(Boolean);
const real = candidates.find((p) => existsSync(p));
if (!real) {
	console.log("找不到真实 schemastery（可用 DSH_SCHEMASTERY_PATH 指定），跳过本次检查");
	process.exit(0);
}
const url = pathToFileURL(real).href;
const LOADER = `const REAL = ${JSON.stringify(url)};
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

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
check("模块导出 name/apply/Config", plugin.name === "token-broadcast" && typeof plugin.apply === "function" && Boolean(plugin.Config));

// cordis.patch.yml 里那份真实配置（逐字抄，别加字段）
const userConfig = {
	enabled: true,
	authCode: "dummy-auth-code",
	scheduleId: "dsh_token_notice",
	registerUrl: "https://<CLOUD-IP>:18443/__gw_register",
	registerLocalGatewayPort: 8443,
	registerKeyPath: "E:\\DSH\\dsh-tunnel\\secrets\\gw-register-key.txt",
	registerInsecure: true,
	registerAttempts: 3,
	registerRetryMs: 5000
};
const result = await plugin.Config["~standard"].validate(userConfig);
const issues = result?.issues;
check("线上那份配置校验通过（无 issues）", !issues, issues ? JSON.stringify(issues) : "0 issue");
const value = result?.value ?? {};
check("新字段默认值已补齐",
	value.tailnetWatch === true && value.tailnetWaitMs === 300000 && value.tailnetPollMs === 5000 && value.gatewayWaitMs === 90000,
	`tailnetWatch=${value.tailnetWatch} wait=${value.tailnetWaitMs} poll=${value.tailnetPollMs} gwWait=${value.gatewayWaitMs}`);
check("老字段默认值未被破坏",
	value.lanPort === 3081 && value.tailnetGatewayPort === 8443 && value.waitMs === 120000 && value.registerInsecure === true,
	`lanPort=${value.lanPort} tailnetPort=${value.tailnetGatewayPort} waitMs=${value.waitMs}`);
check("用户显式值原样保留", value.scheduleId === "dsh_token_notice" && value.registerAttempts === 3);

// 反向验证：校验确实在生效（不是"什么都通过"）
const bad = await plugin.Config["~standard"].validate({ ...userConfig, tailnetWaitMs: "abc" });
check("非法类型会被拒绝（证明校验真的在跑）", Boolean(bad?.issues), JSON.stringify(bad?.issues ?? null).slice(0, 120));

console.log(failures === 0 ? "\n真实 schemastery 校验：全部通过 ✅" : `\n真实 schemastery 校验：失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
