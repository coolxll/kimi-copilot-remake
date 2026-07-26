# Kimi 私有 API 脱敏契约

该文件记录当前实现依赖的最小接口形状，不代表 Kimi 的公开 API 承诺。站点变化时只修改 `src/integrations/kimi/` 并更新这里的脱敏 fixture。

| 顺序 | 方法 | 路径 | 最小响应 |
|---:|---|---|---|
| 1 | GET/POST | `https://www.kimi.com/api/auth/token/refresh` | `{ access_token, refresh_token }` |
| 2 | POST | `/api/pre-sign-url` | `{ url, object_name }` |
| 3 | PUT | 预签名 `url` | HTTP 2xx |
| 4 | POST | `/api/file` | `{ id }` |
| 5 | POST SSE | `/api/file/parse_process` | 事件 JSON 的 `status` 变为 `parsed` |
| 6 | POST | `/api/chat` | `{ id }` |
| 7 | POST SSE | `/api/chat/{id}/completion/stream` | `cmpl.text` 增量，`all_done` 结束 |

## 认证

登录服务打开 `https://www.kimi.com/`，轮询页面 localStorage 的 `refresh_token`，只保存 refresh token（以及刷新后返回的 access/refresh rotation）。Token 不进入 URL、日志、错误消息或测试快照。

每个 `KimiClient` 的 refresh 使用 single-flight。普通请求收到一次 401 时刷新并重放原请求；第二次 401 映射为 `auth-required`，不会无限递归。

## 文件和降级

网页 HTML、原始 PDF、字幕 Markdown 优先走上传/解析。若上传或解析失败但统一文档有 `sourceText`，Provider 发出 warning 后用文本继续；如果没有文本（例如扫描 PDF），保留原始错误。

## SSE

通用 `SseParser` 支持 LF、CRLF、任意 UTF-8 字节边界、多行 data 和注释行。Kimi mapper 只消费已知的 `cmpl`、`content`、`all_done`，未知字段不泄漏到 UI。

生产抓包不得提交。本文件中的示例只描述字段，不包含真实域外 URL、Token、用户 ID、正文或 chat ID。
