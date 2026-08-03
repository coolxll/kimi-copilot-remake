import { browser } from "wxt/browser";
import { AppError, toAppError } from "../domain/errors";
import { DEFAULT_PROMPT } from "../domain/types";
import type { ExtractedDocument, PageContext, ProviderId, SummaryEvent } from "../domain/types";
import { isYoutubePageUrl } from "../domain/youtube";
import { selectExtractor } from "../extractors/registry";
import type { AppServices } from "./services";
import type { TaskAction } from "./task-state";

export async function getPageContext(tabId: number): Promise<PageContext> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\/|^file:\/\//i.test(tab.url)) throw new AppError("unsupported-page", "请在网页或本地文件页面使用此扩展");
  return { tabId, url: tab.url, title: tab.title };
}

export async function runSummary(
  services: AppServices,
  providerId: ProviderId,
  context: PageContext,
  signal: AbortSignal,
  dispatch: (action: TaskAction) => void,
): Promise<ExtractedDocument | undefined> {
  dispatch({ type: "start", provider: providerId });
  let document: ExtractedDocument | undefined;
  try {
    const provider = await services.getProvider(providerId);
    await provider.validateReady();
    dispatch({ type: "phase", phase: "extracting" });
    document = providerId === "gemini-web" && isYoutubePageUrl(context.url)
      ? createDirectYoutubeDocument(context)
      : await (await selectExtractor(services.extractors, context, signal)).extract(context, signal);
    const settings = await services.storage.getSettings();
    const prompt = settings.promptOverride?.trim() || DEFAULT_PROMPT;
    for await (const event of provider.summarize({ document, prompt }, signal)) dispatchEvent(event, dispatch);
    return document;
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === "cancelled" || (signal.aborted && appError.code === "api-unavailable")) return document;
    if (appError.code === "auth-required" || appError.code === "token-refresh-failed") {
      dispatch({ type: "auth-required", message: appError.message });
      return document;
    }
    if (appError.code === "provider-not-configured" || appError.code === "host-permission-denied") {
      dispatch({ type: "provider-not-configured", message: appError.message });
      return document;
    }
    dispatch({ type: "error", error: appError });
    return document;
  }
}

function createDirectYoutubeDocument(context: PageContext): ExtractedDocument {
  return {
    kind: "youtube",
    title: context.title || "YouTube 视频",
    sourceUrl: context.url,
    sourceText: `YouTube 视频链接：${context.url}`,
    warnings: [],
  };
}

function dispatchEvent(event: SummaryEvent, dispatch: (action: TaskAction) => void): void {
  switch (event.type) {
    case "phase": dispatch({ type: "phase", phase: event.phase, current: event.current, total: event.total }); break;
    case "delta": dispatch({ type: "delta", text: event.text }); break;
    case "snapshot": dispatch({ type: "snapshot", text: event.text }); break;
    case "warning": dispatch({ type: "warning", message: event.message }); break;
    case "done": dispatch({ type: "done", externalUrl: event.externalUrl }); break;
  }
}
