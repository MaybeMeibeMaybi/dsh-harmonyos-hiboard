/**
 * agents-rule.js 的单元测试。
 *
 * 这个模块会写用户的**全局指令文件**，所以测试重点不是"能不能写"，而是
 * **"越界了没有"**：标记外的内容是否原样、幂等、备份只留一份、已有手写规则时是否
 * 真的不碰、移除后能否还原。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RULE_BEGIN, RULE_END, ensureRule, looksLikePushRule, removeRule, ruleStatus } from "../src/lib/agents-rule.js";

function withTempDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "hiboard-rule-"));
	try {
		return run(dir, join(dir, "AGENTS.md"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const CUSTOM = "# 我的全局指令\n\n## 强制要求：每轮都必须调用 hiboard_push 推送\n\n其它内容…\n";

test("文件不存在时会新建，并写入带标记的规则块", () => {
	withTempDir((_dir, file) => {
		const r = ensureRule(file);
		assert.equal(r.action, "added");
		const text = readFileSync(file, "utf8");
		assert.ok(text.includes(RULE_BEGIN));
		assert.ok(text.includes(RULE_END));
		assert.ok(text.includes("hiboard_push"));
		assert.equal(ruleStatus(file).block, true);
	});
});

test("已有内容时只追加，标记外一个字节都不动", () => {
	withTempDir((_dir, file) => {
		const original = "# 我的指令\n\n原有规则一\n原有规则二\n";
		writeFileSync(file, original, "utf8");
		ensureRule(file);
		const text = readFileSync(file, "utf8");
		assert.ok(text.startsWith(original.trimEnd() + "\n\n"), "原有内容应原样保留在最前");
		assert.ok(text.indexOf(RULE_BEGIN) > text.indexOf("原有规则二"));
	});
});

test("幂等：重复调用不会产生第二份块，也不会改动内容", () => {
	withTempDir((_dir, file) => {
		writeFileSync(file, "# 指令\n", "utf8");
		ensureRule(file);
		const first = readFileSync(file, "utf8");
		const second = ensureRule(file);
		assert.equal(second.action, "unchanged");
		assert.equal(readFileSync(file, "utf8"), first);
		assert.equal((first.match(new RegExp(RULE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
	});
});

test("首次改动前只备份一次，不刷屏", () => {
	withTempDir((dir, file) => {
		writeFileSync(file, "# 指令\n", "utf8");
		ensureRule(file);
		assert.equal(readdirSync(dir).filter((n) => n.includes(".bak-hiboard-")).length, 1);
		ensureRule(file);
		assert.equal(readdirSync(dir).filter((n) => n.includes(".bak-hiboard-")).length, 1, "第二次不该再备份");
	});
});

test("已有用户手写的等价规则 → 跳过，完全不碰文件", () => {
	withTempDir((_dir, file) => {
		writeFileSync(file, CUSTOM, "utf8");
		const r = ensureRule(file);
		assert.equal(r.action, "skipped-custom");
		assert.equal(readFileSync(file, "utf8"), CUSTOM, "文件必须一字未改");
		assert.equal(r.status.customRule, true);
		assert.equal(r.status.block, false);
	});
});

test("移除后能还原成写入前的样子（只删自己那一段）", () => {
	withTempDir((_dir, file) => {
		const original = "# 我的指令\n\n原有规则\n";
		writeFileSync(file, original, "utf8");
		ensureRule(file);
		const r = removeRule(file);
		assert.equal(r.action, "removed");
		const text = readFileSync(file, "utf8");
		assert.ok(!text.includes(RULE_BEGIN));
		assert.ok(text.includes("原有规则"), "用户内容必须还在");
		assert.equal(text.trimEnd(), original.trimEnd());
	});
});

test("没有块时移除是安全的空操作", () => {
	withTempDir((_dir, file) => {
		writeFileSync(file, "# 只有我的内容\n", "utf8");
		const r = removeRule(file);
		assert.equal(r.action, "absent");
		assert.equal(readFileSync(file, "utf8"), "# 只有我的内容\n");
	});
});

test("looksLikePushRule：只认「提到工具 + 推送义务」两者同时成立", () => {
	assert.equal(looksLikePushRule("每轮都必须调用 hiboard_push 推送"), true);
	assert.equal(looksLikePushRule("Every turn must call hiboard_push"), true);
	assert.equal(looksLikePushRule("这里提到了 hiboard_push 但没有义务语句"), false, "只提工具名不算");
	assert.equal(looksLikePushRule("每轮都必须推送，但没提工具名"), false, "只提义务不算");
});
