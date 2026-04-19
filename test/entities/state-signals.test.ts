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
const { createEntity, listEntityIssues, updateEntity } = await import("../../src/entities/ops.js");
const { listTasks } = await import("../../src/tasks/ops.js");
const { processEvents } = await import("../../src/events/router.js");

describe("entities/state-signals", () => {
  const PROJECT = "entities-state-signals-test";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      agents: {
        "source-onboarding-steward": {
          title: "Source Onboarding Steward",
        },
        "workflow-steward": {
          title: "Workflow Steward",
        },
        "sacramento-owner": {
          title: "Sacramento Owner",
        },
      },
      entities: {
        jurisdiction: {
          title: "Jurisdiction",
          runtimeCreate: true,
          states: {
            proposed: { initial: true },
            bootstrapping: {},
            shadow: {},
          },
          transitions: [
            { from: "proposed", to: "bootstrapping" },
            { from: "bootstrapping", to: "shadow" },
          ],
          health: {
            values: ["healthy", "warning", "degraded"],
            default: "warning",
          },
          metadataSchema: {
            slug: { type: "string", required: true },
          },
          issues: {
            stateSignals: [
              {
                id: "proposed-onboarding",
                whenStates: ["proposed"],
                ownerPresence: "missing",
                issueType: "onboarding_request",
                issueKey: "onboarding:requested",
                titleTemplate: "Onboarding required for {{entity.title}}",
                descriptionTemplate: "{{entity.title}} is proposed and still lacks owner coverage.",
                ownerAgentId: "source-onboarding-steward",
              },
            ],
            types: {
              onboarding_request: {
                defaultSeverity: "medium",
                health: "warning",
                playbook: "jurisdiction-onboarding",
                task: {
                  enabled: true,
                  titleTemplate: "Onboard {{entity.title}} authoritative sources",
                  kind: "feature",
                },
              },
            },
          },
        },
      },
    }, process.cwd());
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("opens and resolves onboarding issues from entity state signals", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Sacramento",
      createdBy: "test",
      metadata: { slug: "sacramento" },
    }, db);

    processEvents(PROJECT, db);
    processEvents(PROJECT, db);

    const openIssues = listEntityIssues(PROJECT, { entityId: entity.id, status: "open" }, db);
    expect(openIssues).toHaveLength(1);
    expect(openIssues[0]).toMatchObject({
      issueType: "onboarding_request",
      issueKey: "onboarding:requested",
      ownerAgentId: "source-onboarding-steward",
    });

    const activeTasks = listTasks(PROJECT, { entityId: entity.id, origin: "reactive" }, db);
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0]).toMatchObject({
      title: "Onboard Sacramento authoritative sources",
      assignedTo: "source-onboarding-steward",
      state: "ASSIGNED",
    });

    updateEntity(PROJECT, entity.id, {
      ownerAgentId: "sacramento-owner",
    }, "test", db);

    processEvents(PROJECT, db);
    processEvents(PROJECT, db);

    const remainingOpenIssues = listEntityIssues(PROJECT, { entityId: entity.id, status: "open" }, db);
    expect(remainingOpenIssues).toHaveLength(0);
    const resolvedIssues = listEntityIssues(PROJECT, { entityId: entity.id, status: "resolved" }, db);
    expect(resolvedIssues).toHaveLength(1);

    const remediationTasks = listTasks(PROJECT, { entityId: entity.id, origin: "reactive" }, db);
    expect(remediationTasks[0]?.state).toBe("CANCELLED");
  });
});
