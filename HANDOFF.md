# Kimi Copilot Remake：可执行重写计划

> **实现状态更新（2026-07-24）**：本仓库已按“双后端执行计划”完成工程骨架和首个可运行版本。当前实现同时包含 `kimi-web` 与 `openai-compatible` Provider、统一文档契约、动态 API origin 权限、Chat Completions 分块归纳、PDF.js 本地 worker、选项页和侧边栏。本文后续章节保留早期探索与行为基线；最新的执行状态、开发命令和双后端验收以 [README.md](<README.md>)、[docs/DEVELOPMENT.md](<docs/DEVELOPMENT.md>)、[docs/ARCHITECTURE.md](<docs/ARCHITECTURE.md>) 为准。

## 1. 项目结论

本项目不是继续修补打包产物，而是以原扩展 `kimi-copilot-patched` 为行为基线，重新实现一个可构建、可测试、可发布的 Chrome Manifest V3 扩展。

交付策略：

1. 先冻结原扩展的真实行为和接口契约。
2. 先完成普通网页总结的端到端最小闭环。
3. 再按独立提取器补齐 Bilibili、YouTube、PDF。
4. 最后完成兼容性、安全、回归测试和发布打包。

“复刻完成”的判断标准不是界面看起来相似，而是核心场景的输入、状态、错误和输出均通过功能对照测试，同时新项目具备稳定的构建、类型检查、测试和发布流程。

当前状态（历史基线已完成）：

- `kimi-copilot-remake` 已初始化为 WXT + React + TypeScript strict 工程，生产构建位于 `.output/chrome-mv3/`。
- 已完成统一 `SummaryProvider` 契约和两套独立后端；Kimi 私有 API 仍隔离在 `src/integrations/kimi/`。
- 已完成普通网页、Bilibili、YouTube、PDF.js 提取器、任务 reducer、设置迁移、动态 host permission 与基本单元测试。Bilibili/YouTube 当前采用“字幕优先、无字幕保守降级”，完整站点适配与无字幕转写列为后续优化，不把整页 DOM 当作可靠正文。
- 当前未完成项主要是脱敏 Kimi fixture 的扩充、fake browser 集成测试、真实 Chrome profile 手工验收和发布前安全扫描，见 [docs/DEVELOPMENT.md](<docs/DEVELOPMENT.md>)。
- 原始行为基线位于 `/Users/lynn/Workspace/kimi-copilot-patched`。
- 原扩展版本为 `1.13.0`，Manifest V3。
- 原项目只有格式化后的打包产物，没有可恢复的 TypeScript 源码。
- Kimi 接口属于网页私有 API，是项目中最大的不确定性，必须隔离在适配层并通过契约样本验证。

---

## 2. 目标、范围与成功标准

### 2.1 产品目标

用户在任意受支持页面点击扩展图标或快捷键后，Chrome 侧边栏打开并自动选择默认后端：

1. 识别当前页面类型。
2. 提取普通网页正文、视频字幕或 PDF。
3. 使用用户的 Kimi 登录态，或用户配置的 OpenAI Compatible Chat Completions，处理内容。
4. 流式展示 Markdown 总结。
5. 支持复制结果、Kimi 跳转继续对话、修改默认提示词和临时切换后端。

### 2.2 工程目标

- TypeScript 严格模式，业务模块具有明确输入、输出和错误类型。
- UI、浏览器能力、内容提取、认证和具体 Provider 相互隔离。
- Kimi 私有 API 或兼容服务协议变化只需要修改对应的 `src/integrations/` 适配层。
- 新页面类型只需要新增 extractor 并注册，不修改主流程。
- 任意提交均可执行 lint、typecheck、unit test、build。
- CI 不依赖真实 Kimi 账号，也不保存真实 token。
- 生产包可直接在 `chrome://extensions` 以“加载已解压的扩展程序”验证。

### 2.3 V1 成功标准

以下条件必须全部满足：

- P0 和 P1 功能对照项全部通过。
- 普通网页、Bilibili、YouTube、PDF 至少各有一个成功样例和一个失败样例。
- 登录、token 过期、401 刷新、退出登录四条认证路径通过。
- SSE 被任意字节边界切分时仍能正确解析。
- 侧边栏关闭或来源标签页变化时，正在进行的请求能够取消。
- 自定义 Prompt 保存后重新打开浏览器仍生效，恢复默认正常。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。
- 生产包中不包含 source map、真实 token、抓包原文或调试凭据。
- Chrome 中无未处理 Promise rejection、无持续报错、无明显内存泄漏。
- README、架构说明、手工回归清单和发布步骤齐全。

### 2.4 明确不做

- 不尝试还原原项目每一个混淆变量或第三方依赖。
- 不复制原包内的 PostHog/遥测逻辑；V1 默认不采集分析数据。
- 不在 V1 支持 Firefox、Safari 或 Edge 专属行为。
- 不提供多轮聊天 UI；完成总结后跳转 Kimi 继续对话。
- 不在 CI 中调用真实 Kimi、Bilibili 或 YouTube 接口。
- 不承诺 Kimi 私有 API 永久兼容，只保证适配层可替换且失败可诊断。
- 不把 `fix-tables.js` 默认视为核心能力；它修补的是 Kimi 网页本身而非扩展侧边栏，需在 P0/P1 完成后单独决定是否保留。

---

## 3. 原扩展行为基线

### 3.1 已确认的数据流

```text
用户点击图标/快捷键
  → background 校验 URL 并打开 tab-specific side panel
  → side panel 获取 tabId 和 URL
  → 获取或引导获取 Kimi refresh_token
  → 根据 URL 选择内容提取器
  → 生成 HTML / Markdown / PDF File
  → Kimi pre-sign → 上传 → 注册文件 → 等待解析
  → 创建 chat
  → 发送 prompt + file reference
  → 解析 SSE 增量
  → 渲染 Markdown
  → 复制结果 / 去 Kimi 继续对话
```

### 3.2 已确认的 Kimi 接口

| 能力 | 接口 | 备注 |
|---|---|---|
| 刷新 token | `POST /api/auth/token/refresh` | Bearer refresh token |
| 创建会话 | `POST /api/chat` | 返回 chat id |
| 获取上传地址 | `POST /api/pre-sign-url` | 返回上传 URL 和 object name |
| 注册文件 | `POST /api/file` | 上传成功后调用 |
| 文件解析 | `POST /api/file/parse_process` | SSE，等待 `parsed` |
| 流式总结 | `POST /api/chat/{id}/completion/stream` | SSE，处理 `cmpl`、`content`、`all_done` |

上述接口只能作为当前观察到的契约，不应散落在组件或提取器中。

### 3.3 功能优先级与对照范围

| 优先级 | 功能 | 原扩展行为 | 新实现验收方式 |
|---|---|---|---|
| P0 | 图标/快捷键打开侧边栏 | 无效页面通知；有效页面打开 tab-specific panel | HTTP(S)、file、受限页各验证一次 |
| P0 | Kimi 登录态 | 从 Kimi 页读取 refresh token，保存到 local storage | 已登录、未登录、token 失效 |
| P0 | 普通网页提取 | 获取标题、HTML、innerText，上传失败时用文本兜底 | 文章页、SPA、空页面、受限页面 |
| P0 | API 调用 | 刷新 token、上传、解析、建会话、发送消息 | 使用脱敏契约 fixture 和一次人工真机验证 |
| P0 | SSE 流式输出 | 累积 `cmpl.text`，识别引用和结束事件 | 分块、跨行、错误 JSON、中途取消 |
| P0 | 侧边栏 UI | 加载、结果、错误、复制、继续对话 | 状态转换和手工交互测试 |
| P0 | 自定义 Prompt | 编辑、保存、恢复默认 | 重启后仍保持 |
| P1 | Bilibili 字幕 | 标题、描述、字幕组成 Markdown | 有字幕、无字幕、接口失败 |
| P1 | YouTube 字幕 | 优先人工字幕，再按中文/英文排序 | 人工字幕、ASR、无字幕 |
| P1 | PDF | 获取当前 PDF 原始数据并上传 | 普通 PDF、arXiv、读取失败 |
| P1 | 错误恢复 | 401 清理登录态，提取/上传失败显示可理解错误 | 错误分类逐项验证 |
| P2 | Kimi 网页表格补丁 | 在旧域名页面中修复流式 Markdown 表格 | 单独 ADR 决定是否进入产品 |

### 3.4 已知问题，重写时不能照搬

- 原 `request()` 在 401 时递归重试，没有明确次数上限；新实现只允许刷新后重试一次。
- 原自动登录创建隐藏标签页后立即读取 localStorage，可能早于页面加载；新实现必须等待标签页完成加载。
- 原侧边栏把完整 URL 放在 query string；新实现只传 `tabId`，再通过 Chrome API 读取当前 URL，避免陈旧或超长 URL。
- 原 React effect 使用空依赖，标签页导航或来源变化时可能继续展示旧结果；新实现将来源快照作为任务输入。
- 原网页上传失败后静默降级，用户不知道总结使用了完整文件还是纯文本；新实现应显示非阻塞提示。
- 原 API 客户端把认证、HTTP、业务接口和 SSE 混在一个类中；新实现拆分。
- 原包包含遥测代码；新项目默认不移植。
- 原清单标注 Chrome 114+，但 `chrome.sidePanel.open()` 实际要求 Chrome 116+；新清单设置 `minimum_chrome_version: "116"`。

---

## 4. 技术决策

### 4.1 固定技术栈

- Chrome Manifest V3，最低 Chrome 116。
- WXT，使用标准 `entrypoints/` 结构。
- React + TypeScript；初始化时选用 WXT 当前稳定模板支持的 React 版本并锁定 lockfile。
- pnpm。
- 轻量 CSS；当前不引入大型 UI 组件库，保持 sidepanel/options 样式可维护。
- `react-markdown` + `remark-gfm` 渲染 Markdown 和表格。
- Vitest + Testing Library + WXT fake browser。
- Playwright 仅用于本地/CI 的扩展烟雾测试，不访问真实账号。
- ESLint + Prettier + TypeScript strict。

### 4.2 暂不使用全局状态库

V1 只有侧边栏和选项页两个简单入口，状态通过：

- `useReducer` 管理总结任务状态机。
- `chrome.storage.local` 作为 token 和设置的持久化单一来源。
- 明确的 repository/service 接口共享逻辑。

只有出现多个入口实时共享复杂状态的真实需求时，才引入 Zustand。这样减少依赖和隐式状态。

### 4.3 关键设计原则

1. **端口与适配器**：核心用例依赖接口，不直接依赖 `chrome.*`、`fetch` 或 DOM。
2. **显式状态机**：总结任务使用离散状态，避免多个布尔值产生非法组合。
3. **可取消**：所有网络和提取调用接受 `AbortSignal`。
4. **有限重试**：401 最多刷新并重放一次；其他失败不隐式无限重试。
5. **最小权限**：只申请真实使用的 permissions 和 host permissions。
6. **默认保护隐私**：不记录 token、正文、Prompt 全文和 Kimi 响应正文。
7. **契约优先**：私有 API 的请求、响应和 SSE 事件先形成脱敏 fixture，再写实现。
8. **能力降级可见**：视频无字幕、文件上传失败等情况必须告诉用户当前使用的降级路径。

---

## 5. 目标架构

### 5.1 目录结构

```text
kimi-copilot-remake/
├── entrypoints/
│   ├── background.ts
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── style.css
│   ├── options/
│   │   ├── index.html
│   │   └── main.tsx
│   └── kimi-table-fix.content.ts     # P2，确认需要后再添加
├── src/
│   ├── application/
│   │   ├── summarize-page.ts         # 端到端用例编排
│   │   ├── acquire-session.ts
│   │   └── task-state.ts
│   ├── domain/
│   │   ├── content.ts
│   │   ├── errors.ts
│   │   ├── settings.ts
│   │   └── stream-event.ts
│   ├── extractors/
│   │   ├── extractor.ts
│   │   ├── registry.ts
│   │   ├── webpage.ts
│   │   ├── bilibili.ts
│   │   ├── youtube.ts
│   │   └── pdf.ts
│   ├── integrations/
│   │   └── kimi/
│   │       ├── transport.ts
│   │       ├── auth.ts
│   │       ├── files.ts
│   │       ├── chat.ts
│   │       ├── sse.ts
│   │       ├── schemas.ts
│   │       └── constants.ts
│   ├── platform/
│   │   └── chrome/
│   │       ├── active-tab.ts
│   │       ├── execute-script.ts
│   │       ├── notifications.ts
│   │       └── storage.ts
│   ├── ui/
│   │   ├── sidepanel/
│   │   ├── options/
│   │   └── shared/
│   └── shared/
│       ├── result.ts
│       ├── filename.ts
│       └── logger.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   │   ├── kimi/
│   │   ├── extractors/
│   │   └── pages/
│   └── e2e/
├── docs/
│   ├── PARITY_MATRIX.md
│   ├── ARCHITECTURE.md
│   ├── KIMI_API_CONTRACT.md
│   ├── MANUAL_QA.md
│   ├── DEVELOPMENT.md
│   └── adr/
├── public/
│   └── icon-128.png
├── wxt.config.ts
├── vitest.config.ts
├── tsconfig.json
├── package.json
├── pnpm-lock.yaml
└── README.md
```

### 5.2 核心接口

```ts
export interface PageContext {
  tabId: number;
  url: string;
  title?: string;
}

export interface ExtractedContent {
  kind: "webpage" | "bilibili" | "youtube" | "pdf";
  title: string;
  sourceUrl: string;
  file?: File;
  fallbackText?: string;
  warnings: string[];
}

export interface ContentExtractor {
  id: ExtractedContent["kind"];
  canHandle(context: PageContext): boolean;
  extract(context: PageContext, signal: AbortSignal): Promise<ExtractedContent>;
}

export type SummaryTaskState =
  | { status: "idle" }
  | { status: "auth-required" }
  | { status: "extracting" }
  | { status: "uploading"; warnings: string[] }
  | { status: "summarizing"; markdown: string; chatId?: string; warnings: string[] }
  | { status: "success"; markdown: string; chatId: string; warnings: string[] }
  | { status: "error"; error: AppError; canRetry: boolean };
```

### 5.3 Kimi 适配层职责

拆分为以下组件：

- `KimiTransport`：基础 URL、header、JSON/stream 请求、超时、错误转换。
- `KimiTokenRepository`：只负责持久化 token，不执行网络请求。
- `KimiAuthService`：刷新、token rotation、单飞刷新、最多一次 401 重试。
- `KimiFileService`：预签名、PUT 上传、注册、解析状态。
- `KimiChatService`：创建会话、发送消息、生成 typed stream events。
- `SSEDecoder`：只做字节流到 SSE event 的转换，不知道 Kimi 业务。
- `KimiEventMapper`：把原始 SSE JSON 映射为 `delta`、`references`、`done`。

运行时响应先进行轻量 schema 校验。字段变化时抛出 `ApiContractError`，不让 `undefined` 传播到 UI。

### 5.4 提取器调度

按明确顺序注册：

1. PDF
2. YouTube
3. Bilibili
4. 普通网页兜底

每个提取器只负责生成 `ExtractedContent`。上传、Prompt、会话和 UI 不属于提取器。

普通网页提取时：

- 移除 `script`、`style`、`noscript`、不可见模板和表单输入值。
- 保留标题、主要语义 HTML 和可读文本兜底。
- 对文件名做非法字符清理。
- 设置内容大小上限；超限时截断并产生 warning。
- 不在日志打印正文。

### 5.5 错误分类

统一错误类型：

- `AuthRequiredError`
- `TokenRefreshError`
- `PermissionDeniedError`
- `UnsupportedPageError`
- `ExtractionError`
- `UploadError`
- `ParseError`
- `ApiContractError`
- `ApiUnavailableError`
- `CancelledError`

UI 根据错误类型决定：

- 显示“登录 Kimi”
- 显示“重试”
- 显示“检查文件 URL 权限”
- 显示“换个页面试试”
- 静默结束用户主动取消

---

## 6. 分阶段执行计划

每个阶段必须满足退出条件后才能进入下一阶段。禁止同时重写所有提取器后再做集成。

### M0：冻结基线与接口契约（0.5～1.5 人日）

任务：

- [ ] `M0-01` 记录原扩展版本、manifest、关键文件 SHA-256 和测试 Chrome 版本。
- [ ] `M0-02` 建立 `docs/PARITY_MATRIX.md`，把第 3.3 节每项拆为可勾选测试用例。
- [ ] `M0-03` 在测试账号中逐条运行原扩展，记录 UI 文案、状态转换和错误行为。
- [ ] `M0-04` 使用 DevTools 记录 Kimi 六类请求的脱敏 request/response 样本。
- [ ] `M0-05` 记录 SSE 的 `cmpl`、`content`、`all_done` 和异常事件样本。
- [ ] `M0-06` 为普通网页、Bilibili、YouTube、PDF 各保存最小输入 fixture。
- [ ] `M0-07` 把无法确认的行为登记到风险表，不凭打包代码猜测。

脱敏要求：

- 删除 Authorization、cookie、object name、用户 ID、chat ID。
- 正文和模型输出替换为人工短文本，但保留 JSON 结构与 SSE 分帧。
- 原始未脱敏抓包不提交 Git。

退出条件：

- 对照矩阵覆盖所有 P0/P1 功能。
- API 文档足以让开发者在不阅读混淆包的情况下实现 mock client。
- fixture 中搜索不到 `Bearer`、refresh token、真实个人内容。

### M1：工程骨架与边界（1～1.5 人日）

任务：

- [ ] `M1-01` 用 WXT React TypeScript 模板初始化项目。
- [ ] `M1-02` 配置 pnpm、strict TypeScript、ESLint、Prettier、Vitest。
- [ ] `M1-03` 配置 `background`、`sidepanel`、`options` 三个 entrypoint。
- [ ] `M1-04` 根据实际调用设置最小 manifest permissions 和 Chrome 116 下限。
- [ ] `M1-05` 创建 domain 类型、错误类型、extractor 和 Kimi service 接口。
- [ ] `M1-06` 创建任务状态 reducer 和静态侧边栏页面。
- [ ] `M1-07` 接入 fake Kimi service，让 UI 可演示流式成功、失败、取消。
- [ ] `M1-08` 建立 CI：install → lint → typecheck → test → build。

退出条件：

- 点击扩展图标或快捷键能打开侧边栏。
- 假数据能够逐段流式渲染 Markdown 表格。
- 选项页可打开。
- 四条质量命令全部通过。
- 生产构建可以在 Chrome 加载且无控制台错误。

### M2：认证和 Kimi API 适配层（2～3 人日）

任务：

- [ ] `M2-01` 实现 storage repository 和设置 schema/version。
- [ ] `M2-02` 实现登录页打开、等待 tab load、轮询读取 refresh token、超时和取消。
- [ ] `M2-03` 实现 token refresh、rotation 和 single-flight。
- [ ] `M2-04` 实现基础 transport、超时、AbortSignal 和错误映射。
- [ ] `M2-05` 实现 SSEDecoder，并用各种分块方式重放同一 fixture。
- [ ] `M2-06` 实现文件预签名、上传、注册和解析。
- [ ] `M2-07` 实现创建 chat 和流式 completion。
- [ ] `M2-08` 实现 401 刷新后最多重试一次，第二次 401 转认证失效。
- [ ] `M2-09` 添加日志脱敏测试。
- [ ] `M2-10` 使用测试账号完成一次真实 API 冒烟验证。

必测单元用例：

- SSE 的 `\n`、`\r\n`、UTF-8 多字节字符被跨 chunk 切分。
- 一个 SSE 事件包含多行 `data:`。
- 未知事件被忽略并记录 debug，不导致整个任务崩溃。
- JSON 错误转为 `ApiContractError`。
- 两个并发请求收到 401 时只刷新一次。
- refresh 失败后清理无效 access token，但不泄漏 refresh token。
- Abort 后不再产生 stream delta。

退出条件：

- 使用 fixture 的所有契约测试通过。
- 人工真机验证能得到一个完整 summary 和 chat id。
- token、正文和响应正文不会出现在普通日志或测试快照中。

### M3：普通网页端到端最小闭环（2～3 人日）

任务：

- [ ] `M3-01` background 校验页面并以 tabId 打开侧边栏。
- [ ] `M3-02` 实现 active tab/page snapshot 读取。
- [ ] `M3-03` 实现普通网页提取、清理、大小限制和文本兜底。
- [ ] `M3-04` 实现 `summarizePage` 用例编排。
- [ ] `M3-05` 将真实 service 接到任务状态 reducer。
- [ ] `M3-06` 实现加载阶段文案、流式 Markdown、warning、错误和重试。
- [ ] `M3-07` 实现复制结果和跳转 `https://www.kimi.com/chat/{chatId}`。
- [ ] `M3-08` 实现 Prompt 读取、保存、恢复默认和快捷键入口。
- [ ] `M3-09` 侧边栏卸载、重试或来源变化时取消旧任务。
- [ ] `M3-10` 对普通文章、SPA、空页面、Chrome Web Store、file URL 做回归。

退出条件：

- 从点击扩展到得到普通网页总结的完整链路可演示。
- 上传失败但有 fallback text 时可以降级完成，并明确提示。
- 受限页面和 file 权限问题给出针对性提示。
- P0 对照项全部通过。

此里程碑完成后产生第一个可用内部版本 `0.1.0-alpha.1`。

### M4：补齐特殊内容提取器（2～3 人日）

> 当前基线已接入字幕路径；无字幕时只保留当前视频元数据并展示 warning。字幕权限、站点结构变化和音频转写属于后续优化，不作为 V1 的稳定正文承诺。

#### Bilibili

- [ ] `M4-01` 解析 BV 号。
- [ ] `M4-02` 在页面上下文请求视频信息和字幕。
- [ ] `M4-03` 生成包含标题、描述、字幕的 Markdown 文件。
- [ ] `M4-04` 无字幕或 API 失败时回退当前视频元数据并产生 warning；不把整页 DOM 静默作为正文。

#### YouTube

- [ ] `M4-05` 在 MAIN world 读取 player response。
- [ ] `M4-06` 实现字幕排序：人工字幕优先，同类中 `zh-CN/zh-Hans` → `zh-Hant` → `en`。
- [ ] `M4-07` 解析字幕响应并保留时间戳。
- [ ] `M4-08` 无字幕或页面结构变化时回退当前视频元数据并产生 warning；音频转写留作后续优化。

#### PDF

- [ ] `M4-09` 识别 `.pdf`、arXiv PDF 和 content type 场景。
- [ ] `M4-10` 读取 ArrayBuffer，保留正确 MIME type 和安全文件名。
- [ ] `M4-11` 处理 Chrome PDF viewer、跨域失败和 file URL 权限。

退出条件：

- 三种特殊提取器各自的成功、无内容和接口失败用例通过。
- 某个特殊提取器失败不会阻断可用的 fallback。
- P1 功能对照项全部通过。

此里程碑完成后产生功能等价候选版本 `0.2.0-beta.1`。

### M5：加固、回归和发布（2～3 人日）

任务：

- [ ] `M5-01` 完成 reducer、Prompt、registry、SSE、auth、API、提取器单元测试。
- [ ] `M5-02` 完成 fake browser 集成测试。
- [ ] `M5-03` 完成扩展加载、打开侧边栏和选项持久化的 Playwright smoke test。
- [ ] `M5-04` 审计 manifest 权限和 CSP。
- [ ] `M5-05` 检查 bundle，不包含远程可执行代码、秘密和未使用大依赖。
- [ ] `M5-06` 检查长页面、长输出、快速开关侧边栏时的资源释放。
- [ ] `M5-07` 完成 `docs/MANUAL_QA.md` 并在干净 Chrome profile 全量执行。
- [ ] `M5-08` 完成 README、架构、开发、调试、发布文档。
- [ ] `M5-09` 生成 zip，记录版本、commit SHA、构建命令和校验和。
- [ ] `M5-10` 单独评审 Kimi 表格补丁；只有确认仍有用户价值才进入后续版本。

退出条件：

- 自动化质量门全部通过。
- 手工矩阵无 P0/P1 阻断问题。
- 使用新的 Chrome profile 可以按 README 在 15 分钟内完成加载和首次总结。
- 发布包可追溯到唯一 commit。

---

## 7. 首个迭代的具体任务顺序

开始编码时严格按以下顺序领取任务：

| 顺序 | 任务 | 依赖 | 产物 |
|---|---|---|---|
| 1 | M0-01～M0-07 | 无 | 基线、对照矩阵、脱敏契约和 fixture |
| 2 | M1-01～M1-04 | M0 | 可加载的 WXT 空扩展 |
| 3 | M1-05～M1-07 | 工程骨架 | typed contracts + fake 流式 demo |
| 4 | M1-08 | 可执行脚本 | CI/本地质量门 |
| 5 | M2-01、M2-04、M2-05 | contracts | storage、transport、SSE |
| 6 | M2-02、M2-03 | storage/transport | 登录和 token refresh |
| 7 | M2-06、M2-07、M2-08 | auth/SSE | 完整 Kimi service |
| 8 | M3-01～M3-04 | Kimi service | 普通网页用例 |
| 9 | M3-05～M3-09 | 用例 | 可交互侧边栏和选项页 |
| 10 | M3-10 | 完整闭环 | `0.1.0-alpha.1` |

并行规则：

- API 契约未冻结前，不并行实现多个 API service。
- M3 稳定前，不并行写三个特殊提取器。
- M4 中三个提取器可以并行，但每个提取器必须独立修改文件，统一通过 registry 集成。
- UI 和 service 可以基于已冻结接口并行，不允许直接相互引用具体实现。

提交建议：

- 一个任务或一组强相关任务对应一个可回滚提交。
- 提交信息包含任务号，例如 `feat(M2-05): add incremental SSE decoder`。
- 不提交构建目录、真实抓包、Chrome profile、token 或 `.env`。

---

## 8. 测试与验收矩阵

### 8.1 自动化测试分层

| 层级 | 范围 | 是否访问真实网络 |
|---|---|---|
| Unit | SSE、Prompt、错误映射、registry、文件名、reducer | 否 |
| Contract | Kimi 请求/响应 schema 和脱敏 SSE fixture | 否 |
| Integration | fake browser storage、tabs、scripting、任务编排 | 否 |
| E2E smoke | 加载生产扩展、打开面板、保存选项、fake stream | 否 |
| Manual smoke | 真实 Kimi 登录和四类页面 | 是，仅发版前 |

### 8.2 必须覆盖的页面

- 普通静态文章。
- 内容延迟加载的 SPA。
- 超长网页。
- 空正文页面。
- Chrome Web Store 等禁止注入页面。
- 本地 `file://` 页面，分别测试权限开启和关闭。
- Bilibili 有字幕和无字幕视频。
- YouTube 人工字幕、ASR、无字幕视频。
- 普通 HTTP PDF、arXiv PDF、本地 PDF。

### 8.3 必须覆盖的认证状态

- 未登录。
- 已登录但扩展尚未保存 token。
- access token 有效。
- access token 过期、refresh token 有效。
- refresh token 失效。
- 登录窗口被用户关闭。
- 登录获取超时。
- 两个任务同时触发刷新。

### 8.4 Definition of Done

每个任务只有同时满足以下条件才可标记完成：

- 实现与既定接口一致。
- 正常路径和至少一个失败路径有测试。
- 错误能够被上层识别，不只 `console.error`。
- 不新增 token/正文日志。
- lint、typecheck、相关测试通过。
- 用户可见行为变化已更新对照矩阵或文档。
- 手工验证步骤可由另一位开发者复现。

---

## 9. 安全、隐私与权限

### 9.1 Token

- 只存储在 `chrome.storage.local`。
- 不存入 localStorage、URL、日志、异常上报或测试快照。
- access/refresh token 使用明确字段和 schema version。
- 401 重试完成后更新 rotation 后的新 token。
- 用户选择退出或 refresh 失效时清理存储。

### 9.2 页面内容

- 只有用户主动打开总结时才提取和上传。
- 不读取输入框当前值、密码、cookie 或页面 localStorage。
- 普通网页清理 script/style/form value。
- README 明确说明页面内容会上传到 Kimi 处理。
- 调试日志只记录 page kind、阶段、耗时和错误码，不记录正文。

### 9.3 Manifest 权限候选

初始候选：

```json
{
  "permissions": [
    "activeTab",
    "notifications",
    "scripting",
    "sidePanel",
    "storage"
  ],
  "host_permissions": [
    "https://*.kimi.com/*",
    "https://*.volces.com/*"
  ],
  "minimum_chrome_version": "116"
}
```

最终权限以真实实现和 Chrome 加载测试为准。没有调用点的权限必须删除。若 `notifications` 只用于无效页面提示且可由其他 UI 替代，应在 M5 审计时评估移除。

---

## 10. 风险登记与应对

| 风险 | 概率/影响 | 预警信号 | 应对 |
|---|---|---|---|
| Kimi 私有 API 改动 | 高/高 | schema、端点或 SSE event 变化 | 独立适配层、runtime schema、契约 fixture、清晰错误 |
| 读取 Kimi 登录态失败 | 中/高 | 新域名、localStorage key 或 CSP 变化 | 登录流程超时、可诊断提示、集中 auth adapter |
| YouTube 页面对象变化 | 高/中 | player response 读取为空 | MAIN world adapter、fixture、保守元数据 fallback、不影响其他提取器；音频转写后置 |
| Bilibili 字幕需登录或 API 限流 | 中/中 | 403、无字幕 URL | 页面上下文带 credentials、保守元数据 fallback、明确 warning；WBI/字幕适配后置 |
| PDF viewer/跨域限制 | 中/中 | fetch 失败、空 buffer | content-type 检测、权限说明、失败错误分类 |
| 长网页导致上传慢或内存高 | 中/中 | 大 Blob、侧栏卡顿 | 清理、大小上限、截断 warning、AbortSignal |
| side panel 显示旧标签页内容 | 中/高 | 切换/导航后结果不匹配 | 创建不可变 PageContext、任务 id、防止旧流写入 |
| token 或正文泄漏 | 低/高 | 日志、fixture、source map 出现敏感值 | redacting logger、测试、发包扫描 |
| 过早引入复杂状态/组件库 | 中/中 | 简单改动跨越大量文件 | reducer + 小组件，按真实需求引入依赖 |
| 原扩展行为本身有 bug | 高/中 | 基线结果不一致 | 对照矩阵注明“兼容”或“有意修复”，用 ADR 记录 |

遇到无法确认的行为时，优先级是：

1. 观察原扩展。
2. 查阅本仓库的代码地图和变量映射。
3. 用脱敏抓包确认。
4. 仍不确定时记录为决策项，不把猜测写进核心接口。

---

## 11. 工期与里程碑

按一名熟悉 TypeScript/Chrome 扩展的开发者估算：

| 里程碑 | 预计人日 | 可演示结果 |
|---|---:|---|
| M0 基线与契约 | 0.5～1.5 | 可验证的复刻清单和 fixtures |
| M1 工程骨架 + Fake Provider | 1.5～2 | 可加载扩展 + 双后端流式面板 |
| M2 OpenAI Compatible MVP | 2.5～4 | Token 配置、普通网页、分块总结 |
| M3 Kimi 登录态/API | 2～3 | 真实 Kimi 文本请求闭环 |
| M4 特殊提取器 | 3～4 | `0.3.0-beta.1` |
| M5 加固发布 | 2～3 | 生产候选包 |
| 合计 | 12～17.5 | 取决于私有 API 与站点结构变化 |

这不是日历承诺。M0 结束后应根据真实接口差异重新估算一次；任何 Kimi 登录/API 变化都可能增加工期。

---

## 12. 立即可执行的下一步

下一次开发从 M0 开始，不直接创建 UI：

1. 创建 `docs/PARITY_MATRIX.md`。
2. 用独立测试账号在原扩展上执行 P0 流程。
3. 生成脱敏 Kimi API/SSE fixture。
4. 确认 `kimi.com` 当前登录态的 token key 和读取时机。
5. 确认普通网页上传失败时的真实 fallback 行为。
6. 完成 M0 退出评审后，再运行 WXT 初始化命令。

建议第一个工作日的验收物：

- 对照矩阵可逐项勾选。
- 六类 Kimi API 契约均有脱敏样本。
- 四类页面均有 fixture。
- 工程初始化命令、Node/pnpm 版本和依赖版本已记录。
- 没有任何真实 token 或个人正文进入 Git。

---

## 13. 参考资料

本地基线：

- `/Users/lynn/Workspace/kimi-copilot-patched/manifest.json`
- `/Users/lynn/Workspace/kimi-copilot-patched/docs/CODE_MAP.md`
- `/Users/lynn/Workspace/kimi-copilot-patched/docs/VARIABLE_MAPPING.md`
- `/Users/lynn/Workspace/kimi-copilot-patched/CLAUDE.md`
- `/Users/lynn/Workspace/kimi-copilot-patched/TABLE_FIX_README.md`

官方资料：

- [WXT Entrypoints](https://wxt.dev/guide/essentials/entrypoints)
- [WXT Unit Testing](https://wxt.dev/guide/essentials/unit-testing)
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome Extensions API Reference](https://developer.chrome.com/docs/extensions/reference)

---

**文档版本**：2.0
**最后更新**：2026-07-24
**当前负责人**：待定
**下一里程碑**：M5 加固、真实 Chrome 手工验收与发布
