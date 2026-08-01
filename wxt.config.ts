import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Kimi Copilot Remake",
    description: "使用 Kimi 或 OpenAI 兼容 API 总结网页内容",
    version: "0.1.0",
    minimum_chrome_version: "140",
    permissions: ["activeTab", "scripting", "sidePanel", "storage", "notifications"],
    host_permissions: [
      "https://*.kimi.com/*",
      "https://*.volces.com/*",
      // Bilibili metadata/player APIs and the signed subtitle CDN. No cookies
      // permission is needed: the background fetch uses the browser session.
      "https://api.bilibili.com/*",
      "https://*.hdslb.com/*",
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
