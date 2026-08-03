import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { browser } from "wxt/browser";
import { AppError, toAppError } from "../../domain/errors";
import { isWebSessionProvider, PROVIDER_LABELS, type AppSettingsV2, type ExtractedDocument, type ProviderId } from "../../domain/types";
import { isYoutubePageUrl } from "../../domain/youtube";
import { getPageContext, runSummary } from "../../application/summarize-page";
import { generateRepurpose, MD2CARD_EDITOR_URL, type RepurposeFormat, type RepurposeProgress, type RepurposeTarget } from "../../application/repurpose";
import { createAppServices } from "../../application/services";
import { initialTaskState, taskReducer, type TaskState } from "../../application/task-state";
import { safeFilename } from "../../shared/filename";
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
  const [repurpose, setRepurpose] = useState<RepurposeState>({ status: "idle" });
  const [repurposeNotice, setRepurposeNotice] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const repurposeControllerRef = useRef<AbortController | undefined>(undefined);
  const sourceDocumentRef = useRef<ExtractedDocument | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let sourceTabId: number | undefined;
    const onSourceTabUpdated = (updatedTabId: number, changeInfo: { status?: string; url?: string }) => {
      if (updatedTabId !== sourceTabId || (!changeInfo.url && changeInfo.status !== "loading")) return;
      controllerRef.current?.abort("source tab navigated");
      repurposeControllerRef.current?.abort("source tab navigated");
      sourceDocumentRef.current = undefined;
      setRepurpose({ status: "idle" });
      setRepurposeNotice(undefined);
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
      repurposeControllerRef.current?.abort("sidepanel closed");
      browser.tabs.onUpdated.removeListener(onSourceTabUpdated);
    };
    // The first mount intentionally captures the source tab.
  }, []);

  const start = useCallback(async (nextProvider: ProviderId, context?: Awaited<ReturnType<typeof getPageContext>>, explicitTabId?: number) => {
    const sourceTabId = explicitTabId ?? tabId;
    if (!sourceTabId) return;
    controllerRef.current?.abort("new summary");
    repurposeControllerRef.current?.abort("new summary");
    sourceDocumentRef.current = undefined;
    setRepurpose({ status: "idle" });
    setRepurposeNotice(undefined);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const page = context ?? await getPageContext(sourceTabId);
      const document = await runSummary(services, nextProvider, page, controller.signal, dispatch);
      if (!controller.signal.aborted) sourceDocumentRef.current = document;
    } catch (error) {
      dispatch({ type: "error", error: toAppError(error) });
    }
  }, [services, tabId]);

  const handleProviderChange = (next: ProviderId) => {
    controllerRef.current?.abort("provider changed");
    repurposeControllerRef.current?.abort("provider changed");
    sourceDocumentRef.current = undefined;
    setProvider(next);
    setLoginNotice(undefined);
    setRepurpose({ status: "idle" });
    setRepurposeNotice(undefined);
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

  const generateRepurposeContent = async () => {
    if (state.status !== "success") return;
    repurposeControllerRef.current?.abort("new Repurpose");
    const controller = new AbortController();
    repurposeControllerRef.current = controller;
    setRepurposeNotice(undefined);
    setRepurpose({ status: "loading", phase: "准备中", markdown: "", warnings: [] });
    try {
      const result = await generateRepurpose(
        services,
        provider,
        state.markdown,
        sourceDocumentRef.current,
        controller.signal,
        (progress) => setRepurpose((current) => updateRepurposeProgress(current, progress)),
      );
      if (!controller.signal.aborted) setRepurpose({ status: "success", ...result });
    } catch (error) {
      if (!controller.signal.aborted) {
        const appError = toAppError(error);
        setRepurpose((current) => ({
          status: "error",
          error: appError,
          markdown: current.status === "loading" ? current.markdown : undefined,
          warnings: current.status === "loading" ? current.warnings : undefined,
        }));
      }
    } finally {
      if (repurposeControllerRef.current === controller) repurposeControllerRef.current = undefined;
    }
  };

  const downloadRepurpose = () => {
    if (repurpose.status !== "success") return;
    const title = sourceDocumentRef.current?.title || "Repurpose 长图文稿";
    downloadTextFile(`${safeFilename(title, "repurpose")}-小红书.md`, repurpose.markdown);
  };

  const openMd2Card = async () => {
    if (repurpose.status !== "success") return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(repurpose.markdown);
      copied = true;
    } catch (error) {
      setRepurposeNotice(`无法自动复制 Markdown：${toAppError(error).message}。已尝试打开编辑器，可改用下载文件。`);
    }
    try {
      await browser.tabs.create({ url: MD2CARD_EDITOR_URL, active: true });
      if (copied) setRepurposeNotice("Markdown 已复制，进入 md2card 后直接粘贴；再使用编辑器的“导出 ZIP”。");
    } catch (error) {
      setRepurposeNotice(`无法打开 md2card：${toAppError(error).message}。可先下载 Markdown 文件。`);
    }
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
      <section className="repurpose-block">
        <div className="repurpose-heading"><span>Repurpose</span><span className="muted">小红书风格 · md2card 长图文</span></div>
        <p className="muted">将当前总结改写为小红书风格 Markdown，并交给 md2card 编辑、分卡和导出长图。微博/X 原生文字或线程会使用另一种呈现格式。</p>
        {repurpose.status === "idle" && <button className="button primary" onClick={() => void generateRepurposeContent()}>生成 Repurpose</button>}
        {repurpose.status === "loading" && <>
          <div className="progress"><span className="spinner" />{repurpose.phase}</div>
          {repurpose.markdown && <Markdown content={repurpose.markdown} />}
          <div className="actions"><button className="button" onClick={() => { repurposeControllerRef.current?.abort("user cancelled"); setRepurpose({ status: "idle" }); }}>取消 Repurpose</button></div>
        </>}
        {repurpose.status === "error" && <>
          <div className="error">{repurpose.error.message}</div>
          {repurpose.markdown && <Markdown content={repurpose.markdown} />}
          {repurpose.warnings?.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
          <div className="actions"><button className="button primary" onClick={() => void generateRepurposeContent()} disabled={!repurpose.error.retryable}>重试 Repurpose</button>{!repurpose.error.retryable && <button className="button" onClick={openOptions}>打开选项</button>}</div>
        </>}
        {repurpose.status === "success" && <>
          <Markdown content={repurpose.markdown} />
          {repurpose.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
          <div className="actions repurpose-actions">
            <button className="button" onClick={downloadRepurpose}>下载 Markdown</button>
            <button className="button primary" onClick={() => void openMd2Card()}>复制并打开 md2card</button>
            <button className="button" onClick={() => void generateRepurposeContent()}>重新生成</button>
          </div>
          {repurpose.imageUrls.length > 0 && <p className="muted">已带入 {repurpose.imageUrls.length} 个真实图片链接；导出 ZIP 前请在 md2card 预览中检查图片是否可访问。</p>}
          <p className="muted">打开后粘贴 Markdown，检查长图文分卡和图片，再点击 md2card 的导出功能生成图片 ZIP。</p>
          {repurposeNotice && <div className="success">{repurposeNotice}</div>}
        </>}
      </section>
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

type RepurposeState =
  | { status: "idle" }
  | { status: "loading"; phase: string; markdown: string; warnings: string[] }
  | { status: "success"; target: RepurposeTarget; format: RepurposeFormat; markdown: string; imageUrls: string[]; warnings: string[] }
  | { status: "error"; error: AppError; markdown?: string; warnings?: string[] };

function updateRepurposeProgress(state: RepurposeState, progress: RepurposeProgress): RepurposeState {
  if (state.status !== "loading") return state;
  const warnings = progress.warning && !state.warnings.includes(progress.warning)
    ? [...state.warnings, progress.warning]
    : state.warnings;
  return {
    ...state,
    phase: progress.phase ? repurposePhaseLabel(progress.phase) : state.phase,
    markdown: progress.markdown ?? state.markdown,
    warnings,
  };
}

function repurposePhaseLabel(phase: string): string {
  switch (phase) {
    case "uploading": return "正在准备改写";
    case "chunking": return "正在拆分总结";
    case "summarizing": return "正在生成 Repurpose 长图文稿";
    default: return phase;
  }
}

function downloadTextFile(filename: string, content: string): void {
  const href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function useReducerCompat(): [TaskState, typeof dispatch] {
  const [state, setState] = useState<TaskState>(initialTaskState);
  const dispatch = (action: Parameters<typeof taskReducer>[1]) => setState((current) => taskReducer(current, action));
  return [state, dispatch];
}
