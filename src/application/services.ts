import { isWebSessionProvider, type OpenAICompatibleConfig, type OpenAICompatibleSecret, type ProviderId, type SummaryProvider } from "../domain/types";
import { AppError } from "../domain/errors";
import { createExtractorRegistry } from "../extractors/registry";
import { KimiAuthService } from "../integrations/kimi/auth";
import { KimiProvider } from "../integrations/kimi/provider";
import { OpenAICompatibleProvider } from "../integrations/openai-compatible/provider";
import type { TestConnectionResult } from "../integrations/openai-compatible/provider";
import { WebSessionClient } from "../integrations/web-session/client";
import { WebSessionProvider } from "../integrations/web-session/provider";
import { createSettingsRepository, type SettingsRepository } from "../platform/chrome/storage";

export interface ProviderConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
  externalUrl?: string;
}

export interface AppServices {
  storage: SettingsRepository;
  auth: KimiAuthService;
  webSessions: WebSessionClient;
  extractors: ReturnType<typeof createExtractorRegistry>;
  getProvider(providerId: ProviderId): Promise<SummaryProvider>;
  testOpenAIConnection(config: OpenAICompatibleConfig, secret: OpenAICompatibleSecret | null): Promise<TestConnectionResult>;
  testProviderConnection(
    providerId: ProviderId,
    options?: {
      config?: OpenAICompatibleConfig;
      secret?: OpenAICompatibleSecret | null;
      signal?: AbortSignal;
    },
  ): Promise<ProviderConnectionResult>;
}

export function createAppServices(): AppServices {
  const storage = createSettingsRepository();
  const auth = new KimiAuthService(storage);
  const webSessions = new WebSessionClient(storage);
  const extractors = createExtractorRegistry();
  return {
    storage,
    auth,
    webSessions,
    extractors,
    async getProvider(providerId) {
      if (providerId === "kimi-web") return new KimiProvider(storage);
      if (isWebSessionProvider(providerId)) return new WebSessionProvider(providerId, webSessions);
      const settings = await storage.getSettings();
      const secret = await storage.getOpenAISecret();
      if (!settings.openAICompatible) throw new AppError("provider-not-configured", "兼容 API 尚未配置");
      return new OpenAICompatibleProvider({ config: settings.openAICompatible, secret });
    },
    async testOpenAIConnection(config, secret) {
      return new OpenAICompatibleProvider({ config, secret }).testConnection();
    },
    async testProviderConnection(providerId, options = {}) {
      if (providerId === "kimi-web") return new KimiProvider(storage).testConnection(options.signal);
      if (isWebSessionProvider(providerId)) return webSessions.testConnection(providerId, options.signal);
      let config = options.config;
      let secret = options.secret;
      if (!config) {
        const settings = await storage.getSettings();
        config = settings.openAICompatible;
        if (!config) throw new AppError("provider-not-configured", "兼容 API 尚未配置");
      }
      if (secret === undefined) secret = await storage.getOpenAISecret();
      return new OpenAICompatibleProvider({ config, secret: secret ?? null }).testConnection();
    },
  };
}
