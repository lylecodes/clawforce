import { describe, it, expect, beforeEach } from "vitest";
import {
  updateProviderUsage,
  getProviderUsage,
  getAllProviderUsage,
  isProviderThrottled,
  clearAllUsage,
} from "../src/rate-limits.js";

describe("rate limit tracker", () => {
  beforeEach(() => clearAllUsage());

  it("stores and retrieves provider usage", () => {
    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 45 },
        { label: "TPM", usedPercent: 72 },
      ],
      plan: "tier-4",
    });

    const usage = getProviderUsage("anthropic");
    expect(usage).toBeDefined();
    expect(usage!.windows).toHaveLength(2);
    expect(usage!.windows[0].usedPercent).toBe(45);
    expect(usage!.plan).toBe("tier-4");
  });

  it("isProviderThrottled returns true when any window above threshold", () => {
    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 92 },
        { label: "TPM", usedPercent: 30 },
      ],
    });

    expect(isProviderThrottled("anthropic", 90)).toBe(true);
    expect(isProviderThrottled("anthropic", 95)).toBe(false);
  });

  it("getAllProviderUsage returns all providers", () => {
    updateProviderUsage("anthropic", { windows: [{ label: "RPM", usedPercent: 50 }] });
    updateProviderUsage("openai", { windows: [{ label: "RPM", usedPercent: 30 }] });

    const all = getAllProviderUsage();
    expect(all).toHaveLength(2);
  });
});
