/**
 * authcode.js 的单元测试，外加一条**对齐测试**：
 * 浏览器半边 src/lib/client.js 里有一份刻意的解析器副本（客户端 bundle 无法
 * import 宿主模块），两边规则必须一致。副本漂移是这类代码最现实的故障，
 * 所以这里把两份实现喂同一组输入，逐条比对结论。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { maskAuthCode, parseAuthCodeInput } from "../src/lib/authcode.js";

/** 在最小沙箱里执行 client.js，取回它导出的解析器。 */
function loadClientCard() {
	const source = readFileSync(new URL("../src/lib/client.js", import.meta.url), "utf8");
	let definition = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
		console
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	assert.ok(definition, "client.js 应当调用 window.__ModuleLoader__.load()");
	const mod = definition.factory(() => {
		throw new Error("factory 在加载期不应 require 任何模块");
	});
	return mod.__card;
}

test("裸授权码可以直接使用", () => {
	const result = parseAuthCodeInput("aaaaaaaaaaaa");
	assert.equal(result.ok, true);
	assert.equal(result.code, "aaaaaaaaaaaa");
	assert.equal(result.shape, "code");
});

test("完整关联指令会取出末尾的授权码", () => {
	const result = parseAuthCodeInput(
		"openclaw config set skills.entries.today-task.config.authCode uhIzvTvjwnAD"
	);
	assert.equal(result.ok, true);
	assert.equal(result.code, "uhIzvTvjwnAD");
	assert.equal(result.shape, "command");
});

test("带引号 / 反引号包裹的授权码同样接受", () => {
	for (const input of ['"uhIzvTvjwnAD"', "'uhIzvTvjwnAD'", "`uhIzvTvjwnAD`"]) {
		const result = parseAuthCodeInput(input);
		assert.equal(result.ok, true, input);
		assert.equal(result.code, "uhIzvTvjwnAD");
	}
});

test("多行粘贴只取第一段有内容的文本", () => {
	const result = parseAuthCodeInput("uhIzvTvjwnAD\n\n（这是我的授权码，别外传）");
	assert.equal(result.ok, true);
	assert.equal(result.code, "uhIzvTvjwnAD");
});

test("前后带说明文字时取最后一个词", () => {
	const result = parseAuthCodeInput("授权码是 uhIzvTvjwnAD");
	assert.equal(result.ok, true);
	assert.equal(result.code, "uhIzvTvjwnAD");
});

test("空输入被拒绝", () => {
	for (const input of ["", "   ", "\n\n", undefined, null]) {
		const result = parseAuthCodeInput(input);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "empty");
	}
});

test("含空格或非法字符的内容被拒绝", () => {
	const bad = parseAuthCodeInput("这不是 授权码");
	assert.equal(bad.ok, false);
	assert.equal(bad.reason, "invalid");
	// 末尾的 token 太短 / 带点号 → 不算授权码
	assert.equal(parseAuthCodeInput("openclaw config set skills.entries.today-task.config.authCode").ok, false);
	assert.equal(parseAuthCodeInput("skills.entries.today-task.config.authCode").ok, false);
});

test("不写死长度：短码与长码都接受，超范围才拒绝", () => {
	assert.equal(parseAuthCodeInput("abc123").ok, true, "6 位是下界");
	assert.equal(parseAuthCodeInput("a".repeat(128)).ok, true, "128 位是上界");
	assert.equal(parseAuthCodeInput("abc12").ok, false, "5 位太短");
	assert.equal(parseAuthCodeInput("a".repeat(129)).ok, false, "129 位太长");
});

test("打码只露最后 4 位", () => {
	assert.equal(maskAuthCode("uhIzvTvjwnAD"), "••••••••wnAD");
	assert.equal(maskAuthCode("abcd"), "••••");
	assert.equal(maskAuthCode(""), "");
});

test("客户端副本与宿主实现结论一致（防副本漂移）", () => {
	const client = loadClientCard();
	const inputs = [
		"aaaaaaaaaaaa",
		"uhIzvTvjwnAD",
		"openclaw config set skills.entries.today-task.config.authCode uhIzvTvjwnAD",
		'"uhIzvTvjwnAD"',
		"`uhIzvTvjwnAD`",
		"uhIzvTvjwnAD\n（说明）",
		"授权码是 uhIzvTvjwnAD",
		"",
		"   ",
		"这不是 授权码",
		"openclaw config set skills.entries.today-task.config.authCode",
		"skills.entries.today-task.config.authCode",
		"abc123",
		"a".repeat(128),
		"abc12",
		"a".repeat(129)
	];
	for (const input of inputs) {
		const host = parseAuthCodeInput(input);
		const web = client.parseAuthCodeInput(input);
		assert.equal(web.ok, host.ok, `ok 不一致: ${JSON.stringify(input)}`);
		if (host.ok) {
			assert.equal(web.code, host.code, `code 不一致: ${JSON.stringify(input)}`);
			assert.equal(web.shape, host.shape, `shape 不一致: ${JSON.stringify(input)}`);
			assert.equal(client.maskAuthCode(host.code), maskAuthCode(host.code), "打码不一致");
		} else {
			assert.equal(web.reason, host.reason, `reason 不一致: ${JSON.stringify(input)}`);
		}
	}
});

test("客户端导出的是挂载设置卡片所需的最小接口", () => {
	const client = loadClientCard();
	assert.equal(typeof client.parseAuthCodeInput, "function");
	assert.equal(typeof client.maskAuthCode, "function");
	assert.ok(client.TEXT && client.TEXT.zh && client.TEXT.en, "中英文案都要在");
});
