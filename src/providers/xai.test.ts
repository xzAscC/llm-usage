import { afterEach, describe, expect, test } from "bun:test";
import { fetchXai } from "./xai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchXai", () => {
  test("missing oauth", async () => {
    const r = await fetchXai({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No xAI OAuth/i);
  });

  test("maps weekly SuperGrok creditUsagePercent", async () => {
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
              creditUsagePercent: 36.0,
              productUsage: [{ product: "Api", usagePercent: 36.0 }],
              onDemandCap: { val: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/billing") && !url.includes("format=")) {
        return new Response(
          JSON.stringify({
            config: {
              monthlyLimit: { val: 20000 },
              used: { val: 2000 },
              billingPeriodEnd: "2026-08-01T00:00:00+00:00",
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
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_XAI_TOKEN/);
  });

  test("falls back when weekly percent omitted", async () => {
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
      if (url.includes("/v1/billing") && !url.includes("format=")) {
        return new Response(
          JSON.stringify({
            config: {
              monthlyLimit: { val: 20000 },
              used: { val: 2744 },
              billingPeriodEnd: "2026-08-01T00:00:00+00:00",
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
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(true);
    const monthly = r.windows.find((w) => w.id === "monthly");
    expect(monthly?.usedPercent).toBeCloseTo(13.72, 1);
  });
});
