import { describe, expect, it, vi } from "vitest";
import { KimiClient } from "../../src/integrations/kimi/client";

describe("KimiClient token refresh", () => {
  it("shares one refresh request across concurrent clients", async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/api/auth/token/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "rotated" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "chat" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onTokensRefreshed = vi.fn(async () => undefined);
    const tokens = { refreshToken: "shared-refresh" };
    const first = new KimiClient({ tokens, onTokensRefreshed });
    const second = new KimiClient({ tokens, onTokensRefreshed: vi.fn(async () => undefined) });
    await Promise.all([first.createChat(), second.createChat()]);
    expect(refreshCalls).toBe(1);
    expect(onTokensRefreshed).toHaveBeenCalledTimes(1);
  });

  it("probes connectivity by refreshing tokens without creating a chat", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/api/auth/token/refresh");
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "rotated" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onTokensRefreshed = vi.fn(async () => undefined);

    await new KimiClient({ tokens: { refreshToken: "refresh" }, onTokensRefreshed }).testConnection();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onTokensRefreshed).toHaveBeenCalledWith({ accessToken: "access", refreshToken: "rotated" });
  });
});
