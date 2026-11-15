export interface QuotaWindow { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null; }
export interface QuotaBucket {
  limitId?: string | null;
  limitName?: string | null;
  primary?: QuotaWindow | null;
  secondary?: QuotaWindow | null;
  credits?: { unlimited: boolean; hasCredits: boolean; balance: string | null } | null;
}
export interface QuotaResponse { rateLimits?: QuotaBucket | null; rateLimitsByLimitId?: Record<string, QuotaBucket | undefined> | null; }

export function quotaBuckets(response: QuotaResponse | null): QuotaBucket[] {
  const entries = Object.entries(response?.rateLimitsByLimitId ?? {}).filter((entry): entry is [string, QuotaBucket] => Boolean(entry[1]));
  return entries.length ? entries.map(([id, bucket]) => ({ ...bucket, limitId: bucket.limitId ?? id })) : response?.rateLimits ? [response.rateLimits] : [];
}
export function windowRemaining(window: QuotaWindow | null | undefined): number | null {
  return window && Number.isFinite(window.usedPercent) ? Math.round(100 - Math.max(0, Math.min(100, window.usedPercent))) : null;
}
export function quotaRemaining(buckets: QuotaBucket[]): number | null {
  const values = buckets.flatMap(bucket => [windowRemaining(bucket.primary), windowRemaining(bucket.secondary)]).filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}
export function quotaWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes || minutes < 0) return `${fallback} window`;
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

export function quotaHeaderWindows(buckets: QuotaBucket[]): { label: string; remaining: number | null }[] {
  const bucket = buckets.find(item => item.limitId === "codex") ?? buckets[0];
  if (!bucket) return [];
  return ([{ window: bucket.primary, fallback: "Primary" }, { window: bucket.secondary, fallback: "Secondary" }])
    .filter(entry => entry.window).map(({ window, fallback }) => {
      const minutes = window!.windowDurationMins;
      const label = !minutes ? fallback : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
      return { label, remaining: windowRemaining(window) };
    });
}

export function quotaResetDuration(resetsAt: number | null | undefined, now: number): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  const seconds = resetsAt - now / 1000;
  if (seconds <= 0) return "Reset pending";
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
