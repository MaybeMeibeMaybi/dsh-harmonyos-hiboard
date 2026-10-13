/**
 * 插件自己的配置存储 —— 设置页保存落到这里。
 *
 * 位置：`<用户目录>/.dsh/hiboard-push/config.json`，权限 0600。
 *
 * 为什么不让设置页直接改 profile 的 `cordis.patch.yml`：那是 dsh 的补丁层，
 * 由宿主与其它插件共同维护（市场就靠它写停用行）。直接改它等于让本插件去
 * 编辑别人的文件，冲突面大；而 profile 路径也不是插件天然知道的东西。
 * 自己持有一份小配置，读写原子、范围清楚，代价只是多一个"来源"概念 ——
 * 所以设置页会明确显示**当前生效来源**，不留歧义。
 *
 * 读取带 mtime 缓存：兜底逻辑在会话事件里判断开关，不能每次都真读盘。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 默认配置文件路径。 */
export function configPath(home = homedir()) {
	return join(home, ".dsh", "hiboard-push", "config.json");
}

/** mtime 缓存：同一毫秒内的重复读取只 stat 一次。 */
const cache = new Map();

/**
 * 读取配置。文件不存在、无法解析、或不是对象时一律返回 `{}`，
 * 让调用方走"没有覆盖值"的正常路径，而不是抛错。
 */
export function readStore(file = configPath()) {
	try {
		const stat = statSync(file);
		const hit = cache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
		return value;
	} catch {
		// 文件不存在或内容坏了都算"没有覆盖值"；不要用旧的缓存值冒充当前状态
		cache.delete(file);
		return {};
	}
}

/**
 * 合并写入（原子替换）：先写 0600 的临时文件再 rename 覆盖，
 * 与 modsearch 的落盘方式一致 —— 中途断电不会留下半个 JSON。
 *
 * 值为 `null` / `undefined` 的键会被**删除**，这是"清除"语义：
 * 设置页把授权码清空时，要让解析回退到补丁层/环境变量，而不是存一个空串。
 */
export function writeStore(patch, file = configPath()) {
	const next = { ...readStore(file), ...patch };
	for (const key of Object.keys(next)) {
		if (next[key] === null || next[key] === undefined) delete next[key];
	}
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	try { chmodSync(tmp, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
	renameSync(tmp, file);
	try { chmodSync(file, 0o600); } catch { /* 同上 */ }
	cache.delete(file);
	return next;
}

/** 仅供测试：清掉 mtime 缓存。 */
export function __clearStoreCache() {
	cache.clear();
}
