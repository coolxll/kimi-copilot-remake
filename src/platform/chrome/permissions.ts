import { browser } from "wxt/browser";
import { AppError } from "../../domain/errors";

export function normalizeApiRoot(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function validateApiRoot(value: string): URL {
  const normalized = normalizeApiRoot(value);
  if (!normalized || /\/chat\/completions$/i.test(normalized)) {
    throw new AppError("provider-not-configured", "API Root 必须填写到 API 根路径，例如 https://example.com/v1");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new AppError("provider-not-configured", "API Root 不是有效 URL", { cause: error });
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new AppError("provider-not-configured", "远程 API Root 必须使用 HTTPS；HTTP 仅允许本机地址");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError("provider-not-configured", "API Root 不应包含账号、密码、查询参数或片段");
  }
  return url;
}

function permissionOrigin(url: URL): string {
  return `${url.origin}/*`;
}

export async function ensureApiHostPermission(apiRoot: string): Promise<void> {
  const url = validateApiRoot(apiRoot);
  const origin = permissionOrigin(url);
  const alreadyGranted = await hasApiHostPermission(apiRoot);
  if (alreadyGranted) return;
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) throw new AppError("host-permission-denied", `未授权访问 ${url.origin}`);
}

export async function hasApiHostPermission(apiRoot: string): Promise<boolean> {
  const url = validateApiRoot(apiRoot);
  return browser.permissions.contains({ origins: [permissionOrigin(url)] });
}

export async function revokeApiHostPermission(apiRoot: string): Promise<void> {
  try {
    const url = validateApiRoot(apiRoot);
    await browser.permissions.remove({ origins: [permissionOrigin(url)] });
  } catch {
    // Permission cleanup must not block saving a new valid configuration.
  }
}

export async function ensurePageHostPermission(value: string): Promise<void> {
  const url = parsePageUrl(value);
  if (url.protocol === "file:") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("unsupported-page", "测试地址必须是网页、PDF 或本地 file 地址");
  }
  const origin = permissionOrigin(url);
  if (await browser.permissions.contains({ origins: [origin] })) return;
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) throw new AppError("host-permission-denied", "未授权访问 " + url.origin);
}

export async function hasPageHostPermission(value: string): Promise<boolean> {
  const url = parsePageUrl(value);
  if (url.protocol === "file:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return browser.permissions.contains({ origins: [permissionOrigin(url)] });
}

function parsePageUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new AppError("unsupported-page", "测试地址不是有效 URL", { cause: error });
  }
}
