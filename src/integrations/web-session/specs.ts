import type { WebSessionProviderId } from "../../domain/types";

export interface WebSessionSpec {
  id: WebSessionProviderId;
  label: string;
  origin: string;
  loginUrl: string;
  loginHint: string;
}

export const WEB_SESSION_PROVIDER_IDS: readonly WebSessionProviderId[] = ["chatgpt-web", "gemini-web", "deepseek-web"];

export const WEB_SESSION_SPECS: Record<WebSessionProviderId, WebSessionSpec> = {
  "chatgpt-web": {
    id: "chatgpt-web",
    label: "ChatGPT Web",
    origin: "https://chatgpt.com",
    loginUrl: "https://chatgpt.com/",
    loginHint: "请先在打开的 ChatGPT 页面完成登录，然后回到扩展重试。",
  },
  "gemini-web": {
    id: "gemini-web",
    label: "Gemini Web",
    origin: "https://gemini.google.com",
    loginUrl: "https://gemini.google.com/",
    loginHint: "请先在打开的 Gemini 页面完成登录，然后回到扩展重试。",
  },
  "deepseek-web": {
    id: "deepseek-web",
    label: "DeepSeek Web",
    origin: "https://chat.deepseek.com",
    loginUrl: "https://chat.deepseek.com/",
    loginHint: "请先在打开的 DeepSeek 页面完成登录，然后回到扩展重试。",
  },
};

export function getWebSessionSpec(providerId: WebSessionProviderId): WebSessionSpec {
  return WEB_SESSION_SPECS[providerId];
}
