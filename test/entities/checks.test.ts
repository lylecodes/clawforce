import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

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

const childProcess = await import("node:child_process");
const dbModule = await import("../../src/db.js");
const { getMemoryDb } = dbModule;
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createEntity, getEntity, summarizeEntityIssues } = await import("../../src/entities/ops.js");
const { listEntityCheckRuns, runEntityChecks } = await import("../../src/entities/checks.js");

describe("entities/checks", () => {
  const PROJECT = "entity-checks-test";
  const PROJECT_DIR = "/tmp/rentright-checks";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      agents: {},
      entities: {
        jurisdiction: {
          states: {
            shadow: { initial: true },
            active: {},
          },
          transitions: [{ from: "shadow", to: "active" }],
          health: { values: ["healthy", "warning", "blocked"], default: "healthy" },
          issues: {
            autoSyncHealth: true,
            defaultBlockingSeverities: ["high", "critical"],
            defaultHealthBySeverity: {
              medium: "warning",
              high: "blocked",
              critical: "blocked",
            },
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health -- --json -j \"{{entity.title}}\"",
                parser: {
                  type: "json_record_issues",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  issueArrayPath: "issues",
                  issueTypeField: "category",
                  issueTypeMap: {
                    completeness: "completeness_gap",
                    semantic: "semantic_mismatch",
                  },
                  severityField: "severity",
                  titleField: "message",
                  fieldNameField: "field",
                  metadataUpdates: {
                    signed_off: "signed_off",
                    completeness_percent: "completeness_pct",
                  },
                },
              },
              integrity_gate: {
                command: "npm run integrity:check -- --json -j \"{{entity.title}}\"",
                parser: {
                  type: "json_record_status",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  statusField: "verdict",
                  ignoreStatuses: ["trusted"],
                  metadataUpdates: {
                    blocked_count: "blocked",
                  },
                  issueStates: {
                    blocked: {
                      issueType: "integrity_block",
                      severity: "critical",
                      blocking: true,
                      approvalRequired: true,
                      titleTemplate: "Integrity verdict blocked for {{entity.title}}",
                    },
                  },
                },
              },
            },
            types: {
              completeness_gap: {
                defaultSeverity: "medium",
                health: "warning",
              },
              semantic_mismatch: {
                defaultSeverity: "high",
                blocking: true,
                health: "blocked",
              },
              integrity_block: {
                defaultSeverity: "critical",
                blocking: true,
                approvalRequired: true,
                health: "blocked",
              },
            },
          },
          metadataSchema: {
            slug: { type: "string", required: true },
            signed_off: { type: "boolean" },
            completeness_percent: { type: "number" },
            blocked_count: { type: "number" },
          },
        },
      },
    }, PROJECT_DIR);
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("runs configured checks, reconciles issues, and updates entity metadata", () => {
    const execSyncMock = vi.mocked(childProcess.execSync);
    let phase = 0;
    execSyncMock.mockImplementation((command) => {
      const text = String(command);
      if (text.includes("pipeline:health")) {
        return JSON.stringify({
          jurisdictions: [{
            name: "Los Angeles",
            signed_off: false,
            completeness_pct: phase === 0 ? 82 : 100,
            issues: phase === 0
              ? [{
                  severity: "warning",
                  category: "completeness",
                  message: "Missing field: max_annual_increase_percentage",
                  field: "max_annual_increase_percentage",
                }]
              : [],
          }],
        });
      }
      if (text.includes("integrity:check")) {
        return JSON.stringify({
          jurisdictions: [{
            name: "Los Angeles",
            verdict: phase === 0 ? "blocked" : "trusted",
            blocked: phase === 0 ? 1 : 0,
          }],
        });
      }
      throw new Error(`Unexpected command: ${text}`);
    });

    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { slug: "los-angeles" },
      createdBy: "test",
    }, db);

    const firstRun = runEntityChecks(PROJECT, entity.id, { actor: "tester", dbOverride: db });
    expect(firstRun.results).toHaveLength(2);
    expect(firstRun.results.map((result) => result.status)).toEqual(["issues", "issues"]);
    expect(summarizeEntityIssues(PROJECT, entity.id, db).openCount).toBe(2);

    const updatedAfterFirstRun = getEntity(PROJECT, entity.id, db)!;
    expect(updatedAfterFirstRun.health).toBe("blocked");
    expect(updatedAfterFirstRun.metadata).toMatchObject({
      slug: "los-angeles",
      signed_off: false,
      completeness_percent: 82,
      blocked_count: 1,
    });

    phase = 1;
    const secondRun = runEntityChecks(PROJECT, entity.id, { actor: "tester", dbOverride: db });
    expect(secondRun.results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(summarizeEntityIssues(PROJECT, entity.id, db).openCount).toBe(0);

    const updatedAfterSecondRun = getEntity(PROJECT, entity.id, db)!;
    expect(updatedAfterSecondRun.health).toBe("healthy");
    expect(updatedAfterSecondRun.metadata).toMatchObject({
      slug: "los-angeles",
      completeness_percent: 100,
      blocked_count: 0,
    });

    const runs = listEntityCheckRuns(PROJECT, entity.id, 10, db);
    expect(runs).toHaveLength(4);
    expect(runs.some((run) => run.checkId === "integrity_gate" && run.status === "passed")).toBe(true);
    expect(runs.some((run) => run.checkId === "pipeline_health" && run.status === "passed")).toBe(true);
    expect(runs.every((run) => run.actor === "tester")).toBe(true);
    expect(runs.every((run) => run.trigger === "manual")).toBe(true);
  });

  it("persists simulated check runs when dry-run execution policy intercepts the command", () => {
    resetEnforcementConfigForTest();
    registerWorkforceConfig(`${PROJECT}-dry-run`, {
      agents: {},
      entities: {
        jurisdiction: {
          states: {
            shadow: { initial: true },
            active: {},
          },
          transitions: [{ from: "shadow", to: "active" }],
          health: { values: ["healthy", "warning", "blocked"], default: "healthy" },
          issues: {
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health -- --json -j \"{{entity.title}}\"",
              },
            },
          },
          metadataSchema: {
            slug: { type: "string", required: true },
          },
        },
      },
      execution: {
        mode: "dry_run",
        defaultMutationPolicy: "simulate",
      },
    }, PROJECT_DIR);

    const entity = createEntity({
      projectId: `${PROJECT}-dry-run`,
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { slug: "oakland" },
      createdBy: "test",
    }, db);

    const result = runEntityChecks(`${PROJECT}-dry-run`, entity.id, { actor: "tester", dbOverride: db });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("simulated");
    expect(result.results[0]?.stderr).toContain("simulated");
  });

  it("syncs clear health on a passing rerun even when no issue rows changed", () => {
    const execSyncMock = vi.mocked(childProcess.execSync);
    execSyncMock.mockImplementation((command) => {
      const text = String(command);
      if (text.includes("pipeline:health")) {
        return JSON.stringify({
          jurisdictions: [{
            name: "Los Angeles",
            signed_off: true,
            completeness_pct: 100,
            issues: [],
          }],
        });
      }
      throw new Error(`Unexpected command: ${text}`);
    });

    resetEnforcementConfigForTest();
    registerWorkforceConfig(`${PROJECT}-clear-health`, {
      agents: {},
      entities: {
        jurisdiction: {
          states: {
            shadow: { initial: true },
            active: {},
          },
          transitions: [{ from: "shadow", to: "active" }],
          health: {
            values: ["healthy", "warning", "blocked"],
            default: "warning",
            clear: "healthy",
          },
          issues: {
            autoSyncHealth: true,
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health -- --json -j \"{{entity.title}}\"",
                parser: {
                  type: "json_record_issues",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  issueArrayPath: "issues",
                  metadataUpdates: {
                    signed_off: "signed_off",
                    completeness_percent: "completeness_pct",
                  },
                },
              },
            },
          },
          metadataSchema: {
            slug: { type: "string", required: true },
            signed_off: { type: "boolean" },
            completeness_percent: { type: "number" },
          },
        },
      },
    }, PROJECT_DIR);

    const entity = createEntity({
      projectId: `${PROJECT}-clear-health`,
      kind: "jurisdiction",
      title: "Los Angeles",
      health: "warning",
      metadata: {
        slug: "los-angeles",
        signed_off: true,
        completeness_percent: 100,
      },
      createdBy: "test",
    }, db);

    const result = runEntityChecks(`${PROJECT}-clear-health`, entity.id, { actor: "tester", dbOverride: db });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("passed");
    expect(summarizeEntityIssues(`${PROJECT}-clear-health`, entity.id, db).openCount).toBe(0);
    expect(getEntity(`${PROJECT}-clear-health`, entity.id, db)?.health).toBe("healthy");
  });
});
