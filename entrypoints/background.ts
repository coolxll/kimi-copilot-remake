import { browser } from "wxt/browser";
import {
  fetchBilibiliSubtitleInBackground,
  isBilibiliSubtitleMessage,
} from "../src/platform/chrome/bilibili";
import { installWebSessionBackground } from "../src/integrations/web-session/background";

export default defineBackground(() => {
  installWebSessionBackground();

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isBilibiliSubtitleMessage(message)) return undefined;
    void fetchBilibiliSubtitleInBackground(message.request)
      .then(sendResponse)
      .catch(() => sendResponse({
        subtitles: "",
        pageCount: 0,
        loginState: "unknown" as const,
        unavailableReason: "扩展后台请求 B 站字幕失败",
      }));
    return true;
  });

  // WXT emits a global default_path for the side panel entrypoint. Disable that
  // global panel at runtime so the panel is only enabled for the tab that the
  // user explicitly opened it from.
  if (browser.sidePanel?.setOptions) {
    void browser.sidePanel.setOptions({ enabled: false }).catch(() => undefined);
  }

  browser.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:\/\/|^file:\/\//i.test(tab.url)) {
      await browser.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: "Kimi Copilot", message: "请在网页或本地文件页面使用" });
      return;
    }
    if (!browser.sidePanel?.open) {
      await browser.notifications.create({ type: "basic", iconUrl: "/icon-128.png", title: "Kimi Copilot", message: "当前 Chrome 不支持 Side Panel" });
      return;
    }
    // Do not await setOptions before open(): awaiting any extension API here
    // loses the user activation required by sidePanel.open().
    const optionsReady = browser.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: `sidepanel.html?tabId=${tab.id}` });
    await browser.sidePanel.open({ tabId: tab.id });
    await optionsReady;
  });
});
