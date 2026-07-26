import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { KimiTokens } from "../../domain/types";
import type { SettingsRepository } from "../../platform/chrome/storage";

export class KimiAuthService {
  constructor(private readonly storage: SettingsRepository) {}

  getStoredTokens(): Promise<KimiTokens | null> {
    return this.storage.getKimiTokens();
  }

  async clear(): Promise<void> {
    await this.storage.clearKimiTokens();
  }

  async openLoginAndWait(timeoutMs = 120_000): Promise<KimiTokens> {
    const tab = await browser.tabs.create({ url: "https://www.kimi.com/", active: true });
    if (!tab.id) throw new AppError("auth-required", "无法打开 Kimi 登录页");
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const refreshToken = await this.readRefreshToken(tab.id).catch(() => undefined);
        if (refreshToken) {
          const tokens = { refreshToken };
          await this.storage.saveKimiTokens(tokens);
          return tokens;
        }
        await delay(1_000);
      }
      throw new AppError("auth-required", "等待 Kimi 登录超时");
    } finally {
      await browser.tabs.remove(tab.id).catch(() => undefined);
    }
  }

  private async readRefreshToken(tabId: number): Promise<string | undefined> {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: () => window.localStorage.getItem("refresh_token"),
    });
    const token = result[0]?.result;
    return typeof token === "string" && token ? token : undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
