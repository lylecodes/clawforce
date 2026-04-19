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
const { checkFrequencyJobs } = await import("../../src/scheduling/scheduler.js");

describe("checkFrequencyJobs", () => {
  let db: DatabaseSync;
  const projectId = "test-project";

  beforeEach(() => {
    resetEnforcementConfigForTest();
    db = getMemoryDb(projectId);
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("dispatches a frequency job that has never run", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            sweep: {
              frequency: "3/day",
            },
          },
        },
      },
    });

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.agentId).toBe("worker1");
    expect(dispatches[0]!.jobName).toBe("sweep");
    expect(dispatches[0]!.reason).toBe("never run before");
  });

  it("does not dispatch a job that ran recently", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            sweep: {
              frequency: "3/day",
            },
          },
        },
      },
    });

    // Insert a recent audit_runs entry (1 hour ago — well within 80% of 8h interval)
    const oneHourAgo = Date.now() - 3_600_000;
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, summary)
      VALUES ('run1', ?, 'worker1', 'sess1', 'completed', ?, ?, 'Job: sweep completed')
    `).run(projectId, oneHourAgo - 60_000, oneHourAgo);

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(0);
  });

  it("dispatches when max interval exceeded", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            sweep: {
              frequency: "3/day",
            },
          },
        },
      },
    });

    // 3/day = 8h interval. 150% = 12h. Insert a run from 13h ago.
    const thirteenHoursAgo = Date.now() - 13 * 3_600_000;
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, summary)
      VALUES ('run1', ?, 'worker1', 'sess1', 'completed', ?, ?, 'Job: sweep completed')
    `).run(projectId, thirteenHoursAgo - 60_000, thirteenHoursAgo);

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.reason).toBe("max interval exceeded");
  });

  it("dispatches early when pending reviews exist", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            review_check: {
              frequency: "3/day",
            },
          },
        },
      },
    });

    // Insert a run from 7h ago (past 80% minimum of 6.4h, but before 8h target)
    const sevenHoursAgo = Date.now() - 7 * 3_600_000;
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, summary)
      VALUES ('run1', ?, 'worker1', 'sess1', 'completed', ?, ?, 'Job: review_check completed')
    `).run(projectId, sevenHoursAgo - 60_000, sevenHoursAgo);

    // Insert a task in REVIEW state
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
      VALUES ('task1', ?, 'Review me', 'REVIEW', 'P2', 'test', ?, ?, 0, 3)
    `).run(projectId, now, now);

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.reason).toBe("1 pending reviews");
  });

  it("skips agents from other projects", () => {
    registerWorkforceConfig("other-project", {
      name: "Other",
      agents: {
        foreign_worker: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            sweep: {
              frequency: "1/hour",
            },
          },
        },
      },
    });

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(0);
  });

  it("skips agents without jobs", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(0);
  });

  it("skips jobs without frequency field", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            cron_job: {
              cron: "*/30 * * * *",
            },
          },
        },
      },
    });

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(0);
  });

  it("skips jobs with invalid frequency strings", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            bad_job: {
              frequency: "invalid",
            },
          },
        },
      },
    });

    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(0);
  });

  it("handles multiple agents with multiple frequency jobs", () => {
    registerWorkforceConfig(projectId, {
      name: "Test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            sweep: { frequency: "3/day" },
            check: { frequency: "1/hour" },
          },
        },
        worker2: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [],
          performance_policy: { action: "alert" },
          jobs: {
            deploy: { frequency: "2/day" },
          },
        },
      },
    });

    // All have never run, so all should dispatch
    const dispatches = checkFrequencyJobs(projectId, db);
    expect(dispatches).toHaveLength(3);

    const jobNames = dispatches.map((d) => `${d.agentId}:${d.jobName}`).sort();
    expect(jobNames).toEqual(["worker1:check", "worker1:sweep", "worker2:deploy"]);
  });
});
