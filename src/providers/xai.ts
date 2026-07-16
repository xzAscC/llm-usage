import { type AuthFile, type OAuthCredential } from "../auth.ts";
import { ensureFreshOAuth, refreshXaiOAuth } from "../oauth-refresh.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  secondsUntil,
} from "../util.ts";

interface MoneyVal {
  val?: number;
}

interface GrokProductUsage {
  product?: string;
  usagePercent?: number;
}

interface GrokBillingConfig {
  monthlyLimit?: MoneyVal;
  used?: MoneyVal;
  onDemandCap?: MoneyVal;
  onDemandUsed?: MoneyVal;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  currentPeriod?: {
    type?: string;
    start?: string;
    end?: string;
  };
  creditUsagePercent?: number;
  productUsage?: GrokProductUsage[];
  isUnifiedBillingUser?: boolean;
}

interface GrokBillingResponse {
  config?: GrokBillingConfig;
}

interface GrokSettingsResponse {
  subscription_tier_display?: string;
}

function periodLabel(type?: string): string {
  if (!type) return "Weekly";
  if (type.includes("WEEKLY")) return "Weekly";
  if (type.includes("MONTHLY")) return "Monthly";
  if (type.includes("DAILY")) return "Daily";
  return "Period";
}

function grokHeaders(oauth: OAuthCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${oauth.access}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "llm-usage/0.1 (Hyprland)",
  };
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("401") || msg.includes("token_expired")) {
    return "xAI token expired — refresh failed. Run: opencode auth login";
  }
  const m = msg.match(/HTTP\s+(\d+)/);
  if (m) return `HTTP ${m[1]} from Grok billing`;
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

function windowsFromBilling(weekly: GrokBillingConfig): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const weeklyEnd = weekly.currentPeriod?.end || weekly.billingPeriodEnd;
  if (weekly.creditUsagePercent != null) {
    const usedPercent = clampPercent(weekly.creditUsagePercent);
    const products = (weekly.productUsage || [])
      .filter((p) => p.product != null && p.usagePercent != null)
      .map((p) => `${p.product} ${Math.round(p.usagePercent!)}%`)
      .join(", ");
    windows.push({
      id: "weekly",
      label: periodLabel(weekly.currentPeriod?.type),
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: weeklyEnd,
      resetAfterSeconds: secondsUntil(weeklyEnd),
      note: products || undefined,
    });
  } else if (weekly.currentPeriod?.type?.includes("WEEKLY") && weeklyEnd) {
    windows.push({
      id: "weekly",
      label: "Weekly",
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: weeklyEnd,
      resetAfterSeconds: secondsUntil(weeklyEnd),
      note: "no % from API",
    });
  }

  const odCap = weekly.onDemandCap?.val ?? 0;
  const odUsed = weekly.onDemandUsed?.val ?? 0;
  if (odCap > 0) {
    const usedPercent = clampPercent((odUsed / odCap) * 100);
    windows.push({
      id: "ondemand",
      label: "On-demand",
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      used: odUsed,
      limit: odCap,
      remaining: Math.max(0, odCap - odUsed),
    });
  }

  return windows;
}

export async function fetchXai(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  let oauth: OAuthCredential | null;
  try {
    oauth = await ensureFreshOAuth(
      auth,
      ["xai", "grok"],
      refreshXaiOAuth,
      "xai",
    );
  } catch (err) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: shortError(err),
      windows: [],
      fetchedAt: now,
    });
  }

  if (!oauth) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: "No xAI OAuth in OpenCode auth.json (opencode /connect xai)",
      windows: [],
      fetchedAt: now,
    });
  }

  try {
    const fetchAll = async (token: OAuthCredential) => {
      const headers = grokHeaders(token);
      const [weekly, settings] = await Promise.all([
        fetchJson<GrokBillingResponse>(
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          { headers },
        ).catch(() => ({ config: {} }) as GrokBillingResponse),
        fetchJson<GrokSettingsResponse>(
          "https://cli-chat-proxy.grok.com/v1/settings",
          { headers },
        ).catch(() => null),
      ]);
      return { weekly, settings };
    };

    let pack: Awaited<ReturnType<typeof fetchAll>>;
    try {
      pack = await fetchAll(oauth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("401") && !msg.includes("token_expired")) throw err;
      oauth = await ensureFreshOAuth(
        auth,
        ["xai", "grok"],
        refreshXaiOAuth,
        "xai",
        true,
      );
      if (!oauth) throw err;
      pack = await fetchAll(oauth);
    }

    const windows = windowsFromBilling(pack.weekly.config || {});

    if (windows.length === 0) {
      return finalizeProvider({
        id: "xai",
        name: "Grok / xAI",
        plan: pack.settings?.subscription_tier_display,
        ok: false,
        error: "No Grok weekly SuperGrok usage data",
        windows: [],
        fetchedAt: now,
      });
    }

    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      plan: pack.settings?.subscription_tier_display,
      ok: true,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: shortError(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
