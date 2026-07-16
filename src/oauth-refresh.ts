import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import {
  type AuthFile,
  type OAuthCredential,
  getOAuth,
  loadAuth,
} from "./auth.ts";
import { opencodeAuthPath } from "./paths.ts";
import { fetchJson } from "./util.ts";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const SKEW_MS = 120_000;
const REFRESH_LOCK_POLL_MS = 25;
const REFRESH_LOCK_TIMEOUT_MS = 20_000;
const REFRESH_LOCK_STALE_MS = 120_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export function isOAuthExpired(
  oauth: OAuthCredential,
  skewMs = SKEW_MS,
): boolean {
  if (oauth.expires == null) return false;
  return oauth.expires <= Date.now() + skewMs;
}

async function postRefresh(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  return fetchJson<TokenResponse>(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
}

function applyTokenResponse(
  prev: OAuthCredential,
  resp: TokenResponse,
): OAuthCredential {
  if (!resp.access_token) {
    throw new Error("OAuth refresh returned no access_token");
  }
  const expiresInSec = resp.expires_in ?? 3600;
  return {
    type: "oauth",
    access: resp.access_token,
    refresh: resp.refresh_token || prev.refresh,
    expires: Date.now() + expiresInSec * 1000,
    accountId: prev.accountId,
  };
}

export async function refreshOpenAIOAuth(
  oauth: OAuthCredential,
): Promise<OAuthCredential> {
  if (!oauth.refresh) throw new Error("OpenAI OAuth missing refresh token");
  const resp = await postRefresh(
    OPENAI_TOKEN_URL,
    OPENAI_CLIENT_ID,
    oauth.refresh,
  );
  return applyTokenResponse(oauth, resp);
}

export function persistOAuthProvider(
  providerKey: string,
  oauth: OAuthCredential,
  authPath = opencodeAuthPath(),
): void {
  const raw = readFileSync(authPath, "utf8");
  const data = JSON.parse(raw) as AuthFile;
  const prev = data[providerKey];
  if (!prev || prev.type !== "oauth") {
    throw new Error(`Cannot persist OAuth for missing provider ${providerKey}`);
  }
  data[providerKey] = {
    ...(prev as OAuthCredential),
    access: oauth.access,
    refresh: oauth.refresh,
    expires: oauth.expires,
    accountId: oauth.accountId ?? (prev as OAuthCredential).accountId,
    type: "oauth",
  };
  const tmp = join(dirname(authPath), `.auth.json.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export type OAuthRefresher = (
  oauth: OAuthCredential,
) => Promise<OAuthCredential>;

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function credentialsChanged(
  previous: OAuthCredential,
  current: OAuthCredential,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

function isRefreshReuseError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("revoked") ||
    message.includes("refresh_token_reused") ||
    message.includes("already been used")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOAuthRefreshLock<T>(
  authPath: string,
  providerKey: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = join(
    dirname(authPath),
    `.auth.json.${providerKey}.llm-usage.lock`,
  );
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${providerKey} OAuth refresh lock`);
      }
      await delay(REFRESH_LOCK_POLL_MS);
    }
  }

  try {
    return await action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

async function recoverRotatedCredential(
  authPath: string,
  providerKeys: string[],
  stale: OAuthCredential,
): Promise<OAuthCredential | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(100);
    const current = getOAuth(loadAuth(authPath), providerKeys);
    if (current && credentialsChanged(stale, current)) return current;
  }
  return null;
}

export async function ensureFreshOAuth(
  auth: AuthFile,
  providerKeys: string[],
  refresh: OAuthRefresher,
  persistKey: string,
  force = false,
  authPath = opencodeAuthPath(),
): Promise<OAuthCredential | null> {
  const requested = getOAuth(auth, providerKeys);
  if (!requested) return null;
  if (!force && !isOAuthExpired(requested)) return requested;

  return withOAuthRefreshLock(authPath, persistKey, async () => {
    const latest = getOAuth(loadAuth(authPath), providerKeys);
    if (!latest) return null;

    if (credentialsChanged(requested, latest)) {
      auth[persistKey] = latest;
      return latest;
    }
    if (!force && !isOAuthExpired(latest)) {
      auth[persistKey] = latest;
      return latest;
    }
    if (!latest.refresh) {
      throw new Error(
        `${persistKey} access token expired and no refresh token — run: opencode auth login`,
      );
    }

    let next: OAuthCredential;
    try {
      next = await refresh(latest);
    } catch (err) {
      if (isRefreshReuseError(err)) {
        const recovered = await recoverRotatedCredential(
          authPath,
          providerKeys,
          latest,
        );
        if (recovered) {
          auth[persistKey] = recovered;
          return recovered;
        }
      }
      throw err;
    }

    persistOAuthProvider(persistKey, next, authPath);
    auth[persistKey] = next;
    return next;
  });
}
