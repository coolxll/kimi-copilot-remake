import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Kimi Copilot Remake",
    description: "使用 Kimi 或 OpenAI 兼容 API 总结网页内容",
    version: "0.1.0",
    minimum_chrome_version: "140",
    permissions: ["activeTab", "scripting", "sidePanel", "storage", "notifications"],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    host_permissions: [
      "https://*.kimi.com/*",
      "https://*.volces.com/*",
      // Bilibili metadata/player APIs and the signed subtitle CDN. No cookies
      // permission is needed: the background fetch uses the browser session.
      "https://api.bilibili.com/*",
      "https://*.hdslb.com/*",
      // Feedly's entry API is used only as a fallback when the reader DOM has
      // only rendered a summary or a shell around the current article.
      "https://feedly.com/*",
      "https://cloud.feedly.com/*",
    ],
    optional_host_permissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "http://[::1]/*",
    ],
    commands: {
      _execute_action: {
        suggested_key: {
          default: "Ctrl+Shift+K",
          mac: "Command+Shift+K",
          windows: "Ctrl+Shift+K",
          linux: "Ctrl+Shift+K",
          chromeos: "Ctrl+Shift+K",
        },
      },
    },
    action: {
      default_title: "总结当前网页",
    },
  },
});
