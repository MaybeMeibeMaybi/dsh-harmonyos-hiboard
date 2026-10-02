/**
 * push-once.mjs - 在**独立进程**里推一次卡片，把结果以一行 JSON 打到 stdout。
 *
 * 为什么要有这个独立进程（2026-09-30 实测）：dsh 启动时插件自己发的推送请求会不稳定 ——
 * 同一分钟内、同一份 payload（逐字节相同）、同一台机器：
 *   · 插件进程内（fetch / https.request / 逐个钉 A 记录）→ 全部 404 `{"message":"Not Found"}`
 *   · 但把**同一份字节**交给一个新起的进程去发 → 立刻 200 `{"code":"0000000000"}`
 * 反复二分过：payload 内容、msgId 形状、连接复用、两条传输实现、先做网关注册、
 * 先 import 插件模块……都不是原因。既然"新进程发就成"是可复现的事实，
 * 插件的投递阶梯最后一级就落到这里：**换个进程发**。
 *
 * 用法：node push-once.mjs <pushUrl> <payloadJsonFile>
 * 输出：{"ok":true,"status":200,"body":"{\"code\":\"0000000000\"...}"}
 */

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const [url, file] = process.argv.slice(2);
const reply = (obj) => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
	process.exit(obj.ok ? 0 : 1);
};

if (!url || !file) reply({ ok: false, status: 0, body: "用法: node push-once.mjs <pushUrl> <payloadJsonFile>" });

let payload;
try {
	payload = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
} catch (error) {
	reply({ ok: false, status: 0, body: `读 payload 失败：${error.message}` });
}

let target;
try {
	target = new URL(url);
} catch (error) {
	reply({ ok: false, status: 0, body: `无效 URL：${error.message}` });
}

const body = Buffer.from(JSON.stringify(payload), "utf8");
const secure = target.protocol !== "http:";
const request = secure ? httpsRequest : httpRequest;
const req = request({
	hostname: target.hostname,
	port: target.port || (secure ? 443 : 80),
	path: target.pathname + target.search,
	method: "POST",
	headers: {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"x-trace-id": `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`
	},
	timeout: 20000,
	rejectUnauthorized: true
}, (res) => {
	let data = "";
	res.on("data", (c) => (data += c));
	res.on("end", () => reply({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: data.slice(0, 300) }));
});
req.on("error", (error) => reply({ ok: false, status: 0, body: error.message }));
req.on("timeout", () => {
	req.destroy();
	reply({ ok: false, status: 0, body: "请求超时" });
});
req.write(body);
req.end();
