import { describe, it, expect, beforeEach } from "vitest";
import { shouldDispatch } from "../../src/dispatch/dispatcher.js";
import { updateProviderUsage, clearAllUsage } from "../../src/rate-limits.js";
import { getDb } from "../../src/db.js";

describe("dispatch gate — budget + rate limits", () => {
  const projectId = "test-dispatch-gate";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("blocks dispatch when provider rate limited", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 98 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("rate limit");
  });

  it("allows dispatch when within budget and rate limits", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 30 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(true);
  });
});
