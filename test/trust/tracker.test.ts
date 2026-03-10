import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  recordTrustDecision,
  getCategoryStats,
  getAllCategoryStats,
  suggestTierAdjustments,
  isProtectedCategory,
  applyTrustOverride,
  getEffectiveTierOverride,
  getActiveTrustOverrides,
  processTrustDecay,
  renderTrustSummary,
} = await import("../../src/trust/tracker.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-trust";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("recordTrustDecision", () => {
  it("records an approval decision", () => {
    const decision = recordTrustDecision({
      projectId: PROJECT,
      category: "email:send",
      decision: "approved",
      agentId: "assistant",
      toolName: "mcp:gmail:send",
      riskTier: "high",
    }, db);

    expect(decision.id).toBeDefined();
    expect(decision.category).toBe("email:send");
    expect(decision.decision).toBe("approved");
  });

  it("records a rejection decision", () => {
    const decision = recordTrustDecision({
      projectId: PROJECT,
      category: "email:send",
      decision: "rejected",
    }, db);

    expect(decision.decision).toBe("rejected");
  });

  it("updates last_used_at on active override", () => {
    applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "medium",
    }, db);

    const before = getEffectiveTierOverride(PROJECT, "email:send", db);
    expect(before).not.toBeNull();

    recordTrustDecision({
      projectId: PROJECT,
      category: "email:send",
      decision: "approved",
    }, db);

    const after = getEffectiveTierOverride(PROJECT, "email:send", db);
    expect(after!.lastUsedAt).toBeGreaterThanOrEqual(before!.lastUsedAt!);
  });
});

describe("getCategoryStats", () => {
  it("returns null for unknown category", () => {
    const stats = getCategoryStats(PROJECT, "unknown", db);
    expect(stats).toBeNull();
  });

  it("computes approval rate correctly", () => {
    for (let i = 0; i < 9; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    }
    recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "rejected" }, db);

    const stats = getCategoryStats(PROJECT, "email:send", db);
    expect(stats).not.toBeNull();
    expect(stats!.totalDecisions).toBe(10);
    expect(stats!.approved).toBe(9);
    expect(stats!.rejected).toBe(1);
    expect(stats!.approvalRate).toBe(0.9);
  });

  it("filters by since timestamp", () => {
    recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);

    const futureTime = Date.now() + 100_000;
    const stats = getCategoryStats(PROJECT, "email:send", db, futureTime);
    expect(stats).toBeNull();
  });
});

describe("getAllCategoryStats", () => {
  it("returns stats for all categories", () => {
    recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    recordTrustDecision({ projectId: PROJECT, category: "calendar:create", decision: "approved" }, db);
    recordTrustDecision({ projectId: PROJECT, category: "calendar:create", decision: "rejected" }, db);

    const stats = getAllCategoryStats(PROJECT, db);
    expect(stats).toHaveLength(2);

    const emailStats = stats.find((s) => s.category === "email:send")!;
    expect(emailStats.approved).toBe(1);
    expect(emailStats.approvalRate).toBe(1);

    const calStats = stats.find((s) => s.category === "calendar:create")!;
    expect(calStats.approved).toBe(1);
    expect(calStats.rejected).toBe(1);
    expect(calStats.approvalRate).toBe(0.5);
  });
});

describe("suggestTierAdjustments", () => {
  it("returns empty when insufficient data", () => {
    recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    const suggestions = suggestTierAdjustments(PROJECT, { "email:send": "high" }, db);
    expect(suggestions).toHaveLength(0);
  });

  it("suggests tier downgrade for high approval rate", () => {
    for (let i = 0; i < 15; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    }

    const suggestions = suggestTierAdjustments(PROJECT, { "email:send": "high" }, db);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.category).toBe("email:send");
    expect(suggestions[0]!.currentTier).toBe("high");
    expect(suggestions[0]!.suggestedTier).toBe("medium");
  });

  it("does not suggest for protected categories", () => {
    for (let i = 0; i < 15; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "purchase", decision: "approved" }, db);
    }

    const suggestions = suggestTierAdjustments(PROJECT, { "purchase": "high" }, db);
    expect(suggestions).toHaveLength(0);
  });

  it("does not suggest when rejection rate is too high", () => {
    for (let i = 0; i < 10; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    }
    for (let i = 0; i < 2; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "rejected" }, db);
    }

    const suggestions = suggestTierAdjustments(PROJECT, { "email:send": "high" }, db);
    expect(suggestions).toHaveLength(0); // 83% < 95% threshold
  });

  it("does not suggest lowering critical tier", () => {
    for (let i = 0; i < 15; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    }

    const suggestions = suggestTierAdjustments(PROJECT, { "email:send": "critical" }, db);
    expect(suggestions).toHaveLength(0);
  });
});

describe("isProtectedCategory", () => {
  it("identifies protected categories", () => {
    expect(isProtectedCategory("purchase")).toBe(true);
    expect(isProtectedCategory("financial")).toBe(true);
    expect(isProtectedCategory("security")).toBe(true);
    expect(isProtectedCategory("code:merge_pr")).toBe(true);
    expect(isProtectedCategory("financial:transfer")).toBe(true); // prefix match
  });

  it("does not flag non-protected categories", () => {
    expect(isProtectedCategory("email:send")).toBe(false);
    expect(isProtectedCategory("calendar:create")).toBe(false);
  });
});

describe("trust overrides", () => {
  it("applies and retrieves an override", () => {
    const override = applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "medium",
      reason: "High approval rate",
    }, db);

    expect(override.category).toBe("email:send");
    expect(override.overrideTier).toBe("medium");

    const retrieved = getEffectiveTierOverride(PROJECT, "email:send", db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.overrideTier).toBe("medium");
  });

  it("replaces existing override on same category", () => {
    applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "medium",
    }, db);

    applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "low",
    }, db);

    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.overrideTier).toBe("low");
  });

  it("returns null when no override exists", () => {
    const override = getEffectiveTierOverride(PROJECT, "nonexistent", db);
    expect(override).toBeNull();
  });
});

describe("processTrustDecay", () => {
  it("decays inactive overrides", () => {
    // Insert override with old last_used_at
    const override = applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "medium",
      decayAfterDays: 1, // 1 day decay for testing
    }, db);

    // Manually backdate last_used_at to 2 days ago
    db.prepare("UPDATE trust_overrides SET last_used_at = ? WHERE id = ?")
      .run(Date.now() - 2 * 86_400_000, override.id);

    const decayed = processTrustDecay(PROJECT, db);
    expect(decayed).toBe(1);

    const retrieved = getEffectiveTierOverride(PROJECT, "email:send", db);
    expect(retrieved).toBeNull(); // decayed, no longer active
  });

  it("does not decay recently used overrides", () => {
    applyTrustOverride({
      projectId: PROJECT,
      category: "email:send",
      originalTier: "high",
      overrideTier: "medium",
      decayAfterDays: 30,
    }, db);

    const decayed = processTrustDecay(PROJECT, db);
    expect(decayed).toBe(0);

    const retrieved = getEffectiveTierOverride(PROJECT, "email:send", db);
    expect(retrieved).not.toBeNull();
  });
});

describe("renderTrustSummary", () => {
  it("returns null when no decisions", () => {
    const md = renderTrustSummary(PROJECT, db);
    expect(md).toBeNull();
  });

  it("renders markdown summary", () => {
    for (let i = 0; i < 5; i++) {
      recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "approved" }, db);
    }
    recordTrustDecision({ projectId: PROJECT, category: "email:send", decision: "rejected" }, db);

    const md = renderTrustSummary(PROJECT, db);
    expect(md).not.toBeNull();
    expect(md).toContain("## Trust Scores");
    expect(md).toContain("email:send");
    expect(md).toContain("83%");
  });
});
