/**
 * authCode 输入解析 —— 设置页的输入框要同时吃两种写法：
 *
 *   1. 裸授权码
 *        aaaaaaaaaaaa
 *
 *   2. 完整关联指令（OpenClaw 的写法，用户常整行复制过来）
 *        openclaw config set skills.entries.today-task.config.authCode aaaaaaaaaaaa
 *
 *   3. 带引号 / 反引号包裹，或前后带说明文字
 *        "aaaaaaaaaaaa"
 *        授权码是 aaaaaaaaaaaa
 *
 * 设计取舍：
 *   - **不写死 16 位**。真实授权码长度会变，用户的示例本身也不足 16 位；
 *     写死长度只会在平台改长度那天静默失败。这里只做字符集与长度区间校验。
 *   - 指令形态一律**取最后一个 token**，因为 authCode 永远在指令末尾；
 *     这样不怕用户把 `skills.entries...` 这种点号路径也粘进来。
 *   - 解析结果里带 `shape`，界面据此告诉用户"这是从指令里提取的"还是"直接输入的"，
 *     避免用户在不知道自己粘了什么的情况下把错误的值存进去。
 */

/** 授权码允许的字符集与长度区间（宽松但有边界，防止把整段说明存进配置）。 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

/** 一眼能看出是"关联指令"的特征词。 */
const COMMAND_HINTS = /(openclaw|config\s+set|skills\.entries|today-task|authCode)/i;

function preview(text) {
	const s = String(text ?? "");
	return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function stripQuotes(text) {
	return String(text ?? "").replace(/^[`'"]+/, "").replace(/[`'"]+$/, "").trim();
}

/**
 * 解析输入框内容。
 *
 * @returns {{ok: true, code: string, shape: 'code'|'command', note: string}
 *         | {ok: false, reason: 'empty'|'invalid', message: string}}
 */
export function parseAuthCodeInput(raw) {
	const original = typeof raw === "string" ? raw : "";
	if (!original.trim()) {
		return { ok: false, reason: "empty", message: "授权码不能为空。" };
	}

	// 多行粘贴：只取第一段有内容的文本（后面往往跟着说明或空行）
	const firstLine = original
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";
	const text = stripQuotes(firstLine);
	if (!text) {
		return { ok: false, reason: "empty", message: "授权码不能为空。" };
	}

	// 形态一：整段就是授权码
	if (!/\s/.test(text)) {
		if (CODE_PATTERN.test(text)) {
			return { ok: true, code: text, shape: "code", note: "已按裸授权码保存。" };
		}
		return {
			ok: false,
			reason: "invalid",
			message: `这串内容不像授权码（只允许字母、数字、下划线、连字符，6–128 位）：${preview(text)}`
		};
	}

	// 形态二：一行指令 → 取最后一个 token
	const tokens = text.split(/\s+/).filter(Boolean);
	const last = stripQuotes(tokens[tokens.length - 1]);
	if (!CODE_PATTERN.test(last)) {
		return {
			ok: false,
			reason: "invalid",
			message: `没能从这行内容里取出授权码（末尾是 ${preview(last)}）。请把授权码放在末尾，或直接粘贴裸授权码。`
		};
	}
	if (!COMMAND_HINTS.test(text)) {
		return {
			ok: true,
			code: last,
			shape: "command",
			note: `这行不像常见的关联指令，已按"取最后一个词"处理：${preview(last)}`
		};
	}
	return { ok: true, code: last, shape: "command", note: "已从关联指令中提取授权码。" };
}

/** 展示用打码：只露最后 4 位，其余换成 •。 */
export function maskAuthCode(code) {
	const s = String(code ?? "");
	if (!s) return "";
	if (s.length <= 4) return "•".repeat(s.length);
	return `${"•".repeat(Math.min(s.length - 4, 12))}${s.slice(-4)}`;
}
