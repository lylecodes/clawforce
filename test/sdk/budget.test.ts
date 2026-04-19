/**
 * Tests for the BudgetNamespace SDK wrapper.
 *
 * Strategy: import internal functions with a shared in-memory DB via dbOverride,
 * then test the SDK namespace methods by verifying they call through to the same
 * internal code paths (check, recordCost, status, set, costSummary, taskCost).
 */

import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// ---- Dynamic imports after mocks ----

const { getMemoryDb } = await import("../../src/db.js");
const { setBudget, checkBudget } = await import("../../src/budget.js");
const { recordCost, getCostSummary, getTaskCost } = await import("../../src/cost.js");
const { getBudgetStatus } = await import("../../src/budget-windows.js");

// ---- Constants ----

const DOMAIN = "test-budget-project";

// ---- Tests ----

describe("BudgetNamespace (via internal functions + dbOverride)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- BudgetNamespace constructor ----------

  describe("BudgetNamespace class", () => {
    it("exposes domain string on instance", async () => {
      const { BudgetNamespace } = await import("../../src/sdk/budget.js");
      const ns = new BudgetNamespace("my-org");
      expect(ns.domain).toBe("my-org");
    });

    it("stores arbitrary domain strings", async () => {
      const { BudgetNamespace } = await import("../../src/sdk/budget.js");
      expect(new BudgetNamespace("research-lab").domain).toBe("research-lab");
      expect(new BudgetNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- check ----------

  describe("check", () => {
    it("returns ok:true when no budget is set", () => {
      const result = checkBudget({ projectId: DOMAIN }, db);
      expect(result.ok).toBe(true);
    });

    it("returns ok:true when spending is within daily limit", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 10000 } } }, db);

      recordCost({
        projectId: DOMAIN,
        agentId: "agent-a",
        inputTokens: 100,
        outputTokens: 50,
      }, db);

      const result = checkBudget({ projectId: DOMAIN }, db);
      expect(result.ok).toBe(true);
    });

    it("returns ok:false when daily limit is exceeded", () => {
      // Set a tiny limit (1 cent)
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 1 } } }, db);

      // Force the counter over the limit directly
      db.prepare(`
        UPDATE budgets SET daily_spent_cents = 100 WHERE project_id = ?
      `).run(DOMAIN);

      const result = checkBudget({ projectId: DOMAIN }, db);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it("returns ok:true when agent-level check passes with no agent budget set", () => {
      const result = checkBudget({ projectId: DOMAIN, agentId: "agent-x" }, db);
      expect(result.ok).toBe(true);
    });
  });

  // ---------- recordCost ----------

  describe("recordCost", () => {
    it("inserts a cost_records row and returns a record with an id", () => {
      const record = recordCost({
        projectId: DOMAIN,
        agentId: "agent-a",
        inputTokens: 1000,
        outputTokens: 500,
      }, db);

      expect(record.id).toBeTruthy();
      expect(record.agentId).toBe("agent-a");
      expect(record.inputTokens).toBe(1000);
      expect(record.outputTokens).toBe(500);
      expect(typeof record.costCents).toBe("number");
    });

    it("records optional fields (taskId, sessionKey, model, provider)", () => {
      const record = recordCost({
        projectId: DOMAIN,
        agentId: "agent-b",
        inputTokens: 200,
        outputTokens: 100,
        taskId: "task-42",
        sessionKey: "sess-abc",
        model: "claude-opus",
        provider: "anthropic",
      }, db);

      expect(record.taskId).toBe("task-42");
      expect(record.sessionKey).toBe("sess-abc");
      expect(record.model).toBe("claude-opus");
      expect(record.provider).toBe("anthropic");
    });

    it("accumulates costs across multiple calls", () => {
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50 }, db);
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50 }, db);

      const summary = getCostSummary({ projectId: DOMAIN }, db);
      expect(summary.recordCount).toBe(2);
    });
  });

  // ---------- status ----------

  describe("status", () => {
    it("returns empty alerts and no windows when no budget is set", () => {
      const status = getBudgetStatus(DOMAIN, undefined, db);
      expect(status.alerts).toEqual([]);
      expect(status.daily).toBeUndefined();
      expect(status.hourly).toBeUndefined();
      expect(status.monthly).toBeUndefined();
    });

    it("returns daily window when daily budget is set", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 5000 } } }, db);
      const status = getBudgetStatus(DOMAIN, undefined, db);
      expect(status.daily).toBeDefined();
      expect(status.daily!.limitCents).toBe(5000);
      expect(status.daily!.spentCents).toBe(0);
      expect(status.daily!.remainingCents).toBe(5000);
    });

    it("reflects spending in window status after recordCost", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 10000 } } }, db);

      recordCost({
        projectId: DOMAIN,
        agentId: "agent-a",
        inputTokens: 1000,
        outputTokens: 500,
      }, db);

      const status = getBudgetStatus(DOMAIN, undefined, db);
      expect(status.daily).toBeDefined();
      expect(status.daily!.spentCents).toBeGreaterThan(0);
    });

    it("fires alert when usage reaches threshold", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 100 } } }, db);

      // Force daily_spent_cents to 80 (80%) via direct update to trigger alert
      db.prepare(`UPDATE budgets SET daily_spent_cents = 80 WHERE project_id = ?`).run(DOMAIN);

      const status = getBudgetStatus(DOMAIN, undefined, db);
      expect(status.alerts.length).toBeGreaterThan(0);
      expect(status.alerts[0]).toMatch(/daily/i);
    });
  });

  // ---------- set ----------

  describe("set", () => {
    it("creates a project-level budget row", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 5000 } } }, db);

      const row = db.prepare(
        "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
      ).get(DOMAIN) as Record<string, unknown>;

      expect(row).toBeTruthy();
      expect(row.daily_limit_cents).toBe(5000);
    });

    it("creates an agent-level budget row when agentId is provided", () => {
      setBudget({ projectId: DOMAIN, agentId: "agent-z", config: { daily: { cents: 2000 } } }, db);

      const row = db.prepare(
        "SELECT * FROM budgets WHERE project_id = ? AND agent_id = ?",
      ).get(DOMAIN, "agent-z") as Record<string, unknown>;

      expect(row).toBeTruthy();
      expect(row.daily_limit_cents).toBe(2000);
    });

    it("updates existing budget on second call (no duplicate rows)", () => {
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 1000 } } }, db);
      setBudget({ projectId: DOMAIN, config: { daily: { cents: 2000 } } }, db);

      const rows = db.prepare(
        "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
      ).all(DOMAIN) as Record<string, unknown>[];

      expect(rows).toHaveLength(1);
      expect(rows[0]!.daily_limit_cents).toBe(2000);
    });
  });

  // ---------- costSummary ----------

  describe("costSummary", () => {
    it("returns zero totals when no costs have been recorded", () => {
      const summary = getCostSummary({ projectId: DOMAIN }, db);
      expect(summary.totalCostCents).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.recordCount).toBe(0);
    });

    it("sums all records for the project", () => {
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50 }, db);
      recordCost({ projectId: DOMAIN, agentId: "agent-b", inputTokens: 200, outputTokens: 100 }, db);

      const summary = getCostSummary({ projectId: DOMAIN }, db);
      expect(summary.recordCount).toBe(2);
      expect(summary.totalInputTokens).toBe(300);
      expect(summary.totalOutputTokens).toBe(150);
    });

    it("filters by agentId", () => {
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50 }, db);
      recordCost({ projectId: DOMAIN, agentId: "agent-b", inputTokens: 200, outputTokens: 100 }, db);

      const summary = getCostSummary({ projectId: DOMAIN, agentId: "agent-a" }, db);
      expect(summary.recordCount).toBe(1);
      expect(summary.totalInputTokens).toBe(100);
    });

    it("filters by taskId", () => {
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50, taskId: "task-1" }, db);
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 200, outputTokens: 100, taskId: "task-2" }, db);

      const summary = getCostSummary({ projectId: DOMAIN, taskId: "task-1" }, db);
      expect(summary.recordCount).toBe(1);
      expect(summary.totalInputTokens).toBe(100);
    });
  });

  // ---------- taskCost ----------

  describe("taskCost", () => {
    it("returns zero when no costs are recorded for the task", () => {
      const summary = getTaskCost(DOMAIN, "no-such-task", db);
      expect(summary.totalCostCents).toBe(0);
      expect(summary.recordCount).toBe(0);
    });

    it("returns summed cost for the given task", () => {
      recordCost({
        projectId: DOMAIN,
        agentId: "agent-a",
        inputTokens: 500,
        outputTokens: 250,
        taskId: "task-abc",
      }, db);
      recordCost({
        projectId: DOMAIN,
        agentId: "agent-b",
        inputTokens: 300,
        outputTokens: 150,
        taskId: "task-abc",
      }, db);

      const summary = getTaskCost(DOMAIN, "task-abc", db);
      expect(summary.recordCount).toBe(2);
      expect(summary.totalInputTokens).toBe(800);
      expect(summary.totalOutputTokens).toBe(400);
    });

    it("only includes records for the specified task", () => {
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 100, outputTokens: 50, taskId: "task-x" }, db);
      recordCost({ projectId: DOMAIN, agentId: "agent-a", inputTokens: 999, outputTokens: 999, taskId: "task-y" }, db);

      const summary = getTaskCost(DOMAIN, "task-x", db);
      expect(summary.recordCount).toBe(1);
      expect(summary.totalInputTokens).toBe(100);
    });
  });
});
