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

const { getMemoryDb } = await import("../../src/db.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createEntity, getEntityIssue, recordEntityIssue, resolveEntityIssue } = await import("../../src/entities/ops.js");
const {
  clearEntityCheckRuns,
  collectEntityExperimentSnapshot,
  collectProjectEventQueueSnapshot,
  replayWorkflowMutationImplementationTask,
  reopenEntityIssue,
  resetIssueRemediationTasks,
  shapeEntityExperimentSnapshot,
  shapeEventQueueSnapshot,
} = await import("../../src/entities/admin.js");
const { listEntityCheckRuns } = await import("../../src/entities/checks.js");
const { approveProposal, createProposal, getProposal } = await import("../../src/approval/resolve.js");
const { createTask, getTask, listTasks } = await import("../../src/tasks/ops.js");
const { ingestEvent, markFailed, claimPendingEvents, requeueEvents } = await import("../../src/events/store.js");

describe("entities/admin", () => {
  const PROJECT = "entity-admin-test";
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
            bootstrapping: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            { from: "bootstrapping", to: "shadow" },
            { from: "shadow", to: "active" },
          ],
          health: {
            values: ["healthy", "warning", "degraded", "blocked"],
            default: "healthy",
          },
          issues: {
            defaultBlockingSeverities: ["high", "critical"],
            defaultHealthBySeverity: {
              high: "blocked",
            },
            types: {
              integrity_flag: {
                defaultSeverity: "high",
                blocking: true,
                health: "blocked",
                playbook: "rentright-integrity-remediation",
                task: {
                  enabled: true,
                  titleTemplate: "Remediate {{entity.title}}: {{issue.title}}",
                  rerunOnStates: ["DONE"],
                },
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
          },
        },
      },
    }, "/tmp/entity-admin-test");
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("collects an experiment snapshot with issues, reactive tasks, check runs, and related events", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
      createdBy: "tester",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.integrity.max-increase",
      issueType: "integrity_flag",
      source: "pipeline_health",
      title: "Duplicate current values",
      actor: "tester",
      evidence: {
        record: { verdict: "flagged" },
      },
    }, db);
    const remediation = resetIssueRemediationTasks({
      projectId: PROJECT,
      entityId: entity.id,
      actor: "tester",
    }, db);
    const taskId = remediation.recreatedTaskIds[0]!;

    db.prepare(`
      INSERT INTO entity_check_runs (
        id, project_id, entity_id, entity_kind, check_id, status, command, parser_type,
        exit_code, issue_count, stdout, stderr, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run-1",
      PROJECT,
      entity.id,
      "jurisdiction",
      "pipeline_health",
      "issues",
      "npm run pipeline:health -- --json",
      "json_record_status",
      0,
      1,
      "{}",
      null,
      50,
      Date.now(),
    );

    db.prepare(`
      INSERT INTO simulated_actions (
        id, project_id, domain_id, action_type, source_type, summary, policy_decision, status, created_at,
        entity_type, entity_id, task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "sim-1",
      PROJECT,
      PROJECT,
      "run_check",
      "entity_check",
      "Would rerun pipeline health",
      "simulate",
      "simulated",
      Date.now(),
      "jurisdiction",
      entity.id,
      taskId,
    );

    ingestEvent(PROJECT, "entity_issue_opened", "internal", {
      entityId: entity.id,
      issueId: issue.id,
      taskId,
    }, undefined, db);

    const snapshot = collectEntityExperimentSnapshot(PROJECT, entity.id, { eventLimit: 10 }, db);
    const compact = shapeEntityExperimentSnapshot(snapshot);

    expect(snapshot.entity.id).toBe(entity.id);
    expect(snapshot.issueSummary.openCount).toBe(1);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.reactiveTasks).toHaveLength(1);
    expect(snapshot.checkRuns).toHaveLength(1);
    expect(snapshot.simulatedActions).toHaveLength(1);
    expect(snapshot.events.items.some((event) => event.payload.issueId === issue.id)).toBe(true);
    expect(snapshot.feedItems.some((item) => item.issueId === issue.id)).toBe(true);
    expect(compact.issues[0]!.evidence).toBeUndefined();
    expect(compact.issues[0]!.evidenceSummary).toContain("verdict");
    expect(compact.events.items[0]!.payload).toBeUndefined();
  });

  it("reopens issues and recreates reactive remediation tasks", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { region: "ca-oak" },
      createdBy: "tester",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "oak.integrity.flag",
      issueType: "integrity_flag",
      source: "pipeline_health",
      title: "Integrity block",
      actor: "tester",
    }, db);

    const firstReset = resetIssueRemediationTasks({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "tester",
    }, db);
    expect(firstReset.cancelledTaskIds).toHaveLength(0);
    expect(firstReset.recreatedTaskIds).toHaveLength(1);

    resolveEntityIssue({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "tester",
    }, db);
    const reopened = reopenEntityIssue({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "tester",
      reason: "rerun experiment",
    }, db);
    expect(reopened.status).toBe("open");

    const secondReset = resetIssueRemediationTasks({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "tester",
    }, db);
    expect(secondReset.cancelledTaskIds).toContain(firstReset.recreatedTaskIds[0]);
    expect(secondReset.recreatedTaskIds).toHaveLength(1);
    expect(secondReset.recreatedTaskIds[0]).not.toBe(firstReset.recreatedTaskIds[0]);

    const tasks = listTasks(PROJECT, { origin: "reactive", originId: issue.id, limit: 10 }, db);
    const cancelled = tasks.find((task) => task.id === firstReset.recreatedTaskIds[0]);
    const active = tasks.find((task) => task.id === secondReset.recreatedTaskIds[0]);
    expect(cancelled?.state).toBe("CANCELLED");
    expect(active?.state).toBe("OPEN");
  });

  it("clears check runs and requeues failed events", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "San Francisco",
      metadata: { region: "ca-sf" },
      createdBy: "tester",
    }, db);

    db.prepare(`
      INSERT INTO entity_check_runs (
        id, project_id, entity_id, entity_kind, check_id, status, command, parser_type,
        exit_code, issue_count, stdout, stderr, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("run-a", PROJECT, entity.id, "jurisdiction", "check-a", "passed", "cmd", "json_record_status", 0, 0, "{}", null, 10, Date.now());
    db.prepare(`
      INSERT INTO entity_check_runs (
        id, project_id, entity_id, entity_kind, check_id, status, command, parser_type,
        exit_code, issue_count, stdout, stderr, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("run-b", PROJECT, entity.id, "jurisdiction", "check-b", "issues", "cmd", "json_record_status", 0, 1, "{}", null, 12, Date.now());

    const cleared = clearEntityCheckRuns({
      projectId: PROJECT,
      entityId: entity.id,
      actor: "tester",
    }, db);
    expect(cleared.cleared).toBe(2);
    expect(listEntityCheckRuns(PROJECT, entity.id, 10, db)).toHaveLength(0);

    const { id } = ingestEvent(PROJECT, "entity_issue_opened", "internal", { entityId: entity.id }, undefined, db);
    const [claimed] = claimPendingEvents(PROJECT, 1, db);
    markFailed(claimed!.id, "boom", db);

    const before = collectProjectEventQueueSnapshot(PROJECT, { status: "failed", limit: 10 }, db);
    expect(before.items).toHaveLength(1);
    const requeued = requeueEvents(PROJECT, { status: "failed", limit: 10 }, db);
    expect(requeued).toHaveLength(1);

    const after = collectProjectEventQueueSnapshot(PROJECT, { status: "pending", limit: 10 }, db);
    expect(after.items.some((event) => event.id === id && event.status === "pending")).toBe(true);
    const compactQueue = shapeEventQueueSnapshot(after);
    expect(compactQueue.items[0]!.payload).toBeUndefined();
  });

  it("prioritizes actionable events over low-signal budget churn and supports focus filters", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
      createdBy: "tester",
    }, db);

    ingestEvent(PROJECT, "dispatch_failed", "internal", {
      taskId: "task-1",
      reason: "missing_acceptance_criteria",
    }, undefined, db);
    ingestEvent(PROJECT, "entity_issue_opened", "internal", {
      entityId: entity.id,
      issueId: "issue-1",
      message: "Integrity issue opened",
    }, undefined, db);
    ingestEvent(PROJECT, "budget_changed", "internal", {
      oldLimit: 15000,
      newLimit: 15000,
      source: "setBudget",
    }, undefined, db);

    const queue = collectProjectEventQueueSnapshot(PROJECT, { limit: 10 }, db);
    expect(queue.items[0]!.type).toBe("dispatch_failed");
    expect(queue.items.some((event) => event.type === "entity_issue_opened")).toBe(true);
    const budgetIndex = queue.items.findIndex((event) => event.type === "budget_changed");
    const entityIssueIndex = queue.items.findIndex((event) => event.type === "entity_issue_opened");
    expect(budgetIndex).toBeGreaterThan(entityIssueIndex);

    const actionable = collectProjectEventQueueSnapshot(PROJECT, {
      limit: 10,
      focus: "actionable",
    }, db);
    expect(actionable.focus).toBe("actionable");
    expect(actionable.items.some((event) => event.type === "dispatch_failed")).toBe(true);
    expect(actionable.items.some((event) => event.type === "entity_issue_opened")).toBe(true);
    expect(actionable.items.some((event) => event.type === "budget_changed")).toBe(false);
  });

  it("replays a terminal workflow-mutation implementation task as a successor task", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
      createdBy: "tester",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.workflow.extraction",
      issueType: "integrity_flag",
      source: "pipeline_health",
      title: "Missing field: rate_period_start_day",
      actor: "tester",
      ownerAgentId: "los-angeles-owner",
    }, db);
    const siblingEntity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { region: "ca-oak" },
      createdBy: "tester",
    }, db);
    const siblingIssue = recordEntityIssue({
      projectId: PROJECT,
      entityId: siblingEntity.id,
      issueKey: "oak.workflow.extraction",
      issueType: "integrity_flag",
      source: "pipeline_health",
      title: "Missing field: rate_period_start_day",
      actor: "tester",
      ownerAgentId: "oakland-owner",
    }, db);
    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Missing field: rate_period_start_day",
      description: "Acceptance criteria:\n- Narrow the issue or resolve it.",
      priority: "P1",
      assignedTo: "los-angeles-owner",
      createdBy: "tester",
      entityType: "jurisdiction",
      entityId: entity.id,
      kind: "bug",
      origin: "reactive",
      originId: issue.id,
      metadata: {
        entityIssue: {
          issueId: issue.id,
          issueType: issue.issueType,
        },
      },
    }, db);
    db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE project_id = ? AND id = ?")
      .run(Date.now(), PROJECT, sourceTask.id);

    const proposal = createProposal({
      projectId: PROJECT,
      title: "Workflow mutation review: repeated verification environment blocked for Los Angeles",
      proposedBy: "workflow-steward",
      origin: "workflow_mutation",
      entityType: entity.kind,
      entityId: entity.id,
      approvalPolicySnapshot: JSON.stringify({
        replayType: "workflow_mutation",
        stewardAgentId: "workflow-steward",
        sourceTaskId: sourceTask.id,
        sourceTaskTitle: sourceTask.title,
        sourceIssueId: issue.id,
        affectedIssueIds: [issue.id, siblingIssue.id],
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 3,
        entityType: entity.kind,
        entityId: entity.id,
        entityTitle: entity.title,
        latestReason: issue.title,
        recommendedChanges: ["Rework the loop."],
        stewardTask: {
          title: "Restructure workflow for Los Angeles",
          description: "Acceptance criteria:\n- Restore the loop.",
          priority: "P1",
          kind: "infra",
        },
      }),
    }, db);
    approveProposal(PROJECT, proposal.id, "approved for replay", db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for Los Angeles: workflow gap",
      description: "Acceptance criteria:\n- Restore the loop.",
      priority: "P1",
      assignedTo: "workflow-steward",
      createdBy: "system:workflow-mutation",
      entityType: entity.kind,
      entityId: entity.id,
      kind: "infra",
      origin: "lead_proposal",
      originId: proposal.id,
      tags: ["workflow-mutation", "workflow-mutation-implementation"],
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        sourceIssueId: issue.id,
        reviewTaskId: "review-1",
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 3,
        workflowMutationPostCondition: {
          verifiedAt: Date.now(),
          sourceTaskState: "DONE",
          sourceIssueStatus: "open",
        },
      },
    }, db);
    db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE project_id = ? AND id = ?")
      .run(Date.now(), PROJECT, implementationTask.id);
    db.prepare("UPDATE entity_issues SET proposal_id = NULL WHERE project_id = ? AND id = ?")
      .run(PROJECT, issue.id);
    db.prepare("UPDATE entity_issues SET proposal_id = NULL WHERE project_id = ? AND id = ?")
      .run(PROJECT, siblingIssue.id);

    const result = replayWorkflowMutationImplementationTask({
      projectId: PROJECT,
      taskId: implementationTask.id,
      actor: "tester",
      reason: "rerun under corrected verifier logic",
    }, db);

    expect(result.previousTaskId).toBe(implementationTask.id);
    expect(result.replayedTaskId).not.toBe(implementationTask.id);
    expect(result.created).toBe(true);
    expect(result.relinkedIssue).toBe(true);

    const replayTask = getTask(PROJECT, result.replayedTaskId, db);
    expect(replayTask?.state).toBe("ASSIGNED");
    expect((replayTask?.metadata as Record<string, unknown>)?.workflowMutationReplayOfTaskId).toBe(implementationTask.id);
    expect((replayTask?.metadata as Record<string, unknown>)?.workflowMutationPostCondition).toBeUndefined();

    const refreshedIssue = getEntityIssue(PROJECT, issue.id, db);
    expect(refreshedIssue?.proposalId).toBe(proposal.id);
    const refreshedSiblingIssue = getEntityIssue(PROJECT, siblingIssue.id, db);
    expect(refreshedSiblingIssue?.proposalId).toBe(proposal.id);

    const refreshedProposal = getProposal(PROJECT, proposal.id, db);
    expect(refreshedProposal?.execution_status).toBe("pending");
    expect(refreshedProposal?.execution_task_id).toBe(replayTask?.id);

    const refreshedSourceTask = getTask(PROJECT, sourceTask.id, db);
    const workflowMutation = (refreshedSourceTask?.metadata as Record<string, unknown>)?.workflowMutation as Record<string, unknown> | undefined;
    expect(workflowMutation?.followUpTaskId).toBe(replayTask?.id);
    expect(workflowMutation?.proposalId).toBe(proposal.id);
  });

  it("replays blocked workflow-mutation implementation tasks after normalizing stale descriptions", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { region: "ca-oak" },
      createdBy: "tester",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "oak.workflow.semantic",
      issueType: "integrity_flag",
      source: "pipeline_health",
      title: "Repeated semantic mismatch",
      actor: "tester",
      ownerAgentId: "oakland-owner",
    }, db);
    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Oakland: repeated semantic mismatch",
      description: "Acceptance criteria:\n- Restore the loop.",
      priority: "P1",
      assignedTo: "oakland-owner",
      createdBy: "tester",
      entityType: "jurisdiction",
      entityId: entity.id,
      kind: "bug",
      origin: "reactive",
      originId: issue.id,
      metadata: {
        entityIssue: {
          issueId: issue.id,
          issueType: issue.issueType,
        },
      },
    }, db);

    const reviewTask = createTask({
      projectId: PROJECT,
      title: "Restructure workflow for repeated semantic_mismatch across 3 jurisdictions",
      description: [
        "Recommended changes:",
        "- Collapse duplicate owner loops into one workflow mutation implementation path.",
        "- Rerun affected issue checks after the shared mutation lands.",
        "",
        "Acceptance criteria:",
        "- Stop duplicate remediation churn.",
      ].join("\n"),
      priority: "P1",
      assignedTo: "workflow-steward",
      createdBy: "tester",
      kind: "infra",
    }, db);

    const proposal = createProposal({
      projectId: PROJECT,
      title: "Workflow mutation review: repeated semantic mismatch",
      proposedBy: "workflow-steward",
      origin: "workflow_mutation",
      entityType: entity.kind,
      entityId: entity.id,
      approvalPolicySnapshot: JSON.stringify({
        replayType: "workflow_mutation",
        stewardAgentId: "workflow-steward",
        sourceTaskId: sourceTask.id,
        sourceTaskTitle: sourceTask.title,
        sourceIssueId: issue.id,
        affectedIssueIds: [issue.id],
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 2,
        entityType: entity.kind,
        entityId: entity.id,
        entityTitle: entity.title,
      }),
    }, db);
    approveProposal(PROJECT, proposal.id, "approved for replay", db);

    const blockedTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for 3 jurisdictions: workflow gap",
      description: [
        "Accepted recommendation:",
        "Reading additional input from stdin...",
        "OpenAI Codex v0.118.0 (research preview)",
        "<system_context>",
      ].join("\n"),
      priority: "P1",
      assignedTo: "workflow-steward",
      createdBy: "system:workflow-mutation",
      entityType: entity.kind,
      entityId: entity.id,
      kind: "infra",
      origin: "lead_proposal",
      originId: proposal.id,
      tags: ["workflow-mutation", "workflow-mutation-implementation"],
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        sourceTaskTitle: sourceTask.title,
        sourceIssueId: issue.id,
        reviewTaskId: reviewTask.id,
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        dispatch_dead_letter_at: Date.now(),
        "$.dispatch_dead_letter": true,
        "$.dispatch_dead_letter_at": Date.now(),
      },
    }, db);
    db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE project_id = ? AND id = ?")
      .run(Date.now(), PROJECT, blockedTask.id);

    const result = replayWorkflowMutationImplementationTask({
      projectId: PROJECT,
      taskId: blockedTask.id,
      actor: "tester",
      reason: "rerun under repaired workflow-mutation prompt builder",
    }, db);

    const replayTask = getTask(PROJECT, result.replayedTaskId, db);
    expect(result.created).toBe(true);
    expect(replayTask?.state).toBe("ASSIGNED");
    expect(replayTask?.description).toContain("Accepted recommendation summary:");
    expect(replayTask?.description).toContain("Collapse duplicate owner loops into one workflow mutation implementation path.");
    expect(replayTask?.description).not.toContain("Reading additional input from stdin");
    const replayMetadata = replayTask?.metadata as Record<string, unknown> | undefined;
    expect(replayMetadata?.dispatch_dead_letter).toBeUndefined();
    expect(replayMetadata?.dispatch_dead_letter_at).toBeUndefined();
    expect(replayMetadata?.["$.dispatch_dead_letter"]).toBeUndefined();
    expect(replayMetadata?.["$.dispatch_dead_letter_at"]).toBeUndefined();
  });
});
