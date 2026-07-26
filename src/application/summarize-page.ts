import { browser } from "wxt/browser";
import { AppError, toAppError } from "../domain/errors";
import { DEFAULT_PROMPT } from "../domain/types";
import type { PageContext, ProviderId, SummaryEvent } from "../domain/types";
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
): Promise<void> {
  dispatch({ type: "start", provider: providerId });
  try {
    const provider = await services.getProvider(providerId);
    await provider.validateReady();
    dispatch({ type: "phase", phase: "extracting" });
    const extractor = selectExtractor(services.extractors, context);
    const document = await extractor.extract(context, signal);
    const settings = await services.storage.getSettings();
    const prompt = settings.promptOverride?.trim() || DEFAULT_PROMPT;
    for await (const event of provider.summarize({ document, prompt }, signal)) dispatchEvent(event, dispatch);
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === "cancelled" || (signal.aborted && appError.code === "api-unavailable")) return;
    if (appError.code === "auth-required" || appError.code === "token-refresh-failed") {
      dispatch({ type: "auth-required", message: appError.message });
      return;
    }
    if (appError.code === "provider-not-configured" || appError.code === "host-permission-denied") {
      dispatch({ type: "provider-not-configured", message: appError.message });
      return;
    }
    dispatch({ type: "error", error: appError });
  }
}

function dispatchEvent(event: SummaryEvent, dispatch: (action: TaskAction) => void): void {
  switch (event.type) {
    case "phase": dispatch({ type: "phase", phase: event.phase, current: event.current, total: event.total }); break;
    case "delta": dispatch({ type: "delta", text: event.text }); break;
    case "warning": dispatch({ type: "warning", message: event.message }); break;
    case "done": dispatch({ type: "done", externalUrl: event.externalUrl }); break;
  }
}
