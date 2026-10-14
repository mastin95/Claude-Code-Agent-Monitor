/**
 * @file muro-api.test.ts
 * @description Verifies the Muro API client sends its period, browser timezone,
 * and global source/provider scope, and propagates server errors.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { setProviderScope, setScope } from "../dataScope";

beforeEach(() => {
  setScope({ mode: "all", selected: [] });
  setProviderScope("both");
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
});

afterEach(() => {
  vi.restoreAllMocks();
  setScope({ mode: "all", selected: [] });
  setProviderScope("both");
});

describe("api.muro.summary", () => {
  it("allows explicit handoff peer reads across products while preserving source scope", async () => {
    setScope({ mode: "selected", selected: ["remote"], provider: "codex" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    await api.sessions.get("parent", { handoffPeer: true });
    await api.sessions.stats("parent", { handoffPeer: true });
    for (const call of fetchMock.mock.calls) {
      const url = new URL(String(call[0]), "http://localhost");
      expect(url.searchParams.get("sources")).toBe("remote");
      expect(url.searchParams.get("providers")).toBe("claude,codex");
    }
    await api.sessions.get("ordinary");
    const last = new URL(String(fetchMock.mock.calls[2]![0]), "http://localhost");
    expect(last.searchParams.get("providers")).toBe("codex");
  });
  it.each(["today", "7d", "30d"] as const)("requests %s with the active scope", async (period) => {
    setScope({ mode: "selected", selected: ["local", "remote"] });
    setProviderScope("codex");
    const payload = { period, streak_days: 3 };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await api.muro.summary(period)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.pathname).toBe("/api/muro/summary");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      period,
      tz_offset: "-120",
      sources: "local,remote",
      providers: "codex",
    });
  });

  it("defaults to today and omits filters for the all/both scope", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await api.muro.summary();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ period: "today", tz_offset: "-120" });
  });

  it("surfaces a structured server error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "FAILED", message: "Summary unavailable" } }), {
        status: 500,
      })
    );
    await expect(api.muro.summary()).rejects.toThrow("Summary unavailable");
  });
  it("narrows the global scope for an agent's exact streak without widening product scope", async () => {
    setScope({ mode: "selected", selected: ["remote"], provider: "both" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await api.muro.summary("30d", "claude");
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("providers")).toBe("claude");
    expect(url.searchParams.get("sources")).toBe("remote");
    setProviderScope("codex");
    await expect(api.muro.summary("today", "claude")).rejects.toThrow(
      "outside current product scope"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
