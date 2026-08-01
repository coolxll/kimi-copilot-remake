import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { AppSettingsV2, OpenAICompatibleConfig, WebSessionProviderId } from "../../domain/types";
import { DEFAULT_CHUNK_CHARS, DEFAULT_MAX_SOURCE_CHARS, DEFAULT_PROMPT, PROVIDER_LABELS } from "../../domain/types";
import { AppError, toAppError } from "../../domain/errors";
import { ensureApiHostPermission, normalizeApiRoot, revokeApiHostPermission, validateApiRoot } from "../../platform/chrome/permissions";
import { createAppServices } from "../../application/services";
import type { WebSessionLoginStatus } from "../../integrations/web-session/client";
import { WEB_SESSION_PROVIDER_IDS } from "../../integrations/web-session/specs";
import { ProviderBadge, ProviderIcon, ProviderPicker } from "../components/provider-brand";
import "../styles.css";

export function OptionsApp() {
  const services = createAppServices();
  const [settings, setSettings] = useState<AppSettingsV2>();
  const [defaultProvider, setDefaultProvider] = useState<AppSettingsV2["defaultProvider"]>("kimi-web");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [config, setConfig] = useState<OpenAICompatibleConfig>({ apiRoot: "", model: "", chunkChars: DEFAULT_CHUNK_CHARS, maxSourceChars: DEFAULT_MAX_SOURCE_CHARS });
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [hasKimiToken, setHasKimiToken] = useState(false);
  const [webStatuses, setWebStatuses] = useState<Record<WebSessionProviderId, WebSessionLoginStatus>>(createInitialWebSessionStatuses);
  const [checkingWebStatus, setCheckingWebStatus] = useState<WebSessionProviderId | "all" | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);

  const refreshWebSessionStatuses = async (providerId?: WebSessionProviderId) => {
    const providerIds = providerId ? [providerId] : [...WEB_SESSION_PROVIDER_IDS];
    setCheckingWebStatus(providerId || "all");
    const entries = await Promise.all(providerIds.map(async (id) => {
      try {
        return [id, await services.webSessions.detectLoginStatus(id)] as const;
      } catch {
        return [id, "unknown"] as const;
      }
    }));
    setWebStatuses((current) => ({ ...current, ...Object.fromEntries(entries) } as Record<WebSessionProviderId, WebSessionLoginStatus>));
    setCheckingWebStatus(null);
  };

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await services.storage.getSettings();
        const secret = await services.storage.getOpenAISecret();
        const kimi = await services.storage.getKimiTokens();
        setSettings(loaded);
        setDefaultProvider(loaded.defaultProvider);
        setPrompt(loaded.promptOverride || DEFAULT_PROMPT);
        setConfig(loaded.openAICompatible || { apiRoot: "", model: "", chunkChars: DEFAULT_CHUNK_CHARS, maxSourceChars: DEFAULT_MAX_SOURCE_CHARS });
        setHasToken(Boolean(secret?.apiToken));
        setHasKimiToken(Boolean(kimi?.refreshToken));
      } catch (error) {
        setNotice({ kind: "error", text: toAppError(error).message });
      }
    })();
    void refreshWebSessionStatuses();
    // Services are stable for this options page.
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice(undefined);
    try {
      const oldRoot = settings?.openAICompatible?.apiRoot;
      const nextConfig = config.apiRoot.trim() || config.model.trim() || token.trim() ? normalizeConfig(config) : undefined;
      if (nextConfig) {
        validateApiRoot(nextConfig.apiRoot);
        if (!nextConfig.model.trim()) throw new AppError("provider-not-configured", "请填写兼容 API 的 Model");
        await ensureApiHostPermission(nextConfig.apiRoot);
      }
      const nextSettings: AppSettingsV2 = {
        version: 2,
        defaultProvider,
        promptOverride: prompt.trim() && prompt.trim() !== DEFAULT_PROMPT ? prompt.trim() : undefined,
        openAICompatible: nextConfig,
      };
      await services.storage.saveSettings(nextSettings);
      if (token.trim()) {
        await services.storage.saveOpenAISecret({ apiToken: token.trim() });
        setHasToken(true);
        setToken("");
      }
      if (oldRoot && nextConfig && normalizeApiRoot(oldRoot) !== nextConfig.apiRoot) await revokeApiHostPermission(oldRoot);
      setSettings(nextSettings);
      setNotice({ kind: "success", text: "保存成功" });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    await services.storage.clearOpenAISecret();
    setHasToken(false);
    setToken("");
    setNotice({ kind: "success", text: "兼容 API Token 已清除" });
  };

  const testConnection = async () => {
    setNotice(undefined);
    try {
      const nextConfig = normalizeConfig(config);
      validateApiRoot(nextConfig.apiRoot);
      await ensureApiHostPermission(nextConfig.apiRoot);
      const secret = token.trim() ? { apiToken: token.trim() } : await services.storage.getOpenAISecret();
      const result = await services.testOpenAIConnection(nextConfig, secret);
      setNotice({ kind: "success", text: result.message });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    }
  };

  const loginKimi = async () => {
    setNotice(undefined);
    try {
      await services.auth.openLoginAndWait();
      setHasKimiToken(true);
      setNotice({ kind: "success", text: "Kimi 登录态已保存" });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    }
  };

  const clearKimi = async () => {
    await services.auth.clear();
    setHasKimiToken(false);
    setNotice({ kind: "success", text: "Kimi 登录态已清除" });
  };

  const openWebSession = async (providerId: WebSessionProviderId) => {
    setNotice(undefined);
    try {
      await services.webSessions.openLogin(providerId);
      void refreshWebSessionStatuses(providerId);
      setNotice({ kind: "success", text: `已打开 ${PROVIDER_LABELS[providerId]} 页面。扩展不会读取或保存 Cookie，登录完成后即可在侧边栏选择它总结。` });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    }
  };

  const openExtractorTest = () => void browser.tabs.create({ url: browser.runtime.getURL("/") + "youtube-test.html" });

  if (!settings) return <main className="page"><div className="panel">加载中…</div></main>;
  return <main className="page"><div className="panel">
    <header className="header"><h1>选项</h1><button className="button" onClick={() => void browser.tabs.create({ url: "chrome://extensions/shortcuts" })}>快捷键</button></header>
    {notice && <div className={notice.kind === "success" ? "success" : "error"}>{notice.text}</div>}
    <section className="card">
      <h2>提取器测试</h2>
      <p className="muted">测试 YouTube、Bilibili、普通网页和 PDF 的实际提取结果，查看正文、字幕和 warning。</p>
      <div className="actions"><button className="button" onClick={openExtractorTest}>打开提取器测试页</button></div>
    </section>
    <section className="card">
      <div className="field"><label className="label" htmlFor="provider">默认总结后端</label><ProviderPicker id="provider" value={defaultProvider} onChange={setDefaultProvider} ariaLabel="默认总结后端" /></div>
      <div className="field"><label className="label" htmlFor="prompt">Prompt</label><textarea id="prompt" className="textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><p className="muted">留空或恢复默认将使用：{DEFAULT_PROMPT}</p></div>
    </section>
    <section className="card">
      <h2 className="provider-heading"><ProviderIcon providerId="kimi-web" /> Kimi Web</h2><p className="muted">复用当前浏览器中的 Kimi 登录态，文件会通过 Kimi 文件接口处理。</p>
      <div className="actions"><span className={hasKimiToken ? "success" : "warning"}>{hasKimiToken ? "已配置登录态" : "未登录"}</span><button className="button" onClick={() => void loginKimi()}>{hasKimiToken ? "重新登录" : "登录 Kimi"}</button>{hasKimiToken && <button className="button danger" onClick={() => void clearKimi()}>清除登录态</button>}</div>
    </section>
    <section className="card">
      <h2>网页会话后端</h2>
      <p className="muted">复用对应网站已有登录态，不申请 cookies 权限，不把站点 Cookie 或 Token 保存到扩展。ChatGPT 优先使用页面侧 Web API，失败后回退 DOM；DeepSeek 使用页面 DOM；Gemini 优先使用 Web RPC，失败后回退页面 DOM。内部协议或网页结构变化可能影响读取。</p>
      <div className="actions">{WEB_SESSION_PROVIDER_IDS.map((providerId) => {
        const status = webStatuses[providerId];
        const isChecking = checkingWebStatus === "all" || checkingWebStatus === providerId;
        return <span key={providerId} className="web-session-action-group"><span className="web-session-provider"><ProviderBadge providerId={providerId} /><span className={webSessionStatusClass(status)}>{isChecking ? "检测中…" : WEB_SESSION_STATUS_LABELS[status]}</span></span><button className="button provider-button" onClick={() => void openWebSession(providerId)}><ProviderIcon providerId={providerId} />{`登录 ${PROVIDER_LABELS[providerId]}`}</button><button className="button" disabled={isChecking} onClick={() => void refreshWebSessionStatuses(providerId)}>检测</button></span>;
      })}</div>
    </section>
    <section className="card">
      <h2 className="provider-heading"><ProviderIcon providerId="openai-compatible" /> OpenAI Compatible</h2><p className="warning">这是个人/内部 BYOK 模式。Token 会保存在本机扩展存储中，并随请求发送到你配置的服务。</p>
      <div className="field"><label className="label" htmlFor="apiRoot">API Root</label><input id="apiRoot" className="input" value={config.apiRoot} placeholder="https://api.openai.com/v1" onChange={(event) => setConfig({ ...config, apiRoot: event.target.value })} /><p className="muted">远程地址必须 HTTPS；HTTP 仅允许 localhost、127.0.0.1 和 ::1。</p></div>
      <div className="field"><label className="label" htmlFor="model">Model</label><input id="model" className="input" value={config.model} placeholder="填写服务商提供的模型名" onChange={(event) => setConfig({ ...config, model: event.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="token">API Token</label><input id="token" className="input" type="password" value={token} placeholder={hasToken ? "已配置（留空保持不变）" : "输入 Token；本机服务可留空"} onChange={(event) => setToken(event.target.value)} />{hasToken && <p className="muted">Token 已配置，不会回填明文。</p>}</div>
      <div className="option-grid"><div className="field"><label className="label" htmlFor="chunkChars">单块字符数</label><input id="chunkChars" className="input" type="number" min={4000} max={50000} value={config.chunkChars} onChange={(event) => setConfig({ ...config, chunkChars: Number(event.target.value) })} /></div><div className="field"><label className="label" htmlFor="maxSourceChars">最大源文本</label><input id="maxSourceChars" className="input" type="number" min={20000} max={500000} value={config.maxSourceChars} onChange={(event) => setConfig({ ...config, maxSourceChars: Number(event.target.value) })} /></div></div>
      <div className="actions"><button className="button" onClick={() => void testConnection()}>测试连接</button><button className="button danger" disabled={!hasToken} onClick={() => void clearToken()}>清除 Token</button></div>
    </section>
    <div className="actions"><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存全部设置"}</button></div>
  </div></main>;
}

function normalizeConfig(config: OpenAICompatibleConfig): OpenAICompatibleConfig {
  return { ...config, apiRoot: normalizeApiRoot(config.apiRoot), model: config.model.trim(), chunkChars: Number(config.chunkChars), maxSourceChars: Number(config.maxSourceChars) };
}

const WEB_SESSION_STATUS_LABELS: Record<WebSessionLoginStatus, string> = {
  "logged-in": "当前页面检测到已登录",
  "logged-out": "当前页面检测到未登录",
  "no-page": "未打开对应页面",
  "permission-required": "未授权页面访问",
  unknown: "暂无法检测",
};

function createInitialWebSessionStatuses(): Record<WebSessionProviderId, WebSessionLoginStatus> {
  return {
    "chatgpt-web": "unknown",
    "gemini-web": "unknown",
    "deepseek-web": "unknown",
  };
}

function webSessionStatusClass(status: WebSessionLoginStatus): string {
  if (status === "logged-in") return "success";
  if (status === "logged-out") return "warning";
  return "muted";
}
