import { getOAuth, type AuthFile } from "../auth.ts";
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

export async function fetchXai(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const oauth = getOAuth(auth, ["xai", "grok"]);
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

  const headers = {
    Authorization: `Bearer ${oauth.access}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "llm-usage/0.1 (Hyprland)",
  };

  try {
    const [billing, settings] = await Promise.all([
      // Official SuperGrok weekly pool (matches grok.com "每周 SuperGrok 限额")
      fetchJson<GrokBillingResponse>(
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        { headers },
      ),
      fetchJson<GrokSettingsResponse>(
        "https://cli-chat-proxy.grok.com/v1/settings",
        { headers },
      ).catch(() => null),
    ]);

    const cfg = billing.config || {};
    const windows: UsageWindow[] = [];

    if (cfg.creditUsagePercent != null) {
      const usedPercent = clampPercent(cfg.creditUsagePercent);
      const end = cfg.currentPeriod?.end || cfg.billingPeriodEnd;
      const products = (cfg.productUsage || [])
        .filter((p) => p.product != null && p.usagePercent != null)
        .map((p) => `${p.product} ${Math.round(p.usagePercent!)}%`)
        .join(", ");
      windows.push({
        id: "weekly",
        label: periodLabel(cfg.currentPeriod?.type),
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt: end,
        resetAfterSeconds: secondsUntil(end),
        note: products || undefined,
      });
    }

    const odCap = cfg.onDemandCap?.val ?? 0;
    const odUsed = cfg.onDemandUsed?.val ?? 0;
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
    } else if (cfg.creditUsagePercent != null) {
      windows.push({
        id: "ondemand",
        label: "Extra credits",
        note: "US$0 / disabled",
      });
    }

    if (windows.length === 0) {
      return finalizeProvider({
        id: "xai",
        name: "Grok / xAI",
        plan: settings?.subscription_tier_display,
        ok: false,
        error: "No weekly SuperGrok usage in billing response",
        windows: [],
        fetchedAt: now,
      });
    }

    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      plan: settings?.subscription_tier_display,
      ok: true,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
