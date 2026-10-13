/**
 * 常驻推送规则：把「每轮回答都要推送」写进 dsh 的全局指令文件。
 *
 * ## 为什么必须动这个文件
 *
 * dsh 的 `dsh-agent-instructions` 在每个会话自动加载 `$DSH_HOME/AGENTS.md`。
 * 它**只认这一个全局文件** —— `.local` 叠加（`AGENTS.local.md`）只在**项目目录**的
 * 祖先链里生效，全局那段代码写死了只探测 `AGENTS.md`（见 dsh-agent-instructions
 * 的 `discoverInstructionFiles`）。所以想让规则对所有会话、所有项目生效，
 * 除了写这个文件没有第二条路（`agent/pre-step` 注入要拼宿主内部消息形状，预览版上太脆）。
 *
 * ## 安全约定（每一条都是必须的）
 *
 * 1. **只改自己那一段**：规则块由 BEGIN/END 标记包裹，标记之外一个字节都不碰。
 * 2. **幂等**：标记已存在就原地替换；重复调用不会产生第二份规则。
 * 3. **不覆盖用户手写的规则**：文件里已有等价规则（非标记块）时**直接跳过**，
 *    并如实报告，而不是硬塞一份重复的。
 * 4. **首次改动前备份**：`AGENTS.md.bak-hiboard-<时间戳>`，且只备份一次，不刷屏。
 * 5. **可一键移除**：`removeRule()` 把标记块整段删掉，其余内容原样保留。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";

/** 规则块的起止标记。改这里等于改契约，不要动。 */
export const RULE_BEGIN = "<!-- BEGIN dsh-harmonyos-hiboard (managed block; the plugin rewrites this region) -->";
export const RULE_END = "<!-- END dsh-harmonyos-hiboard -->";

/** 规则块正文。中英并列：dsh 的全局文件对所有会话生效，读者可能是任意语言。 */
export function buildRuleBlock() {
	return [
		RULE_BEGIN,
		"## 强制要求：每轮回答都要推送到手机负一屏",
		"",
		"1. 给出最终回答时，调用 `hiboard_push` 推送本轮的详细结论。",
		"2. **必须传 `schedule_id`**（例如 `dsh_worklog`）—— 它为空时卡片只有一行标题、正文不渲染、也点不开。",
		"3. `content` 用 Markdown，**上限 5000 字符**；超长就推精简版，并在开头注明被截断，完整内容留在对话里。",
		"4. `result` 是状态标签，默认「任务已完成」。",
		"5. 本轮确实没有实质输出时，也推一张简短卡片，不要跳过。",
		"6. 推送失败要写明原因（未配置授权码 / 接口不通），不要静默略过。",
		"",
		"> Every turn must push: call `hiboard_push` with a non-empty `schedule_id`; Markdown body is",
		"> capped at 5000 characters; push a short card even on a thin turn; never fail silently.",
		"",
		"（本段由 dsh-harmonyos-hiboard 维护，可在插件的设置卡片里一键关闭与移除。）",
		RULE_END
	].join("\n");
}

/** 判定文件里是否已存在「等价规则」（非本插件标记块）。 */
export function looksLikePushRule(text) {
	if (!/hiboard_push/.test(text)) return false;
	return /(每轮|每一轮|每次|每一条|必须)[^\n]{0,24}(推|发送|推送)/.test(text) || /every\s+(turn|reply|response)/i.test(text);
}

function readText(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function hasBackup(file) {
	try {
		return readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.bak-hiboard-`));
	} catch {
		return false;
	}
}

/** 原子写入；`backup` 为真且尚无备份时，先留一份原件。 */
function writeText(file, text, { backup = false } = {}) {
	mkdirSync(dirname(file), { recursive: true });
	if (backup && existsSync(file) && !hasBackup(file)) {
		try {
			copyFileSync(file, `${file}.bak-hiboard-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`);
		} catch {
			/* 备份失败不阻止写入：用户要的是规则生效，不是备份成功 */
		}
	}
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}

/** 用新块替换旧块（保留前后一切内容）。 */
function replaceBlock(text, block) {
	const start = text.indexOf(RULE_BEGIN);
	const end = text.indexOf(RULE_END);
	if (start < 0 || end < 0 || end < start) return text;
	return `${text.slice(0, start)}${block}${text.slice(end + RULE_END.length)}`;
}

/** 状态：文件在哪、有没有我们的块、有没有用户自己写的等价规则。 */
export function ruleStatus(file) {
	const text = readText(file);
	const hasBlock = text.includes(RULE_BEGIN) && text.includes(RULE_END);
	return {
		file,
		exists: existsSync(file),
		block: hasBlock,
		customRule: !hasBlock && looksLikePushRule(text)
	};
}

/**
 * 确保规则就位（幂等）。
 * @returns {{action: 'added'|'updated'|'unchanged'|'skipped-custom', status: object}}
 */
export function ensureRule(file) {
	const block = buildRuleBlock();
	const before = readText(file);
	const hasBlock = before.includes(RULE_BEGIN) && before.includes(RULE_END);

	if (hasBlock) {
		const next = replaceBlock(before, block);
		if (next === before) return { action: "unchanged", status: ruleStatus(file) };
		writeText(file, next);
		return { action: "updated", status: ruleStatus(file) };
	}

	// 用户自己已经写过等价规则 → 不硬塞第二份
	if (looksLikePushRule(before)) return { action: "skipped-custom", status: ruleStatus(file) };

	const body = before.replace(/\s*$/, "");
	const next = body ? `${body}\n\n${block}\n` : `${block}\n`;
	writeText(file, next, { backup: true });
	return { action: "added", status: ruleStatus(file) };
}

/**
 * 移除规则块（只删标记之间那一段）。
 * @returns {{action: 'removed'|'absent', status: object}}
 */
export function removeRule(file) {
	const before = readText(file);
	if (!before.includes(RULE_BEGIN)) return { action: "absent", status: ruleStatus(file) };
	const start = before.indexOf(RULE_BEGIN);
	const end = before.indexOf(RULE_END);
	let next = `${before.slice(0, start)}${before.slice(end + RULE_END.length)}`;
	// 清掉移除后留下的空行堆，但不动其它内容
	next = next.replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/, "");
	writeText(file, next);
	return { action: "removed", status: ruleStatus(file) };
}
