/**
 * dsh-push-guard - 负一屏推送的"保险丝"（三级兜底 + 自检 + 审计）。
 *
 * ## 为什么需要它（真实事故，2026-09-27 凌晨，连丢 3 张卡片）
 *
 * 事故形态都是**静默失败**：那一轮 `turn/end` 的 reason 是 `completed`，
 * 界面上没有任何报错，但手机上就是少一张卡片。已确认的两种写法：
 *
 *   A. 把推送写成了**纯文本**（工具从未执行）：
 *        <hiboard_push>
 *        <parameter name="content" string="true">## IPv6 直连方案：评估结论 ...</parameter>
 *        <parameter name="name">IPv6 直连方案评估：当前网络无 IPv6</parameter>
 *        </hiboard_push>
 *      （注意 `string="true"` 这种额外属性——第一版解析器就是栽在它上面）
 *
 *   B. 正文里说了"我把结果推给你"，**却根本没写调用**，也没调用工具。
 *
 *   C. 工具真的调用了，但**返回失败**（网络抖动/超时），模型没有重试。
 *
 * ## 三级兜底
 *
 *   L1 rescue （rescueEnabled）
 *      正文里出现字面量调用 → 用**同一个解析器**还原参数并代为推送。
 *   L2 promise（promiseRescueEnabled）
 *      该轮从未推送，但正文**明确承诺了推送**（推/发/送到 + 负一屏/卡片/手机…）
 *      → 用该轮最后一条实质正文代为推送，卡片名标注"自动补推"，避免张冠李戴。
 *   L3 retry  （retryEnabled）
 *      包一层 hiboard_push 的 execute：失败分类后重试（瞬时错误才重试，
 *      授权码无效/内容过长这类永久错误不重试），并把每次结果写进审计日志。
 *
 * ## 另外两件事
 *
 *   - **审计**：每次判定都写 `<状态目录>/push-guard/audit.jsonl`，
 *     并把"最后一轮是否真的推送成功"写进 `last-state.json`。
 *     这样"哪一轮没推出去"可以直接查文件，不用再靠用户发现。
 *   - **自检**：本插件会注册一个 `hiboard_push_selfcheck` 工具，
 *     用来回答"保险丝到底生效了没有、授权码对不对、接口通不通"。
 *     在它生效之前，这种事只能靠猜。
 *
 * ## 安全约束（非常重要）
 *
 * 本插件运行在 dsh 进程内，**任何未捕获异常都可能拖垮整个 dsh**
 * （这台机器上已经崩过好几次）。所以：
 *   - 每个回调整体 try/catch，永不向外抛；
 *   - 所有磁盘写入用 `safeWrite`，失败只记日志；
 *   - 审计日志有大小上限，写满就滚动截断，绝不无限增长。
 *
 * `Config` 必须是 schemastery schema（cordis 4 会调 Config["~standard"].validate）。
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "push-guard";
/** tools 用来注册自检工具；会话事件走事件总线，不需要额外服务。 */
export const inject = ["tools"];

const DEFAULTS = {
	authCode: "",
	pushServiceUrl: "https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload",
	maxContentLength: 5000,
	retryDelayMs: 2000,
	retryCount: 1,
	defaultResult: "任务已完成",
	stateDir: "",
	minPromiseLength: 120,
	auditMaxBytes: 512 * 1024
};

export const Config = z.object({
	enabled: z.boolean().default(true),
	/** L1：抢救"写成纯文本的调用"。 */
	rescueEnabled: z.boolean().default(true),
	/** L2：抢救"正文承诺了推送、但根本没调用工具"。 */
	promiseRescueEnabled: z.boolean().default(true),
	/** L3：给失败的 hiboard_push 自动重试。 */
	retryEnabled: z.boolean().default(true),
	/** 负一屏授权码；留空则尝试从环境变量 DSH_HIBOARD_AUTH_CODE 读取。 */
	authCode: z.string().default(""),
	pushServiceUrl: z.string().default(DEFAULTS.pushServiceUrl),
	maxContentLength: z.number().default(DEFAULTS.maxContentLength),
	/** 重试前等待毫秒数。 */
	retryDelayMs: z.number().default(DEFAULTS.retryDelayMs),
	/** 失败后最多重试几次（瞬时错误才重试）。 */
	retryCount: z.number().default(DEFAULTS.retryCount),
	/** 兜底卡片的结果标签默认值。 */
	defaultResult: z.string().default(DEFAULTS.defaultResult),
	/** 审计/状态文件目录；留空表示 <用户目录>/.dsh/lan/push-guard。 */
	stateDir: z.string().default(""),
	/** L2 的最低正文长度：太短的回答不补推，避免刷屏。 */
	minPromiseLength: z.number().default(DEFAULTS.minPromiseLength),
	/** 审计日志大小上限（字节），超出后截断为最近一半。 */
	auditMaxBytes: z.number().default(DEFAULTS.auditMaxBytes)
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 解析

/** 去转义并裁剪，和 dsh-hiboard-push 的 normalizeContent 保持一致。 */
function normalizeContent(content) {
	if (typeof content !== "string") return "";
	let text = content;
	if (text.includes("\\n") && !text.includes("\n")) text = text.replace(/\\n/g, "\n");
	text = text.replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	return text.trim();
}

/**
 * 从 assistant 正文里解析出"本该是一次 hiboard_push 调用"的参数。
 * 返回 undefined 表示这段文本里没有这种标记。
 *
 * 兼容三种写法：
 *   a) <hiboard_push>\n<parameter name="x" [其他属性]>v</parameter>...   ← 事故写法
 *   b) {"name":"hiboard_push","arguments":{...}}                         ← JSON 风格
 *   c) {"name":"hiboard_push","arguments":"{...}"}                       ← arguments 是字符串
 */
export function parseLiteralInvocation(text) {
	if (typeof text !== "string" || !text.includes("hiboard_push")) return undefined;

	let args;
	const json = jsonStyleArguments(text);
	if (json) {
		args = json;
	} else if (/<hiboard_push\b/i.test(text) || /<parameter\s+name=/i.test(text)) {
		args = xmlStyleArguments(text);
	} else {
		return undefined;
	}
	if (!args) return undefined;

	const name = String(args.name ?? "").trim();
	const content = normalizeContent(args.content);
	if (!name && !content) return undefined;
	if (!name || !content) return { incomplete: true, name, content };
	const scheduleId = String(args.schedule_id ?? args.scheduleId ?? "").trim();
	const result = String(args.result ?? "").trim();
	return { incomplete: false, name, content, result, scheduleId };
}

/** 形态 b/c：正文里出现了 JSON 形式的调用。 */
function jsonStyleArguments(text) {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					const parsed = JSON.parse(text.slice(start, i + 1));
					const fn = String(parsed?.name ?? parsed?.tool ?? "");
					if (fn !== "hiboard_push") return undefined;
					let raw = parsed.arguments ?? parsed.parameters ?? parsed.input;
					if (typeof raw === "string") {
						try { raw = JSON.parse(raw); } catch { return undefined; }
					}
					return raw && typeof raw === "object" ? raw : undefined;
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * 形态 a：<hiboard_push> 包着若干 <parameter name="k" ...>v</parameter>。
 *
 * 只按参数名取值，不看它属于哪一层标签——事故里的写法把 </parameter> 套错了层，
 * 严格按 XML 解析反而取不到值，所以刻意"宽松但安全"。
 *
 * 注意 `[^>]*>`：标签上**可能带别的属性**。2026-09-27 第二次事故就是栽在这：
 * 正文里写的是 `<parameter name="content" string="true">`，
 * 原来用 `\s*>` 匹配不上 → 只抓到 name、content 为空 → 整张卡片被当成"参数不全"放弃。
 */
function xmlStyleArguments(text) {
	const args = {};
	const attr = '<parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>';
	const re = new RegExp(`${attr}([\\s\\S]*?)(?=<\\/parameter>|${attr}|<\\/hiboard_push>|$)`, "gi");
	let match;
	while ((match = re.exec(text)) !== null) {
		const key = match[1];
		const value = match[2];
		if (args[key] === undefined) args[key] = value;
	}
	return Object.keys(args).length > 0 ? args : undefined;
}

// ---------------------------------------------------------------- 意图识别（L2）

/** 推送动作词。 */
const PUSH_VERB = /(推|发|送|同步|上报)/;
/** 推送目的地/载体词（"推给你"这种没有目的地词的写法另算）。 */
const PUSH_TARGET = /(负一屏|卡片|手机|助手|今天|给你|给您|到你|到您)/;

/**
 * 判断这段正文是否**明确承诺了推送**。返回 { sentence, index } 或 undefined。
 *
 * 判据刻意保守：宁可漏判（少补推一张）也不要误判（把普通聊天刷成卡片）。
 * 命中条件（满足其一）：
 *   a) 出现"推/发/送给(你)"这类**明确的推送短语**（"我把结论推给你："）；
 *   b) 出现"**推送**"这个完整词；
 *   c) 推送动作词 + 目的地词同句出现。
 * 同句含否定/疑问/条件词则不算。
 *
 * 真实样本（2026-09-27 轮 52 / 轮 54 都是这个形态）：
 *   "测试完成，结论明确。我把评估推给你："
 *   "实测完成，我把结论和**剩余验证清单**推给你："
 *
 * 注意：第一版把"动作词+目的地词"设成**必须同时满足**，结果连上面两个真实样本
 * 都判不出来（"推给你"里没有"负一屏/卡片/手机"）——所以改成"短语优先"。
 */
export function detectPushPromise(text) {
	if (typeof text !== "string" || text.length === 0) return undefined;
	const sentences = [...text.matchAll(/[^\n。！？!?；;]+/g)].map((m) => ({ sentence: m[0].trim(), index: m.index ?? 0 }));
	for (const { sentence, index } of sentences) {
		if (sentence.length === 0 || sentence.length > 60) continue; // 承诺句通常很短
		const strongPhrase = /(推|发|送)(给|到|至)/.test(sentence) || sentence.includes("推送");
		const verbPlusTarget = PUSH_VERB.test(sentence) && PUSH_TARGET.test(sentence);
		if (!strongPhrase && !verbPlusTarget) continue;
		if (/(不|没|别|无需|不必|是否|要不要|如果|若|可以|能否)/.test(sentence)) continue; // 否定/疑问/条件句不算
		if (/hiboard_push/i.test(sentence)) continue; // 已在讨论工具名，交给 L1
		return { sentence, index };
	}
	return undefined;
}

/** 从正文里猜一个卡片标题：优先取第一个 Markdown 标题，否则取首行。 */
function deriveCardName(text, turn) {
	const heading = text.match(/^#{1,3}\s+(.{2,60})$/m);
	if (heading) return heading[1].trim();
	const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length >= 4);
	const name = firstLine ? firstLine.replace(/^[*_`>\-\s]+/, "").slice(0, 40) : "";
	return name || `dsh 自动补推（第 ${turn ?? "?"} 轮）`;
}

// ---------------------------------------------------------------- 推送

/** POST JSON；不抛出，返回 { ok, status, body }。 */
function postJson(url, payload) {
	return new Promise((resolve) => {
		let target;
		try {
			target = new URL(url);
		} catch (error) {
			resolve({ ok: false, status: 0, body: `无效 URL: ${error.message}` });
			return;
		}
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		const traceId = `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`;
		// 华为负一屏是 https；http 分支用于对着本地桩做端到端自测。
		const secure = target.protocol !== "http:";
		const request = secure ? httpsRequest : httpRequest;
		const req = request(
			{
				hostname: target.hostname,
				port: target.port || (secure ? 443 : 80),
				path: target.pathname + target.search,
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-length": String(body.length),
					"user-agent": "OpenClaw-TaskPusher/2.0",
					"x-trace-id": traceId
				},
				timeout: 20000,
				rejectUnauthorized: true
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
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

function buildPayload({ authCode, name, content, result, scheduleId }) {
	const nowSec = Math.floor(Date.now() / 1000);
	return {
		data: {
			authCode,
			msgContent: [
				{
					msgId: `dsh_guard_${nowSec}_${Math.random().toString(36).slice(2, 10)}`,
					scheduleTaskId: scheduleId ?? "",
					scheduleTaskName: name,
					summary: name,
					result,
					content,
					source: "OpenClaw",
					taskFinishTime: nowSec
				}
			]
		}
	};
}

const SUCCESS_RE = /"code"\s*:\s*"(0{10}|0)"/;
/** 已知永久错误码（重试没有意义）。 */
const PERMANENT_CODES = new Set(["0000900034"]);

/** 判断一次推送结果：成功 / 可重试 / 永久失败。 */
export function classifyPush(result) {
	if (!result) return { ok: false, retryable: true, code: "", message: "无响应" };
	if (result.ok && SUCCESS_RE.test(result.body ?? "")) return { ok: true, retryable: false, code: "", message: "OK" };
	const codeMatch = /"code"\s*:\s*"([^"]+)"/.exec(result.body ?? "");
	const code = codeMatch ? codeMatch[1] : "";
	const permanent = PERMANENT_CODES.has(code) || (result.status >= 400 && result.status < 500);
	return { ok: false, retryable: !permanent, code, message: result.body ?? "" };
}

// ---------------------------------------------------------------- 审计 / 状态

function safeWrite(dir, filename, text, append = false) {
	try {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, filename);
		if (append) appendFileSync(path, text, "utf8");
		else writeFileSync(path, text, "utf8");
		return path;
	} catch {
		return undefined;
	}
}

/** 审计日志只保留最近的窗口，避免无限增长。 */
function trimAudit(dir, maxBytes) {
	try {
		const path = join(dir, "audit.jsonl");
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size <= maxBytes) return;
		const text = readFileSync(path, "utf8");
		const kept = text.slice(Math.floor(text.length / 2));
		const firstNewline = kept.indexOf("\n");
		writeFileSync(path, firstNewline >= 0 ? kept.slice(firstNewline + 1) : kept, "utf8");
	} catch {
		/* 审计失败不影响推送 */
	}
}

// ---------------------------------------------------------------- 插件

export function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config ?? {}) };
	if (settings.enabled === false) {
		ctx.logger?.info?.("[push-guard] 已禁用（enabled: false）");
		return;
	}
	const resolveAuthCode = () => String(settings.authCode || process.env.DSH_HIBOARD_AUTH_CODE || "").trim();
	const pushUrl = String(settings.pushServiceUrl || DEFAULTS.pushServiceUrl);
	const maxLen = Number(settings.maxContentLength) > 0 ? Number(settings.maxContentLength) : DEFAULTS.maxContentLength;
	const stateDir = String(settings.stateDir || "").trim() || join(homedir(), ".dsh", "lan", "push-guard");
	const auditMax = Number(settings.auditMaxBytes) > 0 ? Number(settings.auditMaxBytes) : DEFAULTS.auditMaxBytes;

	const audit = (record) => {
		try {
			safeWrite(stateDir, "audit.jsonl", `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, true);
			trimAudit(stateDir, auditMax);
		} catch {
			/* 忽略 */
		}
	};

	// 启动自检：把"保险丝到底有没有配上"写进日志和状态文件，不再靠猜
	const startup = {
		at: new Date().toISOString(),
		pid: process.pid,
		authCode: resolveAuthCode() ? "configured" : "MISSING",
		pushServiceUrl: pushUrl,
		rescueEnabled: settings.rescueEnabled !== false,
		promiseRescueEnabled: settings.promiseRescueEnabled !== false,
		retryEnabled: settings.retryEnabled !== false,
		stateDir
	};
	safeWrite(stateDir, "startup.json", JSON.stringify(startup, null, 2));
	ctx.logger?.info?.(
		"[push-guard] 启动自检：authCode=%s；L1 抢救=%s，L2 承诺兜底=%s，L3 重试=%s；状态目录=%s",
		startup.authCode, startup.rescueEnabled, startup.promiseRescueEnabled, startup.retryEnabled, stateDir
	);
	if (startup.authCode === "MISSING") {
		ctx.logger?.warn?.("[push-guard] ⚠️ 未配置 authCode，任何兜底推送都会失败（请检查 hiboard-push / push-guard 配置）");
	}

	// ---- L1 + L2：会话级抢救
	if (settings.rescueEnabled !== false || settings.promiseRescueEnabled !== false) {
		/** 每个会话当前轮的最后一条实质 assistant 正文。 */
		const pending = new Map();
		/** 每个会话**真正执行过** hiboard_push 的轮次号。 */
		const pushedTurns = new Map();
		/** 每个会话最近一次兜底推送的指纹，用于去重。 */
		const lastRescued = new Map();

		ctx.effect(() => {
			const onEvent = (session, event) => {
				try {
					if (!event || typeof event !== "object") return;
					const sessionId = session?.id ?? "?";

					if (event.type === "assistant/message") {
						const content = event.data?.message?.content;
						if (!Array.isArray(content)) return;
						const text = content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
						const realPush = content.some((b) => b?.type === "tool-call" && b.name === "hiboard_push");
						if (realPush) pushedTurns.set(sessionId, event.data?.turn);
						// 只留该轮**最后一条**含正文的消息，避免拿半截草稿当结果
						if (text.trim().length > 0) pending.set(sessionId, { turn: event.data?.turn, text });
						return;
					}

					if (event.type !== "turn/end") return;
					const current = pending.get(sessionId);
					if (!current) return;
					pending.delete(sessionId);
					const alreadyPushed = pushedTurns.get(sessionId) === current.turn;
					const text = current.text;
					const card = decideCard({
						text,
						turn: current.turn,
						alreadyPushed,
						rescueEnabled: settings.rescueEnabled !== false,
						promiseRescueEnabled: settings.promiseRescueEnabled !== false,
						minLength: Number(settings.minPromiseLength) > 0 ? Number(settings.minPromiseLength) : DEFAULTS.minPromiseLength
					});
					if (!card) {
						// 没推送也没兜底：如果这一轮"看着像该推"，记一条审计，别让它无声无息
						if (!alreadyPushed && looksLikePushTurn(text)) {
							ctx.logger?.warn?.("[push-guard] ⚠️ 本轮（会话 %s 第 %s 轮）看不出推送企图，未兜底；如需卡片请让模型显式调用", sessionId, current.turn);
							audit({ kind: "no-push", sessionId, turn: current.turn, reason: "no-intent" });
						}
						return;
					}
					const fingerprint = `${card.name}\n${card.content.length}\n${card.content.slice(0, 80)}`;
					if (lastRescued.get(sessionId) === fingerprint) return;
					lastRescued.set(sessionId, fingerprint);
					void deliver(ctx, {
						sessionId,
						turn: current.turn,
						card,
						authCode: resolveAuthCode(),
						pushUrl,
						maxLen,
						defaultResult: settings.defaultResult || DEFAULTS.defaultResult,
						stateDir,
						audit
					});
				} catch (error) {
					// 绝不向外抛：宿主稳定性优先于这张卡片
					ctx.logger?.warn?.("[push-guard] 处理会话事件出错（已忽略）：%s", error?.message ?? String(error));
				}
			};
			ctx.on("session/event", onEvent);
			return () => {
				pending.clear();
				pushedTurns.clear();
				lastRescued.clear();
			};
		}, "push-guard: rescue missed pushes (literal markup + broken promise)");
	}

	// ---- L3：失败自动重试（带错误分类）+ 审计
	if (settings.retryEnabled !== false) {
		ctx.effect(() => {
			let timer;
			let patched = false;
			const stop = () => {
				if (timer) clearInterval(timer);
				timer = undefined;
			};
			const patch = () => {
				try {
					const tool = ctx.tools?.get?.("hiboard_push");
					if (!tool || typeof tool.execute !== "function") return;
					if (tool.execute.__pushGuard) {
						patched = true;
						stop();
						return;
					}
					const original = tool.execute;
					const attempts = Math.max(0, Number(settings.retryCount) >= 0 ? Number(settings.retryCount) : DEFAULTS.retryCount);
					const wrapped = async (args, exec) => {
						let outcome = await original(args, exec);
						try {
							let verdict = classifyPush(outcome);
							let tries = 0;
							while (!verdict.ok && verdict.retryable && tries < attempts) {
								tries += 1;
								ctx.logger?.warn?.(
									"[push-guard] hiboard_push 失败（%s，可重试），%dms 后第 %d 次重试：%s",
									verdict.code || "-", settings.retryDelayMs, tries, String(verdict.message).slice(0, 120)
								);
								await sleep(Math.max(200, Number(settings.retryDelayMs) || DEFAULTS.retryDelayMs));
								const next = await original(args, exec);
								if (next && next.success) {
									audit({ kind: "retry-ok", tries, taskName: next.taskName });
									return { ...next, message: `${next.message}（首次失败 ${verdict.code || "-"}，已自动重试 ${tries} 次成功）` };
								}
								outcome = next;
								verdict = classifyPush(next);
							}
							if (!verdict.ok) {
								audit({ kind: "push-failed", code: verdict.code, retryable: verdict.retryable, tries, message: String(verdict.message).slice(0, 200) });
								ctx.logger?.warn?.("[push-guard] 推送最终失败（%s，%s）：%s",
									verdict.code || "-", verdict.retryable ? "可重试但已用尽" : "永久错误，不重试", String(verdict.message).slice(0, 160));
							} else {
								audit({ kind: "push-ok", taskName: outcome?.taskName });
							}
						} catch (error) {
							ctx.logger?.warn?.("[push-guard] 重试逻辑出错（已忽略）：%s", error?.message ?? String(error));
						}
						return outcome;
					};
					wrapped.__pushGuard = true;
					tool.execute = wrapped;
					ctx.logger?.info?.("[push-guard] 已接管 hiboard_push：失败分类 + 最多重试 %d 次", attempts);
					audit({ kind: "hook-installed", retryCount: attempts });
				} catch (error) {
					ctx.logger?.warn?.("[push-guard] 包装 hiboard_push 失败（已忽略）：%s", error?.message ?? String(error));
				}
			};
			// hiboard-push 与本插件谁先挂载不确定，且插件可能热重载 → 轮询补齐，装好即停表
			patch();
			if (!patched) {
				timer = setInterval(patch, 3000);
				timer.unref?.();
			}
			return () => stop();
		}, "push-guard: retry failed hiboard_push (classified)");
	}

	// ---- 自检工具：回答"保险丝生效了吗 / 授权码对吗 / 接口通吗"
	try {
		ctx.effect(() => {
			const off = ctx.tools.register({
				name: "hiboard_push_selfcheck",
				description:
					"Self-check the HarmonyOS assistant-today (负一屏) push path: reports whether the push-guard plugin is active, whether hiboard_push is hooked for retry, whether an authCode is configured, and probes the HIBoard endpoint. Use it when a push may have failed silently or after changing push config.",
				parameters: {},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							guardActive: { type: "boolean", required: true },
							hooked: { type: "boolean", required: true },
							authCode: { type: "string", required: true },
							endpoint: { type: "string", required: true },
							endpointReachable: { type: "boolean", required: true },
							lastState: { type: "string", required: true },
							auditTail: { type: "string", required: true }
						}
					},
					render(_args, value) {
						return [{
							type: "text",
							text: [
								`push-guard 生效: ${value.guardActive ? "✅" : "❌"}`,
								`hiboard_push 已被接管（失败重试）: ${value.hooked ? "✅" : "❌（该轮可能未挂载成功）"}`,
								`authCode: ${value.authCode}`,
								`接口可达: ${value.endpointReachable ? "✅" : "❌"}  (${value.endpoint})`,
								`最后状态: ${value.lastState}`,
								`审计尾部: ${value.auditTail}`
							].join("\n")
						}];
					}
				},
				isConcurrencySafe: () => true,
				async execute() {
					let hooked = false;
					try {
						hooked = ctx.tools?.get?.("hiboard_push")?.execute?.__pushGuard === true;
					} catch { /* ignore */ }
					// 探活：故意用无效 authCode 推一张"探针"卡片是浪费；
					// 改为只做 TCP/TLS 可达性判断（发一个必定失败但无害的请求代价太高），
					// 这里用 HEAD 到接口地址判断连通性。
					const reachable = await probeEndpoint(pushUrl);
					let lastState = "(无)";
					let auditTail = "(无)";
					try {
						const p = join(stateDir, "last-state.json");
						if (existsSync(p)) lastState = readFileSync(p, "utf8").replace(/\s+/g, " ").slice(0, 300);
					} catch { /* ignore */ }
					try {
						const p = join(stateDir, "audit.jsonl");
						if (existsSync(p)) {
							const lines = readFileSync(p, "utf8").trim().split("\n");
							auditTail = lines.slice(-3).join(" | ").slice(0, 500);
						}
					} catch { /* ignore */ }
					return {
						guardActive: true,
						hooked,
						authCode: resolveAuthCode() ? "已配置" : "未配置（推送会失败）",
						endpoint: pushUrl,
						endpointReachable: reachable,
						lastState,
						auditTail
					};
				}
			});
			return () => off();
		}, "push-guard: self-check tool");
	} catch (error) {
		ctx.logger?.warn?.("[push-guard] 注册自检工具失败（已忽略）：%s", error?.message ?? String(error));
	}
}

/** 接口可达性探测：能建立 TLS/TCP 连接即视为可达。 */
function probeEndpoint(url) {
	return new Promise((resolve) => {
		let target;
		try {
			target = new URL(url);
		} catch {
			resolve(false);
			return;
		}
		const secure = target.protocol !== "http:";
		const request = secure ? httpsRequest : httpRequest;
		const req = request(
			{ hostname: target.hostname, port: target.port || (secure ? 443 : 80), path: "/", method: "HEAD", timeout: 8000 },
			() => resolve(true)
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => { req.destroy(); resolve(false); });
		req.end();
	});
}

/**
 * 决定这一轮要不要兜底推送，以及推什么。
 * 返回 undefined 表示"不兜底"。
 *
 * 优先级：L1（还原原始参数）> L2（用本轮正文补推）。
 * 已经真正推送过的轮次，只有在 L1 能还原出**更像样的正文**时才兜底——
 * 实践中这意味着"模型先写了纯文本、后来又补了一次真调用"，此时不重复推。
 */
export function decideCard({ text, turn, alreadyPushed, rescueEnabled, promiseRescueEnabled, minLength }) {
	const body = normalizeContent(text ?? "");

	// L1：字面量调用
	if (rescueEnabled) {
		const parsed = parseLiteralInvocation(body);
		if (parsed && !parsed.incomplete) {
			if (alreadyPushed) return undefined; // 真推过就别重复
			return {
				level: "L1",
				name: parsed.name,
				content: parsed.content,
				result: parsed.result,
				scheduleId: parsed.scheduleId,
				reason: "literal-markup"
			};
		}
	}

	if (alreadyPushed) return undefined; // 这一轮真推过，收工

	// L2：承诺了推送但没调用工具
	if (promiseRescueEnabled) {
		const promise = detectPushPromise(body);
		if (promise && body.length >= minLength) {
			// 只删掉那句承诺本身（精确到该句的原文区间），别把标题一起吃掉
			const cutStart = promise.index;
			const cutEnd = promise.index + promise.sentence.length;
			let content = `${body.slice(0, cutStart)}\n${body.slice(cutEnd)}`.trim();
			content = content.replace(/<hiboard_push>[\s\S]*$/i, "").trim();
			// 去掉承诺后留下的孤立冒号/破折号行
			content = content.replace(/^[\s：:，,。.\-—…]+/, "").trim();
			if (content.length >= minLength) {
				return {
					level: "L2",
					name: deriveCardName(content, turn),
					content,
					result: "自动补推（模型未调用推送工具）",
					scheduleId: "",
					reason: `promise: ${promise.sentence}`
				};
			}
		}
	}
	return undefined;
}

/** 粗略判断"这一轮看起来像是有交付内容"（仅用于审计告警，不会推送）。 */
function looksLikePushTurn(text) {
	if (typeof text !== "string") return false;
	return text.length > 400 || /^#{1,3}\s/m.test(text) || /\|.*\|/.test(text);
}

/** 真正把兜底卡片推出去，并落审计 + 最后一轮状态。全部错误内部消化。 */
async function deliver(ctx, { sessionId, turn, card, authCode, pushUrl, maxLen, defaultResult, stateDir, audit }) {
	const stamp = () => new Date().toISOString();
	try {
		if (!authCode) {
			ctx.logger?.warn?.("[push-guard] %s 兜底失败：未配置 authCode", card.level);
			audit({ kind: "rescue-failed", level: card.level, sessionId, turn, reason: "no-authCode" });
			return;
		}
		let content = card.content;
		if (content.length > maxLen) content = `${content.slice(0, maxLen - 60)}\n\n> （内容超出 ${maxLen} 字符上限，已截断）`;
		const payload = buildPayload({
			authCode,
			name: card.name,
			content,
			result: card.result || defaultResult || DEFAULTS.defaultResult,
			scheduleId: card.scheduleId
		});
		const raw = await postJson(pushUrl, payload);
		const verdict = classifyPush(raw);
		const state = {
			at: stamp(),
			turn,
			sessionId,
			level: card.level,
			name: card.name,
			ok: verdict.ok,
			code: verdict.code,
			contentLength: content.length,
			reason: card.reason
		};
		safeWrite(stateDir, "last-state.json", JSON.stringify(state, null, 2));
		if (verdict.ok) {
			ctx.logger?.warn?.("[push-guard] ⚠️ %s 兜底推送成功（会话 %s 第 %s 轮）：%s —— 模型%s",
				card.level, sessionId, turn ?? "?", card.name,
				card.level === "L1" ? "把 hiboard_push 写成了纯文本" : "在正文里承诺了推送却没调用工具");
			audit({ kind: "rescue-ok", ...state });
		} else {
			ctx.logger?.warn?.("[push-guard] %s 兜底推送失败（HTTP %s）：%s", card.level, raw.status, String(raw.body).slice(0, 160));
			audit({ kind: "rescue-failed", ...state, body: String(raw.body).slice(0, 200) });
		}
	} catch (error) {
		ctx.logger?.warn?.("[push-guard] 兜底推送出错（已忽略）：%s", error?.message ?? String(error));
		audit({ kind: "rescue-error", level: card?.level, sessionId, turn, message: String(error?.message ?? error) });
	}
}
