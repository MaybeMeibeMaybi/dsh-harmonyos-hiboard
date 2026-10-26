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

import {
	MAX_CARD_NAME,
	RECOVERY_CARD_NAME,
	TITLE_TOO_LONG_CODE,
	clampCardName,
	isCardNameTruncated,
	isTitleTooLongFailure,
	shrinkCardName
} from "../src/lib/card-limits.js";

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

// ---------------------------------------------------------------- 恢复发送（再压一档）

test("恢复长度比上限留出余量（吸收平台计数差异）", () => {
	assert.ok(RECOVERY_CARD_NAME < MAX_CARD_NAME, "恢复长度必须小于上限");
	assert.equal(MAX_CARD_NAME - RECOVERY_CARD_NAME, 24, "留 24 字符余量；改这里请说明理由");
});

test("shrinkCardName：够短就原样返回（调用方据此判断「不能再压」）", () => {
	for (const s of ["", "短标题", "a".repeat(RECOVERY_CARD_NAME)]) {
		assert.equal(shrinkCardName(s), s);
	}
});

test("shrinkCardName：64 字符的标题被压到 40（带省略号）", () => {
	const full = "a".repeat(MAX_CARD_NAME);
	const out = shrinkCardName(full);
	assert.equal(out.length, RECOVERY_CARD_NAME);
	assert.ok(out.endsWith("…"));
	assert.notEqual(out, full, "必须真的变短，否则重发毫无意义");
});

test("isTitleTooLongFailure：认码，也认消息形态（平台换码时仍能识别）", () => {
	assert.equal(TITLE_TOO_LONG_CODE, "0000500002");
	assert.equal(isTitleTooLongFailure({ code: TITLE_TOO_LONG_CODE, message: "" }), true);
	assert.equal(isTitleTooLongFailure({ code: "", message: "Parameter scheduleTaskName size is too long" }), true);
	assert.equal(isTitleTooLongFailure({ code: "", message: "Parameter summary is too long" }), true);
});

test("isTitleTooLongFailure：别的失败绝不能误判成标题超长", () => {
	// 误判的后果：会拿一个被压短的标题凭空重发一次，多打一次端点
	const others = [
		{ code: "0000900034", message: "authCode invalid" },
		{ code: "", message: "Not Found" },
		{ code: "", message: "" },
		{ code: "0200100004", message: "device offline" },
		{ code: "", message: "unauthorized" }
	];
	for (const v of others) {
		assert.equal(isTitleTooLongFailure(v), false, `不该判为标题超长：${JSON.stringify(v)}`);
	}
	assert.equal(isTitleTooLongFailure(null), false);
	assert.equal(isTitleTooLongFailure(undefined), false);
});
