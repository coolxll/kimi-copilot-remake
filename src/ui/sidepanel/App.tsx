import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { browser } from "wxt/browser";
import { AppError, toAppError } from "../../domain/errors";
import { isWebSessionProvider, PROVIDER_LABELS, type AppSettingsV2, type ProviderId } from "../../domain/types";
import { isYoutubePageUrl } from "../../domain/youtube";
import { getPageContext, runSummary } from "../../application/summarize-page";
import { createAppServices } from "../../application/services";
import { initialTaskState, taskReducer, type TaskState } from "../../application/task-state";
import { ProviderBadge, ProviderIcon, ProviderPicker } from "../components/provider-brand";
import "../styles.css";

export function SidePanelApp() {
  const services = useMemo(() => createAppServices(), []);
  const [settings, setSettings] = useState<AppSettingsV2>();
  const [provider, setProvider] = useState<ProviderId>("kimi-web");
  const [state, dispatch] = useReducerCompat();
  const [tabId, setTabId] = useState<number>();
  const [pageError, setPageError] = useState<AppError>();
  const [loginNotice, setLoginNotice] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let sourceTabId: number | undefined;
    const onSourceTabUpdated = (updatedTabId: number, changeInfo: { status?: string; url?: string }) => {
      if (updatedTabId !== sourceTabId || (!changeInfo.url && changeInfo.status !== "loading")) return;
      controllerRef.current?.abort("source tab navigated");
      dispatch({ type: "reset" });
    };
    browser.tabs.onUpdated.addListener(onSourceTabUpdated);
    void (async () => {
      try {
        const settingsValue = await services.storage.getSettings();
        const queryTabId = Number(new URLSearchParams(location.search).get("tabId"));
        const fallback = (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        const activeTabId = Number.isInteger(queryTabId) && queryTabId > 0 ? queryTabId : fallback;
        if (!activeTabId) throw new AppError("unsupported-page", "找不到当前标签页");
        if (!disposed) {
          sourceTabId = activeTabId;
          setSettings(settingsValue);
          setTabId(activeTabId);
          const context = await getPageContext(activeTabId);
          const initialProvider: ProviderId = isYoutubePageUrl(context.url) ? "gemini-web" : settingsValue.defaultProvider;
          if (!disposed) {
            setProvider(initialProvider);
            void start(initialProvider, context, activeTabId);
          }
        }
      } catch (error) {
        if (!disposed) setPageError(toAppError(error));
      }
    })();
    return () => {
      disposed = true;
      controllerRef.current?.abort("sidepanel closed");
      browser.tabs.onUpdated.removeListener(onSourceTabUpdated);
    };
    // The first mount intentionally captures the source tab.
  }, []);

  const start = useCallback(async (nextProvider: ProviderId, context?: Awaited<ReturnType<typeof getPageContext>>, explicitTabId?: number) => {
    const sourceTabId = explicitTabId ?? tabId;
    if (!sourceTabId) return;
    controllerRef.current?.abort("new summary");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const page = context ?? await getPageContext(sourceTabId);
      await runSummary(services, nextProvider, page, controller.signal, dispatch);
    } catch (error) {
      dispatch({ type: "error", error: toAppError(error) });
    }
  }, [services, tabId]);

  const handleProviderChange = (next: ProviderId) => {
    controllerRef.current?.abort("provider changed");
    setProvider(next);
    setLoginNotice(undefined);
    dispatch({ type: "reset" });
  };

  const handleLogin = async () => {
    controllerRef.current?.abort("login started");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setLoginNotice(undefined);
      if (isWebSessionProvider(provider)) {
        await services.webSessions.openLogin(provider, 120_000, controller.signal);
        setLoginNotice(`${PROVIDER_LABELS[provider]} 登录态已更新，正在重新总结。`);
        if (tabId) await start(provider, undefined, tabId);
        return;
      }
      await services.auth.openLoginAndWait(120_000, controller.signal);
      if (tabId) await start("kimi-web");
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "error", error: toAppError(error) });
    }
  };

  const openOptions = () => void browser.runtime.openOptionsPage();
  const copy = () => {
    if (state.status === "success") void navigator.clipboard.writeText(state.markdown);
  };

  return <main className="page sidepanel-page"><div className="panel">
    <header className="header">
      <div className="brand"><img src={browser.runtime.getURL("/icon-128.png")} alt="" /> Kimi Copilot</div>
      <div className="toolbar">
        <ProviderPicker value={provider} onChange={handleProviderChange} ariaLabel="总结后端" />
        <button className="button" onClick={openOptions}>选项</button>
      </div>
    </header>

    {pageError && <div className="error">{pageError.message}</div>}
    {loginNotice && <div className="success">{loginNotice}</div>}
    {state.status === "auth-required" && <div className="card">
      <p>{state.message}</p><button className="button primary provider-button" onClick={() => void handleLogin()}><ProviderIcon providerId={provider} />{isWebSessionProvider(provider) ? `打开 ${PROVIDER_LABELS[provider]}` : "登录 Kimi"}</button>
    </div>}
    {state.status === "provider-not-configured" && <div className="card">
      <p>{state.message}</p><button className="button primary" onClick={openOptions}>打开选项配置</button>
    </div>}
    {state.status === "loading" && <section className="card">
      <div className="progress"><span className="spinner" /><ProviderBadge providerId={state.provider} /> · {state.phase}{state.current && state.total ? ` ${state.current}/${state.total}` : ""}</div>
      {state.markdown && <Markdown content={state.markdown} />}
      {state.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      <div className="actions"><button className="button" onClick={() => { controllerRef.current?.abort("user cancelled"); dispatch({ type: "reset" }); }}>取消</button></div>
    </section>}
    {state.status === "success" && <section className="card">
      <p className="muted output-provider"><span>输出后端：</span><ProviderBadge providerId={state.provider} /></p><Markdown content={state.markdown} />
      {state.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      <div className="actions">
        <div className="action-group">
          <IconButton icon="copy" label="复制总结" onClick={copy} />
          {state.externalUrl && <a className="button" href={state.externalUrl} target="_blank" rel="noreferrer">去 {PROVIDER_LABELS[state.provider]} 继续对话</a>}
        </div>
        <IconButton icon="refresh" label="重新总结" onClick={() => void start(provider)} />
      </div>
    </section>}
    {state.status === "error" && <section className="card">
      <div className="error">{state.error.message}</div>
      {state.markdown && <Markdown content={state.markdown} />}
      {state.warnings?.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      <div className="actions"><button className="button primary" onClick={() => void start(provider)} disabled={!state.canRetry}>重试</button><button className="button" onClick={openOptions}>打开选项</button></div>
    </section>}
    {state.status === "idle" && <section className="card"><p className="current-provider">当前后端：<ProviderBadge providerId={provider} />。</p><button className="button primary provider-button" onClick={() => void start(provider)}><ProviderIcon providerId={provider} />使用此后端重新总结</button></section>}
    {settings && <p className="muted current-provider">当前后端：<ProviderBadge providerId={provider} /> · 临时切换不会修改默认设置</p>}
  </div></main>;
}

function Markdown({ content }: { content: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

function IconButton({ icon, label, onClick }: { icon: "copy" | "refresh"; label: string; onClick: () => void }) {
  return <button className="button icon-button" type="button" onClick={onClick} aria-label={label} title={label}>
    <Icon name={icon} />
  </button>;
}

function Icon({ name }: { name: "copy" | "refresh" }) {
  if (name === "copy") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 11a8 8 0 0 0-14.7-4.3L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.7 4.3L20 16" />
    <path d="M20 20v-4h-4" />
  </svg>;
}

function useReducerCompat(): [TaskState, typeof dispatch] {
  const [state, setState] = useState<TaskState>(initialTaskState);
  const dispatch = (action: Parameters<typeof taskReducer>[1]) => setState((current) => taskReducer(current, action));
  return [state, dispatch];
}
