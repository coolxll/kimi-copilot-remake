import { browser } from "wxt/browser";
import { withAbort, throwIfAborted } from "../../shared/abort";

export interface PageJsonResult {
  ok: boolean;
  status: number;
  data: unknown;
  contentType: string;
  error?: string;
}
/**
 * Fetch JSON from the page's own origin in the MAIN world. This deliberately
 * uses the current tab's session rather than storing or copying cookies into
 * the extension context.
 */
export async function fetchPageJson(tabId: number, url: string, signal: AbortSignal): Promise<PageJsonResult> {
  throwIfAborted(signal);
  const result = await withAbort(browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (requestUrl: string): Promise<PageJsonResult> => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(requestUrl, {
          credentials: "include",
          headers: { Accept: "application/json, text/plain, */*" },
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        const text = await response.text();
        let data: unknown = null;
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          // A non-JSON response is represented by `data: null`; callers can
          // decide whether to fall back to the rendered page.
        }
        return {
          ok: response.ok,
          status: response.status,
          data,
          contentType,
          error: response.ok ? undefined : `${response.status} ${response.statusText}`.trim(),
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          data: null,
          contentType: "",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    args: [url],
  }) as Promise<Array<{ result?: PageJsonResult }>>, signal);
  return result[0]?.result ?? { ok: false, status: 0, data: null, contentType: "", error: "页面脚本没有返回结果" };
}
