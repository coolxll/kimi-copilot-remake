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
        let tokens: KimiTokens | undefined;
        try {
          tokens = signal
            ? await withAbort(this.readTokens(tab.id), signal)
            : await this.readTokens(tab.id);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        if (tokens && (tokens.refreshToken || tokens.accessToken)) {
          if (signal) throwIfAborted(signal);
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

  private async readTokens(tabId: number): Promise<KimiTokens | undefined> {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: () => ({
        accessToken: window.localStorage.getItem("access_token") || undefined,
        refreshToken: window.localStorage.getItem("refresh_token") || undefined,
      }),
    });
    const item = result[0]?.result;
    if (item && (item.refreshToken || item.accessToken)) {
      return {
        accessToken: typeof item.accessToken === "string" ? item.accessToken : undefined,
        refreshToken: typeof item.refreshToken === "string" ? item.refreshToken : undefined,
      };
    }
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
