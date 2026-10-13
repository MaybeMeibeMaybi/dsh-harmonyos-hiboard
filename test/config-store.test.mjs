/**
 * config-store.js 的单元测试。
 *
 * 重点在两处容易写错、又不容易在界面上看出来地方：
 *   1. **合并写入**：设置页只提交一个字段时，不能把其它字段冲掉；
 *   2. **null = 删除**：界面上的"清除"必须让解析回退到补丁层/环境变量，
 *      而不是存一个空串把有效值盖住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __clearStoreCache, readStore, writeStore } from "../src/lib/config-store.js";

function withTempFile(run) {
	__clearStoreCache();
	const dir = mkdtempSync(join(tmpdir(), "hiboard-store-"));
	const file = join(dir, "config.json");
	try {
		return run(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		__clearStoreCache();
	}
}

test("文件不存在时读到空对象（零配置路径）", () => {
	withTempFile((file) => {
		assert.deepEqual(readStore(file), {});
	});
});

test("写入后能读回，且只保留写入的键", () => {
	withTempFile((file) => {
		writeStore({ authCode: "uhIzvTvjwnAD" }, file);
		assert.deepEqual(readStore(file), { authCode: "uhIzvTvjwnAD" });
	});
});

test("合并写入不会冲掉其它字段", () => {
	withTempFile((file) => {
		writeStore({ authCode: "uhIzvTvjwnAD", guardEnabled: true }, file);
		writeStore({ guardEnabled: false }, file);
		assert.deepEqual(readStore(file), { authCode: "uhIzvTvjwnAD", guardEnabled: false });
	});
});

test("null / undefined 删除该键，形成回退语义", () => {
	withTempFile((file) => {
		writeStore({ authCode: "uhIzvTvjwnAD", defaultScheduleId: "dsh_worklog" }, file);
		writeStore({ authCode: null }, file);
		assert.deepEqual(readStore(file), { defaultScheduleId: "dsh_worklog" });
	});
});

test("坏 JSON 不抛错，按未配置处理", () => {
	withTempFile((file) => {
		writeFileSync(file, "{ this is not json", "utf8");
		assert.deepEqual(readStore(file), {});
	});
});

test("JSON 是数组或标量时也按未配置处理", () => {
	withTempFile((file) => {
		writeFileSync(file, "[1,2,3]", "utf8");
		assert.deepEqual(readStore(file), {});
		__clearStoreCache();
		writeFileSync(file, '"just a string"', "utf8");
		assert.deepEqual(readStore(file), {});
	});
});
