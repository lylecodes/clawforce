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
const { EntitiesNamespace } = await import("../../src/sdk/entities.js");

describe("sdk/entities", () => {
  const DOMAIN = "sdk-entities-test";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(DOMAIN, {
      agents: {},
      entities: {
        jurisdiction: {
          title: "Jurisdiction",
          states: {
            bootstrapping: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            { from: "bootstrapping", to: "shadow" },
            {
              from: "shadow",
              to: "active",
              reasonRequired: true,
              approvalRequired: true,
              blockedByOpenIssues: true,
              blockedBySeverities: ["high", "critical"],
            },
          ],
          health: { values: ["healthy", "warning"], default: "healthy" },
          issues: {
            defaultBlockingSeverities: ["high", "critical"],
            defaultHealthBySeverity: {
              high: "warning",
            },
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health -- --json",
                parser: {
                  type: "json_record_status",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  statusField: "verdict",
                  issueStates: {
                    blocked: {
                      issueType: "bundle_regression",
                      severity: "high",
                      blocking: true,
                      approvalRequired: true,
                      titleTemplate: "Pipeline blocked for {{entity.title}}",
                    },
                  },
                },
                issueTypes: ["bundle_regression"],
              },
            },
            types: {
              bundle_regression: {
                defaultSeverity: "high",
                blocking: true,
                approvalRequired: true,
                health: "warning",
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
          },
        },
      },
    }, "/tmp/sdk-entities-test");
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("lists configured entity kinds", () => {
    const entities = new EntitiesNamespace(DOMAIN);
    const kinds = entities.kinds();

    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toMatchObject({
      kind: "jurisdiction",
      states: ["bootstrapping", "shadow", "active"],
      healthValues: ["healthy", "warning"],
    });
  });

  it("creates, updates, and transitions entities through the SDK mapping", () => {
    const entities = new EntitiesNamespace(DOMAIN);

    const created = entities.create({
      kind: "jurisdiction",
      title: "San Francisco",
      group: "california",
      subgroup: "bay-area",
      metadata: { region: "ca-sf" },
    }, "sdk-test");

    expect(created.state).toBe("bootstrapping");
    expect(created.owner).toBeUndefined();
    expect(created.group).toBe("california");
    expect(created.subgroup).toBe("bay-area");

    const updated = entities.update(created.id, {
      owner: "sf-owner",
      metadata: { region: "ca-sf" },
    }, "sdk-test");
    expect(updated.owner).toBe("sf-owner");

    const shadow = entities.transition(created.id, {
      toState: "shadow",
    }, "sdk-test");
    expect(shadow.state).toBe("shadow");

    const listed = entities.list({ kind: "jurisdiction" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
  });

  it("exposes issue reporting, summaries, detail, and approval-backed transition requests", () => {
    const entities = new EntitiesNamespace(DOMAIN);

    const created = entities.create({
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { region: "ca-oak" },
    }, "sdk-test");

    entities.transition(created.id, { toState: "shadow" }, "sdk-test");
    const issue = entities.reportIssue({
      entityId: created.id,
      issueKey: "oak.bundle_regression.overlap",
      issueType: "bundle_regression",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Overlapping periods detected",
    }, "sdk-test");

    expect(issue.blocking).toBe(true);
    expect(entities.issueSummary(created.id).blockingOpenCount).toBe(1);
    expect(entities.issues(created.id)).toHaveLength(1);

    const transitionResult = entities.requestTransition(created.id, {
      toState: "active",
      reason: "Ready for operator signoff",
    }, "sdk-test");
    expect(transitionResult.ok).toBe(false);
    if (transitionResult.ok) throw new Error("expected approval gating");
    expect(transitionResult.proposal.title).toContain("Approve entity transition");
    expect(transitionResult.blockingIssues).toHaveLength(1);

    const detail = entities.detail(created.id)!;
    expect(detail.issues).toHaveLength(1);
    expect(detail.issueSummary.pendingProposalCount).toBe(1);

    const resolved = entities.resolveIssue(issue.id, "sdk-test");
    expect(resolved.status).toBe("resolved");
    expect(entities.issueSummary(created.id).openCount).toBe(0);
  });

  it("runs checks through the SDK and exposes recent check runs", () => {
    vi.mocked(childProcess.execSync).mockReturnValue(JSON.stringify({
      jurisdictions: [{ name: "San Francisco", verdict: "blocked" }],
    }));

    const entities = new EntitiesNamespace(DOMAIN);
    const created = entities.create({
      kind: "jurisdiction",
      title: "San Francisco",
      metadata: { region: "ca-sf" },
    }, "sdk-test");

    const result = entities.runChecks(created.id, { actor: "sdk-test" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.issues).toHaveLength(1);

    const detail = entities.detail(created.id)!;
    expect(detail.checkRuns).toHaveLength(1);
    expect(detail.checkRuns[0]?.checkId).toBe("pipeline_health");
  });
});
