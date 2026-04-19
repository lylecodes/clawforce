import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";

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

const { getMemoryDb } = await import("../../src/db.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { scheduleDueRecurringJobs } = await import("../../src/scheduling/recurring-jobs.js");
const { hasAcceptanceCriteria } = await import("../../src/dispatch/dispatcher.js");

describe("scheduleDueRecurringJobs", () => {
  let db: DatabaseSync;
  const projectId = "recurring-jobs-test";

  beforeEach(() => {
    resetEnforcementConfigForTest();
    db = getMemoryDb(projectId);
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates recurring workflow tasks with dispatchable acceptance criteria", () => {
    registerWorkforceConfig(projectId, {
      name: "Recurring jobs",
      agents: {
        steward: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            backlog_sweep: {
              frequency: "1/hour",
              nudge: "Review onboarding backlog and open governed follow-up work when needed.",
            },
          },
        },
      },
    });

    const scheduled = scheduleDueRecurringJobs(projectId, db, Date.now());
    expect(scheduled).toHaveLength(1);
    expect(hasAcceptanceCriteria(scheduled[0]!.task.description ?? "")).toBe(true);
    expect(scheduled[0]!.task.description).toContain("## Acceptance Criteria");
  });

  it("prioritizes operational onboarding sweeps ahead of maintenance cron", () => {
    registerWorkforceConfig(projectId, {
      name: "Recurring jobs",
      agents: {
        steward: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            "onboarding-backlog-sweep": {
              cron: "at:2000-01-01T00:00:00Z",
              nudge: "Review proposed jurisdictions and onboarding requests.",
            },
            session_reset: {
              cron: "at:2000-01-01T00:00:00Z",
              nudge: "Reset long-lived main sessions.",
            },
          },
        },
      },
    });

    const scheduled = scheduleDueRecurringJobs(projectId, db, Date.now());
    const priorities = Object.fromEntries(scheduled.map((entry) => [entry.jobName, entry.task.priority]));

    expect(priorities["onboarding-backlog-sweep"]).toBe("P2");
    expect(priorities.session_reset).toBe("P3");
  });
});
