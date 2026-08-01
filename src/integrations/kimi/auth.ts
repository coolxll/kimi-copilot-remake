import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";
import type { KimiTokens } from "../../domain/types";
import type { SettingsRepository } from "../../platform/chrome/storage";
import { abortableDelay, throwIfAborted, withAbort } from "../../shared/abort";

export class KimiAuthService {
  constructor(private readonly storage: SettingsRepository) {}

  getStoredTokens(): Promise<KimiTokens | null> {
    return this.storage.getKimiTokens();
  }

  async clear(): Promise<void> {
    await this.storage.clearKimiTokens();
  }

  async openLoginAndWait(timeoutMs = 120_000, signal?: AbortSignal): Promise<KimiTokens> {
    if (signal) throwIfAborted(signal);
    const tab = await browser.tabs.create({ url: "https://www.kimi.com/", active: true });
    if (!tab.id) throw new AppError("auth-required", "无法打开 Kimi 登录页");
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (signal) throwIfAborted(signal);
        let refreshToken: string | undefined;
        try {
          refreshToken = signal
            ? await withAbort(this.readRefreshToken(tab.id), signal)
            : await this.readRefreshToken(tab.id);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        if (refreshToken) {
          if (signal) throwIfAborted(signal);
          const tokens = { refreshToken };
          await this.storage.saveKimiTokens(tokens);
          return tokens;
        }
        if (signal) await abortableDelay(1_000, signal);
        else await delay(1_000);
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
