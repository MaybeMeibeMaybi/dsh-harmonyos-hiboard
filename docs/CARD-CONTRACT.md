# 卡片契约：负载字段、卡片形态、错误码

本文件是**这一个项目的核心知识**。所有结论都来自实测（2026-09-23）与官方/第三方参考实现
（`today-task` skill、Rust 实现 `hwpush`）的交叉核对。

---

## 1. 端点与请求

| 项 | 值 |
|---|---|
| 端点 | `POST https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload` |
| 内容类型 | `application/json; charset=utf-8` |
| 追踪头 | `x-trace-id: task-push-<yyyyMMddHHmmss>` |
| User-Agent | `OpenClaw-TaskPusher/2.0`（与官方客户端一致） |
| 方法限制 | **只接受 POST**；对同一路径发 GET 返回 `405 Method Not Allowed` |
| 鉴权 | 仅靠请求体里的 `authCode`（个人凭据） |

---

## 2. 请求体（8 个字段，全部必填）

```json
{
  "data": {
    "authCode": "<AUTH_CODE>",
    "msgContent": [
      {
        "msgId": "dsh_<epoch秒>_<随机8位>",
        "scheduleTaskId": "dsh_worklog",
        "scheduleTaskName": "任务名称",
        "summary": "任务名称",
        "result": "已完成",
        "content": "# Markdown 正文\n\n- 支持列表\n- 支持 **加粗**",
        "source": "OpenClaw",
        "taskFinishTime": 1790135654
      }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `msgId` | 消息唯一 ID。本插件用 `dsh_<秒级时间戳>_<uuid前8位>`；参考实现用 `hwpush_<毫秒>`。两者服务端都接受 |
| `scheduleTaskId` | **决定卡片形态的关键字段**，见下节 |
| `scheduleTaskName` | 卡片标题栏文字 |
| `summary` | 摘要（与标题一致即可） |
| `result` | 状态标签文字，默认「任务已完成」 |
| `content` | Markdown 正文，**上限 5000 字符**，换行用 `\n` |
| `source` | 固定 `"OpenClaw"` —— 平台按此值做品牌化渲染，**不要改** |
| `taskFinishTime` | Unix 秒级时间戳 |

---

## 3. ⚠️ 卡片形态：为什么必须传 `scheduleTaskId`

**实测结论**：

| 形态 | 填充方式 | 手机上的表现 |
|---|---|---|
| **周期任务卡片** | `scheduleTaskName + summary + result + content`，且 **`scheduleTaskId` 非空** | 点击后**打开完整详情页，渲染整段 Markdown 正文** ✅ |
| 标准任务卡片 | 同上，但 **`scheduleTaskId` 为空字符串** | **只有一行标题 + 时间 + 来源**；正文完全不显示，深链无响应 ❌ |

也就是说：`content` 字段本身没问题（实测负载里 274 字符带换行，序列化正确），
**但平台只对"有 scheduleTaskId"的卡片开放详情页**。

**因此本项目的推送调用一律带 `schedule_id`**，同一会话用同一个 ID 还能在负一屏分组。

---

## 4. 返回码

| 返回 | 含义 | 处理 |
|---|---|---|
| HTTP 200 + `"0000000000"` | 成功 | — |
| `"0"` | 成功（官方客户端也接受） | — |
| `"0000900034"` | **授权码无效/未授权** | 重新取码，改 `cordis.patch.yml`，重启 dsh |
| `"0200100004"` + CP 子码 `82600017` | 设备离线或未登录华为账号 | 检查手机 |
| `"0200100004"` + CP 子码 `82600013` | **服务动态推送开关关闭** | 负一屏 → 我的 → 设置/动态管理 里打开 |
| `"0200100004"` + CP 子码 `82600005` | 服务云端暂时不可用 | 稍后重试 |
| `"0000500001"` | 缺少必要请求头（如 `x-trace-id`） | 检查请求头 |
| HTTP 405 | 用了 GET | 必须 POST |

---

## 5. 内容格式建议（基于实测可渲染的样例）

能正常渲染的 Markdown 结构：

```markdown
# 一级标题

## 二级标题

- 列表项一
- 列表项二

**加粗** 与 `行内代码`

1. 有序项
2. 有序项

> 引用行
```

**注意事项**：

- 上限 **5000 字符**，超长会被插件拒绝（`validatePush` 会先报错，不会静默截断）。
- 建议推送**每轮的结论**，而不是整段原始日志；超长时推精简版并在开头注明已截断。
- 支持中文标点与 emoji（实测 `✅`、`⚠️`、`🎉` 均正常）。

---

## 6. 安全

- `authCode` 是个人凭据：**持有者可以往你负一屏推任意卡片**。
- 存放位置：`~/.dsh/profiles/web/cordis.patch.yml`（私有目录，勿提交、勿外传）。
- 一旦泄露：去负一屏重新取码即可让旧码失效。
