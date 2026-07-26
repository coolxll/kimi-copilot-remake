import { browser } from "wxt/browser";
import type {
  AppSettingsV2,
  KimiTokens,
  OpenAICompatibleSecret,
} from "../../domain/types";
import { createDefaultSettings } from "../../domain/types";

const SETTINGS_KEY = "settings:v2";
const OPENAI_SECRET_KEY = "secrets:openai-compatible:v1";
const KIMI_TOKENS_KEY = "local:kimi_tokens";
const LEGACY_PROMPT_KEY = "local:custom_prompt";

export interface SettingsRepository {
  getSettings(): Promise<AppSettingsV2>;
  saveSettings(settings: AppSettingsV2): Promise<void>;
  getOpenAISecret(): Promise<OpenAICompatibleSecret | null>;
  saveOpenAISecret(secret: OpenAICompatibleSecret): Promise<void>;
  clearOpenAISecret(): Promise<void>;
  getKimiTokens(): Promise<KimiTokens | null>;
  saveKimiTokens(tokens: KimiTokens): Promise<void>;
  clearKimiTokens(): Promise<void>;
}

function isSettings(value: unknown): value is AppSettingsV2 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && (record.defaultProvider === "kimi-web" || record.defaultProvider === "openai-compatible");
}

export function createSettingsRepository(): SettingsRepository {
  return {
    async getSettings() {
      const stored = await browser.storage.local.get(SETTINGS_KEY);
      if (isSettings(stored[SETTINGS_KEY])) return stored[SETTINGS_KEY];

      const settings = createDefaultSettings();
      const legacy = await browser.storage.local.get(LEGACY_PROMPT_KEY);
      if (typeof legacy[LEGACY_PROMPT_KEY] === "string" && legacy[LEGACY_PROMPT_KEY].trim()) {
        settings.promptOverride = legacy[LEGACY_PROMPT_KEY];
      }
      await browser.storage.local.set({ [SETTINGS_KEY]: settings });
      return settings;
    },
    async saveSettings(settings) {
      await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    },
    async getOpenAISecret() {
      const stored = await browser.storage.local.get(OPENAI_SECRET_KEY);
      const secret = stored[OPENAI_SECRET_KEY];
      return secret && typeof secret === "object" && typeof (secret as OpenAICompatibleSecret).apiToken === "string"
        ? (secret as OpenAICompatibleSecret)
        : null;
    },
    async saveOpenAISecret(secret) {
      await browser.storage.local.set({ [OPENAI_SECRET_KEY]: secret });
    },
    async clearOpenAISecret() {
      await browser.storage.local.remove(OPENAI_SECRET_KEY);
    },
    async getKimiTokens() {
      const stored = await browser.storage.local.get(KIMI_TOKENS_KEY);
      const tokens = stored[KIMI_TOKENS_KEY];
      return tokens && typeof tokens === "object" && typeof (tokens as KimiTokens).refreshToken === "string"
        ? (tokens as KimiTokens)
        : null;
    },
    async saveKimiTokens(tokens) {
      await browser.storage.local.set({ [KIMI_TOKENS_KEY]: tokens });
    },
    async clearKimiTokens() {
      await browser.storage.local.remove(KIMI_TOKENS_KEY);
    },
  };
}
