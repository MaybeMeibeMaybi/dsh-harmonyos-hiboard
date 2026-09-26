/**
 * dsh-token-broadcast - dsh 每次启动时，把会话 token 推到手机负一屏。
 *
 * 为什么需要它：dsh 的会话 token 只在启动时打印一次到 stdout，不落盘；
 * 而用户经常需要在手机上粘贴它（HTTPS 网关联署会话时）。手工去日志里翻很麻烦，
 * 所以做成"随 dsh 启动自动推送一张只含 token 的卡片"。
 *
 * 行为：
 *   1. 等启动器把**本次**运行的 token 写进 <用户目录>/.dsh/lan/web-state.json（最多等 120 秒）
 *   2. 用 patch 配置里的 authCode 调 HIBoard 接口推一张卡片
 *   3. 卡片**必须带非空 scheduleTaskId**，否则负一屏只显示标题、正文不渲染
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

import { readFileSync, existsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import z from "@deepseek-ai/schemastery";

export const name = "token-broadcast";

// 默认值必须写成常量并在 apply 里兜底：schemastery 的 .default() 只在通过
// Config(...) 走校验时才填值，直接 `{...Config}` 展开是拿不到的（踩过）。
const DEFAULTS = {
	scheduleId: "dsh_token_notice",
	waitMs: 120000,
	pollMs: 1000,
	registerInsecure: false,
	pushServiceUrl: "https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload"
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
	/** 可选：网关注册地址 */
	registerUrl: z.string().default(""),
	/** 可选：卡片里显示的网关主机（形如 1.2.3.4:18443）；留空则从 registerUrl 推导。 */
	gatewayHost: z.string().default(""),
	/** 可选：卡片里显示的本机局域网 IP；留空则每次启动动态探测。 */
	lanIp: z.string().default(""),
	/** 局域网入口端口（卡片里拼 http://<lanIp>:<port>/?token=...） */
	lanPort: z.number().default(3081),
	pushServiceUrl: z.string().default(DEFAULTS.pushServiceUrl)
});

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 第一个非内部 IPv4 地址，与入口代理的默认绑定保持一致（见 dsh-entry-startup）。 */
function detectLanIp() {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return "";
}

/** 从网关注册地址推导卡片里显示的网关主机（host:port），失败返回空串。 */
function gatewayHostFrom(url) {
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

/** 状态文件是否属于当前 dsh 进程：pid 一致优先，其次比对启动时间。 */
function isFresh(state) {
	if (!state) return false;
	if (state.pid && state.pid !== process.pid) return false;
	const startedMs = Date.parse(state.startedAt);
	if (!Number.isFinite(startedMs)) return true; // 老格式没有 startedAt：pid 能对上就用
	// 进程启动时间不可能晚于状态文件写入时间；给 5 分钟容差防止时钟抖动误判。
	return startedMs >= Date.now() - 5 * 60 * 1000;
}

/** POST JSON，返回 { ok, status, body }。不抛出，交给调用方判断。
 *  insecure 仅用于我们自己的网关（自签证书）；对华为负一屏一律保持严格校验。 */
function postJson(url, payload, insecure = false) {
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
		const traceId = `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`;
		const req = httpsRequest(
			{
				hostname: target.hostname,
				port: target.port || 443,
				path: target.pathname + target.search,
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-length": String(body.length),
					"x-trace-id": traceId
				},
				timeout: 15000,
				rejectUnauthorized: !insecure
			},
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: data.slice(0, 300) }));
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

export function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config ?? {}) };
	if (settings.enabled === false) return;

	const authCode = String(settings.authCode || process.env.DSH_HIBOARD_AUTH_CODE || "").trim();
	const statePath = settings.statePath || join(homedir(), ".dsh", "lan", "web-state.json");
	const scheduleId = String(settings.scheduleId || DEFAULTS.scheduleId);
	const pushUrl = String(settings.pushServiceUrl || DEFAULTS.pushServiceUrl);

	ctx.effect(() => {
		let cancelled = false;

		(async () => {
			// 1) 等启动器写入**本次运行**的 token（旧文件里的陈旧 token 不算数）
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
				return;
			}
			const token = state.token;
			ctx.logger?.info?.("[token-broadcast] 已取到本次 token（%d 字符）", token.length);

			// 2) 推负一屏卡片（地址一律写真实 IP，不留占位符）
			if (!authCode) {
				ctx.logger?.warn?.("[token-broadcast] 未配置 authCode，跳过负一屏推送");
			} else {
				const registerUrl = String(settings.registerUrl || "");
				const gatewayHost =
					String(settings.gatewayHost || "").trim() || gatewayHostFrom(registerUrl) || "<网关未配置>";
				const lanIp = String(settings.lanIp || "").trim() || detectLanIp();
				const lanPort = Number(settings.lanPort) > 0 ? Number(settings.lanPort) : 3081;
				if (!lanIp) ctx.logger?.warn?.("[token-broadcast] 探测不到 LAN IP，卡片将省略局域网地址");

				const gatewayLine = gatewayHost.startsWith("<")
					? `- 网关：未配置（registerUrl / gatewayHost 都为空）`
					: `- 网关：\`https://${gatewayHost}/?token=${token}\``;
				const lanLine = lanIp
					? `- 局域网：\`http://${lanIp}:${lanPort}/?token=${token}\``
					: `- 局域网：本机当前无局域网 IPv4 地址`;
				const nowSec = Math.floor(Date.now() / 1000);
				const payload = {
					data: {
						authCode,
						msgContent: [
							{
								msgId: `dsh_token_${nowSec}`,
								scheduleTaskId: scheduleId,
								scheduleTaskName: "dsh 本次启动 token",
								summary: "dsh 本次启动 token",
								result: "已更新",
								content: `# dsh 会话 token\n\n\`${token}\`\n\n用于 HTTPS 网关或局域网地址（均为实测地址）：\n\n${gatewayLine}\n${lanLine}\n\n- 本机局域网 IP：\`${lanIp || "未探测到"}\`（随网络变化，本卡片每次启动自动更新）\n\n> 每次重启 dsh 都会更换 token，本卡片自动更新。`,
								source: "OpenClaw",
								taskFinishTime: nowSec
							}
						]
					}
				};
				const result = await postJson(pushUrl, payload);
				if (cancelled) return;
				const matched = /"code"\s*:\s*"(0{10}|0)"/.test(result.body);
				if (result.ok && matched) {
					ctx.logger?.info?.("[token-broadcast] token 卡片已推送到负一屏（网关 %s，局域网 %s:%s）", gatewayHost, lanIp || "-", lanPort);
				} else {
					ctx.logger?.warn?.("[token-broadcast] 推送失败（HTTP %s）：%s", result.status, result.body);
				}
			}

			// 3) 可选：把 token 注册给 HTTPS 网关（免手工粘贴）
			const keyPath = String(settings.registerKeyPath || "");
			const registerUrl = String(settings.registerUrl || "");
			if (!keyPath || !registerUrl || !existsSync(keyPath)) return;
			let key = "";
			try {
				key = readFileSync(keyPath, "utf8").trim();
			} catch {
				return;
			}
			if (!key) return;
			const result = await postJson(registerUrl, { token, key }, settings.registerInsecure === true);
			if (cancelled) return;
			if (result.ok) {
				ctx.logger?.info?.("[token-broadcast] 已把 token 注册给网关（浏览器免粘贴）");
			} else {
				ctx.logger?.warn?.("[token-broadcast] 网关注册失败（HTTP %s）：%s", result.status, result.body);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, "token-broadcast: push token card on startup");
}
