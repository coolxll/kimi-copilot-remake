import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { AppError, toAppError } from "../../domain/errors";
import type { DocumentKind, ExtractedDocument, PageContext } from "../../domain/types";
import type { ExtractorDescriptor } from "../../extractors/extractor";
import { createExtractorRegistry, selectExtractor } from "../../extractors/registry";
import { ensurePageHostPermission } from "../../platform/chrome/permissions";
import "../styles.css";

interface TestTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  extractor: ExtractorDescriptor;
}

interface BrowserTab {
  id?: number;
  title?: string;
  url?: string;
  status?: string;
  active?: boolean;
}

interface ExtractorTestResult {
  extractor: ExtractorDescriptor;
  kind: DocumentKind;
  title: string;
  url: string;
  output: string;
  warnings: string[];
}

const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  youtube: "YouTube",
  bilibili: "Bilibili",
  webpage: "普通网页",
  pdf: "PDF",
};

export function ExtractorTestApp() {
  const [tabs, setTabs] = useState<TestTab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number>();
  const [urlInput, setUrlInput] = useState("");
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string }>();
  const [result, setResult] = useState<ExtractorTestResult>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controllerRef.current?.abort("test page closed"), []);

  const scanTabs = async () => {
    setLoadingTabs(true);
    setNotice(undefined);
    try {
      const allTabs = await browser.tabs.query({});
      const testTabs = allTabs
        .filter((tab): tab is typeof tab & { id: number; url: string } => Boolean(tab.id && tab.url && isTestableUrl(tab.url)))
        .map((tab) => ({
          id: tab.id,
          title: tab.title || tab.url,
          url: tab.url,
          active: Boolean(tab.active),
          extractor: inferExtractor(tab.url),
        }));
      setTabs(testTabs);
      setSelectedTabId((current) => testTabs.some((tab) => tab.id === current)
        ? current
        : testTabs.find((tab) => tab.active)?.id ?? testTabs[0]?.id);
      if (!testTabs.length) {
        setNotice({ kind: "error", text: "没有找到可见的网页标签页；也可以在下方粘贴 URL 直接测试。" });
      } else {
        setNotice({ kind: "success", text: "找到 " + testTabs.length + " 个可测试标签页。" });
      }
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      setLoadingTabs(false);
    }
  };

  const runTest = async () => {
    const inputUrl = urlInput.trim();
    if (!selectedTabId && !inputUrl) {
      setNotice({ kind: "error", text: "请先选择标签页，或输入一个网页/PDF URL。" });
      return;
    }
    setRunning(true);
    setNotice(undefined);
    setResult(undefined);
    controllerRef.current?.abort("new extractor test");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      let tab: BrowserTab | undefined = selectedTabId
        ? await browser.tabs.get(selectedTabId) as unknown as BrowserTab
        : undefined;
      if (inputUrl) {
        validateTestUrl(inputUrl);
        await ensurePageHostPermission(inputUrl);
        const created = await browser.tabs.create({ url: inputUrl, active: false }) as unknown as BrowserTab;
        if (!created.id) throw new AppError("extraction-failed", "无法打开测试页面");
        tab = await waitForTabReady(created.id, controller.signal);
      } else if (tab?.url) {
        await ensurePageHostPermission(tab.url);
      }
      if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string" || !isTestableUrl(tab.url)) {
        throw new AppError("unsupported-page", "目标标签页不是可测试的网页、PDF 或本地文件");
      }
      if (tab.status !== "complete") tab = await waitForTabReady(tab.id, controller.signal);
      if (typeof tab.id !== "number" || typeof tab.url !== "string" || !isTestableUrl(tab.url)) {
        throw new AppError("unsupported-page", "测试页面加载后跳转到了不支持的地址");
      }
      await ensurePageHostPermission(tab.url);
      const context: PageContext = { tabId: tab.id, url: tab.url, title: tab.title };
      const extractor = selectExtractor(createExtractorRegistry(), context);
      const document = await extractor.extract(context, controller.signal);
      setResult(toTestResult(document, extractor.descriptor));
      setNotice(document.warnings.length
        ? { kind: "error", text: "提取完成，但存在 warning；请查看下方详情。" }
        : { kind: "success", text: `提取成功：${extractor.descriptor.label} → ${DOCUMENT_KIND_LABELS[document.kind]}` });
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  const copyOutput = () => {
    if (result?.output) void navigator.clipboard.writeText(result.output);
  };

  const selectedTab = tabs.find((tab) => tab.id === selectedTabId);
  return <main className="page test-page"><div className="panel">
    <header className="header">
      <div><h1>提取器测试</h1><p className="muted">测试 YouTube、Bilibili、Feedly、普通网页和 PDF 的实际提取结果；不读取或保存 Cookie。</p></div>
      <div className="header-actions"><button className="button" onClick={() => void browser.runtime.openOptionsPage()}>返回选项</button></div>
    </header>

    <section className="card">
      <h2>选择测试页面</h2>
      <p className="muted">已打开的页面可以直接选择；输入 URL 时会在新标签页打开，并使用当前浏览器会话加载。</p>
      <div className="actions">
        <button className="button" onClick={() => void scanTabs()} disabled={loadingTabs || running}>{loadingTabs ? "扫描中…" : "扫描已打开标签页"}</button>
        <select className="select" aria-label="测试页面" value={selectedTabId ? String(selectedTabId) : ""} onChange={(event) => { setSelectedTabId(Number(event.target.value) || undefined); setUrlInput(""); }} disabled={!tabs.length || running}>
          <option value="">选择页面</option>
          {tabs.map((tab) => <option value={tab.id} key={tab.id}>[{tab.extractor.label}] {tab.title}</option>)}
        </select>
      </div>
      {selectedTab && <span className="tab-url">[{selectedTab.extractor.label}] {selectedTab.url}</span>}
      <div className="field">
        <label className="label" htmlFor="test-url">或输入 URL</label>
        <input id="test-url" className="input" value={urlInput} placeholder="https://... 或 file:///.../document.pdf" onChange={(event) => { setUrlInput(event.target.value); if (event.target.value.trim()) setSelectedTabId(undefined); }} disabled={running} />
      </div>
      <div className="actions"><button className="button primary" onClick={() => void runTest()} disabled={running || (!selectedTabId && !urlInput.trim())}>{running ? "提取中…" : "开始提取"}</button></div>
    </section>

    {notice && <div className={notice.kind === "success" ? "success" : "error"}>{notice.text}</div>}
    {result && <section className="card">
      <h2>提取结果</h2>
      <p className="muted">站点：{result.extractor.label} · 输出：{DOCUMENT_KIND_LABELS[result.kind]} · {result.title} · {result.output.length.toLocaleString()} 字符</p>
      <span className="tab-url">{result.url}</span>
      {result.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      {result.output
        ? <><pre className="subtitle-output">{result.output}</pre><div className="actions"><button className="button" onClick={copyOutput}>复制提取结果</button></div></>
        : <div className="warning">没有提取到正文或字幕；请查看上面的 warning。</div>}
    </section>}
  </div></main>;
}

function isTestableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

function validateTestUrl(value: string): void {
  if (!isTestableUrl(value)) throw new AppError("unsupported-page", "测试地址必须是网页、PDF 或本地 file 地址");
}

function inferExtractor(url: string): ExtractorDescriptor {
  const context: PageContext = { tabId: 0, url };
  return selectExtractor(createExtractorRegistry(), context).descriptor;
}

async function waitForTabReady(tabId: number, signal: AbortSignal): Promise<BrowserTab> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal.aborted) throw new AppError("cancelled", "已取消");
    const tab = await browser.tabs.get(tabId) as unknown as BrowserTab;
    if (tab.status === "complete" && tab.url) return tab;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new AppError("extraction-failed", "测试页面加载超时，请确认页面已打开");
}

function toTestResult(document: ExtractedDocument, extractor: ExtractorDescriptor): ExtractorTestResult {
  const output = document.kind === "youtube" ? extractYoutubeTranscript(document.sourceText) : document.sourceText;
  return { extractor, kind: document.kind, title: document.title, url: document.sourceUrl, output, warnings: document.warnings };
}

function extractYoutubeTranscript(sourceText: string): string {
  const marker = "## 视频文稿";
  const markerIndex = sourceText.indexOf(marker);
  return markerIndex >= 0 ? sourceText.slice(markerIndex + marker.length).trim() : "";
}
