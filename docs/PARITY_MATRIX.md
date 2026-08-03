# 功能对照矩阵

状态：`✅` 已实现并有自动化覆盖，`🧪` 需要真实 Chrome/站点手工验证，`⬜` 未进入 V1。

| ID | 场景 | Kimi Web | Web Session（三家） | OpenAI Compatible | 验证方式 |
|---|---|---:|---:|---:|---|
| P0-01 | 图标/快捷键打开 tab-specific side panel | ✅ | ✅ | ✅ | 手工 |
| P0-02 | 默认 Provider 自动启动 | ✅ | 🧪 | ✅ | reducer + 手工 |
| P0-03 | 临时切换且不自动发请求 | ✅ | ✅ | ✅ | reducer + 手工 |
| P0-04 | 失败不跨 Provider fallback | ✅ | ✅ | ✅ | Provider/用例测试 |
| P0-05 | 普通网页正文提取 | ✅ | 🧪 | ✅ | 手工 |
| P0-06 | 流式 Markdown、复制、重试 | ✅ | 🧪 | ✅ | reducer + 手工 |
| P0-07 | 自定义 Prompt 与默认值 | ✅ | 🧪 | ✅ | storage + 手工 |
| P0-08 | 未登录/Token 无效 | ✅ | 🧪 | 不适用 | 手工 |
| P0-09 | Token 401 刷新一次、并发 single-flight | ✅ | 不适用 | 不适用 | 契约 fixture |
| P0-10 | API Root、Token 和 origin 权限 | 不适用 | 不适用 | ✅ | 权限手工 |
| P0-11 | SSE 任意字节边界与普通 JSON fallback | 不适用 | 不适用 | ✅ | unit |
| P0-12 | 429/5xx/网络重试与取消 | 不适用 | 🧪 | ✅ | unit/手工 |
| P0-13 | 长文分块、递归归并、截断 warning | 不适用 | 🧪 | ✅ | chunk unit + 手工 |
| P0-14 | Kimi 继续对话链接 | ✅ | 不适用 | 不适用 | 手工 |
| P0-15 | ChatGPT/Gemini/DeepSeek 页面会话复用 | 不适用 | 🧪 | 不适用 | 干净 Chrome profile 手工 |
| P1-01 | Bilibili 字幕/保守元数据 fallback | 🧪 | 🧪 | 手工；字幕接口优化待后续 |
| P1-02 | YouTube 字幕/保守元数据 fallback | 🧪 | 🧪 | 手工；人工优先、PO Token timedtext/transcript 面板、多格式字幕与 InnerTube fallback；云端转写待后续 |
| P1-03 | 文本型 PDF | ✅ | ✅ | 手工 |
| P1-04 | 扫描 PDF | ✅ 尝试上传原文件 | ✅ 明确不可提取错误 | 手工 |
| P1-05 | 旧设置迁移 | ✅ | ✅ | unit |
| P1-06 | Discourse 主题、热门帖子与直接回复 | 🧪 | 🧪 | 手工；通用自动探测与安全上限 |
| P1-07 | 知乎问题/回答、评论与回复 | 🧪 | 🧪 | 手工；接口分页与部分 warning |
| P2-01 | Kimi 网页表格补丁 | ⬜ | 不适用 | 独立 ADR |

真实 Chrome 验证必须使用干净 profile，且不把 Token、正文或模型输出写入仓库。
