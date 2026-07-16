import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureFreshOAuth,
  isOAuthExpired,
} from "./oauth-refresh.ts";
import type { AuthFile, OAuthCredential } from "./auth.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempAuthFile(auth: AuthFile): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-oauth-test-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  return path;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("isOAuthExpired", () => {
  test("fresh token", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() + 3_600_000,
    };
    expect(isOAuthExpired(oauth)).toBe(false);
  });

  test("expired token", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() - 1_000,
    };
    expect(isOAuthExpired(oauth)).toBe(true);
  });

  test("within skew treated as expired", () => {
    const oauth: OAuthCredential = {
      type: "oauth",
      access: "a",
      expires: Date.now() + 30_000,
    };
    expect(isOAuthExpired(oauth, 120_000)).toBe(true);
  });

  test("missing expires is not expired", () => {
    const oauth: OAuthCredential = { type: "oauth", access: "a" };
    expect(isOAuthExpired(oauth)).toBe(false);
  });
});

describe("ensureFreshOAuth", () => {
  test("serializes concurrent refresh-token rotation", async () => {
    const expired: OAuthCredential = {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() - 1_000,
    };
    const authPath = tempAuthFile({ xai: expired });
    let refreshCalls = 0;
    const refresh = async (): Promise<OAuthCredential> => {
      refreshCalls += 1;
      await delay(30);
      return {
        type: "oauth",
        access: "access-2",
        refresh: "refresh-2",
        expires: Date.now() + 3_600_000,
      };
    };

    const [first, second] = await Promise.all([
      ensureFreshOAuth(
        { xai: { ...expired } },
        ["xai", "grok"],
        refresh,
        "xai",
        false,
        authPath,
      ),
      ensureFreshOAuth(
        { xai: { ...expired } },
        ["xai", "grok"],
        refresh,
        "xai",
        false,
        authPath,
      ),
    ]);

    expect(refreshCalls).toBe(1);
    expect(first?.refresh).toBe("refresh-2");
    expect(second?.refresh).toBe("refresh-2");
  });

  test("adopts a rotated token from disk instead of refreshing stale memory", async () => {
    const stale: OAuthCredential = {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() - 1_000,
    };
    const rotated: OAuthCredential = {
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: Date.now() + 3_600_000,
    };
    const authPath = tempAuthFile({ xai: rotated });
    let refreshCalls = 0;

    const result = await ensureFreshOAuth(
      { xai: stale },
      ["xai", "grok"],
      async () => {
        refreshCalls += 1;
        return rotated;
      },
      "xai",
      false,
      authPath,
    );

    expect(refreshCalls).toBe(0);
    expect(result?.access).toBe("access-2");
    expect(result?.refresh).toBe("refresh-2");
  });

  test("recovers when an external process wins a refresh-token race", async () => {
    const stale: OAuthCredential = {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() - 1_000,
    };
    const rotated: OAuthCredential = {
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: Date.now() + 3_600_000,
    };
    const authPath = tempAuthFile({ xai: stale });

    const result = await ensureFreshOAuth(
      { xai: stale },
      ["xai", "grok"],
      async () => {
        setTimeout(() => {
          writeFileSync(authPath, JSON.stringify({ xai: rotated }));
        }, 150);
        await delay(20);
        throw new Error(
          'HTTP 400: {"error":"invalid_grant","error_description":"Refresh token has been revoked"}',
        );
      },
      "xai",
      false,
      authPath,
    );

    expect(result?.access).toBe("access-2");
    expect(result?.refresh).toBe("refresh-2");
  });
});
