# 手工验收清单

## 准备

- [ ] 使用 Chrome 140+ 的干净 profile。
- [ ] 加载 `.output/chrome-mv3/`，确认没有远程脚本或启动错误。
- [ ] 准备 Kimi、ChatGPT、Gemini、DeepSeek 登录态、一个可用的 Chat Completions 服务和一套短/长文本页面。
- [ ] 测试结束后清除 Kimi 登录态、网页会话凭据、兼容 Token 和已授予的 API origin 权限；扩展存储中不应留下 Cookie、正文或未脱敏 fixture。

## 设置与权限

- [ ] 默认后端可在 Kimi Web、ChatGPT Web、Gemini Web、DeepSeek Web、OpenAI Compatible 间保存，重新打开选项页仍保持。
- [ ] Prompt 可保存、恢复默认；空白 Prompt 使用默认文案。
- [ ] API Root 去除尾部 `/`，填写 `/chat/completions` 会被拒绝。
- [ ] 远程 HTTP 被拒绝；HTTPS、localhost、127.0.0.1、::1 按规则通过。
- [ ] 首次保存远程 API Root 出现 origin 授权；修改 Root 后旧 origin 权限被撤销。
- [ ] Token 保存后只显示“已配置”；空白保存保留旧 Token；清除按钮删除 Token。
- [ ] `/models` 返回 200 时兼容 API 测试成功；404/405 只显示“不支持模型探测”；401/403 显示凭据错误。
- [ ] 选项页分别点击 Kimi、ChatGPT、Gemini、DeepSeek 和 OpenAI Compatible 的连接测试；ChatGPT、Gemini、DeepSeek 应收到 PROJECT_OK 并显示原生会话链接，Kimi/兼容端按各自只读探测返回结果。

## 侧边栏与任务

- [ ] 普通网页打开侧边栏后使用默认后端自动开始总结。
- [ ] 切换后端会取消旧任务并停在确认态，不自动发起新请求。
- [ ] 点击“使用此后端重新总结”后才使用临时后端；侧边栏重新打开恢复默认后端。
- [ ] 关闭侧边栏、点击取消、重新总结时旧流不能覆盖新结果。
- [ ] 结果区域显示实际后端、warning、复制按钮；Kimi 显示继续对话，兼容端不显示无效链接。
- [ ] 未配置后端显示打开选项页入口；Kimi 未登录显示登录入口。
- [ ] ChatGPT/Gemini/DeepSeek 分别点击登录按钮完成授权；确认 ChatGPT access token、DeepSeek `userToken` 和 Gemini 登录标记保存在扩展本地存储，Cookie、正文和短期 Gemini `at/bl/f.sid` 不进入存储。
- [ ] 设置页 Web 会话卡片实时验证已打开页面；关闭页面时显示“已保存登录态，尚未实时验证”，退出登录后显示未登录。ChatGPT 安全校验提示不应清除仍有效的本地 credential。
- [ ] 三家分别验证一次已有页面会话和一次无已有页面会话；已有页面被复用，无已有页面时只创建临时登录/验证 Tab，采集后扩展创建的 Tab 自动关闭，用户原有 Tab 不关闭。
- [ ] ChatGPT Web 验证 Web conversation 普通 SSE 和可靠 WebSocket 两种 fixture/网络路径；确认首个快照出现后持续更新 Markdown，最终带 ChatGPT 原生会话链接，reasoning 不显示。
- [ ] Gemini Web 验证后台按保存账号读取 `/u/N/app` 短期参数并解析当前 `StreamGenerate`；确认 `at/bl/f.sid` 不落盘、快照实时替换且最终带 Gemini 原生会话链接。模拟协议/参数失败时显示明确错误，不回退 DOM 代答。
- [ ] DeepSeek Web 验证会话创建、PoW challenge、`DeepSeekHashV1`/SHA-256 solver 和 completion SSE；确认只展示 `RESPONSE` Markdown，忽略 thinking，最终带 DeepSeek 原生会话链接。
- [ ] 同一页面分别使用 Kimi、ChatGPT、Gemini、DeepSeek 和兼容端总结，记录输出长度、结构、事实遗漏和 warning；网页结构变化时应显示明确失败，不得静默使用另一家结果。
- [ ] YouTube 页面选择 Gemini Web 总结时确认不等待扩展字幕提取，Prompt 中包含当前 YouTube URL，并由 Gemini 返回视频总结；协议失败显示错误而不是使用 DOM 答案，切换到其他后端时仍验证各自的提取器路径。

## 内容类型

- [ ] 静态网页、SPA、空正文页面各测试一次。
- [ ] Bilibili 有字幕和无字幕各一次；无字幕保留标题/简介，并只从评论容器提取少量评论摘录，明确标注“不代表视频正文”，不混入推荐区。
- [ ] Bilibili 已登录与未登录各一次；字幕请求在后台脚本完成，未登录时显示登录态 warning，扩展不读取或保存 SESSDATA。
- [ ] Bilibili 多 P 视频测试 URL `?p=2` 与播放器当前 P；确认字幕 CID 与页面 P 一致。
- [ ] YouTube 人工字幕、ASR、无字幕各一次；确认人工字幕优先、JSON3/SRV/TTML/SRT/WebVTT 至少两种格式可解析并保留时间戳；无字幕只使用标题/简介并显示“云端转写尚未接入” warning。
- [ ] 从选项页打开“提取器测试”，扫描并选择已打开的 YouTube、Bilibili、Discourse、知乎、普通网页和 PDF 标签页；确认能直接看到实际提取正文、讨论、评论、时间戳和 warning，也验证输入 URL 新开标签页测试。
- [ ] YouTube 登录/未登录各一次；字幕请求在当前页面上下文完成，扩展不申请或保存 YouTube Cookie；Web 字幕响应为空时确认先复用页面 timedtext 请求/读取 transcript 面板，再确认 Android VR/iOS/TV/VisionOS 备用轨回退生效。
- [ ] YouTube 页面首次打开侧边栏默认选择 Gemini Web 并自动开始总结；普通网页仍使用选项页中的默认后端，侧边栏手动切换后不被自动改回。
- [ ] 文本型 PDF 多页提取成功；扫描 PDF 在兼容端显示明确错误，Kimi 尝试上传原文件。
- [ ] 本地 `file://` 页面和 PDF 分别验证文件访问权限开启/关闭。
- [ ] Linux.do 短主题确认全部帖子按时间顺序出现；长主题确认热门 summary、热门帖直接回复和“部分讨论未展开” warning，且不会超过 200 个帖子/160,000 个讨论字符。
- [ ] 在一个带子路径的 Discourse 站点（如 `/forum/t/...`）确认自动探测成功；在普通站点伪造 `/t/slug/id` 路径确认回退普通网页。
- [ ] 知乎问题页确认前 5 个完整回答、每个 5 条顶层评论及 3 条回复；回答页确认 20 条顶层评论及 3 条回复；分页或未登录失败时保留已读取内容并显示 warning。

## 兼容端长文与错误

- [ ] 正文小于单块上限时只请求一次流式总结。
- [ ] 超过单块上限时顺序显示“正在归纳 n/m”，最终结果不漏块。
- [ ] 超过最大源文本时显示截断 warning。
- [ ] 模拟 429、5xx、临时网络失败，最多重试两次并尊重 `Retry-After`。
- [ ] 模拟 401/403，不重试、不切到 Kimi。
- [ ] 模拟上下文超限，当前块减半；仍失败时显示降低单块字符数提示。
- [ ] 取消请求后不再出现增量文本或旧结果覆盖。
- [ ] ChatGPT/Gemini/DeepSeek 生成中点击取消或关闭侧边栏，确认 runtime Port、SSE/WebSocket 和后台请求均停止，旧快照不覆盖新任务。

## 发布前检查

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过。
- [ ] `.output/chrome-mv3/` 中无 source map、远程脚本、Token、未脱敏 fixture。
- [ ] 重新加载扩展后无未处理 Promise rejection。
- [ ] 记录 Chrome 版本、扩展版本、测试页面类型和失败项；真实数据不入 Git。
