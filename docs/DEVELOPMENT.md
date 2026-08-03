# 执行计划与当前状态

## 目标

在不把 Kimi 私有 API、浏览器能力或具体 UI 渗透到业务编排的前提下，交付一个可维护的 Chrome 扩展。所有后端都实现 `SummaryProvider`，输入统一为 `ExtractedDocument`，输出统一为 `SummaryEvent`。

## 已完成

### M0：契约与基线

- 已冻结 Provider、文档、设置 V2、错误和任务事件类型。
- 已实现可脱敏的 SSE parser、分块函数和 Chat Completions fixture 测试。
- 已保留 Kimi 的请求路径与事件映射在独立适配层。

### M1：工程骨架

- WXT + React + TypeScript strict + Vitest + ESLint。
- background、sidepanel、options 三个入口。
- `SettingsRepository`、迁移逻辑、Provider registry 及任务 reducer。
- `pnpm lint/typecheck/test/build` 质量命令。

### M2：兼容 API 普通网页 MVP

- API Root 校验、动态 optional host permission、Token 独立存储。
- Chat Completions SSE、任意字节边界、UTF-8、`[DONE]`、普通 JSON。
- 401/403、429、5xx、网络失败、Retry-After、AbortSignal 和上下文超限处理。
- 按标题/段落边界分块，顺序局部摘要、递归归并、最终流式输出、截断 warning。

### M3：Kimi 普通网页

- 登录标签页轮询 refresh token、Token 刷新 single-flight 和一次 401 重试。
- 网页 HTML 上传、文件解析、创建 chat、流式 completion 和继续对话链接。
- 文件失败后有 `sourceText` 时显式降级为文本。

### M4：特殊提取器

- Bilibili 字幕、分 P 选择与当前视频元数据的保守 fallback。
- Bilibili API/字幕资源改由扩展后台脚本直拉，使用最小固定 host permissions 和浏览器会话，不读取或保存 Cookie；无字幕时补充少量页面评论摘录并明确标注其非正文性质。
- YouTube 迁移 BiliNote 的人工字幕优先策略；从当前播放器状态、Performance timeline 或同源 InnerTube player 请求合并字幕轨，优先复用页面已带 PO Token 的 timedtext URL，再按 BiliNote 的去 `fmt` 方式和 yt-dlp 格式顺序读取 JSON3/SRV/TTML/SRT/WebVTT；当前 Web 字幕轨因客户端/PO Token 返回空内容时，回退读取 YouTube transcript 面板，再请求 Android VR、iOS、TV、VisionOS 客户端字幕，并保留时间戳和滚动字幕去重；无字幕时保留标题/简介，不接入本地 Whisper。
- 选项页提供统一的提取器测试页，可对已打开或输入 URL 的 YouTube、Bilibili、普通网页和 PDF 查看实际 `sourceText` 与 warning；测试时按目标页面精确申请可选 origin 权限。
- 已将 ChatGPT、Gemini、DeepSeek 的实验性网页会话 Provider 重构为后台 runtime Port + Web 协议流：登录时优先复用同站点 Tab，否则创建临时登录/验证 Tab；ChatGPT 缓存 `/api/auth/session` access token 并支持 conversation SSE/可靠 WebSocket，Gemini 每次刷新 `/app` 的短期参数并参考 [gemini-nexus](https://github.com/yeahhe365/gemini-nexus) 调用 `StreamGenerate`，DeepSeek 缓存 `userToken`、按需换取短时 access token，再执行会话创建、PoW 和 completion SSE。三家通过累计 Markdown 快照实时更新侧边栏，reasoning/thought 不进入 UI；登录/验证 Tab 只用于授权/WAF，不作为答案 DOM 兜底，协议变化显示明确错误。
- Web 会话凭据按 Provider 保存在 `chrome.storage.local` 的独立 key；ChatGPT 请求时读取的 Cookie/oai-did 只存在单次请求内存，不写入存储，正文不落盘，Gemini `at/bl/f.sid` 也只存在单次请求内存。设置页会重新验证已打开站点页面；只有保存但没有可验证页面时显示未验证状态。ChatGPT、Gemini、DeepSeek 的连接测试会发送固定 PROJECT_OK，因此会创建测试会话。
- YouTube 页面默认选择 Gemini Web，并直接提交当前视频 URL，不等待扩展字幕提取；这是 Gemini 专用能力，Kimi、ChatGPT、DeepSeek 和兼容 API 手动切换后仍走统一提取链路。
- 本地打包 PDF.js worker；PDF 文本给兼容端，原始 PDF 给 Kimi。

### M5：讨论站点提取

- Discourse 通用提取器支持根路径和子路径安装，自动通过 URL、DOM 标记与同源主题 JSON 探测站点，不维护域名 allowlist；短主题完整读取，长主题使用原生 summary + 热门回复展开，带帖子数和讨论字符安全上限。
- 知乎问题/回答提取器读取完整回答与受控评论树：回答页 20×3，问题页前 5 个回答各 5×3；评论分页校验回答归属，首个核心接口失败退回 DOM，后续接口失败保留部分内容并标记 warning。
- 参考 opencli 的通用模式：树状回复的安全上限和省略标记、分页中断 warning、顶层评论与回复额度分离、同源身份校验。后续可复用到 Bilibili/V2EX/HN/Lobsters/Reddit 等站点，但本阶段不新增第三方 provider。

### 视频提取器优化 backlog（不阻断 V1）

Bilibili 和 YouTube 的字幕依赖登录态、站点接口及播放器页面结构，不能把“无字幕时的整页文本”当作可靠正文。当前实现只在拿到字幕时生成完整视频文稿；无字幕时仅保留标题/简介/播放器区域，并在 Bilibili 页面存在可见评论时补充有限摘录且显示 warning。

后续可独立优化：

- Bilibili：互动视频 CID、字幕轨道权限和接口限流重试；AI 字幕质量筛选或音频转写。
- YouTube：播放器对象继续变化、字幕权限/翻译轨道、PO Token，以及后续云端转写服务。
- 两者都应增加脱敏真实站点 fixture 和人工回归，不把评论区、推荐区或整页 DOM 作为静默 fallback。

## 当前验收结果

截至 2026-08-01，以下本地检查已通过：

| 检查 | 命令 | 结果 |
|---|---|---|
| ESLint | `./node_modules/.bin/eslint .` | 通过 |
| 类型检查 | `./node_modules/.bin/tsc --noEmit` | 通过 |
| 单元测试 | `./node_modules/.bin/vitest run` | 20 个文件、107 个测试通过 |
| 生产构建 | `./node_modules/.bin/wxt build` | 通过 |

构建包包含本地 `pdf.worker.mjs`，没有远程脚本。首次安装依赖后优先使用 `pnpm check` 复核全部质量门。

## 继续执行顺序

1. 用脱敏 fixture 扩充 Kimi refresh、上传、解析和 `all_done` 契约测试。
2. 增加 fake browser 集成测试，覆盖 sidepanel 自动启动、取消、临时切换和旧流隔离。
3. 在干净 Chrome profile 运行 [手工验收清单](<MANUAL_QA.md>)，记录真实 Kimi 和四类页面结果。
4. 修复实际站点结构变化后再发布 `0.3.0-beta.1`；Kimi 网页表格补丁继续作为 P2 ADR，不阻断 V1。

## 质量门

每次提交至少执行：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

禁止提交真实 Token、正文、模型输出、未经脱敏的抓包、Chrome profile、source map 或 `.env`。
