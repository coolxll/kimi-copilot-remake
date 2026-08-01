# Kimi Copilot Remake

一个 Manifest V3 Chrome 侧边栏扩展，使用统一的 `SummaryProvider` 契约支持多套独立后端：

- **Kimi Web**：复用当前浏览器中的 Kimi 登录态，支持文件上传、解析、会话和“去 Kimi 继续对话”。
- **网页会话后端**：登录时采集 ChatGPT/DeepSeek 的可复用 Token，正常请求在扩展后台通过 Web 协议流式生成；Gemini 每次刷新短期请求参数。凭据保存在本机扩展存储，站点页面只用于登录或安全验证。
- **OpenAI Compatible**：使用用户配置的 API Root、Model 和 API Token 调用流式 Chat Completions，长内容自动分块归纳。

V1 是个人或内部 BYOK 工具。兼容 API Token 只保存在本机 `chrome.storage.local`，会从扩展页面直接发送到用户配置的服务；不要把它当作面向不受控用户的 SaaS 密钥托管方案。

## 开发

```bash
pnpm install
pnpm dev       # WXT 开发模式
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm zip       # 生成可分发 zip
```

如果系统没有 `pnpm` 命令，但已安装 Node.js 22，可用 Corepack 直接执行同一套命令：

```bash
corepack pnpm install
corepack pnpm build
```

本机已经存在依赖时，也可以直接运行 `npm run build`。

也可以执行 `pnpm check` 一次完成 lint、类型检查、单元测试和生产构建。

构建产物位于 `.output/chrome-mv3/`。在 Chrome 中打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”并选择该目录。

## 使用

1. 打开扩展选项页，选择默认后端并编辑 Prompt。
2. Kimi Web 点击“登录 Kimi”；ChatGPT/Gemini/DeepSeek 点击对应的登录按钮；兼容端填写 API Root 和 Model，并按需保存 Token。
3. 远程 API Root 必须为 HTTPS；HTTP 只允许 `localhost`、`127.0.0.1` 和 `::1`。保存时扩展会请求对应 origin 的可选权限。
4. 打开网页后点击扩展图标或快捷键。侧边栏首次使用默认后端自动总结。
5. 下拉框切换后端只影响当前侧边栏实例；切换后需点击“使用此后端重新总结”，失败不会自动换后端。网页会话后端会在后台实时输出累计 Markdown 快照，站点页面不会被填充 Prompt；登录态失效时点击提示按钮重新采集，成功后自动重试。

Bilibili 字幕请求在扩展后台使用最小固定站点权限和当前浏览器会话，不会读取或保存 Cookie。没有可用字幕时，扩展保留标题/简介，并尝试从页面评论容器提取少量摘录；评论会明确标注为非视频正文。

YouTube 字幕沿用 BiliNote 的人工字幕优先策略：从当前页面播放器状态和 Performance timeline 读取字幕轨，必要时回退到页面同源 InnerTube player 请求，优先人工中文/英文，再使用自动字幕。字幕请求优先复用页面已经带 PO Token 的 timedtext URL，再按 BiliNote 的去 `fmt` 方式和 yt-dlp 的格式顺序尝试 JSON3、SRV、TTML、SRT、WebVTT；若当前 Web 字幕轨因客户端/PO Token 返回空内容，会先读取 YouTube 自己的 transcript 面板，再回退请求 Android VR、iOS、TV、VisionOS 播放器客户端的字幕轨。请求在当前 YouTube 页面上下文中完成，同源请求带页面会话，扩展不申请或保存 YouTube Cookie；没有字幕时仅保留标题/简介，云端转写暂未接入。

YouTube 页面默认使用 Gemini Web：扩展不等待字幕提取，直接把当前 YouTube URL 交给 Gemini 页面会话，由 Gemini 自己处理视频、字幕和可用内容；用户仍可在侧边栏临时切换到其他后端，Kimi、ChatGPT、DeepSeek 与兼容 API 切换后使用扩展提取结果。

Gemini Web 的专用路径参考了 [Gemini Nexus](https://github.com/yeahhe365/Gemini-Nexus) 的逆向协议：每次后台请求先从 Gemini `/app` 获取短期 `at/bl/f.sid` 参数，再调用 `StreamGenerate` 并把累计 RPC 文本实时发送到侧栏。参数只在本次请求内存中存在，不写入扩展存储；这不是 Google 官方 API，协议可能随时漂移，失败会要求重新验证登录，不会回退 DOM 代答。

选项页的“提取器测试”会打开独立诊断页；用户可以扫描已打开的 YouTube、Bilibili、普通网页和 PDF 标签页，也可以输入 URL 在新标签页中测试，直接查看实际提取到的正文、字幕和 warning。诊断页只在用户操作时请求目标页面的精确 origin 权限，不申请或保存站点 Cookie。

兼容端只承诺 Chat Completions 的文本子集：`POST <apiRoot>/chat/completions`，支持 SSE `data: {...}`、`[DONE]` 和服务商忽略 `stream` 时返回的普通 JSON。设置页的“测试连接”使用 `<apiRoot>/models`，404/405 仅提示不支持模型探测，不阻止保存。

网页会话后端是实验性适配器，不调用各家公开 API，也不伪装成稳定 API。ChatGPT 通过缓存的 access token 在扩展后台调用 Web conversation SSE/WebSocket；DeepSeek 通过缓存的 `userToken` 换取短时 access token，再在后台执行会话创建、PoW 和 SSE；Gemini 通过后台 `credentials: include` 调用逆向 Web RPC。三者都保留原生会话并提供站点继续对话链接，原始 Markdown 会在生成过程中实时渲染。站点页面只用于首次登录或 WAF 验证，扩展不读取 Cookie、不自动填写 Prompt、不抓取 DOM 答案。站点登录失效、协议变化、PoW 或内容加载失败会显示明确错误。

设置页的 Web 会话状态仅对已打开的对应站点页面执行只读 DOM 检查；检测到输入区或会话 UI 时显示“当前页面检测到已登录”，不会创建标签页、发送 Prompt 或保存 Token。

## 目录

```text
entrypoints/                 WXT background、sidepanel、options、提取器测试页
src/domain/                  Provider、文档、设置和错误契约
src/application/             任务状态机与总结用例编排
src/extractors/              网页、Bilibili、YouTube、PDF.js 提取器
src/integrations/kimi/       Kimi 登录态、Token 刷新、上传和 SSE
src/integrations/openai-compatible/
                             兼容 API、SSE、重试和分块归并
src/integrations/web-session/
                             后台流式 Web 协议、Token 采集、ChatGPT/Gemini/DeepSeek 适配器
src/platform/chrome/         storage 与动态 host permission
src/ui/                      侧边栏、选项页和样式
tests/unit/                  SSE、分块、reducer、兼容端协议测试
docs/                        架构、契约、手工验收和开发说明
```

## 文档

- [执行计划与当前状态](<docs/DEVELOPMENT.md>)
- [架构与数据流](<docs/ARCHITECTURE.md>)
- [Kimi 脱敏契约](<docs/KIMI_API_CONTRACT.md>)
- [功能对照矩阵](<docs/PARITY_MATRIX.md>)
- [手工验收清单](<docs/MANUAL_QA.md>)

原始探索记录和历史计划保留在 [HANDOFF.md](<HANDOFF.md>)。

内置 DeepSeek PoW WebAssembly 模块的来源和许可证见 [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>)。
