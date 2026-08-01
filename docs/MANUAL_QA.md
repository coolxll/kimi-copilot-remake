# 手工验收清单

## 准备

- [ ] 使用 Chrome 140+ 的干净 profile。
- [ ] 加载 `.output/chrome-mv3/`，确认没有远程脚本或启动错误。
- [ ] 准备 Kimi、ChatGPT、Gemini、DeepSeek 登录态、一个可用的 Chat Completions 服务和一套短/长文本页面。
- [ ] 测试结束后清除 Kimi 登录态、兼容 Token 和已授予的 API origin 权限；网页会话不应在扩展存储中留下 Cookie/Token。

## 设置与权限

- [ ] 默认后端可在 Kimi Web、ChatGPT Web、Gemini Web、DeepSeek Web、OpenAI Compatible 间保存，重新打开选项页仍保持。
- [ ] Prompt 可保存、恢复默认；空白 Prompt 使用默认文案。
- [ ] API Root 去除尾部 `/`，填写 `/chat/completions` 会被拒绝。
- [ ] 远程 HTTP 被拒绝；HTTPS、localhost、127.0.0.1、::1 按规则通过。
- [ ] 首次保存远程 API Root 出现 origin 授权；修改 Root 后旧 origin 权限被撤销。
- [ ] Token 保存后只显示“已配置”；空白保存保留旧 Token；清除按钮删除 Token。
- [ ] `/models` 返回 200 时测试连接成功；404/405 只显示“不支持模型探测”；401/403 显示凭据错误。

## 侧边栏与任务

- [ ] 普通网页打开侧边栏后使用默认后端自动开始总结。
- [ ] 切换后端会取消旧任务并停在确认态，不自动发起新请求。
- [ ] 点击“使用此后端重新总结”后才使用临时后端；侧边栏重新打开恢复默认后端。
- [ ] 关闭侧边栏、点击取消、重新总结时旧流不能覆盖新结果。
- [ ] 结果区域显示实际后端、warning、复制按钮；Kimi 显示继续对话，兼容端不显示无效链接。
- [ ] 未配置后端显示打开选项页入口；Kimi 未登录显示登录入口。
- [ ] ChatGPT/Gemini/DeepSeek 分别点击登录按钮打开目标站点；完成登录后在侧边栏逐一选择并重新总结，确认优先复用已打开的同站点 Tab、ChatGPT 优先走页面 Web API、失败时回退 DOM，未申请 cookies 权限，扩展存储中没有 Cookie/Token。
- [ ] 设置页 Web 会话卡片对已打开且已登录的页面显示“当前页面检测到已登录”；关闭对应页面、退出登录或无页面时状态变化合理。检测过程不创建标签页、不提交 Prompt、不产生 Token 存储。
- [ ] 三家分别验证一次已有页面会话和一次无已有页面会话；无已有页面时只创建后台 Tab，已有页面的当前 Chrome Profile 登录态可以直接使用。
- [ ] Gemini Web 验证一次 RPC 优先路径：扩展网络请求能取得页面短期参数并解析 `StreamGenerate`；再模拟协议/参数失败，确认自动回退到 Gemini 页面 DOM，且扩展存储中没有 `at`、`bl`、`f.sid` 或 Cookie。
- [ ] ChatGPT Web 验证一次页面 Web API 优先路径：在已登录 `chatgpt.com` 页面中能读取会话并解析 `/backend-api/conversation` 的 SSE；再模拟接口失败，确认自动回退到页面 DOM，且扩展存储中没有 access token 或 Cookie。
- [ ] 同一页面分别使用 Kimi、ChatGPT、Gemini、DeepSeek 和兼容端总结，记录输出长度、结构、事实遗漏和 warning；网页结构变化时应显示明确失败，不得静默使用另一家结果。
- [ ] YouTube 页面选择 Gemini Web 总结时确认不等待扩展字幕提取，Prompt 中包含当前 YouTube URL，并由 Gemini 返回视频总结；切换到其他后端时仍验证各自的提取器路径。

## 内容类型

- [ ] 静态网页、SPA、空正文页面各测试一次。
- [ ] Bilibili 有字幕和无字幕各一次；无字幕保留标题/简介，并只从评论容器提取少量评论摘录，明确标注“不代表视频正文”，不混入推荐区。
- [ ] Bilibili 已登录与未登录各一次；字幕请求在后台脚本完成，未登录时显示登录态 warning，扩展不读取或保存 SESSDATA。
- [ ] Bilibili 多 P 视频测试 URL `?p=2` 与播放器当前 P；确认字幕 CID 与页面 P 一致。
- [ ] YouTube 人工字幕、ASR、无字幕各一次；确认人工字幕优先、JSON3/SRV/TTML/SRT/WebVTT 至少两种格式可解析并保留时间戳；无字幕只使用标题/简介并显示“云端转写尚未接入” warning。
- [ ] 从选项页打开“提取器测试”，扫描并选择已打开的 YouTube、Bilibili、普通网页和 PDF 标签页；确认能直接看到实际提取正文、字幕、时间戳和 warning，也验证输入 URL 新开标签页测试。
- [ ] YouTube 登录/未登录各一次；字幕请求在当前页面上下文完成，扩展不申请或保存 YouTube Cookie；Web 字幕响应为空时确认先复用页面 timedtext 请求/读取 transcript 面板，再确认 Android VR/iOS/TV/VisionOS 备用轨回退生效。
- [ ] YouTube 页面首次打开侧边栏默认选择 Gemini Web 并自动开始总结；普通网页仍使用选项页中的默认后端，侧边栏手动切换后不被自动改回。
- [ ] 文本型 PDF 多页提取成功；扫描 PDF 在兼容端显示明确错误，Kimi 尝试上传原文件。
- [ ] 本地 `file://` 页面和 PDF 分别验证文件访问权限开启/关闭。

## 兼容端长文与错误

- [ ] 正文小于单块上限时只请求一次流式总结。
- [ ] 超过单块上限时顺序显示“正在归纳 n/m”，最终结果不漏块。
- [ ] 超过最大源文本时显示截断 warning。
- [ ] 模拟 429、5xx、临时网络失败，最多重试两次并尊重 `Retry-After`。
- [ ] 模拟 401/403，不重试、不切到 Kimi。
- [ ] 模拟上下文超限，当前块减半；仍失败时显示降低单块字符数提示。
- [ ] 取消请求后不再出现增量文本或旧结果覆盖。

## 发布前检查

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过。
- [ ] `.output/chrome-mv3/` 中无 source map、远程脚本、Token、未脱敏 fixture。
- [ ] 重新加载扩展后无未处理 Promise rejection。
- [ ] 记录 Chrome 版本、扩展版本、测试页面类型和失败项；真实数据不入 Git。
