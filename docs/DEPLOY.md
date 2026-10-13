# 从零部署：把 DSH 结果推到华为负一屏

假设目标机器：Windows + Node.js 18+ + 已安装 dsh（`npm i -g @deepseek-ai/dsh`）。
全程约 5 分钟。

---

## 第 0 步：先拿到授权码

手机负一屏 → **我的 → 动态管理 → 关联账号 → Claw 智能体** → 取得授权码。

> 授权码是个人凭据：持有它的人就能往你负一屏推卡片。别提交、别发群聊。
> 本项目文档与示例里出现的授权码一律用 `<AUTH_CODE>` 占位。

---

## 第 1 步：获取插件源码（可选）

**方式 A：不克隆。** 直接用 GitHub 安装（推荐，见第 2 步方式 A）。

**方式 B：本地克隆**（改源码 / 调试时用）。
**克隆路径必须不含空格**（pnpm / npm 的 `file:` 依赖会把空格路径截断，
报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。

```powershell
git clone https://github.com/MaybeMeibeMaybi/dsh-harmonyos-hiboard.git E:\dsh-vendor\dsh-harmonyos-hiboard
```

> 仓库**根目录**就是插件包（`package.json` 里声明了 `dsh.bundle`）。
> 不要再像旧布局那样只把 `src/` 复制出去单独安装 —— `src/package.json` 已移除。

---

## 第 2 步：安装到 web profile

```powershell
# 方式 A（推荐）：直接从 GitHub 安装
dsh plugin --profile web add github:MaybeMeibeMaybi/dsh-harmonyos-hiboard

# 方式 B：安装本地克隆
dsh plugin --profile web add "file:E:/dsh-vendor/dsh-harmonyos-hiboard"
```

> 前提：本机已安装 **pnpm**（`dsh plugin` 转发给 pnpm）。
> 若报 `'pnpm' is not recognized`：`npm install -g pnpm`，然后重开终端。

安装成功后，`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里会出现
`dsh-harmonyos-hiboard`。

---

## 第 3 步：写入授权码

**推荐做法（图形界面）**：不用命令行 —— 打开 **主界面侧栏的「插件」面板 →
`dsh-harmonyos-hiboard` → 点进它的页面**（**不在「设置」里**，见 README「设置卡片」一节），
在「推送设置」卡片里填。输入框**裸授权码**和**整条关联指令**
（`openclaw config set skills.entries.today-task.config.authCode <AUTH_CODE>`）都认，
保存后立即生效，并显示当前生效来源。

**命令行做法**：编辑（不存在就新建）`~/.dsh/profiles/web/cordis.patch.yml`，加入：

```yaml
- id: hiboard-push
  config:
    authCode: <AUTH_CODE>
```

**解析顺序**：设置页存储（`<用户目录>/.dsh/hiboard-push/config.json`）→ 上面这条 loader entry
的 `config.authCode` → 环境变量 `DSH_HIBOARD_AUTH_CODE`。设置页会显示当前生效来源。

**不要放 `~/.dsh/.env`** —— `DSH_HIBOARD_AUTH_CODE` 是 bootstrap-only 变量，
dsh 会**拒绝启动**并报 `only the launching environment may set`。

---

## 第 4 步：重启 dsh 并验证（**先读注意事项**）

```powershell
# 1) 配置预检（只读，不会起服务；正常输出上万字符，报 Error 就是配置有问题）
dsh --profile web --dump-config | Select-Object -First 5

# 2) 确认端口占用情况 —— 若 3080 已被健康实例占用，无需重启
Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
```

> ⚠️ **重启注意（本项目最常翻车的一步）**
> - 不要在旧实例还在运行时盲目启动新实例，否则报 `EADDRINUSE 3080`——**这通常不代表 dsh 崩了**，
>   而是新实例抢不到端口。先查上面的端口占用。
> - 不要用 `Start-Process -FilePath 'dsh'`：`dsh` 解析到的是 `dsh.ps1`（ExternalScript），
>   会报「不是有效的 Win32 应用程序」。请用 `node.exe + bin.js`，或直接用项目的启动器。
> - 如果改了 `.cmd` / `.ps1` 脚本：**`.cmd`/`.bat` 必须纯 ASCII**（cmd.exe 按系统 ANSI 解码，
>   UTF-8 中文注释会变乱码并吃掉行首 `REM`）；**含非 ASCII 的 `.ps1` 必须带 UTF-8 BOM**
>   （PowerShell 5.1 无 BOM 时按 ANSI 解码，会解析失败）。
>   自检：`([regex]::Matches([IO.File]::ReadAllText('<file>'),'[^\x00-\x7F]')).Count` 应为 0。
> - 跨机迁移时若换了机器，`dsh-entry-startup` 之类的**本地插件也要重新 link**，否则启动报
>   `Cannot find package '...'`。

---

## 第 5 步：推送并确认卡片形态

让 agent（或你自己）调用 `hiboard_push`，**务必传 `schedule_id`**：

```
hiboard_push
  name        : 任务名称（卡片标题）
  content     : Markdown 正文（上限 5000 字符）
  result      : 状态标签，例如「已完成」
  schedule_id : 任意稳定字符串，例如 dsh_worklog      ← 关键：不传则正文不显示
```

**验证成功的判据**：手机负一屏出现该卡片 → **点进去能看到完整 Markdown 正文**。
若只看到一行标题，说明 `schedule_id` 没传或为空。

---

## 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| dsh 启动即崩，报 `undefined (reading 'validate')` | 插件 `Config` 不是 schemastery schema（用了未修的上游版本） | 用本包 `src/lib/index.js`（已修） |
| dsh 启动即崩，报 `only the launching environment may set` | 授权码写进了 `.env` | 删掉那行，改放 `cordis.patch.yml` |
| `Cannot find package 'dsh-harmonyos-hiboard'` | 插件没装进 profile | 重跑第 2 步 |
| `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND` | 源码目录路径含空格 | 换到无空格路径（第 1 步） |
| 推送返回 `0000900034` | 授权码无效/过期 | 重新取码，改 `cordis.patch.yml`，重启 |
| 推送返回 `404 {"message":"Not Found"}`（`Server: elb`） | **华为侧 ELB 坏窗口**：请求没到业务服务，与授权码/正文无关 | 见 [`ENDPOINT-NOTES.md`](ENDPOINT-NOTES.md) 第 3 节：用错误 authCode 探一次即可判定。坏窗口会自行恢复；`push-guard` 已把 404 视为可重试（指数退避） |
| 推送返回 `0000000000` 但卡片只有一行 | 没传 `schedule_id` | 传一个稳定的 schedule_id |
| `0200100004` + 子码 `82600013` | 平台侧「服务动态推送」开关关闭 | 负一屏 → 我的 → 设置/动态管理 打开 |
| 工具 `hiboard_push` 不存在 | 插件只在 `web` profile 注册 | 用 `dsh --profile web` |

## 补充：让"每轮都推送"对所有会话生效

见 `docs/AGENTS-rule.md`。
