# 华为鸿蒙系统 DeepSeek Harness 对话结果负一屏卡片推送

**HarmonyOS DeepSeek Harness Result Push to Assistant-Today Cards**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![HarmonyOS NEXT](https://img.shields.io/badge/HarmonyOS-NEXT-000000?logo=huawei&logoColor=white)](#)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh%200.1.5-4B6BFB)](#)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](#)

把 **DeepSeek Harness（dsh）** 的对话与任务结果，以 **服务卡片** 形式推送到华为鸿蒙
**负一屏（智慧助手·今天）**，手机上点开即可看到完整的 Markdown 正文。

> 本仓库基于 [Entity-Him/dsh-hiboard-push](https://github.com/Entity-Him/dsh-hiboard-push)（MIT）修改，
> 修复了它在 **dsh 0.1.5 / cordis 4** 上的启动崩溃，并补齐了部署文档与卡片契约分析。
> 来源与改动逐条列于 [`NOTICE`](NOTICE)。

---

## 效果

DSH 每完成一件事，agent 调用一次工具：

```
hiboard_push(
  name        = "磁盘健康检查",
  content     = "# 检查结果\n\n- C 盘：正常\n- D 盘：正常",
  result      = "已完成",
  schedule_id = "dsh_worklog"        # 关键，见下
)
```

手机负一屏出现卡片 → 点进去 → **完整 Markdown 正文**。

```
DSH agent ──调用 hiboard_push──► 华为 HIBoard 云侧 ──► 手机负一屏服务卡片
  (本插件注册的两个工具)            POST .../msg/upload
```

---

## ⚠️ 三个必须知道的坑

### 1. 卡片必须带 `scheduleTaskId`，否则正文完全不显示

这是本项目最有价值的实测结论（2026-09-23 对着线上服务验证）：

| 负载形态 | 手机上看到什么 |
|---|---|
| `scheduleTaskId` **为空** | 只有一行标题 + 时间 + 来源；**正文一行都不显示**，「进任务」深链点了没反应 |
| `scheduleTaskId` **非空** | **打开完整详情页，渲染整段 Markdown 正文** ✅ |

`content` 字段本身没问题（实测负载里带换行、序列化正确，接口也返回成功），
**平台只是不给"没有 scheduleTaskId"的卡片开放详情页**。

**结论：推送一律传 `schedule_id`。** 同一会话用同一个 ID，还能在负一屏里分组。

### 2. 授权码不能放 `~/.dsh/.env`

`DSH_HIBOARD_AUTH_CODE` 是 dsh 的 **bootstrap-only** 变量。写进 `.env` 会让 dsh
**直接拒绝启动**：

```
Error: dsh: ...\.env sets "DSH_HIBOARD_AUTH_CODE", which only the launching
       environment may set ...
```

正确做法：写进 profile 补丁层的插件 config（见下方部署）。

### 3. 上游版本会让新版 dsh 启动崩溃（本仓库已修）

上游使用 `@deepseek-ai/dsh-settings` 的 `installSettingsSection`，该 API 在 cordis 4 已移除：

```
SyntaxError: The requested module '@deepseek-ai/dsh-settings'
             does not provide an export named 'installSettingsSection'
TypeError: Cannot read properties of undefined (reading 'validate')
```

`src/lib/index.js` 是**已修复版**：摘掉失效的设置面板注册，推送逻辑完整保留；
上游原版留作 `src/lib/index.js.upstream-backup` 便于比对。

---

## 快速开始

前置：Windows / macOS / Linux + Node.js 18+ + dsh 已安装 + `pnpm` 已安装。

```bash
# 1) 克隆到一个「路径不含空格」的位置（pnpm 的 file: 依赖会被空格截断）
git clone https://github.com/MaybeMeibeMaybi/dsh-harmonyos-hiboard.git E:/dsh-vendor/dsh-harmonyos-hiboard

# 2) 安装为 dsh 插件
dsh plugin --profile web add "file:E:/dsh-vendor/dsh-harmonyos-hiboard"
```

**3) 写入授权码** —— 编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: hiboard-push
  config:
    authCode: <你的授权码>
```

授权码获取：手机 **负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体**。

**4) 重启 dsh**，然后让 agent 调用 `hiboard_push`（记得传 `schedule_id`）。

完整步骤（含预检、排错、错误码）见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。

---

## 提供的工具

| 工具 | 作用 |
|---|---|
| `hiboard_push` | 推送一张任务卡片：`name`（标题）、`content`（Markdown，≤5000 字符）、`result`（状态标签）、`schedule_id`（**必传**）、`dry_run`（只校验不发送） |
| `hiboard_verify` | 发送一张「连接测试」卡片，端到端验证授权码与网络 |

---

## 网络契约

| 项 | 值 |
|---|---|
| 端点 | `POST https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload` |
| 鉴权 | 请求体中的 `authCode`（个人凭据） |
| 必填字段 | `msgId` `scheduleTaskId` `scheduleTaskName` `summary` `result` `content` `source` `taskFinishTime` |
| `source` | 固定 `"OpenClaw"`（平台按此值品牌化渲染，**不要改**） |
| 内容上限 | 5000 字符 |
| 成功码 | `0000000000`（也接受 `"0"`） |
| 授权码无效 | `0000900034` |
| 方法限制 | **仅 POST**（GET 返回 405） |

字段细节、卡片形态对照、全部错误码（含 `0200100004` 的 CP 子码含义）见
**[`docs/CARD-CONTRACT.md`](docs/CARD-CONTRACT.md)**。

---

## 让"每一轮回答都推送"对所有会话生效

工具不会自己调用。把规则写进 **全局指令文件** `~/.dsh/AGENTS.md`，
dsh 会在**每个会话**里自动加载它。现成模板见
**[`docs/AGENTS-rule.md`](docs/AGENTS-rule.md)**。

---

## 目录结构

```
.
├── README.md
├── LICENSE                                    MIT（含上游 Entity-Him 版权声明）
├── NOTICE                                     来源与改动声明
├── package.json
├── docs/
│   ├── DEPLOY.md                              从零部署（含排错表）
│   ├── CARD-CONTRACT.md                       负载契约 / 卡片形态 / 错误码
│   └── AGENTS-rule.md                         全局推送规则模板
└── src/
    ├── lib/index.js                           插件源码（兼容性修复版）
    ├── lib/index.js.upstream-backup           上游原始版本，便于比对
    ├── package.json
    └── cordis.patch.yml                       bundle 补丁（挂载插件用）
```

---

## 兼容性

| 组件 | 版本 |
|---|---|
| DeepSeek Harness (dsh) | 0.1.5（验证版本） |
| cordis | 4.x |
| Node.js | 18+ |

**平台侧**：华为负一屏「智慧助手·今天」的 HIBoard 云侧接口。
网络契约与官方 `today-task` skill、以及独立 Rust 实现
[`lichtcui/hwpush`](https://github.com/lichtcui/hwpush) 交叉核对一致。

---

## 安全

- `authCode` 是**个人凭据**：持有它的人可以往你负一屏推卡片。
  不要提交到仓库、不要发群聊。泄露后去负一屏重新取码即可让旧码失效。
- 本仓库所有示例与模板中的授权码一律为 `<AUTH_CODE>` 占位。

## 许可证与致谢

MIT。上游版权归 **Entity-Him** 所有，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
感谢上游作者以及 [`lichtcui/hwpush`](https://github.com/lichtcui/hwpush) 提供的协议参考。
