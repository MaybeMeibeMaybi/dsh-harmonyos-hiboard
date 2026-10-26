/**
 * 卡片字段的平台硬限制 —— 全部**实测得出**，不是猜的。
 *
 * ## 为什么需要这个模块
 *
 * 2026-10-17 一次真实推送失败，返回：
 *
 *     {"code":"0000500002","message":"Parameter scheduleTaskName size is too long"}
 *
 * 那张卡片**直接丢失**了：标题（`name`，同时用作 `scheduleTaskName` 与 `summary`）太长，
 * 平台拒收，而插件此前从不校验它 —— `content` 有 5000 字符限制且文档里写了三处，
 * 标题却完全没人管。
 *
 * ## 上限是怎么测出来的（2026-10-27）
 *
 * 对真实端点二分探测（每次发一张真实卡片，用独立 `schedule_id` 分组）：
 *
 *     63 字符 → 0000000000（成功）
 *     64 字符 → 0000000000（成功）   ← 边界
 *     65 字符 → 0000500002（被拒）
 *     64 个中文字符 = 192 字节 → 成功
 *
 * 结论：**按字符数限制，上限 64，与 UTF-8 字节数无关。**
 *
 * ## 为什么用 `.length`（UTF-16 码元）而不是码点
 *
 * `str.length` 对 BMP 字符等于字符数，对 emoji 等代理对会**多算**（1 个 emoji 算 2）。
 * 平台到底按码点还是码元计数，本模块无法区分；但用 `.length` 只会**更保守**（多算 → 更早截断），
 * 不会放过超长标题。宁可标题少一个字，也不要丢整张卡。
 */

/** 卡片标题（`scheduleTaskName` / `summary`）的平台上限：64 字符。实测 64 通过、65 被拒。 */
export const MAX_CARD_NAME = 64;

/**
 * 把卡片标题裁到平台上限之内。
 *
 * 超长时保留前 63 个字符并加一个省略号（总共 64），让"被截断"这件事在卡片上**看得出来**，
 * 而不是莫名其妙少了半句。
 *
 * @param {unknown} name - 原始标题
 * @returns {string} 可直接发送的标题
 */
export function clampCardName(name) {
	const text = typeof name === "string" ? name : String(name ?? "");
	if (text.length <= MAX_CARD_NAME) return text;
	return `${text.slice(0, MAX_CARD_NAME - 1)}…`;
}

/**
 * 是否发生了截断（供调用方决定要不要记日志）。
 * @param {unknown} name - 原始标题
 * @returns {boolean}
 */
export function isCardNameTruncated(name) {
	const text = typeof name === "string" ? name : String(name ?? "");
	return text.length > MAX_CARD_NAME;
}

/**
 * 恢复发送时把标题压到的长度。
 *
 * 比上限 64 再留 24 字符余量，用来吸收"平台的计数方式与我们的 `.length` 不一致"
 * （emoji / 组合字符 / 未来收紧上限）。**只压一档，不做阶梯循环。**
 */
export const RECOVERY_CARD_NAME = 40;

/**
 * 把标题再压短一档，用于"平台仍然嫌长"时的**恢复发送**。
 *
 * 与 `clampCardName` 的区别：那个是**预防**（按实测上限 64，发送前就裁好），
 * 这个是**兜底**（收到"太长"拒绝后再压一档重发）。两者叠加，压一次就够 ——
 * 因为同一负载重发是确定性的，只有**改小**才是另一个请求。
 *
 * @param {unknown} name - 原始标题
 * @returns {string} 压短后的标题（已经够短时原样返回，调用方据此判断"还能不能再压"）
 */
export function shrinkCardName(name) {
	const text = typeof name === "string" ? name : String(name ?? "");
	if (text.length <= RECOVERY_CARD_NAME) return text;
	return `${text.slice(0, RECOVERY_CARD_NAME - 1)}…`;
}

/** 平台"标题超长"的业务码（实测：`Parameter scheduleTaskName size is too long`）。 */
export const TITLE_TOO_LONG_CODE = "0000500002";

/** 从错误消息里也能认出"太长"（平台可能换码，但消息形态稳定）。 */
const TOO_LONG_MESSAGE_RE = /size is too long|\bis too long\b/i;

/**
 * 这次失败是不是"标题超长"—— 决定要不要走**恢复发送**。
 *
 * 纯函数，所以能被 `test/card-limits.test.mjs` 直接覆盖；
 * 真正"改小再发一次"的接线在 `push-guard.js` 的 L3 包装里。
 *
 * @param {{code?: string, message?: string}} verdict - classifyPush 的结果
 * @returns {boolean}
 */
export function isTitleTooLongFailure(verdict) {
	if (!verdict) return false;
	if (String(verdict.code ?? "") === TITLE_TOO_LONG_CODE) return true;
	return TOO_LONG_MESSAGE_RE.test(String(verdict.message ?? ""));
}
