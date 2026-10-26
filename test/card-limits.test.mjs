/**
 * 卡片标题长度上限的回归测试 —— 守的是 2026-10-17 那次**整张卡片丢失**。
 *
 * 事故：标题超过平台限制时端点返回 `0000500002 Parameter scheduleTaskName size is too long`，
 * 而插件当时**完全不校验标题长度**，卡片直接丢了。`content` 的 5000 字符限制写了三处文档，
 * 标题却没人管。
 *
 * 上限是实测出来的（2026-10-27，对真实端点二分）：63 / 64 字符通过，65 被拒，
 * 64 个中文字符（192 字节）也通过 → **按字符数限制，与字节无关**。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_CARD_NAME, clampCardName, isCardNameTruncated } from "../src/lib/card-limits.js";

test("上限是实测出来的 64", () => {
	assert.equal(MAX_CARD_NAME, 64, "平台实测：64 通过、65 被拒；改这个值前请重新实测");
});

test("不超长时原样返回，不做任何改动", () => {
	for (const s of ["", "a", "磁盘健康检查", "a".repeat(63), "a".repeat(64)]) {
		assert.equal(clampCardName(s), s, `长度 ${s.length} 不应被改动`);
		assert.equal(isCardNameTruncated(s), false);
	}
});

test("65 字符被截到 64，且带省略号（让「被截断」在卡片上看得出来）", () => {
	const input = "a".repeat(65);
	const out = clampCardName(input);
	assert.equal(out.length, MAX_CARD_NAME, "截断后必须正好等于上限");
	assert.ok(out.endsWith("…"), "截断后应带省略号");
	assert.equal(out.slice(0, -1), "a".repeat(63), "保留前 63 个字符");
	assert.equal(isCardNameTruncated(input), true);
});

test("按字符数而不是字节数 —— 64 个中文字符（192 字节）不截断", () => {
	const chinese = "汉".repeat(64);
	assert.equal(Buffer.byteLength(chinese, "utf8"), 192, "前提：这串是 192 字节");
	assert.equal(clampCardName(chinese), chinese, "实测 64 个中文字符能通过，不该被截");
	assert.equal(isCardNameTruncated(chinese), false);
});

test("中英文混排超长时也按 64 字符截断", () => {
	const mixed = "补推完成：v0.7.13 HAP+截图+文档（含MD5校验）".repeat(3);
	const out = clampCardName(mixed);
	assert.ok(out.length <= MAX_CARD_NAME, `实际 ${out.length}`);
	assert.ok(out.endsWith("…"));
});

test("emoji（代理对）不会被算出超过上限", () => {
	// 40 个 emoji：码点 40、UTF-16 码元 80。用 .length 计数只会更保守 → 截到 64 码元
	const emoji = "🎉".repeat(40);
	assert.equal(emoji.length, 80);
	const out = clampCardName(emoji);
	assert.ok(out.length <= MAX_CARD_NAME, `实际 ${out.length}`);
});

test("非字符串输入不会抛错", () => {
	for (const v of [undefined, null, 123, {}, []]) {
		assert.doesNotThrow(() => clampCardName(v));
		assert.equal(typeof clampCardName(v), "string");
	}
});

test("幂等：裁过的再裁一次不变", () => {
	const once = clampCardName("x".repeat(200));
	assert.equal(clampCardName(once), once);
});
