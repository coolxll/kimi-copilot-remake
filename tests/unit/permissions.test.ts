import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({ browser: { permissions: { contains: vi.fn(), request: vi.fn(), remove: vi.fn() } } }));

import { validateApiRoot } from "../../src/platform/chrome/permissions";

describe("API Root validation", () => {
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
});
