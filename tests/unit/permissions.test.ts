import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({ browser: { permissions: { contains: vi.fn(), request: vi.fn(), remove: vi.fn() } } }));

import { browser } from "wxt/browser";
import { ensurePageHostPermission, shouldRevokeApiHostPermission, validateApiRoot } from "../../src/platform/chrome/permissions";

describe("API Root validation", () => {
  afterEach(() => vi.clearAllMocks());

  it("accepts HTTPS and loopback HTTP roots", () => {
    expect(validateApiRoot("https://api.example.com/v1/").toString()).toBe("https://api.example.com/v1");
    expect(validateApiRoot("http://localhost:3000/v1").hostname).toBe("localhost");
    expect(validateApiRoot("http://[::1]:8080/v1").hostname).toBe("[::1]");
  });

  it("rejects remote HTTP and a full chat completions URL", () => {
    expect(() => validateApiRoot("http://api.example.com/v1")).toThrow("必须使用 HTTPS");
    expect(() => validateApiRoot("https://api.example.com/v1/chat/completions")).toThrow("API Root 必须填写到 API 根路径");
    expect(() => validateApiRoot("https://api.example.com/v1?token=secret")).toThrow("不应包含");
  });

  it("requests only the target page origin for the extractor test page", async () => {
    vi.mocked(browser.permissions.contains).mockImplementation(async () => false as never);
    vi.mocked(browser.permissions.request).mockImplementation(async () => true as never);
    await ensurePageHostPermission("https://www.youtube.com/watch?v=demo");
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: ["https://www.youtube.com/*"] });
  });

  it("does not request a host permission for local files", async () => {
    await ensurePageHostPermission("file:///tmp/demo.pdf");
    expect(browser.permissions.request).not.toHaveBeenCalled();
  });

  it("revokes the old API origin when the compatible API configuration is cleared", () => {
    expect(shouldRevokeApiHostPermission("https://old.example/v1", undefined)).toBe(true);
    expect(shouldRevokeApiHostPermission("https://old.example/v1", "https://old.example/v1/")).toBe(false);
    expect(shouldRevokeApiHostPermission(undefined, undefined)).toBe(false);
  });
});
