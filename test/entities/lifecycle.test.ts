import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createEntity, getEntity, listEntityIssues, recordEntityIssue } = await import("../../src/entities/ops.js");
const { reconcileEntityReadiness } = await import("../../src/entities/lifecycle.js");
const { createTask, getTask } = await import("../../src/tasks/ops.js");
const { listPendingProposals } = await import("../../src/approval/resolve.js");

describe("entities/lifecycle", () => {
  const PROJECT = "entity-lifecycle-test";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      agents: {},
      entities: {
        jurisdiction: {
          title: "Jurisdiction",
          runtimeCreate: true,
          states: {
            proposed: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            { from: "proposed", to: "shadow" },
            { from: "shadow", to: "active", approvalRequired: true, reasonRequired: true, blockedByOpenIssues: true },
          ],
          health: {
            values: ["healthy", "warning", "degraded", "blocked"],
            default: "warning",
            clear: "healthy",
          },
          metadataSchema: {
            slug: { type: "string", required: true },
            activation_blockers: { type: "array" },
            signed_off: { type: "boolean" },
            completeness_percent: { type: "number" },
            health_percent: { type: "number" },
            quality_percent: { type: "number" },
            rates_status: { type: "string" },
          },
          readiness: {
            whenStates: ["shadow"],
            blockersField: "activation_blockers",
            requirements: {
              noOpenIssues: true,
              metadataTrue: ["signed_off"],
              metadataEquals: {
                rates_status: "current",
              },
              metadataMin: {
                completeness_percent: 100,
                health_percent: 100,
                quality_percent: 100,
              },
            },
            closeTasksWhenReady: {
              titleTemplates: ["Stand up shadow governance for {{entity.title}}"],
            },
            requestTransitionWhenReady: {
              toState: "active",
              reason: "Shadow readiness requirements satisfied",
            },
          },
          issues: {
            autoSyncHealth: true,
            defaultBlockingSeverities: ["high", "critical"],
            defaultHealthBySeverity: {
              high: "degraded",
              critical: "blocked",
            },
            types: {
              extraction_failure: {
                defaultSeverity: "high",
                blocking: true,
                health: "degraded",
              },
            },
          },
        },
      },
    }, "/tmp/entity-lifecycle-test");
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("closes bootstrap tasks and raises one promotion proposal for a clean shadow entity", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      state: "shadow",
      createdBy: "tester",
      metadata: {
        slug: "los-angeles",
        activation_blockers: ["stale blocker"],
        signed_off: true,
        completeness_percent: 100,
        health_percent: 100,
        quality_percent: 100,
        rates_status: "current",
      },
    }, db);
    const kickoff = createTask({
      projectId: PROJECT,
      title: "Stand up shadow governance for Los Angeles",
      createdBy: "tester",
      entityId: entity.id,
      entityType: entity.kind,
    }, db);

    const result = reconcileEntityReadiness(PROJECT, entity.id, "tester", db);

    expect(result.evaluated).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.closedTaskIds).toEqual([kickoff.id]);
    expect(result.transitionProposalId).toBeDefined();

    const updatedEntity = getEntity(PROJECT, entity.id, db)!;
    expect(updatedEntity.metadata?.activation_blockers).toEqual([]);

    const updatedKickoff = getTask(PROJECT, kickoff.id, db)!;
    expect(updatedKickoff.state).toBe("CANCELLED");

    const proposals = listPendingProposals(PROJECT, db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.origin).toBe("entity_transition");
    expect(proposals[0]!.entity_id).toBe(entity.id);

    const second = reconcileEntityReadiness(PROJECT, entity.id, "tester", db);
    expect(second.transitionProposalId).toBe(proposals[0]!.id);
    expect(listPendingProposals(PROJECT, db)).toHaveLength(1);
  });

  it("updates blocker metadata without creating a promotion proposal when requirements are not met", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      state: "shadow",
      createdBy: "tester",
      metadata: {
        slug: "los-angeles",
        activation_blockers: ["old blocker"],
        signed_off: false,
        completeness_percent: 80,
        health_percent: 95,
        quality_percent: 100,
        rates_status: "missing",
      },
    }, db);
    const kickoff = createTask({
      projectId: PROJECT,
      title: "Stand up shadow governance for Los Angeles",
      createdBy: "tester",
      entityId: entity.id,
      entityType: entity.kind,
    }, db);
    recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.extraction",
      issueType: "extraction_failure",
      source: "pipeline_health",
      title: "Extraction failed",
      actor: "tester",
      severity: "high",
    }, db);

    const result = reconcileEntityReadiness(PROJECT, entity.id, "tester", db);

    expect(result.ready).toBe(false);
    expect(result.transitionProposalId).toBeUndefined();
    expect(result.blockers).toEqual(expect.arrayContaining([
      "1 open issue(s) remain",
      "metadata.signed_off must be true",
      "metadata.rates_status must equal current",
      "metadata.completeness_percent must be >= 100",
      "metadata.health_percent must be >= 100",
    ]));

    const updatedEntity = getEntity(PROJECT, entity.id, db)!;
    expect(updatedEntity.metadata?.activation_blockers).toEqual(result.blockers);
    expect(getTask(PROJECT, kickoff.id, db)?.state).toBe("OPEN");
    expect(listPendingProposals(PROJECT, db)).toHaveLength(0);
    expect(listEntityIssues(PROJECT, { entityId: entity.id, status: "open" }, db)).toHaveLength(1);
  });
});
