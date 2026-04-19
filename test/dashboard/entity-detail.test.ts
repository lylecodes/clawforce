import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

const dbModule = await import("../../src/db.js");
const { getMemoryDb } = dbModule;
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createEntity, recordEntityIssue, transitionEntity } = await import("../../src/entities/ops.js");
const { queryEntityDetail } = await import("../../src/dashboard/queries.js");

describe("dashboard/queryEntityDetail", () => {
  const PROJECT = "dashboard-entity-detail-test";
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
            bootstrapping: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            { from: "bootstrapping", to: "shadow" },
            { from: "shadow", to: "active", reasonRequired: true, approvalRequired: true },
          ],
          health: { values: ["healthy", "warning", "blocked"], default: "healthy" },
          issues: {
            defaultBlockingSeverities: ["high", "critical"],
            defaultHealthBySeverity: {
              high: "blocked",
            },
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health -- --json",
                issueTypes: ["bundle_regression"],
              },
            },
            types: {
              bundle_regression: {
                defaultSeverity: "high",
                blocking: true,
                approvalRequired: true,
                health: "blocked",
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
          },
        },
      },
    });
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns issues and issue summary alongside entity detail", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      metadata: { region: "ca-la" },
    }, db);

    transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "shadow",
      actor: "test",
    }, db);

    recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.bundle_regression.overlap",
      issueType: "bundle_regression",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Overlapping periods detected",
      actor: "test",
    }, db);

    const detail = queryEntityDetail(PROJECT, entity.id);
    expect(detail).not.toBeNull();
    expect(detail!.issues).toHaveLength(1);
    expect(detail!.checkRuns).toEqual([]);
    expect(detail!.issueSummary).toMatchObject({
      openCount: 1,
      blockingOpenCount: 1,
      highestSeverity: "high",
      suggestedHealth: "blocked",
    });
    expect(detail!.transitions).toHaveLength(1);
  });
});
