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
