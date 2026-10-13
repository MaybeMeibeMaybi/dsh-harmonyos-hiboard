# 华为鸿蒙系统 DeepSeek Harness 对话结果负一屏卡片推送

**HarmonyOS DeepSeek Harness Result Push to Assistant-Today Cards**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![HarmonyOS NEXT](https://img.shields.io/badge/HarmonyOS-NEXT-000000?logo=huawei&logoColor=white)](#)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5%20%7C%200.2-4B6BFB)](#)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](#)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/maybemeibemaybi/dsh-harmonyos-hiboard)

把 **DeepSeek Harness（dsh）** 的对话与任务结果，以 **服务卡片** 形式推送到华为鸿蒙
**负一屏（智慧助手·今天）**，手机上点开即可看到完整的 Markdown 正文。

> 本仓库基于 [Entity-Him/dsh-hiboard-push](https://github.com/Entity-Him/dsh-hiboard-push)（MIT）修改，
> 修复了它在 **dsh 0.1.5 / cordis 4** 上的启动崩溃，并补齐了部署文档与卡片契约分析。
> 同时兼容 **dsh 0.2**（见下方「兼容性」与 [`docs/UPDATES-2026-10-12.md`](docs/UPDATES-2026-10-12.md)）。
> 来源与改动逐条列于 [`NOTICE`](NOTICE)。

---

## 效果（真机截图）

<table>
<tr>
<td align="center" width="33%">
<img src="docs/images/card-list.jpg" alt="负一屏卡片列表">
<br><b>① 负一屏卡片</b><br>
<sub>同一 schedule_id 的卡片会归到一组</sub>
</td>
<td align="center" width="33%">
<img src="docs/images/card-history.jpg" alt="历史记录列表">
<br><b>② 历史记录</b><br>
<sub>每条任务都有「进任务」入口</sub>
</td>
<td align="center" width="33%">
<img src="docs/images/card-detail.jpg" alt="卡片详情页完整 Markdown">
<br><b>③ 点开详情页</b><br>
<sub>完整 Markdown 正文，含渲染正常的表格 —— 这正是必须传 schedule_id 的原因</sub>
</td>
</tr>
</table>

> **测试环境**：HarmonyOS **7.0.0.107**，**仅测试了手机端**（未验证平板 / 折叠屏 / 手表等形态）。
> ③ 是项目介绍卡；①② 里带「示例」字样的卡片为测试数据，非真实任务记录。
> Markdown 支持范围与表格写法要求见 [兼容性](#兼容性) 一节。


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
# 1) 安装为 dsh 插件（从 GitHub 安装，跨平台）
dsh plugin --profile web add github:MaybeMeibeMaybi/dsh-harmonyos-hiboard
```

<details>
<summary>或者从本地克隆安装（改源码 / 调试时用）</summary>

```bash
# 路径不要含空格，否则 pnpm 的 file: 依赖会被空格截断
git clone https://github.com/MaybeMeibeMaybi/dsh-harmonyos-hiboard.git <不含空格的路径>
dsh plugin --profile web add "file:<不含空格的路径>"
```

</details>

**2) 填授权码** —— 两种方式，任选其一。

**方式 A（推荐）：图形界面。** 重启 dsh 后打开 **设置 → 插件 → `dsh-harmonyos-hiboard`**，
在「推送设置」卡片里填写。输入框**两种写法都认**：

```text
aaaaaaaaaaaa                                                                # 裸授权码
openclaw config set skills.entries.today-task.config.authCode aaaaaaaaaaaa    # 整条关联指令
```

粘贴整条关联指令时会**自动取出末尾的授权码**，保存前还会显示打码预览（形如 `••••••••wnAD`），
所以不会把整段指令误当成授权码存进去。保存后**立即生效，不需要重启**。

**方式 B：配置文件。** 编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: hiboard-push
  config:
    authCode: <你的授权码>
```

授权码获取：手机 **负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体**。

> **解析顺序**：设置页保存的值 → 补丁层 `hiboard-push.config.authCode` → 环境变量 `DSH_HIBOARD_AUTH_CODE`。
> 设置页会显示**当前生效来源**，所以"我改了一处怎么不生效"一眼可见；
> 卡片上的「清除」会删掉设置页那份，回退到下一层。

> **装完/改过 `package.json` 后一定要重新注入**：profile 里的
> `node_modules/dsh-harmonyos-hiboard` 是 pnpm **复制**进去的，不是链接。
> 只改源目录会被旧副本盖住，表现为"改了没反应"。
> `dsh plugin --profile web install` 之后用
> `Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-harmonyos-hiboard\package.json" -Pattern "dsh-tools"`
> 确认 peer 上界已是 `<0.3.0-0`。

**3) 重启 dsh**，然后让 agent 调用 `hiboard_push`（记得传 `schedule_id`）。

**4) 推送兜底：已内置，默认开启** —— 无需额外安装。

原先的独立插件 `dsh-push-guard` 已并入本包（三级兜底：L1 抢救"被写成纯文本的调用"、
L2 抢救"承诺了却没调用"、L3 按错误类别重试并自动补 `schedule_id`）。
它在**同一张设置卡片**里有一个开关，**默认开启**，关掉**立即生效**（不必重启）。

> **从旧版升级**：如果 profile 补丁层里还留着独立的 `push-guard` 条目，请删掉 ——
> 能力已在本包内，留着会让同一套逻辑挂两份，审计日志也会两处各写一份。

完整步骤（含预检、排错、错误码）见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。

---

## 提供的工具

| 工具 | 作用 |
|---|---|
| `hiboard_push` | 推送一张任务卡片：`name`（标题）、`content`（Markdown，≤5000 字符）、`result`（状态标签）、`schedule_id`（**必传**）、`dry_run`（只校验不发送） |
| `hiboard_verify` | 发送一张「连接测试」卡片，端到端验证授权码与网络 |
| `hiboard_push_selfcheck` | 报告内置兜底是否生效、`hiboard_push` 是否已被接管重试、授权码是否配置、接口是否可达、最近一次推送状态 |

---

## 设置页（插件卡片）

打开 **设置 → 插件 → `dsh-harmonyos-hiboard`**，卡片提供两件事：

1. **授权码输入框** —— 裸授权码与整条关联指令都认（自动取末尾的码），保存前显示打码预览，
   保存后**立即生效**；卡片还显示**当前生效来源**（设置页 / 补丁层 / 环境变量），
   避免"改了一处却不生效"。点「清除」删掉设置页那份，回退到下一层。
2. **推送兜底开关** —— **默认开启**，关掉**立即生效**（不必重启）。

配置写在 `<用户目录>/.dsh/hiboard-push/config.json`（0600，先写临时文件再原子替换）。
该文件属于当前系统用户，本机所有 dsh profile 共用一份。

> ⚠️ **部署安全边界**：卡片靠一个注册在 webServer 上的**原始路由**
> `/hiboard-push/config` 读写配置。它**不继承 dsh Connection 的登录认证**，
> 本插件也不做 Host / Origin 策略 —— 与 modsearch 同类路由性质相同。
> 若 dsh 暴露在需要鉴权的入口后面，**鉴权必须同时覆盖这条路由**；
> 不需要图形界面时，用补丁层 `settingsCard: false` 把路由与卡片一起撤掉。

---

## ⚠️ 第四个坑（最坑的一个）：推送会**静默丢失**

> 2026-09-27 实测事故：一晚连着 3 张卡片没到手机，而 dsh 界面**没有任何报错**。
> 完整复盘见 **[`docs/INCIDENT-2026-09-27-silent-push-loss.md`](docs/INCIDENT-2026-09-27-silent-push-loss.md)**。

工具不会自己调用 —— 而 **agent 可能"以为"自己调用了**。已实测到三种形态，全部是静默失败：

| 形态 | 长什么样 | 为什么没报错 |
|---|---|---|
| **A. 把调用写成正文** | 正文里出现 `<hiboard_push><parameter name="content">…` 这段 XML | 只是普通文本，`turn/end` 依然 `completed` |
| **B. 承诺了却没调用** | 正文写"我把结论推给你："，然后**什么调用都没有** | 同上，从会话记录看一切正常 |
| **C. 标签带额外属性** | `<parameter name="content" string="true">` | 朴素正则匹配不到 `content` → 被当成"参数不全"，安静放弃 |

### 第五个坑：卡片**能到手机、却点不开**

第五种失败更气人：推送**成功**（接口回 `0000000000`），手机上却只有一行标题、
点开没有任何内容 —— 因为**漏传了 `schedule_id`**（第 3 节的规则：`scheduleTaskId`
为空时平台不开放详情页，正文一律不渲染）。2026-09-27 真实翻车。
所以现在不靠"记得传"，而是**双保险**：

| 层 | 做法 | 效果 |
|---|---|---|
| **调用契约** | `schedule_id` 声明为 `required: true` | 漏传被参数校验直接拒绝（`missing required property "schedule_id"`） |
| **宿主兜底** | `push-guard` 检测到漏传/空串/纯空格 → 自动补 `dsh_worklog`（明确传值**不覆盖**） | 到达 HIBoard 的每张卡片都带非空 `scheduleTaskId` |

> 还有一个易被忽略的隐患：重试分类若把"2xx 但响应无 `code` 字段"当成失败，
> 会在卡片**已经推成功**的情况下再推一遍 → **重复卡片**。
> 原则是：宁可少重试，也不要制造重复卡片。

### 修复：内置三级兜底 `src/lib/push-guard.js`

| 级别 | 触发条件 | 行为 |
|---|---|---|
| **L1 rescue** | 正文出现字面量调用标记，且**该轮**从未真正调用 `hiboard_push` | 用同一解析器还原参数，按原样代为推送 |
| **L2 promise** | 该轮未推送，但正文**明确承诺了推送**且正文够长 | 用该轮正文补推，`result` 标注"模型未调用推送工具" |
| **L3 retry** | 工具真调用了但返回失败 | **按错误类别**重试，且**分成两份预算**（`retryCount` / `ambiguousRetryCount`）：<br>· **确定没送达**（ELB 直出的 **HTTP 404**，见 [`docs/ENDPOINT-NOTES.md`](docs/ENDPOINT-NOTES.md)）→ 按 `retryCount`（默认 3）多试几次；<br>· **可能已经送达**（超时 / 无响应 / 5xx / 业务侧未知失败码）→ 只按 `ambiguousRetryCount`（默认 1）少试，因为每次重试都是**新的 `msgId`**、平台不去重，多试就可能多出一张重复卡片；<br>· 永久错误（如 `0000900034`、405）不重试。<br>退避为**指数**（基数 × 2ⁿ⁻¹，封顶 60s），以便跨过几十秒的坏窗口 |

关键实现细节（都是踩出来的）：

- 判定"本轮推过没有"用**轮次号**而非消息序号，否则"上一轮推过"会吃掉本轮的兜底；
- 解析 `<parameter>` 时正则必须允许**额外属性**（`[^>]*>`），否则形态 C 会漏；
- L2 的意图识别**保守优先**：`要不要我把结果推给你？`／`我不会推送这张卡片。` 都不触发；
- 插件的任何异常都内部吞掉并记日志 —— **绝不允许兜底逻辑把宿主 dsh 拖崩**。

### 可观测性（"彻底修好"的关键）

```
<DSH_HOME>/lan/push-guard/
├── startup.json      启动自检：authCode 是否配置、三级开关、pid
├── last-state.json   最近一次兜底推送（哪一轮、哪一级、成功与否）
└── audit.jsonl       流水：push-ok / push-failed / retry-ok / rescue-ok / no-push
```

装好之后，先让 agent 调一次 `hiboard_push_selfcheck` 确认三件事：
**内置兜底生效了、`hiboard_push` 被接管了、授权码配对了**。
在这之前，"保险丝到底有没有生效"只能靠猜 —— 本次事故里就真的猜错过一次。

> 兜底已并入主包，**默认开启**；开关在设置页的同一张卡片上，关掉**立即生效**。
> 因此这里没有"装不装兜底"这一步 —— 只有"要不要关掉它"。

---

## 网络契约

| 项 | 值 |
|---|---|
| 端点 | `POST https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload` |
| 鉴权 | 请求体中的 `authCode`（个人凭据） |
| 必填字段 | `msgId` `scheduleTaskId` `scheduleTaskName` `summary` `result` `content` `source` `taskFinishTime` |
| `source` | 卡片上的**来源 / AI 工具名**（平台按此值做品牌化渲染）。默认 `"OpenClaw"`（与官方 today-task skill 一致）；可用插件的 `source` 配置项改成任意值 —— 实测平台接受自定义值，但渲染样式由平台决定，换值后先在真机上看一眼 |
| 内容上限 | 5000 字符 |
| 成功码 | `0000000000`（也接受 `"0"`） |
| 授权码无效 | `0000900034` |
| 方法限制 | **仅 POST**（GET 返回 405） |
| 间歇性 404 | `404 {"message":"Not Found"}` + `Server: elb`（**没有** `x-nuwa-*` 头）= 华为侧 ELB 坏窗口，**不是**密钥/正文/长度问题；几十秒~十几分钟自行恢复 |

字段细节、卡片形态对照、全部错误码（含 `0200100004` 的 CP 子码含义）见
**[`docs/CARD-CONTRACT.md`](docs/CARD-CONTRACT.md)**；
端点的实测证据、404 的判定方法与"坏窗口自检"见
**[`docs/ENDPOINT-NOTES.md`](docs/ENDPOINT-NOTES.md)**。

> **推送返回 404？** 先别改配置。按 [`docs/ENDPOINT-NOTES.md`](docs/ENDPOINT-NOTES.md) 第 3 节
> "用错误 authCode 探一次"判断是不是坏窗口：返回业务码 `0000900034` 说明端点正常（问题在你这边），
> 返回 ELB 的 404 说明你正处在坏窗口。坏窗口会自己恢复，重试即可 ——
> `push-guard` 已把 HTTP 404 视为**可重试**（指数退避，见下）。

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
│   ├── images/                                真机截图（卡片 / 历史 / 详情页）
│   ├── DEPLOY.md                              从零部署（含排错表）
│   ├── CARD-CONTRACT.md                       负载契约 / 卡片形态 / 错误码
│   ├── AGENTS-rule.md                         全局推送规则模板
│   ├── INCIDENT-2026-09-27-silent-push-loss.md  ★ 推送静默丢失复盘（三级兜底的由来）
│   ├── ENDPOINT-NOTES.md                      ★ 端点实测：间歇性 404 的判定与坏窗口自检
│   ├── UPDATES-2026-10-12.md                   ★ dsh 0.2 兼容：放宽 peer 上界（不修会被拒载）
│   ├── UPDATES-2026-10-11.md                   ★ 重复卡片修复 / 凭据出仓 / 重试预算拆分 / source 可配
│   ├── UPDATES-2026-09-27.md                   ★ 兜底插件 / 可观测性 / schedule_id 双保险
│   └── UPDATES-2026-09-23.md                  演进汇总（远程访问架构与实测结论）
└── src/
    ├── lib/index.js                           宿主半边：两个工具 + 设置页路由 + 兜底装配
    ├── lib/client.js                          浏览器半边：设置卡片（手写 lazy-CJS，零构建）
    ├── lib/authcode.js                        授权码解析：裸码 / 整条关联指令
    ├── lib/config-store.js                    插件自己的配置（原子写、0600、mtime 缓存）
    ├── lib/push-guard.js                      ★ 内置三级兜底（L1/L2/L3 + 自检 + 审计）
    ├── lib/index.js.upstream-backup           上游原始版本，便于比对
    └── cordis.patch.yml                       bundle 补丁（挂载插件用）
```

测试（不随 npm 包发布）：

```
test/
├── authcode.test.mjs        解析规则 + 宿主/客户端副本对齐
└── config-store.test.mjs    合并写入 / null 删除 / 坏文件容错
```

```bash
npm test
```

---

## 兼容性

| 组件 | 版本 |
|---|---|
| DeepSeek Harness (dsh) | **0.1.5**（修复目标）／ **0.2**（兼容，已验证准入） |
| cordis | 4.x |
| Node.js | 18+ |
| HarmonyOS | **7.0.0.107**（实测；仅手机端） |

> **dsh 0.2 注意**：0.2 起会对插件的 `peerDependencies` 做准入检查，
> 不匹配则**整个 bundle 被跳过**（工具随之消失）。
> 本仓库自 **`dsh-harmonyos-hiboard` 0.5.0** 起已放宽 peer 上界到 `<0.3.0-0`。
> 若你用的是更早的副本，请升级或自行放宽，否则在 dsh 0.2 上会被拒载 ——
> 详见 [`docs/UPDATES-2026-10-12.md`](docs/UPDATES-2026-10-12.md)。
>
> 另注意：放宽 peer 后必须**重新注入**（`dsh plugin --profile web install`），
> 因为 profile 的 `node_modules/<pkg>` 是 pnpm 的**注入副本**，不是符号链接。

**平台侧**：华为负一屏「智慧助手·今天」的 HIBoard 云侧接口。
网络契约与官方 `today-task` skill、以及独立 Rust 实现
[`lichtcui/hwpush`](https://github.com/lichtcui/hwpush) 交叉核对一致。

### 卡片正文的 Markdown 渲染实测

详情页（[效果图 ③](docs/images/card-detail.jpg)）实际渲染范围：

| Markdown 语法 | 是否渲染 | 说明 |
|---|---|---|
| `#` `##` 标题 | ✅ | 各级标题正常，长标题会自动换行 |
| `-` 无序列表 | ✅ | 缩进与符号正常 |
| `1.` 有序列表 | ✅ | 编号正常 |
| `**加粗**` | ✅ | 正常 |
| `>` 引用块 | ✅ | 左侧竖线样式正常 |
| **表格 `\| a \| b \|`** | ✅ **支持** | 见下方写法要求 |
| `` `行内代码` `` | 未单独验证 | 建议少量使用 |
| 代码块 ```` ``` ```` | 未单独验证 | 长代码块在窄屏可读性差，建议只放结论 |

**表格写法要求**（实测：格式正确即可正常渲染，[效果图 ③](docs/images/card-detail.jpg) 中即有一张渲染正常的表格）：

1. 表格前**必须留一个空行**，否则可能被当作普通文本
2. 必须有**表头行** + **分隔行** `|---|---|`，两者都不能省
3. 每行的**竖线数量要一致**（列数与表头匹配）
4. 单元格内容**不要跨行**；内容过长会让列被挤窄，建议精简措辞

`content` 会被原样上传、平台按 Markdown 渲染，因此**正文里的换行要写成 `\n`**
（本插件的 `normalizeContent` 也会把误转义的 `\n` 还原成真实换行）。



---

## 安全

- `authCode` 是**个人凭据**：持有它的人可以往你负一屏推卡片。
  不要提交到仓库、不要发群聊。泄露后去负一屏重新取码即可让旧码失效。
- 本仓库所有示例与模板中的授权码一律为 `<AUTH_CODE>` 占位。

## 许可证与致谢

MIT。上游版权归 **Entity-Him** 所有，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
感谢上游作者以及 [`lichtcui/hwpush`](https://github.com/lichtcui/hwpush) 提供的协议参考。
