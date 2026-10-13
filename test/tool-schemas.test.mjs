/**
 * 工具 schema 回归测试 —— 守的是 2026-10-13 那两次**整机级**事故。
 *
 * 背景：`hiboard_push_selfcheck` 用**裸对象**注册（不走 `defineTool()`），
 * 而 `ctx.tools.register()` **只校验 `output.schema`**，`parameters` 会被原样透传给
 * 模型 API。于是本地没有任何东西看着 `parameters`：
 *
 * - 属性级 `required: true` → `assertSupportedJsonSchema` 抛错 → 被 catch 吞掉 → 工具静默不存在
 * - `parameters: {}` → 注册成功，但 API 要求 `type:"object"` → **每一个请求**都被拒，
 *   整台机器无法对话
 *
 * 这个测试在**仓库里**就能跑（`tool-schemas.js` 不 import 任何东西），
 * 所以这类问题在下一次 `npm publish` 之前就会红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SELFCHECK_OUTPUT_SCHEMA, SELFCHECK_PARAMETERS } from "../src/lib/tool-schemas.js";

/** 递归找出所有 `required` 出现的位置，用于断言它只在对象层。 */
function findRequired(node, path = "$", found = []) {
	if (node && typeof node === "object" && !Array.isArray(node)) {
		for (const [key, value] of Object.entries(node)) {
			if (key === "required") found.push({ path, value });
			findRequired(value, `${path}.${key}`, found);
		}
	}
	return found;
}

test("parameters 必须是显式对象根 schema（写成 {} 会让整机无法对话）", () => {
	assert.equal(SELFCHECK_PARAMETERS.type, "object", "parameters.type 必须是 'object'");
	assert.equal(typeof SELFCHECK_PARAMETERS.properties, "object");
	assert.equal(SELFCHECK_PARAMETERS.additionalProperties, false);
});

test("parameters 不能是空对象——那正是 2026-10-13 的事故形态", () => {
	const empty = {};
	assert.equal(empty.type, undefined, "空对象的 type 是 undefined → API 报 type: null");
	assert.notDeepEqual(SELFCHECK_PARAMETERS, empty);
	assert.ok(Object.keys(SELFCHECK_PARAMETERS).length > 0, "必须是显式 schema，不能是 {}");
});

test("output.schema 的 required 只在对象层，且是数组", () => {
	const hits = findRequired(SELFCHECK_OUTPUT_SCHEMA);
	assert.equal(hits.length, 1, `required 只应出现一次，实际 ${hits.length} 次：${hits.map((h) => h.path).join(", ")}`);
	assert.equal(hits[0].path, "$", "required 必须挂在根节点上");
	assert.ok(Array.isArray(hits[0].value), "对象层的 required 必须是数组");
});

test("output.schema 里没有属性级 required: true（那会让注册被拒且静默）", () => {
	const offenders = findRequired(SELFCHECK_OUTPUT_SCHEMA).filter((h) => h.value === true);
	assert.equal(offenders.length, 0, `属性级 required 出现在：${offenders.map((h) => h.path).join(", ")}`);
});

test("output.schema 声明的属性与 required 一一对应", () => {
	const props = Object.keys(SELFCHECK_OUTPUT_SCHEMA.properties).sort();
	const required = [...SELFCHECK_OUTPUT_SCHEMA.required].sort();
	assert.deepEqual(required, props, "required 与实际属性必须完全一致，避免漏声明");
});

test("两个 schema 都是纯 JSON（可结构化克隆，无函数/undefined）", () => {
	for (const [label, schema] of [["parameters", SELFCHECK_PARAMETERS], ["output.schema", SELFCHECK_OUTPUT_SCHEMA]]) {
		assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, `${label} 必须能无损 JSON 往返`);
	}
});

test("如果装了 dsh-tools，就用它真实的校验器再验一遍", async () => {
	let tools = null;
	try {
		tools = await import("@deepseek-ai/dsh-tools");
	} catch {
		// 仓库里没装 dsh-tools（它由宿主提供）—— 上面的结构断言已经覆盖同样的缺陷
		return;
	}
	// register() 用的就是这个
	tools.assertSupportedJsonSchema(SELFCHECK_OUTPUT_SCHEMA);
	// 而 parameters 本地只有这个拦得住（assertSupportedJsonSchema 会放过 {}）
	tools.assertObjectJsonSchema(SELFCHECK_PARAMETERS);
});
