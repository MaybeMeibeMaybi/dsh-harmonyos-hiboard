/**
 * 客户端半边的结构测试 —— 把 lazy-CJS bundle 真正执行一遍。
 *
 * 为什么需要它：`src/lib/client.js` 是手写的 `window.__ModuleLoader__.load({id, factory})`
 * bundle，**没有构建步骤**，所以语法检查之外没人验证过它到底注册了什么。
 * 这个测试用最小的垫片跑一遍 factory，断言：
 *
 *   1. 返回的 cordis 插件导出里有 `apply`
 *   2. 三个座席都按正确的 key 注册了：
 *        - `plugins.bundle.config`      （插件页上的设置卡片）
 *        - `plugins.bundle.activation`  （**启用后指引**，本测试的重点）
 *        - `settings.plugin.item`       （老宿主的兼容座席）
 *   3. 指引的两行文案与按钮文案，中英都在（用户明确指定的措辞）
 *
 * 只 stub、不真跑浏览器：`require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')`
 * 由垫片提供，所以 `mountCard` 不会走"拿不到原语就跳过"的早退分支。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "src", "lib", "client.js"), "utf8");

/** 假 React：只要够 `createElement` / hooks 不炸即可。 */
const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value }),
	useCallback: (fn) => fn,
	Fragment: "Fragment"
};

/** 假原语：组件名只要是个可辨识的值。 */
const fakePrimitives = { Button: "Button", Switch: "Switch", Input: "Input" };

/**
 * 执行 bundle，返回 `{ plugin, registrations }`。
 * `plugin` 是 factory 的返回值（cordis 插件导出），`registrations` 记录每次 slots.register。
 */
function evaluateClient() {
	let loaded = null;
	const windowShim = { __ModuleLoader__: { load: (definition) => { loaded = definition; } } };

	// bundle 在模块顶层调用 window.__ModuleLoader__.load(...)，所以要有 window
	const run = new Function("window", "document", "navigator", "console", "fetch", "setTimeout", SOURCE);
	run(
		windowShim,
		{ documentElement: { getAttribute: () => "zh-CN" }, lang: "zh-CN" },
		{ language: "zh-CN" },
		{ error: () => {}, warn: () => {}, log: () => {} },
		async () => ({ ok: true, json: async () => ({ authCode: { configured: false } }) }),
		setTimeout
	);

	assert.ok(loaded, "bundle 应当调用 window.__ModuleLoader__.load");
	assert.equal(loaded.id, "dsh-harmonyos-hiboard", "bundle id 必须是包名");

	const registrations = [];
	const ctx = {
		effect: () => () => {},
		inject: (_deps, callback) => callback(ctx),
		slots: {
			// 驱动生成器，让里面那句 yield ctx.slots.register(...) 真正执行
			inject: (_name, factory) => {
				const iterator = factory();
				iterator.next();
				return () => {};
			},
			register: (definition, component) => {
				registrations.push({ definition, component });
				return () => {};
			}
		}
	};

	const requireShim = (id) => {
		if (id === "react") return fakeReact;
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return fakePrimitives;
		throw new Error(`unexpected require: ${id}`);
	};

	const plugin = loaded.factory(requireShim);
	assert.equal(typeof plugin.apply, "function", "factory 应当返回带 apply 的插件");
	plugin.apply(ctx);
	return { plugin, registrations };
}

test("客户端 bundle 能执行，并返回带 apply 的插件", () => {
	const { plugin } = evaluateClient();
	assert.equal(typeof plugin.apply, "function");
});

test("三个座席都按正确的 key 注册（含新增的「启用后指引」）", () => {
	const { registrations } = evaluateClient();
	const byName = new Map(registrations.map((r) => [r.definition.name, r.definition]));

	assert.deepEqual(
		[...byName.keys()].sort(),
		["plugins.bundle.activation", "plugins.bundle.config", "settings.plugin.item"],
		"三个座席都要注册"
	);

	// key 必须等于包名，否则宿主按包名分发时找不到（这是踩过的坑）
	assert.equal(byName.get("plugins.bundle.config").key, "dsh-harmonyos-hiboard");
	assert.equal(byName.get("plugins.bundle.activation").key, "dsh-harmonyos-hiboard");
	assert.equal(byName.get("settings.plugin.item").key, "hiboard-push");
});

test("每个座席都拿到了可渲染的组件", () => {
	const { registrations } = evaluateClient();
	for (const { definition, component } of registrations) {
		assert.ok(component, `${definition.name} 应当有组件`);
		assert.ok(["function", "object"].includes(typeof component), `${definition.name} 的组件类型应可渲染`);
	}
});

test("启用后指引的文案是用户指定的措辞（中英都在）", () => {
	const { plugin } = evaluateClient();
	const text = plugin.__card?.TEXT;
	assert.ok(text, "客户端应当导出 __card.TEXT 供测试断言");
	assert.equal(text.zh.guideTitle, "安装后请在插件设置页输入授权码", "中文主文案");
	assert.equal(text.zh.guideWhere, "DSH主页面左上角「插件」→ 「dsh-harmonyos-hiboard」", "中文指路小字");
	assert.equal(text.zh.guideOk, "确定");
	assert.equal(text.en.guideTitle, "Enter your auth code on this plugin's settings page.", "英文主文案");
	assert.equal(text.en.guideWhere, "In DSH: top-left 「Plugins」 → 「dsh-harmonyos-hiboard」", "英文指路小字");
	assert.equal(text.en.guideOk, "OK");
	// 中英都要有，不能漏
	for (const lang of ["zh", "en"]) {
		for (const key of ["guideTitle", "guideWhere", "guideOk", "guideLater", "guideInCard"]) {
			assert.ok(String(text[lang][key] ?? "").length > 0, `${lang}.${key} 不能为空`);
		}
	}
});

test("指引组件在未知状态下不渲染（避免闪一下再消失）", () => {
	const { registrations } = evaluateClient();
	const guide = registrations.find((r) => r.definition.name === "plugins.bundle.activation");
	assert.equal(typeof guide.component, "function");
	// useState 桩返回初始 null → 查询中 → 应当返回 null
	const tree = guide.component({ packageName: "dsh-harmonyos-hiboard", onDismiss: () => {}, onOpenDetails: () => {} });
	assert.equal(tree, null, "配置状态未知时不应渲染");
});
