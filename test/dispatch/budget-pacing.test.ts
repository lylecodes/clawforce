import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Mock the inject dispatcher to prevent actual agent spawning
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async () => ({ ok: true, sessionKey: "test-session" })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { registerWorkforceConfig, getExtendedProjectConfig } = await import("../../src/project.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");
const { setBudget } = await import("../../src/budget.js");

import { computeBudgetPacing } from "../../src/budget/pacer.js";

describe("budget pacing gate in dispatcher", () => {
  let db: DatabaseSync;
  const PROJECT = "test-budget-pacing";

  beforeEach(() => {
    db = getMemoryDb();

    registerWorkforceConfig(PROJECT, {
      name: "test-pacing",
      agents: {
        "pacing-lead": {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
        "pacing-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        budget_pacing: {
          enabled: true,
          reactive_reserve_pct: 20,
          low_budget_threshold: 10,
          critical_threshold: 5,
        },
      },
    });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("computeBudgetPacing blocks workers when in low budget mode", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 9100, // 9% remaining — below 10% low threshold, above 5% critical
      hoursRemaining: 8,
    });

    expect(pacing.canDispatchWorker).toBe(false);
    expect(pacing.canDispatchLead).toBe(true);
  });

  it("computeBudgetPacing blocks both when critical", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 9600, // 4% remaining — below 5% critical
      hoursRemaining: 8,
    });

    expect(pacing.canDispatchWorker).toBe(false);
    expect(pacing.canDispatchLead).toBe(false);
  });

  it("computeBudgetPacing allows both when budget is healthy", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 2000,
      hoursRemaining: 16,
    });

    expect(pacing.canDispatchWorker).toBe(true);
    expect(pacing.canDispatchLead).toBe(true);
  });

  it("respects paceDelay when burning too fast", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 2000,
      hoursRemaining: 16,
      currentHourSpentCents: 600, // hourlyRate = 400, so 600 is over
    });

    expect(pacing.paceDelay).toBeGreaterThan(0);
  });

  it("skips pacing when budget_pacing.enabled is false", () => {
    // Re-register with pacing disabled
    registerWorkforceConfig(PROJECT + "-disabled", {
      name: "test-pacing-disabled",
      agents: {
        "disabled-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        budget_pacing: {
          enabled: false,
        },
      },
    });

    const config = getExtendedProjectConfig(PROJECT + "-disabled");
    expect(config?.dispatch?.budget_pacing?.enabled).toBe(false);
    // When enabled is false, the dispatcher should skip pacing checks entirely
  });

  it("canDispatchReactive is true when budget remains", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 9600, // 4% remaining — below critical
      hoursRemaining: 8,
    });

    // Critical blocks workers and leads, but reactive is still allowed if remaining > 0
    expect(pacing.canDispatchReactive).toBe(true);
    expect(pacing.canDispatchWorker).toBe(false);
    expect(pacing.canDispatchLead).toBe(false);
  });

  it("canDispatchReactive is false when budget exhausted", () => {
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 10000,
      spentCents: 10000, // 0% remaining
      hoursRemaining: 8,
    });

    expect(pacing.canDispatchReactive).toBe(false);
  });
});

describe("per-team budget strategy", () => {
  const PROJECT = "test-team-pacing";

  it("normalizes team dispatch overrides from config", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test-team-pacing",
      agents: {
        "team-lead": {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          team: "dashboard",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
        "team-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          team: "core",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        budget_pacing: {
          enabled: true,
          reactive_reserve_pct: 20,
        },
        teams: {
          dashboard: {
            budget_pacing: {
              enabled: true,
            },
          },
          core: {
            budget_pacing: {
              enabled: false,
            },
          },
        },
      },
    });

    const config = getExtendedProjectConfig(PROJECT);
    expect(config?.dispatch?.budget_pacing?.enabled).toBe(true);
    expect(config?.dispatch?.teams).toBeDefined();
    expect(config?.dispatch?.teams?.dashboard?.budget_pacing?.enabled).toBe(true);
    expect(config?.dispatch?.teams?.core?.budget_pacing?.enabled).toBe(false);
  });

  it("falls back to domain-level pacing when no team override exists", () => {
    registerWorkforceConfig(PROJECT + "-fallback", {
      name: "test-fallback",
      agents: {
        "fb-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          team: "unknown-team",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        budget_pacing: {
          enabled: true,
        },
        teams: {
          dashboard: {
            budget_pacing: {
              enabled: false,
            },
          },
        },
      },
    });

    const config = getExtendedProjectConfig(PROJECT + "-fallback");
    // Domain-level pacing is enabled
    expect(config?.dispatch?.budget_pacing?.enabled).toBe(true);
    // The unknown-team agent should not find a team override
    expect(config?.dispatch?.teams?.["unknown-team"]).toBeUndefined();
    // Dashboard team override exists
    expect(config?.dispatch?.teams?.dashboard?.budget_pacing?.enabled).toBe(false);
  });

  it("handles empty teams config gracefully", () => {
    registerWorkforceConfig(PROJECT + "-empty", {
      name: "test-empty-teams",
      agents: {
        "empty-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        budget_pacing: {
          enabled: true,
        },
      },
    });

    const config = getExtendedProjectConfig(PROJECT + "-empty");
    expect(config?.dispatch?.budget_pacing?.enabled).toBe(true);
    expect(config?.dispatch?.teams).toBeUndefined();
  });
});
