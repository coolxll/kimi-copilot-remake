import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { AppSettingsV2, OpenAICompatibleConfig, ProviderId, WebSessionProviderId } from "../../domain/types";
import { DEFAULT_CHUNK_CHARS, DEFAULT_MAX_SOURCE_CHARS, DEFAULT_PROMPT, isWebSessionProvider, PROVIDER_LABELS } from "../../domain/types";
import type { AppErrorCode } from "../../domain/errors";
import { AppError, toAppError } from "../../domain/errors";
import { ensureApiHostPermission, normalizeApiRoot, revokeApiHostPermission, shouldRevokeApiHostPermission, validateApiRoot } from "../../platform/chrome/permissions";
import { createAppServices } from "../../application/services";
import type { WebSessionLoginStatus } from "../../integrations/web-session/client";
import { isGeminiDiagnosticReport, type GeminiDiagnosticEvent, type GeminiDiagnosticMode, type GeminiDiagnosticReport } from "../../integrations/web-session/gemini-diagnostics";
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
  const [connectionStatuses, setConnectionStatuses] = useState<Record<ProviderId, ConnectivityStatus>>(createInitialConnectivityStatuses);
  const [geminiDiagnosticReports, setGeminiDiagnosticReports] = useState<GeminiDiagnosticReport[]>([]);
  const [geminiDiagnosticReport, setGeminiDiagnosticReport] = useState<GeminiDiagnosticReport>();
  const [geminiDiagnosticEvents, setGeminiDiagnosticEvents] = useState<GeminiDiagnosticEvent[]>([]);
  const [geminiDiagnosticMode, setGeminiDiagnosticMode] = useState<GeminiDiagnosticMode>();
  const loginControllerRef = useRef<AbortController | undefined>(undefined);
  const connectionControllersRef = useRef(new Map<ProviderId, AbortController>());
  const geminiDiagnosticControllerRef = useRef<AbortController | undefined>(undefined);
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
        const diagnosticReports = await services.storage.getGeminiDiagnosticReports();
        setSettings(loaded);
        setDefaultProvider(loaded.defaultProvider);
        setPrompt(loaded.promptOverride || DEFAULT_PROMPT);
        setConfig(loaded.openAICompatible || { apiRoot: "", model: "", chunkChars: DEFAULT_CHUNK_CHARS, maxSourceChars: DEFAULT_MAX_SOURCE_CHARS });
        setHasToken(Boolean(secret?.apiToken));
        setHasKimiToken(Boolean(kimi?.refreshToken));
        setGeminiDiagnosticReports(diagnosticReports);
        setGeminiDiagnosticReport(diagnosticReports[0]);
      } catch (error) {
        setNotice({ kind: "error", text: toAppError(error).message });
      }
    })();
    void refreshWebSessionStatuses();
    return () => {
      loginControllerRef.current?.abort("options closed");
      for (const controller of connectionControllersRef.current.values()) controller.abort("options closed");
      geminiDiagnosticControllerRef.current?.abort("options closed");
    };
    // Services are stable for this options page.
  }, []);

  const beginLogin = (): AbortController => {
    loginControllerRef.current?.abort("new login");
    const controller = new AbortController();
    loginControllerRef.current = controller;
    return controller;
  };

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
      if (oldRoot && shouldRevokeApiHostPermission(oldRoot, nextConfig?.apiRoot)) await revokeApiHostPermission(oldRoot);
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

  const testProviderConnection = async (providerId: ProviderId) => {
    connectionControllersRef.current.get(providerId)?.abort("new connectivity test");
    const controller = new AbortController();
    connectionControllersRef.current.set(providerId, controller);
    setNotice(undefined);
    setConnectionStatuses((current) => ({ ...current, [providerId]: { state: "testing" } }));
    try {
      let result: { ok: boolean; message: string; externalUrl?: string };
      if (providerId === "openai-compatible") {
        const nextConfig = normalizeConfig(config);
        validateApiRoot(nextConfig.apiRoot);
        await ensureApiHostPermission(nextConfig.apiRoot);
        const secret = token.trim() ? { apiToken: token.trim() } : await services.storage.getOpenAISecret();
        result = await services.testProviderConnection(providerId, {
          config: nextConfig,
          secret,
          signal: controller.signal,
        });
      } else {
        result = await services.testProviderConnection(providerId, { signal: controller.signal });
      }
      if (controller.signal.aborted) return;
      setConnectionStatuses((current) => ({
        ...current,
        [providerId]: { state: result.ok ? "success" : "error", message: result.message, ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}) },
      }));
    } catch (error) {
      if (!controller.signal.aborted) {
        const appError = toAppError(error);
        setConnectionStatuses((current) => ({
          ...current,
          [providerId]: { state: "error", message: appError.message, code: appError.code, ...(appError.externalUrl ? { externalUrl: appError.externalUrl } : {}) },
        }));
      }
    } finally {
      if (!controller.signal.aborted && isWebSessionProvider(providerId)) void refreshWebSessionStatuses(providerId);
      if (connectionControllersRef.current.get(providerId) === controller) connectionControllersRef.current.delete(providerId);
    }
  };

  const loginKimi = async () => {
    setNotice(undefined);
    const controller = beginLogin();
    try {
      await services.auth.openLoginAndWait(120_000, controller.signal);
      setHasKimiToken(true);
      setConnectionStatuses((current) => ({ ...current, "kimi-web": { state: "idle" } }));
      setNotice({ kind: "success", text: "Kimi 登录态已保存" });
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      if (loginControllerRef.current === controller) loginControllerRef.current = undefined;
    }
  };

  const clearKimi = async () => {
    await services.auth.clear();
    setHasKimiToken(false);
    setConnectionStatuses((current) => ({ ...current, "kimi-web": { state: "idle" } }));
    setNotice({ kind: "success", text: "Kimi 登录态已清除" });
  };

  const openWebSession = async (providerId: WebSessionProviderId) => {
    setNotice(undefined);
    const controller = beginLogin();
    try {
      await services.webSessions.openLogin(providerId, 120_000, controller.signal);
      void refreshWebSessionStatuses(providerId);
      setConnectionStatuses((current) => ({ ...current, [providerId]: { state: "idle" } }));
      setNotice({ kind: "success", text: `${PROVIDER_LABELS[providerId]} 登录态已保存，正常总结时使用后台 Web 协议。` });
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      if (loginControllerRef.current === controller) loginControllerRef.current = undefined;
    }
  };

  const clearWebSession = async (providerId: WebSessionProviderId) => {
    await services.storage.clearWebSessionCredential(providerId);
    setWebStatuses((current) => ({ ...current, [providerId]: "no-page" }));
    setConnectionStatuses((current) => ({ ...current, [providerId]: { state: "idle" } }));
    setNotice({ kind: "success", text: `${PROVIDER_LABELS[providerId]} 登录态已清除` });
  };

  const runGeminiDiagnostic = async (mode: GeminiDiagnosticMode) => {
    geminiDiagnosticControllerRef.current?.abort("new Gemini diagnostic");
    const controller = new AbortController();
    geminiDiagnosticControllerRef.current = controller;
    setGeminiDiagnosticMode(mode);
    setGeminiDiagnosticEvents([]);
    setNotice(undefined);
    try {
      const report = await services.webSessions.diagnoseGemini(mode, controller.signal, (event) => {
        setGeminiDiagnosticEvents((current) => [...current, event].slice(-96));
      });
      if (controller.signal.aborted) return;
      setGeminiDiagnosticReport(report);
      setGeminiDiagnosticReports((current) => [report, ...current.filter((item) => item.runId !== report.runId)].slice(0, 10));
      await services.storage.saveGeminiDiagnosticReport(report);
    } catch (error) {
      if (controller.signal.aborted) return;
      const appError = toAppError(error);
      const report = isGeminiDiagnosticReport(appError.diagnostic) ? appError.diagnostic : undefined;
      if (report) {
        setGeminiDiagnosticReport(report);
        setGeminiDiagnosticReports((current) => [report, ...current.filter((item) => item.runId !== report.runId)].slice(0, 10));
        await services.storage.saveGeminiDiagnosticReport(report);
      }
      setNotice({ kind: "error", text: `${appError.message}${appError.code ? ` · 错误码：${appError.code}` : ""}` });
    } finally {
      if (geminiDiagnosticControllerRef.current === controller) {
        geminiDiagnosticControllerRef.current = undefined;
        setGeminiDiagnosticMode(undefined);
      }
    }
  };

  const clearGeminiDiagnostics = async () => {
    await services.storage.clearGeminiDiagnosticReports();
    setGeminiDiagnosticReports([]);
    setGeminiDiagnosticReport(undefined);
    setGeminiDiagnosticEvents([]);
    setNotice({ kind: "success", text: "Gemini 诊断历史已清除" });
  };

  const copyGeminiDiagnostics = async () => {
    const report = geminiDiagnosticReport || geminiDiagnosticReports[0];
    if (!report) return;
    try {
      const { externalUrl: _externalUrl, ...safeReport } = report;
      await navigator.clipboard.writeText(JSON.stringify(safeReport, null, 2));
      setNotice({ kind: "success", text: "已复制脱敏 Gemini 诊断 JSON" });
    } catch (error) {
      setNotice({ kind: "error", text: `复制诊断信息失败：${toAppError(error).message}` });
    }
  };

  const openExtractorTest = () => void browser.tabs.create({ url: browser.runtime.getURL("/") + "youtube-test.html" });

  if (!settings) return <main className="page"><div className="panel">加载中…</div></main>;
  return <main className="page"><div className="panel">
    <header className="header"><h1>选项</h1><button className="button" onClick={() => void browser.tabs.create({ url: "chrome://extensions/shortcuts" })}>快捷键</button></header>
    {notice && <div className={notice.kind === "success" ? "success" : "error"}>{notice.text}</div>}
    <section className="card">
      <h2>提取器测试</h2>
      <p className="muted">测试 YouTube、Bilibili、Discourse、知乎、X / Twitter、普通网页和 PDF 的实际提取结果，查看正文、讨论、评论和 warning。</p>
      <div className="actions"><button className="button" onClick={openExtractorTest}>打开提取器测试页</button></div>
    </section>
    <section className="card">
      <div className="field"><label className="label" htmlFor="provider">默认总结后端</label><ProviderPicker id="provider" value={defaultProvider} onChange={setDefaultProvider} ariaLabel="默认总结后端" /></div>
      <div className="field"><label className="label" htmlFor="prompt">Prompt</label><textarea id="prompt" className="textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><p className="muted">留空或恢复默认将使用：{DEFAULT_PROMPT}</p></div>
    </section>
    <section className="card">
      <h2 className="provider-heading"><ProviderIcon providerId="kimi-web" /> Kimi Web</h2><p className="muted">复用当前浏览器中的 Kimi 登录态，文件会通过 Kimi 文件接口处理。</p>
      <div className="actions"><span className={hasKimiToken ? "success" : "warning"}>{hasKimiToken ? "已配置登录态" : "未登录"}</span><button className="button" onClick={() => void loginKimi()}>{hasKimiToken ? "重新登录" : "登录 Kimi"}</button><button className="button" disabled={!hasKimiToken || isConnectionTesting(connectionStatuses["kimi-web"])} onClick={() => void testProviderConnection("kimi-web")}>{isConnectionTesting(connectionStatuses["kimi-web"]) ? "测试中…" : "测试连通性"}</button>{renderConnectivityStatus(connectionStatuses["kimi-web"])}{hasKimiToken && <button className="button danger" onClick={() => void clearKimi()}>清除登录态</button>}</div>
    </section>
    <section className="card">
      <h2>网页会话后端</h2>
      <p className="muted">登录时打开对应网站采集可复用凭据并保存在本机扩展存储；“发送会话测试”会向对应账号发送 PROJECT_OK，并创建一条测试会话。ChatGPT Cookie 只在请求内存中使用，不会落盘。</p>
      <div className="actions">{WEB_SESSION_PROVIDER_IDS.map((providerId) => {
        const status = webStatuses[providerId];
        const isChecking = checkingWebStatus === "all" || checkingWebStatus === providerId;
        return <div key={providerId} className="web-session-action-group"><span className="web-session-provider"><ProviderBadge providerId={providerId} /><span className={webSessionStatusClass(status)}>{isChecking ? "检测中…" : WEB_SESSION_STATUS_LABELS[status]}</span></span><button className="button provider-button" onClick={() => void openWebSession(providerId)}><ProviderIcon providerId={providerId} />{status === "logged-in" || status === "page-logged-in" || status === "saved-unverified" ? `更新 ${PROVIDER_LABELS[providerId]}` : `登录 ${PROVIDER_LABELS[providerId]}`}</button><button className="button" disabled={isChecking} onClick={() => void refreshWebSessionStatuses(providerId)}>检测登录态</button><button className="button" disabled={isConnectionTesting(connectionStatuses[providerId])} onClick={() => void testProviderConnection(providerId)}>{isConnectionTesting(connectionStatuses[providerId]) ? "测试中…" : "发送会话测试"}</button>{renderConnectivityStatus(connectionStatuses[providerId])}{status === "logged-in" || status === "saved-unverified" ? <button className="button danger" onClick={() => void clearWebSession(providerId)}>清除</button> : null}</div>;
      })}</div>
      <div className="gemini-diagnostic-box">
        <div className="gemini-diagnostic-heading"><div><h3>Gemini 调试诊断</h3><p className="muted">只在这里发送 PROJECT_OK 测试，不影响正常总结。事件与响应结构会脱敏保存最近 10 次。</p></div><span className="muted">{geminiDiagnosticReports.length ? `历史 ${geminiDiagnosticReports.length} 条` : "暂无历史"}</span></div>
        <div className="actions gemini-diagnostic-actions"><button className="button" disabled={Boolean(geminiDiagnosticMode)} onClick={() => void runGeminiDiagnostic("context")}>{geminiDiagnosticMode === "context" ? "检查中…" : "检查上下文"}</button><button className="button" disabled={Boolean(geminiDiagnosticMode)} onClick={() => void runGeminiDiagnostic("background")}>{geminiDiagnosticMode === "background" ? "测试中…" : "诊断后台请求"}</button><button className="button" disabled={Boolean(geminiDiagnosticMode)} onClick={() => void runGeminiDiagnostic("page")}>{geminiDiagnosticMode === "page" ? "测试中…" : "页面同源对照"}</button>{(geminiDiagnosticReport || geminiDiagnosticReports.length > 0) && <button className="button" onClick={() => void copyGeminiDiagnostics()}>复制诊断 JSON</button>}<button className="button danger" disabled={geminiDiagnosticReports.length === 0} onClick={() => void clearGeminiDiagnostics()}>清除历史</button></div>
        {geminiDiagnosticMode && geminiDiagnosticEvents.length > 0 && <DiagnosticTimeline events={geminiDiagnosticEvents} live />}
        {geminiDiagnosticReport && <GeminiDiagnosticReportView report={geminiDiagnosticReport} />}
        {!geminiDiagnosticReport && geminiDiagnosticReports[0] && <GeminiDiagnosticReportView report={geminiDiagnosticReports[0]} />}
        {geminiDiagnosticReports.length > 1 && <details className="gemini-diagnostic-history"><summary>查看最近诊断</summary><div>{geminiDiagnosticReports.map((report) => <button key={report.runId} className="gemini-diagnostic-history-item" onClick={() => setGeminiDiagnosticReport(report)}><span className={`gemini-diagnostic-outcome ${report.outcome}`}>{report.outcome === "success" ? "成功" : report.outcome === "warning" ? "警告" : "失败"}</span><span>{report.summary}</span><span className="muted">{new Date(report.endedAt).toLocaleString()}</span></button>)}</div></details>}
      </div>
    </section>
    <section className="card">
      <h2 className="provider-heading"><ProviderIcon providerId="openai-compatible" /> OpenAI Compatible</h2><p className="warning">这是个人/内部 BYOK 模式。Token 会保存在本机扩展存储中，并随请求发送到你配置的服务。</p>
      <div className="field"><label className="label" htmlFor="apiRoot">API Root</label><input id="apiRoot" className="input" value={config.apiRoot} placeholder="https://api.openai.com/v1" onChange={(event) => setConfig({ ...config, apiRoot: event.target.value })} /><p className="muted">远程地址必须 HTTPS；HTTP 仅允许 localhost、127.0.0.1 和 ::1。</p></div>
      <div className="field"><label className="label" htmlFor="model">Model</label><input id="model" className="input" value={config.model} placeholder="填写服务商提供的模型名" onChange={(event) => setConfig({ ...config, model: event.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="token">API Token</label><input id="token" className="input" type="password" value={token} placeholder={hasToken ? "已配置（留空保持不变）" : "输入 Token；本机服务可留空"} onChange={(event) => setToken(event.target.value)} />{hasToken && <p className="muted">Token 已配置，不会回填明文。</p>}</div>
      <div className="option-grid"><div className="field"><label className="label" htmlFor="chunkChars">单块字符数</label><input id="chunkChars" className="input" type="number" min={4000} max={50000} value={config.chunkChars} onChange={(event) => setConfig({ ...config, chunkChars: Number(event.target.value) })} /></div><div className="field"><label className="label" htmlFor="maxSourceChars">最大源文本</label><input id="maxSourceChars" className="input" type="number" min={20000} max={500000} value={config.maxSourceChars} onChange={(event) => setConfig({ ...config, maxSourceChars: Number(event.target.value) })} /></div></div>
      <div className="actions"><button className="button" disabled={isConnectionTesting(connectionStatuses["openai-compatible"])} onClick={() => void testProviderConnection("openai-compatible")}>{isConnectionTesting(connectionStatuses["openai-compatible"]) ? "测试中…" : "测试连接"}</button>{renderConnectivityStatus(connectionStatuses["openai-compatible"])}<button className="button danger" disabled={!hasToken} onClick={() => void clearToken()}>清除 Token</button></div>
    </section>
    <div className="actions"><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存全部设置"}</button></div>
  </div></main>;
}

function GeminiDiagnosticReportView({ report }: { report: GeminiDiagnosticReport }) {
  const outcomeLabel = report.outcome === "success" ? "成功" : report.outcome === "warning" ? "有警告" : "失败";
  return <div className="gemini-diagnostic-report">
    <div className="gemini-diagnostic-summary"><span className={`gemini-diagnostic-outcome ${report.outcome}`}>{outcomeLabel}</span><span>{report.summary}</span>{report.externalUrl && <a href={report.externalUrl} target="_blank" rel="noreferrer">打开测试会话</a>}<span className="muted">{new Date(report.endedAt).toLocaleString()}</span></div>
    <DiagnosticTimeline events={report.events} />
  </div>;
}

function DiagnosticTimeline({ events, live = false }: { events: GeminiDiagnosticEvent[]; live?: boolean }) {
  return <div className="gemini-diagnostic-timeline" aria-live={live ? "polite" : undefined}>
    {events.map((event) => <div key={`${event.sequence}-${event.at}`} className={`gemini-diagnostic-event ${event.status}`}>
      <span className="gemini-diagnostic-event-marker" />
      <div className="gemini-diagnostic-event-content"><div><strong>{event.stage}</strong><span className="muted"> · {event.status}</span>{typeof event.attempt === "number" && <span className="muted"> · 尝试 {event.attempt}</span>}</div><div>{event.message}</div>{event.details && <pre>{JSON.stringify(event.details)}</pre>}</div>
    </div>)}
  </div>;
}

function normalizeConfig(config: OpenAICompatibleConfig): OpenAICompatibleConfig {
  return { ...config, apiRoot: normalizeApiRoot(config.apiRoot), model: config.model.trim(), chunkChars: Number(config.chunkChars), maxSourceChars: Number(config.maxSourceChars) };
}

const WEB_SESSION_STATUS_LABELS: Record<WebSessionLoginStatus, string> = {
  "logged-in": "扩展登录态可用",
  "page-logged-in": "页面已登录，尚未采集扩展登录态",
  "logged-out": "当前页面检测到未登录",
  "saved-unverified": "已保存登录态，尚未实时验证",
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
  if (status === "page-logged-in" || status === "logged-out" || status === "saved-unverified") return "warning";
  return "muted";
}

type ConnectivityStatus = {
  state: "idle" | "testing" | "success" | "error";
  message?: string;
  code?: AppErrorCode;
  externalUrl?: string;
};

function createInitialConnectivityStatuses(): Record<ProviderId, ConnectivityStatus> {
  return {
    "kimi-web": { state: "idle" },
    "chatgpt-web": { state: "idle" },
    "gemini-web": { state: "idle" },
    "deepseek-web": { state: "idle" },
    "openai-compatible": { state: "idle" },
  };
}

function isConnectionTesting(status: ConnectivityStatus | undefined): boolean {
  return status?.state === "testing";
}

function renderConnectivityStatus(status: ConnectivityStatus | undefined) {
  const current = status ?? { state: "idle" as const };
  const label = current.state === "testing"
    ? "测试中…"
    : current.state === "success"
      ? current.message || "连通性正常"
      : current.state === "error"
        ? current.message || "连通性测试失败"
        : "尚未测试";
  const diagnostic = current.state === "error" && current.code ? ` · 错误码：${current.code}` : "";
  return <span className={`connectivity-status ${connectivityStatusClass(current.state)}`} aria-live="polite">{label}{diagnostic}{current.externalUrl ? <> · <a href={current.externalUrl} target="_blank" rel="noreferrer">打开会话</a></> : null}</span>;
}

function connectivityStatusClass(state: ConnectivityStatus["state"]): string {
  if (state === "success") return "success";
  if (state === "error") return "error";
  return "muted";
}
