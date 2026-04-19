import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence, getTask, getTaskEvidence } = await import("../../src/tasks/ops.js");
const { submitVerdict } = await import("../../src/tasks/verify.js");
const { getReviewsForTask } = await import("../../src/telemetry/review-store.js");
const { recordEntityIssue, resolveEntityIssue } = await import("../../src/entities/ops.js");
const project = await import("../../src/project.js");

describe("submitVerdict", () => {
  let db: DatabaseSync;
  const PROJECT = "test-verify";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function createReviewableTask() {
    const task = createTask({
      projectId: PROJECT,
      title: "Test task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    return task;
  }

  it("records an approved manager review on passing verdict", () => {
    const task = createReviewableTask();

    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: true,
      reason: "All tests pass",
      sessionKey: "agent:pm:cron:abc123",
    }, db);

    const reviews = getReviewsForTask(PROJECT, task.id, db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.verdict).toBe("approved");
    expect(reviews[0]!.reviewerAgentId).toBe("agent:pm");
    expect(reviews[0]!.reasoning).toBe("All tests pass");
    expect(reviews[0]!.sessionKey).toBe("agent:pm:cron:abc123");
  });

  it("records a rejected manager review on failing verdict", () => {
    const task = createReviewableTask();

    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Tests failing",
    }, db);

    const reviews = getReviewsForTask(PROJECT, task.id, db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.verdict).toBe("rejected");
    expect(reviews[0]!.reasonCode).toBe("verification_environment_blocked");
    expect(reviews[0]!.reasoning).toBe("Tests failing");
  });

  it("transitions task to DONE on passing verdict", () => {
    const task = createReviewableTask();

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: true,
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("DONE");
    }
  });

  it("transitions task to IN_PROGRESS on failing verdict", () => {
    const task = createReviewableTask();

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("IN_PROGRESS");
    }
  });

  it("blocks the task on verification_environment_blocked instead of redispatching the same rework loop", () => {
    const task = createReviewableTask();

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Verifier environment is missing the required DB/socket access",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("BLOCKED");
    }
  });

  it("raises one workflow-mutation proposal immediately for verification_environment_blocked review failures", () => {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue({
      review: {
        workflowSteward: {
          agentId: "workflow-steward",
          autoProposalThreshold: 2,
          autoProposalReasonCodes: ["verification_environment_blocked"],
          proposalCooldownHours: 24,
        },
      },
    } as any);

    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "degraded", "agent:pm", Date.now(), Date.now());
    const task = createTask({
      projectId: PROJECT,
      title: "Reactive task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      entityType: "jurisdiction",
      entityId: "entity-la",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Sandbox blocked the decisive verification run",
    }, db);

    const proposals = db.prepare(`
      SELECT title, proposed_by, origin, entity_id, approval_policy_snapshot
      FROM proposals
      WHERE project_id = ?
        AND origin = 'workflow_mutation'
    `).all(PROJECT) as Array<Record<string, unknown>>;

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposed_by).toBe("workflow-steward");
    expect(proposals[0]!.entity_id).toBe("entity-la");
    expect(proposals[0]!.title).toContain("verification environment blocked");
    const snapshot = JSON.parse(proposals[0]!.approval_policy_snapshot as string) as Record<string, unknown>;
    expect(snapshot.replayType).toBe("workflow_mutation");
    expect(snapshot.stewardAgentId).toBe("workflow-steward");
    expect(snapshot.sourceTaskId).toBe(task.id);
    expect(snapshot.reasonCode).toBe("verification_environment_blocked");
  });

  it("does not complete a workflow-mutation implementation task when the post-condition rerun cannot restore the source path", () => {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue({
      entities: {
        jurisdiction: {},
      },
    } as any);
    vi.spyOn(project, "getProjectDir").mockReturnValue("/tmp");

    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "warning", "agent:pm", Date.now(), Date.now());

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: "entity-la",
      issueKey: "missing-rate-period-start-day",
      issueType: "completeness_gap",
      source: "pipeline_health",
      actor: "system:test",
      title: "Missing field: rate_period_start_day",
      fieldName: "rate_period_start_day",
    }, db);

    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Missing field: rate_period_start_day",
      createdBy: "system:test",
      assignedTo: "los-angeles-owner",
      entityType: "jurisdiction",
      entityId: "entity-la",
      metadata: {
        entityIssue: {
          issueId: issue.id,
        },
      },
    }, db);
    transitionTask({
      projectId: PROJECT,
      taskId: sourceTask.id,
      toState: "BLOCKED",
      actor: "system:test",
      verificationRequired: false,
    }, db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for Los Angeles: verification environment blocked",
      createdBy: "workflow-steward",
      assignedTo: "workflow-steward",
      entityType: "jurisdiction",
      entityId: "entity-la",
      kind: "infra",
      origin: "lead_proposal",
      originId: "proposal-1",
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        reasonCode: "verification_environment_blocked",
        mutationCategory: "verification_path",
      },
    }, db);

    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "IN_PROGRESS", actor: "workflow-steward", verificationRequired: false }, db);
    attachEvidence({
      projectId: PROJECT,
      taskId: implementationTask.id,
      type: "output",
      content: "Implemented verifier-path mutation candidate",
      attachedBy: "workflow-steward",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "REVIEW", actor: "workflow-steward" }, db);

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: implementationTask.id,
      verifier: "agent:pm",
      passed: true,
      reason: "Looks good on paper",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("IN_PROGRESS");
    }
    const sourceAfter = getTask(PROJECT, sourceTask.id, db);
    expect(sourceAfter?.state).toBe("BLOCKED");
    const evidence = getTaskEvidence(PROJECT, implementationTask.id, db);
    expect(evidence.at(-1)?.content).toContain("post-condition rerun: failed");
  });

  it("completes a workflow-mutation implementation task only after the post-condition rerun restores the source path", () => {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue({
      entities: {
        jurisdiction: {},
      },
    } as any);
    vi.spyOn(project, "getProjectDir").mockReturnValue("/tmp");

    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "warning", "agent:pm", Date.now(), Date.now());

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: "entity-la",
      issueKey: "missing-rate-period-start-day",
      issueType: "completeness_gap",
      source: "pipeline_health",
      actor: "system:test",
      title: "Missing field: rate_period_start_day",
      fieldName: "rate_period_start_day",
    }, db);
    resolveEntityIssue({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "system:test",
    }, db);

    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Missing field: rate_period_start_day",
      createdBy: "system:test",
      assignedTo: "los-angeles-owner",
      entityType: "jurisdiction",
      entityId: "entity-la",
      metadata: {
        entityIssue: {
          issueId: issue.id,
          rerunOnStates: ["DONE"],
        },
      },
    }, db);
    transitionTask({
      projectId: PROJECT,
      taskId: sourceTask.id,
      toState: "BLOCKED",
      actor: "system:test",
      verificationRequired: false,
    }, db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for Los Angeles: verification environment blocked",
      createdBy: "workflow-steward",
      assignedTo: "workflow-steward",
      entityType: "jurisdiction",
      entityId: "entity-la",
      kind: "infra",
      origin: "lead_proposal",
      originId: "proposal-2",
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        reasonCode: "verification_environment_blocked",
        mutationCategory: "verification_path",
      },
    }, db);

    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "IN_PROGRESS", actor: "workflow-steward", verificationRequired: false }, db);
    attachEvidence({
      projectId: PROJECT,
      taskId: implementationTask.id,
      type: "output",
      content: "Implemented verifier-path mutation candidate",
      attachedBy: "workflow-steward",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "REVIEW", actor: "workflow-steward" }, db);

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: implementationTask.id,
      verifier: "agent:pm",
      passed: true,
      reason: "Verified and rerun path restored",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("DONE");
      expect((result.task.metadata as Record<string, unknown>)?.workflowMutationPostCondition).toBeTruthy();
    }
  });

  it("completes a workflow-mutation implementation task when the rerun reopens the source task itself", () => {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue({
      entities: {
        jurisdiction: {},
      },
    } as any);
    vi.spyOn(project, "getProjectDir").mockReturnValue("/tmp");

    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "warning", "agent:pm", Date.now(), Date.now());

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: "entity-la",
      issueKey: "failed-bulletin-source",
      issueType: "extraction_failure",
      source: "pipeline_health",
      actor: "system:test",
      title: "Source failed but current value survives",
    }, db);

    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: failed bulletin source",
      createdBy: "system:test",
      assignedTo: "los-angeles-owner",
      entityType: "jurisdiction",
      entityId: "entity-la",
      metadata: {
        entityIssue: {
          issueId: issue.id,
          rerunOnStates: ["DONE"],
        },
      },
    }, db);
    transitionTask({ projectId: PROJECT, taskId: sourceTask.id, toState: "IN_PROGRESS", actor: "los-angeles-owner", verificationRequired: false }, db);
    attachEvidence({
      projectId: PROJECT,
      taskId: sourceTask.id,
      type: "output",
      content: "Narrowed the extraction failure but issue still open",
      attachedBy: "los-angeles-owner",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: sourceTask.id, toState: "DONE", actor: "los-angeles-owner" }, db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for Los Angeles: workflow gap",
      createdBy: "workflow-steward",
      assignedTo: "workflow-steward",
      entityType: "jurisdiction",
      entityId: "entity-la",
      kind: "infra",
      origin: "lead_proposal",
      originId: "proposal-3",
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        sourceIssueId: issue.id,
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
      },
    }, db);

    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "IN_PROGRESS", actor: "workflow-steward", verificationRequired: false }, db);
    attachEvidence({
      projectId: PROJECT,
      taskId: implementationTask.id,
      type: "output",
      content: "Updated workflow routing docs",
      attachedBy: "workflow-steward",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: implementationTask.id, toState: "REVIEW", actor: "workflow-steward" }, db);

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: implementationTask.id,
      verifier: "agent:pm",
      passed: true,
      reason: "Looks good, but the rerun must restore an active remediation path",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("DONE");
      expect((result.task.metadata as Record<string, unknown>)?.workflowMutationPostCondition).toBeTruthy();
    }
    const evidence = getTaskEvidence(PROJECT, implementationTask.id, db);
    expect(evidence.at(-1)?.content).toContain("post-condition rerun: passed");
    expect(evidence.at(-1)?.content).toContain("Source task state after rerun: IN_PROGRESS");
  });
});
