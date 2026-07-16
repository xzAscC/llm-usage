import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchXai } from "./xai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempAuthFile(auth: AuthFile): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-xai-test-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  return path;
}

describe("fetchXai", () => {
  test("missing oauth", async () => {
    const r = await fetchXai({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No xAI OAuth/i);
  });

  test("maps weekly SuperGrok only (no monthly)", async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-grok-cli-version")).toBe("0.2.93");
        expect(headers.get("x-grok-client-version")).toBe("0.2.93");
        expect(headers.get("x-grok-client-surface")).toBe("grok-cli");
        expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
        expect(headers.get("user-agent")).toBe("grok-cli/0.2.93");
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-19T08:17:27.853505+00:00",
              },
              creditUsagePercent: 36.0,
              productUsage: [{ product: "Api", usagePercent: 36.0 }],
              onDemandCap: { val: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.usedPercent).toBe(36);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_XAI_TOKEN/);
  });

  test("never consumes the refresh token shared with OpenCode", async () => {
    let tokenEndpointCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("auth.x.ai/oauth2/token")) {
        tokenEndpointCalls += 1;
        return new Response("{}", { status: 500 });
      }
      if (url.includes("format=credits")) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.includes("/v1/settings")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: {
        type: "oauth",
        access: "EXPIRED_XAI_TOKEN",
        refresh: "REVOKED_REFRESH_TOKEN",
        expires: Date.now() - 1_000,
      },
    };
    const r = await fetchXai(auth, tempAuthFile(auth));
    expect(r.ok).toBe(false);
    expect(tokenEndpointCalls).toBe(0);
    expect(r.error).toMatch(/expired.*OpenCode.*opencode auth login/i);
  });

  test("does not swallow billing authentication failures", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.includes("/v1/settings")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "EXPIRED_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired.*opencode auth login/i);
    expect(r.error).not.toMatch(/No Grok weekly/i);
  });

  test("weekly period without percent still ok", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-19T08:17:27.853505+00:00",
              },
              onDemandCap: { val: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(false);
    expect(r.usedPercent).toBe(0);
  });
});
