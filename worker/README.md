# Kimi Copilot Serverless Extractor API

基于 **Cloudflare Workers** 的无头内容提取与总结微服务，专为**手机端快捷指令（iOS Shortcuts）**、移动端原生 App 分享扩展或第三方自动化工作流设计。

---

## 🌟 核心特性

- **跨平台提取引擎**：支持 Bilibili、YouTube、知乎、微信公众号、小红书、Reddit 以及通用网页的结构化正文与字幕抽取；
- **纯边缘计算运行**：无需常驻服务器，基于 Cloudflare Workers 全球边缘网络，毫秒级冷启动；
- **CORS 友好**：原生支持所有来源的跨域请求，手机快捷指令或 Web 应用可直接无障碍调用；
- **双模接口**：
  - `/api/extract`：只做上下文工程提取，返回清洗后的 Markdown、标题与图片数组；
  - `/api/summarize`：一步到位完成“提取 + AI 总结提炼”（支持配置 Kimi 或 OpenAI-compatible 密钥）。

---

## 🚀 部署指南

### 1. 本地启动开发预览

在项目根目录下执行：

```bash
npx wrangler dev worker/src/index.ts
```

启动后可在 `http://localhost:8787` 访问本地 API。

### 2. 一键部署到 Cloudflare

确保已登录 Cloudflare 账号：

```bash
npx wrangler deploy worker/src/index.ts --name kimi-copilot-extractor
```

部署成功后，你将获得一个全局公网访问域名，例如：
`https://kimi-copilot-extractor.<你的子域>.workers.dev`

### 3. 配置密钥（可选，仅在使用 `/api/summarize` 时需要）

如果你希望 Worker 直接生成 AI 总结，可配置环境变量：

```bash
npx wrangler secret put OPENAI_API_KEY
# 或
npx wrangler secret put KIMI_TOKEN
```

---

## 📡 API 接口说明

### 1. 内容提取接口

* **地址**：`POST /api/extract` 或 `GET /api/extract?url=<目标网址>`
* **请求体 (POST)**：
  ```json
  {
    "url": "https://www.bilibili.com/video/BV1xx411c7mD"
  }
  ```
* **返回示例**：
  ```json
  {
    "ok": true,
    "data": {
      "title": "视频标题",
      "markdown": "# 视频标题\n\n> UP主：... · 时长：...\n\n## 视频字幕逐字稿\n\n...",
      "imageUrls": ["https://..."],
      "sourceUrl": "https://www.bilibili.com/video/BV...",
      "extractor": "bilibili",
      "warnings": []
    }
  }
  ```

### 2. 提取并总结接口

* **地址**：`POST /api/summarize`
* **请求体**：
  ```json
  {
    "url": "https://mp.weixin.qq.com/s/...",
    "prompt": "请提炼本文的核心观点与论证细节",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini"
  }
  ```
* **返回示例**：
  ```json
  {
    "ok": true,
    "summary": "### 核心观点提炼\n\n1. ...\n2. ...",
    "document": { ... }
  }
  ```

---

## 📱 iOS 快捷指令（Shortcuts）配置教程

只需在 iPhone 上的“快捷指令” App 中配置一个简单的 4 步流程，即可在任何手机 App 里**一键总结**：

1. **新建快捷指令**，命名为 **“AI 网页/视频总结”**；
2. **开启分享表单**：
   - 点击快捷指令右上角设置（ⓘ 图标）；
   - 勾选 **“在共享表单中显示”**（在微信、小红书、B站等点击分享时即可看到）；
   - 接收类型勾选 **“URL”** 和 **“Safari 网页”**。
3. **添加动作**：
   - **动作 1：获取 URL**：从输入中获取 URL；
   - **动作 2：获取 URL 内容（网络请求）**：
     - **URL**：`https://kimi-copilot-extractor.<你的子域>.workers.dev/api/summarize`
     - **方法**：`POST`
     - **请求体**：JSON
       - 键 `url` = 上一步获取到的 `URL`
       - 键 `apiKey` = 你的 API Key（如果在 Worker 端未配置全局环境变量）
   - **动作 3：从输入中获取词典值**：
     - 从网络响应中获取键 `summary`；
   - **动作 4：显示结果**：
     - 选择 **“显示结果”** 或 **“快速查看”**（或使用 **“拷贝至剪贴板”**）。

> **体验效果**：在小红书、微信公众号、B站、知乎或推特原生 App 里看到感兴趣的内容，点击系统 **分享 ➔ AI 网页/视频总结**，手机屏幕顶部立刻弹出悬浮卡片展示提炼摘要！
