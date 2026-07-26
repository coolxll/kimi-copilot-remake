import type { OpenAICompatibleConfig, OpenAICompatibleSecret, ProviderId, SummaryProvider } from "../domain/types";
import { AppError } from "../domain/errors";
import { createExtractorRegistry } from "../extractors/registry";
import { KimiAuthService } from "../integrations/kimi/auth";
import { KimiProvider } from "../integrations/kimi/provider";
import { OpenAICompatibleProvider } from "../integrations/openai-compatible/provider";
import type { TestConnectionResult } from "../integrations/openai-compatible/provider";
import { createSettingsRepository, type SettingsRepository } from "../platform/chrome/storage";

export interface AppServices {
  storage: SettingsRepository;
  auth: KimiAuthService;
  extractors: ReturnType<typeof createExtractorRegistry>;
  getProvider(providerId: ProviderId): Promise<SummaryProvider>;
  testOpenAIConnection(config: OpenAICompatibleConfig, secret: OpenAICompatibleSecret | null): Promise<TestConnectionResult>;
}

export function createAppServices(): AppServices {
  const storage = createSettingsRepository();
  const auth = new KimiAuthService(storage);
  const extractors = createExtractorRegistry();
  return {
    storage,
    auth,
    extractors,
    async getProvider(providerId) {
      if (providerId === "kimi-web") return new KimiProvider(storage);
      const settings = await storage.getSettings();
      const secret = await storage.getOpenAISecret();
      if (!settings.openAICompatible) throw new AppError("provider-not-configured", "兼容 API 尚未配置");
      return new OpenAICompatibleProvider({ config: settings.openAICompatible, secret });
    },
    async testOpenAIConnection(config, secret) {
      return new OpenAICompatibleProvider({ config, secret }).testConnection();
    },
  };
}
