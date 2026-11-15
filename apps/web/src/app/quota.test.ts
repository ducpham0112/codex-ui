import { describe, expect, it } from "vitest";
import { quotaBuckets, quotaRemaining, quotaWindowLabel, quotaResetDuration, quotaHeaderWindows } from "./quota";

describe("quota presentation", () => {
  it("shows both Codex quota windows separately in the header", () => {
    const windows = quotaHeaderWindows([{ limitId: "other", primary: { usedPercent: 5 } }, { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } }]);
    expect(windows.map(item => [item.label, item.remaining])).toEqual([["5h", 75], ["7d", 60]]);
    expect(quotaHeaderWindows([])).toEqual([]);
  });
  it("formats reset countdowns without rounding down or showing negative time", () => {
    expect(quotaResetDuration(8110, 10_000)).toBe("2h 15m");
    expect(quotaResetDuration(176410, 10_000)).toBe("2d 1h");
    expect(quotaResetDuration(20, 10_000)).toBe("less than a minute");
    expect(quotaResetDuration(1, 10_000)).toBe("Reset pending");
    expect(quotaResetDuration(null, 10_000)).toBeNull();
  });
  it("keeps unavailable quota distinct from unused quota", () => {
    expect(quotaBuckets(null)).toEqual([]);
    expect(quotaRemaining([{ primary: null, secondary: null }])).toBeNull();
    expect(quotaRemaining([{ primary: { usedPercent: 0 } }])).toBe(100);
  });
  it("uses all named buckets instead of duplicating the legacy bucket", () => {
    const buckets = quotaBuckets({ rateLimits: { limitId: "codex" }, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 25 } }, other: { secondary: { usedPercent: 80 } }
    } });
    expect(buckets.map(bucket => bucket.limitId)).toEqual(["codex", "other"]);
    expect(quotaRemaining(buckets)).toBe(20);
  });
  it("clamps usage and ignores invalid percentages", () => {
    expect(quotaRemaining([{ primary: { usedPercent: 130 } }])).toBe(0);
    expect(quotaRemaining([{ primary: { usedPercent: -10 } }])).toBe(100);
    expect(quotaRemaining([{ primary: { usedPercent: NaN } }])).toBeNull();
  });
  it("labels actual window durations without assuming account limits", () => {
    expect(quotaWindowLabel(300, "Primary")).toBe("5 hours");
    expect(quotaWindowLabel(10080, "Secondary")).toBe("7 days");
    expect(quotaWindowLabel(null, "Primary")).toBe("Primary window");
  });
});
