/**
 * 自检工具（`hiboard_push_selfcheck`）的两个 JSON Schema。
 *
 * ## 为什么单独抽成一个模块
 *
 * 2026-10-13 出过一次**整机无法对话**的事故，两次都栽在"裸对象注册"上：
 *
 * 1. `output.schema` 把 `required: true` 写在**每个属性节点**里 → `ctx.tools.register()`
 *    调 `assertSupportedJsonSchema` 时抛 `JsonSchemaError` → 注册异常被 catch 吞成一条
 *    看不见的 warn → 工具静默不存在（验收报告第 5 节）。
 * 2. 修好上面之后注册**成功了**，于是 `parameters: {}` 第一次真的发到模型 API ——
 *    而 API 要求 `parameters` 必须是 `type: "object"`，`{}` 的 type 是 null：
 *
 *        Invalid schema for function 'hiboard_push_selfcheck':
 *        schema must be a JSON Schema of 'type: "object"', got 'type: null'.
 *
 *    **每一个**请求都被服务端拒绝，整台机器都无法对话。
 *
 * 根因是：`ctx.tools.register()` **只校验 `output.schema`**，`parameters` 会被原样透传；
 * 而 `assertSupportedJsonSchema` 会**放过** `{}`（得用 `assertObjectJsonSchema` 才拦得住）。
 * 本地没有任何东西看着 `parameters`。
 *
 * 所以这两个 schema 抽成纯模块（不 import 任何东西），由 `test/tool-schemas.test.mjs`
 * 在**仓库里**直接断言 —— 这个文件能被测试 import，才是真正的防线。
 */

/**
 * 工具入参 schema —— **必须是显式对象根**。
 *
 * 不能写 `{}`：模型 API 要求 `type: "object"`，`{}` 的 type 是 null，会拒绝每一个请求。
 * 本工具不需要任何入参，所以就是"空对象的对象 schema"。
 */
export const SELFCHECK_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false
};

/**
 * 工具返回 schema。
 *
 * `required` **必须**写在对象层（数组），不能写进每个属性节点 —— 后者会被
 * `assertSupportedJsonSchema` 拒绝（它只允许 `required` 出现在 `type: "object"` 上）。
 */
export const SELFCHECK_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"guardActive",
		"hooked",
		"authCode",
		"source",
		"retryBudget",
		"endpoint",
		"endpointReachable",
		"lastState",
		"auditTail"
	],
	properties: {
		guardActive: { type: "boolean" },
		hooked: { type: "boolean" },
		authCode: { type: "string" },
		source: { type: "string" },
		retryBudget: { type: "string" },
		endpoint: { type: "string" },
		endpointReachable: { type: "boolean" },
		lastState: { type: "string" },
		auditTail: { type: "string" }
	}
};
