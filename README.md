# Kimi Copilot Remake

一个 Manifest V3 Chrome 侧边栏扩展，使用统一的 `SummaryProvider` 契约支持两套独立后端：

- **Kimi Web**：复用当前浏览器中的 Kimi 登录态，支持文件上传、解析、会话和“去 Kimi 继续对话”。
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
2. Kimi Web 点击“登录 Kimi”；兼容端填写 API Root 和 Model，并按需保存 Token。
3. 远程 API Root 必须为 HTTPS；HTTP 只允许 `localhost`、`127.0.0.1` 和 `::1`。保存时扩展会请求对应 origin 的可选权限。
4. 打开网页后点击扩展图标或快捷键。侧边栏首次使用默认后端自动总结。
5. 下拉框切换后端只影响当前侧边栏实例；切换后需点击“使用此后端重新总结”，失败不会自动换后端。

兼容端只承诺 Chat Completions 的文本子集：`POST <apiRoot>/chat/completions`，支持 SSE `data: {...}`、`[DONE]` 和服务商忽略 `stream` 时返回的普通 JSON。设置页的“测试连接”使用 `<apiRoot>/models`，404/405 仅提示不支持模型探测，不阻止保存。

## 目录

```text
entrypoints/                 WXT background、sidepanel、options
src/domain/                  Provider、文档、设置和错误契约
src/application/             任务状态机与总结用例编排
src/extractors/              网页、Bilibili、YouTube、PDF.js 提取器
src/integrations/kimi/       Kimi 登录态、Token 刷新、上传和 SSE
src/integrations/openai-compatible/
                             兼容 API、SSE、重试和分块归并
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
