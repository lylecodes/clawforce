/**
 * Tests for the Attention Item Builder.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { buildAttentionSummary, buildDecisionInboxSummary } from "../../src/attention/builder.js";

// We use a real in-memory SQLite DB (with full schema) for these tests,
// so we don't have to mock the DB layer. We do mock higher-level functions
// that are expensive or hard to set up (approval resolver, budget-windows, safety).

// Mock: approval/resolve
let _pendingProposals: Array<{
  id: string;
  title: string;
  description: string | null;
  proposed_by: string;
  risk_tier: string | null;
  origin?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  reasoning?: string | null;
  created_at?: number;
}> = [];

vi.mock("../../src/approval/resolve.js", () => ({
  listPendingProposals: vi.fn(() => _pendingProposals),
}));

// Mock: budget-windows
let _budgetStatus: Record<string, unknown> = { alerts: [] };

vi.mock("../../src/budget-windows.js", () => ({
  getBudgetStatus: vi.fn(() => _budgetStatus),
}));

// Mock: safety
let _emergencyStop = false;

vi.mock("../../src/safety.js", () => ({
  isEmergencyStopActive: vi.fn(() => _emergencyStop),
}));

// Mock: tasks/ops — only needed for REVIEW state detection
let _reviewTasks: Array<{ id: string; title: string | null; assignedTo: string | null }> = [];

vi.mock("../../src/tasks/ops.js", () => ({
  listTasks: vi.fn((projectId: string, filters?: { state?: string }) => {
    if (filters?.state === "REVIEW") return _reviewTasks;
    return [];
  }),
}));

// Mock: history/store
let _recentChanges: Array<{ id: string; projectId: string; resourceType: string; resourceId: string; action: string; provenance: string; actor: string; before: null; after: null; reversible: boolean; createdAt: number }> = [];

vi.mock("../../src/history/store.js", () => ({
  listRecentChanges: vi.fn(() => _recentChanges),
  ensureHistoryTable: vi.fn(),
}));

// We import getMemoryDb to get a real DB (with schema) to pass to buildAttentionSummary
import { getMemoryDb } from "../../src/db.js";
import { createEntity, recordEntityIssue } from "../../src/entities/ops.js";
import { registerWorkforceConfig, resetEnforcementConfigForTest } from "../../src/project.js";

const PROJECT_ID = "test-project";

function freshDb(): DatabaseSync {
  return getMemoryDb();
}

// Helper to insert a task into the DB
function insertTask(
  db: DatabaseSync,
  opts: {
    id: string;
    state: string;
    title?: string;
    deadline?: number;
    updatedAt?: number;
    assignedTo?: string | null;
    origin?: string | null;
    originId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at,
      origin, origin_id, entity_type, entity_id, metadata
    ) VALUES (?, ?, ?, ?, 'P2', ?, 'test', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    PROJECT_ID,
    opts.title ?? opts.id,
    opts.state,
    opts.assignedTo ?? null,
    now,
    opts.updatedAt ?? now,
    opts.origin ?? null,
    opts.originId ?? null,
    opts.entityType ?? null,
    opts.entityId ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  );
  if (opts.deadline !== undefined) {
    db.prepare(
      "UPDATE tasks SET deadline = ? WHERE id = ? AND project_id = ?",
    ).run(opts.deadline, opts.id, PROJECT_ID);
  }
}

// Helper to insert a cost record
function insertCost(db: DatabaseSync, taskId: string, costCents: number): void {
  db.prepare(
    `INSERT INTO cost_records (id, project_id, agent_id, task_id, cost_cents, input_tokens, output_tokens, model, created_at)
     VALUES (?, ?, 'agent1', ?, ?, 0, 0, 'test-model', ?)`,
  ).run(`cost-${Math.random()}`, PROJECT_ID, taskId, costCents, Date.now());
}

// Helper to insert an unread user-addressed message
function insertUnreadMessage(
  db: DatabaseSync,
  id: string,
  opts?: { fromAgent?: string; priority?: string; metadata?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO messages (id, project_id, from_agent, to_agent, type, priority, content, status, created_at, metadata)
     VALUES (?, ?, ?, 'user', 'info', ?, 'hello', 'delivered', ?, ?)`,
  ).run(
    id,
    PROJECT_ID,
    opts?.fromAgent ?? "agent1",
    opts?.priority ?? "normal",
    Date.now(),
    opts?.metadata ? JSON.stringify(opts.metadata) : null,
  );
}

function insertSimulatedAction(
  db: DatabaseSync,
  id: string,
  opts?: { policyDecision?: string; status?: string; entityId?: string; entityType?: string; taskId?: string; summary?: string; proposalId?: string },
): void {
  db.prepare(
    `INSERT INTO simulated_actions (
      id, project_id, domain_id, agent_id, session_key, task_id,
      entity_type, entity_id, proposal_id, source_type, source_id, action_type,
      target_type, target_id, summary, payload, policy_decision, status,
      created_at, resolved_at
    ) VALUES (?, ?, ?, 'agent1', NULL, ?, ?, ?, ?, 'tool', 'clawforce_config', 'set_section', 'domain', ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    PROJECT_ID,
    PROJECT_ID,
    opts?.taskId ?? null,
    opts?.entityType ?? null,
    opts?.entityId ?? null,
    opts?.proposalId ?? null,
    opts?.entityId ?? PROJECT_ID,
    opts?.summary ?? "Would execute clawforce_config:set_section",
    opts?.policyDecision ?? "simulate",
    opts?.status ?? "simulated",
    Date.now(),
  );
}

// Helper to insert a proposal row directly (bypasses the mock for DB-level tests if needed)
// The proposals are detected via listPendingProposals (mocked above), not by DB query.

beforeEach(() => {
  // Reset mocked state
  _pendingProposals = [];
  _budgetStatus = { alerts: [] };
  _emergencyStop = false;
  _reviewTasks = [];
  _recentChanges = [];
  resetEnforcementConfigForTest();
  registerWorkforceConfig(PROJECT_ID, {
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
        metadataSchema: {},
      },
    },
  });
});

describe("buildAttentionSummary — empty project", () => {
  it("returns zero items and correct shape", () => {
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);
    expect(summary.projectId).toBe(PROJECT_ID);
    expect(summary.items).toHaveLength(0);
    expect(summary.counts.actionNeeded).toBe(0);
    expect(summary.counts.watching).toBe(0);
    expect(summary.counts.fyi).toBe(0);
    expect(typeof summary.generatedAt).toBe("number");
  });
});

describe("buildAttentionSummary — approvals", () => {
  it("pending approval creates an action-needed item", () => {
    _pendingProposals = [
      {
        id: "p1",
        title: "Deploy to prod",
        description: "Risk: HIGH",
        proposed_by: "agent1",
        risk_tier: "HIGH",
        origin: "risk_gate",
        created_at: Date.now(),
      },
    ];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const approvalItems = summary.items.filter((i) => i.category === "approval");
    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0]!.urgency).toBe("action-needed");
    expect(approvalItems[0]!.title).toContain("Deploy to prod");
    expect(approvalItems[0]!.destination).toBe("/approvals");
    expect(approvalItems[0]!.focusContext?.proposalId).toBe("p1");
    expect(approvalItems[0]!.kind).toBe("approval");
    expect(approvalItems[0]!.automationState).toBe("needs_human");
    expect(summary.counts.actionNeeded).toBe(1);
  });

  it("low-risk lead proposals surface as proactive proposals instead of approvals", () => {
    _pendingProposals = [
      {
        id: "p2",
        title: "Add automated drift trend report",
        description: "Recurring warning pattern detected",
        proposed_by: "data-director",
        risk_tier: "low",
        origin: "lead_proposal",
        created_at: Date.now(),
      },
    ];

    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);
    const proposalItem = summary.items.find((item) => item.proposalId === "p2");

    expect(proposalItem).toMatchObject({
      kind: "proposal",
      category: "proposal",
      urgency: "watching",
      automationState: "needs_human",
      proposalId: "p2",
    });

    const decisions = buildDecisionInboxSummary(PROJECT_ID, db);
    expect(decisions.items.find((item) => item.proposalId === "p2")).toBeUndefined();
  });
});

describe("buildAttentionSummary — entity issues", () => {
  it("surfaces open entity issues with entity context", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Payments",
      createdBy: "test",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "payments-rate-limit",
      issueType: "system:rate_limit",
      source: "test",
      severity: "high",
      title: "Rate limit exceeded",
      description: "The upstream API started throttling requests.",
      actor: "test",
      blocking: true,
    }, db);

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      severity: "high",
      urgency: "action-needed",
      entityType: "jurisdiction",
      entityId: entity.id,
      sourceType: "entity_issue",
      sourceId: issue.id,
    });
    expect(issueItem?.title).toContain("Payments");
  });

  it("surfaces blocked reactive remediation as an alert instead of auto-handling", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Bulletin mismatch",
      description: "Bulletin-derived fields need review.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "los-angeles-owner",
    }, db);
    insertTask(db, {
      id: "reactive-1",
      state: "BLOCKED",
      title: "Remediate Los Angeles: Bulletin mismatch",
      assignedTo: "los-angeles-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
      metadata: { stale: 1, stale_since: Date.now() - 60_000 },
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "alert",
      automationState: "blocked_for_agent",
      taskId: "reactive-1",
      entityId: entity.id,
    });
    expect(issueItem?.metadata).toMatchObject({
      remediationTaskId: "reactive-1",
      remediationTaskState: "BLOCKED",
      remediationTaskStale: true,
    });
    expect(issueItem?.recommendedAction).toContain("Review blocked remediation task");
  });

  it("treats a freshly completed reactive remediation as auto-handled while the issue stays open", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "integrity-gate:integrity-flag:flagged",
      issueType: "integrity_flag",
      source: "test",
      severity: "high",
      title: "Integrity gate flagged California",
      description: "California remains flagged pending the next real-world update.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);
    insertTask(db, {
      id: "reactive-done-1",
      state: "DONE",
      title: "Remediate California: Integrity gate flagged California",
      assignedTo: "california-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
      updatedAt: Date.now(),
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      automationState: "auto_handling",
      taskId: "reactive-done-1",
      entityId: entity.id,
    });
    expect(issueItem?.recommendedAction).toContain("already reran verification and completed");
  });

  it("treats active entity-scoped onboarding work as auto-handling even without a reactive remediation task", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Sacramento",
      createdBy: "test",
      ownerAgentId: "data-director",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "onboarding:requested",
      issueType: "onboarding_request",
      source: "state_signal:proposed-onboarding-request",
      severity: "medium",
      title: "Onboarding required for Sacramento",
      description: "Sacramento is still in proposed with no owner coverage.",
      actor: "test",
      blocking: false,
      playbook: "jurisdiction-onboarding",
      ownerAgentId: "data-director",
    }, db);
    insertTask(db, {
      id: "entity-task-1",
      state: "ASSIGNED",
      title: "Create Sacramento owner coverage and bootstrapping scaffold",
      assignedTo: "org-builder",
      entityType: "jurisdiction",
      entityId: entity.id,
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      urgency: "watching",
      automationState: "auto_handling",
      taskId: "entity-task-1",
      entityId: entity.id,
    });
    expect(issueItem?.metadata).toMatchObject({
      remediationTaskId: undefined,
      entityTaskId: "entity-task-1",
      entityTaskState: "ASSIGNED",
      entityTaskAssignedTo: "org-builder",
    });
    expect(issueItem?.recommendedAction).toContain("Create Sacramento owner coverage");
  });

  it("surfaces a completed reactive remediation as human follow-up once the immediate auto-handling window expires", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "integrity-gate:integrity-flag:flagged",
      issueType: "integrity_flag",
      source: "test",
      severity: "high",
      title: "Integrity gate flagged California",
      description: "Integrity finding remains open after rerun.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);

    insertTask(db, {
      id: "reactive-ca-followup",
      state: "DONE",
      title: "Remediate California: Integrity gate flagged California",
      assignedTo: "california-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
      updatedAt: now - (16 * 60 * 1000),
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      urgency: "action-needed",
      automationState: "needs_human",
      taskId: "reactive-ca-followup",
    });
    expect(issueItem?.recommendedAction).toContain("reran verification and completed");
    expect(issueItem?.recommendedAction).toContain("Decide whether to reopen owner remediation");
  });

  it("tracks approved workflow-mutation follow-up instead of reopening blind remediation", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:extraction-failure",
      issueType: "extraction_failure",
      source: "test",
      severity: "medium",
      title: "LA bulletin extraction failed",
      description: "Repeated narrowed remediations did not resolve the source drift.",
      actor: "test",
      blocking: true,
      playbook: "source-onboarding",
      ownerAgentId: "los-angeles-owner",
    }, db);

    insertTask(db, {
      id: "workflow-mutation-1",
      state: "ASSIGNED",
      title: "Restructure workflow for Los Angeles: repeated extraction_failure remediation loop",
      assignedTo: "workflow-steward",
      origin: "lead_proposal",
      originId: "proposal-loop-1",
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, execution_status, execution_requested_at, execution_updated_at,
        execution_task_id, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, NULL)
    `).run(
      "proposal-loop-1",
      PROJECT_ID,
      "Workflow mutation review: repeated unresolved extraction_failure loop for Los Angeles",
      "Approved workflow mutation",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-old",
        sourceTaskTitle: "Remediate Los Angeles",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 2,
        stewardTask: {
          title: "Restructure workflow for Los Angeles: repeated extraction_failure remediation loop",
          description: "Pause the blind remediation loop and restructure it.",
          priority: "P1",
          kind: "infra",
        },
      }),
      "medium",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      entity.id,
      "workflow_mutation",
      JSON.stringify({ source: "entity_remediation_loop", issueId: issue.id }),
      now - 1_000,
      now - 1_000,
      "workflow-mutation-1",
    );
    db.prepare(`UPDATE entity_issues SET proposal_id = ? WHERE project_id = ? AND id = ?`)
      .run("proposal-loop-1", PROJECT_ID, issue.id);

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      automationState: "auto_handling",
      proposalId: "proposal-loop-1",
      entityId: entity.id,
    });
    expect(issueItem?.recommendedAction).toContain("workflow mutation task");
    expect(issueItem?.recommendedAction).toContain("Restructure workflow for Los Angeles");
  });

  it("surfaces failed approved workflow-mutation execution against the steward task", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "San Francisco",
      createdBy: "test",
      ownerAgentId: "san-francisco-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Bulletin mismatch",
      description: "Verifier path needs workflow mutation follow-through.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "san-francisco-owner",
    }, db);

    insertTask(db, {
      id: "reactive-sf",
      state: "BLOCKED",
      title: "Remediate San Francisco: Bulletin mismatch",
      assignedTo: "san-francisco-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    insertTask(db, {
      id: "workflow-mutation-sf",
      state: "IN_PROGRESS",
      title: "Restructure workflow for San Francisco: verification environment blocked",
      assignedTo: "workflow-steward",
      origin: "lead_proposal",
      originId: "proposal-sf",
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, execution_status, execution_requested_at, execution_updated_at,
        execution_task_id, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
    `).run(
      "proposal-sf",
      PROJECT_ID,
      "Workflow mutation review: repeated verification environment blocked for San Francisco",
      "Approved workflow mutation",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-sf",
        sourceTaskTitle: "Remediate San Francisco: Bulletin mismatch",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
      }),
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      entity.id,
      "workflow_mutation",
      JSON.stringify({ source: "verification_environment_blocked", issueId: issue.id }),
      now - 1_000,
      now - 1_000,
      "workflow-mutation-sf",
    );
    db.prepare(`
      INSERT INTO dispatch_queue (
        id, project_id, task_id, priority, payload, status, dispatch_attempts, max_dispatch_attempts, last_error, created_at, completed_at
      ) VALUES (?, ?, ?, 1, NULL, 'failed', 1, 3, ?, ?, ?)
    `).run(
      "dq-sf-failed",
      PROJECT_ID,
      "workflow-mutation-sf",
      "Task remained in IN_PROGRESS after inline dispatch: Inline dispatch returned no summary",
      now - 500,
      now - 100,
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "alert",
      automationState: "blocked_for_agent",
      taskId: "workflow-mutation-sf",
      proposalId: "proposal-sf",
      entityId: entity.id,
    });
    expect(issueItem?.metadata).toMatchObject({
      workflowMutationExecutionTaskId: "workflow-mutation-sf",
      workflowMutationExecutionTaskState: "IN_PROGRESS",
      workflowMutationExecutionQueueStatus: "failed",
      workflowMutationExecutionQueueError: "Task remained in IN_PROGRESS after inline dispatch: Inline dispatch returned no summary.",
    });
  expect(issueItem?.recommendedAction).toContain("Recover workflow mutation task");
  expect(issueItem?.recommendedAction).toContain("Inline dispatch returned no summary");
  });

  it("tracks the active workflow-mutation follow-up task instead of the stale blocked execution task", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Repeated semantic mismatch across jurisdictions",
      description: "Verifier path needs workflow mutation follow-through.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);

    insertTask(db, {
      id: "reactive-ca",
      state: "BLOCKED",
      title: "Remediate California: semantic mismatch",
      assignedTo: "california-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    insertTask(db, {
      id: "workflow-mutation-ca",
      state: "BLOCKED",
      title: "Implement workflow mutation for California",
      assignedTo: "workflow-steward",
      origin: "lead_proposal",
      originId: "proposal-ca",
      entityType: "jurisdiction",
      entityId: entity.id,
      metadata: {
        sourceTaskId: "reactive-ca",
        mutationCategory: "workflow_routing",
      },
    });
    insertTask(db, {
      id: "workflow-mutation-ca-follow-up",
      state: "IN_PROGRESS",
      title: "Restructure workflow for Implement workflow mutation for California: verification environment blocked",
      assignedTo: "workflow-steward",
      origin: "lead_proposal",
      originId: "proposal-ca-follow-up",
      entityType: "jurisdiction",
      entityId: entity.id,
      metadata: {
        sourceTaskId: "workflow-mutation-ca",
        mutationCategory: "verification_path",
      },
    });
    db.prepare(`
      INSERT INTO tracked_sessions (
        session_key, project_id, agent_id, requirements, satisfied, dispatch_context, started_at, last_persisted_at, tool_call_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      "dispatch:workflow-mutation-ca-follow-up",
      PROJECT_ID,
      "workflow-steward",
      "[]",
      "{}",
      JSON.stringify({ taskId: "workflow-mutation-ca-follow-up" }),
      now - 10_000,
      now - 1_000,
    );
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, execution_status, execution_requested_at, execution_updated_at,
        execution_task_id, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, NULL)
    `).run(
      "proposal-ca",
      PROJECT_ID,
      "Workflow mutation review: repeated semantic mismatch for California",
      "Approved workflow mutation",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-ca",
        sourceTaskTitle: "Remediate California: semantic mismatch",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
      }),
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      entity.id,
      "workflow_mutation",
      JSON.stringify({ source: "semantic_mismatch", issueId: issue.id }),
      now - 1_000,
      now - 1_000,
      "workflow-mutation-ca",
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      automationState: "auto_handling",
      taskId: "workflow-mutation-ca-follow-up",
      proposalId: "proposal-ca",
      entityId: entity.id,
    });
    expect(issueItem?.metadata).toMatchObject({
      workflowMutationExecutionTaskId: "workflow-mutation-ca",
      workflowMutationExecutionTaskState: "BLOCKED",
      workflowMutationFollowUpExecutionTaskId: "workflow-mutation-ca-follow-up",
      workflowMutationFollowUpExecutionTaskState: "IN_PROGRESS",
    });
    expect(issueItem?.recommendedAction).toContain("Restructure workflow for Implement workflow mutation for California");
    expect(issueItem?.recommendedAction).toContain("restores the verifier path");
  });

  it("summarizes raw workflow-mutation launch transcripts instead of dumping them into the feed", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Repeated semantic mismatch across jurisdictions",
      description: "Verifier path needs a workflow mutation rerun.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);

    insertTask(db, {
      id: "reactive-ca",
      state: "BLOCKED",
      title: "Remediate California: semantic mismatch",
      assignedTo: "california-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    insertTask(db, {
      id: "workflow-mutation-ca",
      state: "ASSIGNED",
      title: "Implement workflow mutation for California",
      assignedTo: "workflow-steward",
      origin: "lead_proposal",
      originId: "proposal-ca",
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, execution_status, execution_requested_at, execution_updated_at,
        execution_task_id, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
    `).run(
      "proposal-ca",
      PROJECT_ID,
      "Workflow mutation review: repeated semantic mismatch for California",
      "Approved workflow mutation",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-ca",
        sourceTaskTitle: "Remediate California: semantic mismatch",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
      }),
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      entity.id,
      "workflow_mutation",
      JSON.stringify({ source: "semantic_mismatch", issueId: issue.id }),
      now - 1_000,
      now - 1_000,
      "workflow-mutation-ca",
    );
    db.prepare(`
      INSERT INTO dispatch_queue (
        id, project_id, task_id, priority, payload, status, dispatch_attempts, max_dispatch_attempts, last_error, created_at, completed_at
      ) VALUES (?, ?, ?, 1, NULL, 'failed', 1, 3, ?, ?, ?)
    `).run(
      "dq-ca-failed",
      PROJECT_ID,
      "workflow-mutation-ca",
      `Reading additional input from stdin...
OpenAI Codex v0.118.0 (research preview)
--------
user
<system_context>
Very long launch transcript body
</system_context>
tokens used
145,706`,
      now - 500,
      now - 100,
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem?.recommendedAction).toContain("Recover workflow mutation task");
    expect(issueItem?.recommendedAction).toContain("raw Codex launch transcript");
    expect(issueItem?.recommendedAction).not.toContain("<system_context>");
    expect(issueItem?.metadata).toMatchObject({
      workflowMutationExecutionQueueError: "Captured queue error is a raw Codex launch transcript rather than a concise dispatch failure. Inspect session archives for full details.",
    });
  });

  it("keeps pending workflow-mutation-linked issues out of the decision inbox", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Repeated semantic mismatch across jurisdictions",
      description: "This should be reviewed as one workflow mutation proposal.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);

    insertTask(db, {
      id: "reactive-pending-wm",
      state: "BLOCKED",
      title: "Remediate California: semantic mismatch",
      assignedTo: "california-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
    });
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      "proposal-cross-entity",
      PROJECT_ID,
      "Workflow mutation review: repeated semantic_mismatch pattern across 4 jurisdictions",
      "Pending workflow mutation review",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-pending-wm",
        sourceTaskTitle: "Remediate California: semantic mismatch",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 4,
        stewardTask: {
          title: "Restructure workflow for repeated semantic_mismatch across 4 jurisdictions",
          description: "Consolidate the repeated issue pattern.",
          priority: "P1",
          kind: "infra",
        },
      }),
      "high",
      now,
      "jurisdiction",
      null,
      "workflow_mutation",
      JSON.stringify({ source: "cross_entity_issue_pattern", issueType: issue.issueType, issueTitle: issue.title }),
    );
    db.prepare(`UPDATE entity_issues SET proposal_id = ? WHERE project_id = ? AND id = ?`)
      .run("proposal-cross-entity", PROJECT_ID, issue.id);
    _pendingProposals = [
      {
        id: "proposal-cross-entity",
        title: "Workflow mutation review: repeated semantic_mismatch pattern across 4 jurisdictions",
        description: "Pending workflow mutation review",
        proposed_by: "workflow-steward",
        risk_tier: "high",
        origin: "workflow_mutation",
        created_at: now,
      },
    ];

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);
    const proposalItem = summary.items.find((item) => item.proposalId === "proposal-cross-entity" && item.sourceType === "proposal");
    const decisionSummary = buildDecisionInboxSummary(PROJECT_ID, db);

    expect(issueItem).toMatchObject({
      kind: "issue",
      urgency: "watching",
      automationState: "needs_human",
      proposalId: "proposal-cross-entity",
    });
    expect(proposalItem).toMatchObject({
      kind: "approval",
      urgency: "action-needed",
      proposalId: "proposal-cross-entity",
    });
    expect(decisionSummary.items).toHaveLength(1);
    expect(decisionSummary.items[0]!.proposalId).toBe("proposal-cross-entity");
  });

  it("keeps approved workflow-mutation-linked issues out of the decision inbox while execution is pending", () => {
    const db = freshDb();
    const now = Date.now();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:semantic-mismatch-approved",
      issueType: "semantic_mismatch",
      source: "test",
      severity: "medium",
      title: "Repeated semantic mismatch across jurisdictions",
      description: "Approved workflow mutation should keep this out of the decision inbox.",
      actor: "test",
      blocking: true,
      playbook: "integrity-remediation",
      ownerAgentId: "california-owner",
    }, db);

    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      "proposal-cross-entity-approved",
      PROJECT_ID,
      "Workflow mutation review: repeated semantic_mismatch pattern across 3 jurisdictions",
      "Approved workflow mutation review",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "reactive-pending-wm",
        sourceTaskTitle: "Remediate California: semantic mismatch",
        sourceIssueId: issue.id,
        stewardAgentId: "workflow-steward",
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 3,
      }),
      "high",
      now - 2_000,
      now - 1_000,
      "jurisdiction",
      null,
      "workflow_mutation",
      JSON.stringify({ source: "cross_entity_issue_pattern", issueType: issue.issueType, issueTitle: issue.title }),
    );
    db.prepare(`UPDATE entity_issues SET proposal_id = ? WHERE project_id = ? AND id = ?`)
      .run("proposal-cross-entity-approved", PROJECT_ID, issue.id);

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);
    const decisionSummary = buildDecisionInboxSummary(PROJECT_ID, db);

    expect(issueItem).toMatchObject({
      kind: "issue",
      urgency: "watching",
      automationState: "auto_handling",
      proposalId: "proposal-cross-entity-approved",
    });
    expect(issueItem?.recommendedAction).toContain("approved workflow mutation");
    expect(decisionSummary.items.find((item) => item.issueId === issue.id)).toBeUndefined();
  });

  it("surfaces dead-lettered reactive remediation as an alert", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:completeness-gap:rate-period-start-day",
      issueType: "completeness_gap",
      source: "test",
      severity: "medium",
      title: "Missing field",
      description: "A required field is missing.",
      actor: "test",
      blocking: true,
      playbook: "jurisdiction-onboarding",
      ownerAgentId: "los-angeles-owner",
    }, db);
    insertTask(db, {
      id: "reactive-dead-letter",
      state: "ASSIGNED",
      title: "Remediate Los Angeles: Missing field",
      assignedTo: "los-angeles-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
      metadata: { "$.dispatch_dead_letter": true, "$.dispatch_dead_letter_at": Date.now() },
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "alert",
      automationState: "blocked_for_agent",
      taskId: "reactive-dead-letter",
      entityId: entity.id,
    });
    expect(issueItem?.metadata).toMatchObject({
      remediationTaskId: "reactive-dead-letter",
      remediationTaskState: "ASSIGNED",
      remediationTaskDeadLetter: true,
    });
  });

  it("marks review-state remediation as needing human follow-up", () => {
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "pipeline-health:completeness-gap:rate-period-start-day",
      issueType: "completeness_gap",
      source: "test",
      severity: "medium",
      title: "Missing field",
      description: "A required field is missing.",
      actor: "test",
      blocking: false,
      playbook: "jurisdiction-onboarding",
      ownerAgentId: "los-angeles-owner",
    }, db);
    insertTask(db, {
      id: "reactive-review",
      state: "REVIEW",
      title: "Remediate Los Angeles: Missing field",
      assignedTo: "los-angeles-owner",
      origin: "reactive",
      originId: issue.id,
      entityType: "jurisdiction",
      entityId: entity.id,
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const issueItem = summary.items.find((item) => item.issueId === issue.id);

    expect(issueItem).toMatchObject({
      kind: "issue",
      automationState: "needs_human",
      taskId: "reactive-review",
      entityId: entity.id,
    });
    expect(issueItem?.recommendedAction).toContain("Review remediation task");
  });
});

describe("buildAttentionSummary — simulated actions", () => {
  it("surfaces simulated actions as feed items and approval-required ones in the decision inbox", () => {
    const db = freshDb();
    insertSimulatedAction(db, "sim-1", { policyDecision: "simulate", status: "simulated" });
    insertSimulatedAction(db, "sim-2", { policyDecision: "require_approval", status: "blocked" });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const simulatedItem = summary.items.find((item) => item.simulatedActionId === "sim-1");
    const approvalItem = summary.items.find((item) => item.simulatedActionId === "sim-2");

    expect(simulatedItem).toMatchObject({
      kind: "info",
      category: "dry_run",
      urgency: "watching",
    });
    expect(approvalItem).toMatchObject({
      kind: "approval",
      category: "dry_run",
      urgency: "action-needed",
    });

    const decisions = buildDecisionInboxSummary(PROJECT_ID, db);
    expect(decisions.items.find((item) => item.simulatedActionId === "sim-2")).toBeDefined();
    expect(decisions.items.find((item) => item.simulatedActionId === "sim-1")).toBeUndefined();
  });

  it("does not duplicate a simulated approval when a pending proposal already exists", () => {
    const db = freshDb();
    const createdAt = Date.now();
    _pendingProposals = [{
      id: "proposal-sim",
      title: "Approve dry-run action",
      description: "Needs approval",
      proposed_by: "agent1",
      risk_tier: "medium",
      origin: "simulated_action",
      created_at: createdAt,
    }];
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      "proposal-sim",
      PROJECT_ID,
      "Approve dry-run action",
      "Needs approval",
      "agent1",
      "medium",
      createdAt,
      "simulated_action",
    );
    insertSimulatedAction(db, "sim-linked", {
      policyDecision: "require_approval",
      status: "blocked",
      proposalId: "proposal-sim",
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    expect(summary.items.filter((item) => item.proposalId === "proposal-sim")).toHaveLength(1);
    expect(summary.items.some((item) => item.simulatedActionId === "sim-linked")).toBe(false);
  });
});

describe("buildDecisionInboxSummary", () => {
  it("keeps approval items and excludes ordinary issue items", () => {
    _pendingProposals = [
      {
        id: "p1",
        title: "Promote Los Angeles",
        description: "Ready for decision",
        proposed_by: "agent1",
        risk_tier: "high",
        origin: "entity_transition",
        created_at: Date.now(),
      },
    ];
    const db = freshDb();
    const entity = createEntity({
      projectId: PROJECT_ID,
      kind: "jurisdiction",
      title: "Search",
      createdBy: "test",
    }, db);
    recordEntityIssue({
      projectId: PROJECT_ID,
      entityId: entity.id,
      issueKey: "search-warning",
      issueType: "system:warning",
      source: "test",
      severity: "medium",
      title: "Search warning",
      actor: "test",
    }, db);

    const summary = buildDecisionInboxSummary(PROJECT_ID, db);

    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]!.kind).toBe("approval");
    expect(summary.items[0]!.proposalId).toBe("p1");
    expect(summary.items[0]!.metadata).toEqual(expect.objectContaining({
      proposedBy: "agent1",
      agentId: "agent1",
      requiresDecision: true,
    }));
    expect(summary.counts.actionNeeded).toBe(1);
    expect(summary.counts.watching).toBe(0);
    expect(summary.counts.fyi).toBe(0);
  });
});

describe("buildAttentionSummary — budget", () => {
  it("budget >90% creates an action-needed item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 950, remainingCents: 50, usedPercent: 95 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("action-needed");
    expect(budgetItems[0]!.title).toContain("95%");
    expect(budgetItems[0]!.destination).toBe("/config");
    expect(budgetItems[0]!.focusContext?.section).toBe("budget");
  });

  it("budget 70-90% creates a watching item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 800, remainingCents: 200, usedPercent: 80 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("watching");
    expect(budgetItems[0]!.title).toContain("80%");
    expect(budgetItems[0]!.destination).toBe("/config");
  });

  it("budget below 70% creates no budget item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 500, remainingCents: 500, usedPercent: 50 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(0);
  });

  it("90% threshold maps to action-needed not watching", () => {
    _budgetStatus = {
      alerts: [],
      hourly: { window: "hourly", limitCents: 100, spentCents: 90, remainingCents: 10, usedPercent: 90 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("action-needed");
  });
});

describe("buildAttentionSummary — recent failed tasks", () => {
  it("recently failed tasks create watching items", () => {
    const db = freshDb();
    const recentlyFailed = Date.now() - 3_600_000; // 1 hour ago
    insertTask(db, { id: "t1", state: "FAILED", title: "Broken task", updatedAt: recentlyFailed });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const taskItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching",
    );
    expect(taskItems.length).toBeGreaterThanOrEqual(1);
    const failedItem = taskItems.find((i) => i.focusContext?.taskId === "t1");
    expect(failedItem).toBeDefined();
    expect(failedItem!.urgency).toBe("watching");
    expect(failedItem!.destination).toBe("/tasks");
  });

  it("recently cancelled tasks do not create failure items", () => {
    const db = freshDb();
    const recentlyCancelled = Date.now() - 3_600_000; // 1 hour ago
    insertTask(db, { id: "t2", state: "CANCELLED", title: "Cancelled task", updatedAt: recentlyCancelled });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const item = summary.items.find((i) => i.focusContext?.taskId === "t2");
    expect(item).toBeUndefined();
  });
});

describe("buildAttentionSummary — completed tasks", () => {
  it("recently completed tasks create fyi items", () => {
    const db = freshDb();
    const recentDone = Date.now() - 3_600_000; // 1 hour ago
    insertTask(db, { id: "t1", state: "DONE", title: "Finished task", updatedAt: recentDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const fyiItems = summary.items.filter((i) => i.urgency === "fyi" && i.category === "task");
    expect(fyiItems.length).toBeGreaterThanOrEqual(1);
    expect(fyiItems[0]!.destination).toBe("/tasks");
    expect(fyiItems[0]!.focusContext?.state).toBe("DONE");
  });

  it("completed tasks older than 24h do not create fyi items", () => {
    const db = freshDb();
    const oldDone = Date.now() - 48 * 3_600_000; // 2 days ago
    insertTask(db, { id: "t3", state: "DONE", title: "Old completed task", updatedAt: oldDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const fyiItems = summary.items.filter((i) => i.urgency === "fyi" && i.category === "task");
    expect(fyiItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — emergency stop", () => {
  it("active kill switch creates action-needed item pointing to /ops", () => {
    _emergencyStop = true;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const healthItems = summary.items.filter((i) => i.category === "health" && i.urgency === "action-needed");
    expect(healthItems).toHaveLength(1);
    expect(healthItems[0]!.destination).toBe("/ops");
    expect(healthItems[0]!.title).toContain("Emergency stop");
  });

  it("no kill switch means no health action-needed item from that detector", () => {
    _emergencyStop = false;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const killItems = summary.items.filter(
      (i) => i.category === "health" && i.urgency === "action-needed" && i.title.includes("Emergency"),
    );
    expect(killItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — stale tasks past deadline", () => {
  it("tasks past deadline create action-needed items", () => {
    const db = freshDb();
    const pastDeadline = Date.now() - 2 * 3_600_000; // 2 hours ago
    insertTask(db, { id: "t-overdue", state: "IN_PROGRESS", title: "Late task", deadline: pastDeadline });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const overdueItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "action-needed" && i.focusContext?.taskId === "t-overdue",
    );
    expect(overdueItems).toHaveLength(1);
    expect(overdueItems[0]!.destination).toBe("/tasks");
    expect(overdueItems[0]!.title).toContain("Overdue");
  });
});

describe("buildAttentionSummary — high cost running tasks", () => {
  it("running task with cost >$1 creates watching item", () => {
    const db = freshDb();
    insertTask(db, { id: "t-expensive", state: "IN_PROGRESS", title: "Pricey task" });
    insertCost(db, "t-expensive", 150); // $1.50

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const costItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching" && i.focusContext?.taskId === "t-expensive",
    );
    expect(costItems).toHaveLength(1);
    expect(costItems[0]!.destination).toBe("/tasks");
    expect(costItems[0]!.title).toContain("High-cost");
  });

  it("running task with cost ≤$1 does not create high-cost item", () => {
    const db = freshDb();
    insertTask(db, { id: "t-cheap", state: "IN_PROGRESS", title: "Cheap task" });
    insertCost(db, "t-cheap", 50); // $0.50

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const costItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching" && i.focusContext?.taskId === "t-cheap",
    );
    expect(costItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — unread messages", () => {
  it("unread messages addressed to user create feed items plus a queue summary", () => {
    const db = freshDb();
    insertUnreadMessage(db, "msg-1");
    insertUnreadMessage(db, "msg-2");

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const commsItems = summary.items.filter((i) => i.category === "comms" && i.sourceType === "message");
    expect(commsItems).toHaveLength(2);
    expect(commsItems[0]!.destination).toBe("/comms");
    expect(commsItems[0]!.urgency).toBe("watching");

    const queueItem = summary.items.find((i) => i.category === "comms" && i.metadata?.count === 2 && i.urgency === "watching");
    expect(queueItem).toBeDefined();
  });

  it("proposal-linked unread messages surface as approval items", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      "proposal-123",
      PROJECT_ID,
      "Review risky change",
      "Needs approval",
      "lead",
      "high",
      Date.now(),
      "risk_gate",
    );
    insertUnreadMessage(db, "msg-proposal", {
      priority: "high",
      metadata: { proposalId: "proposal-123" },
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const proposalMessage = summary.items.find((item) => item.sourceId === "msg-proposal");

    expect(proposalMessage).toMatchObject({
      kind: "approval",
      urgency: "action-needed",
      proposalId: "proposal-123",
      destination: "/comms",
    });
  });

  it("proposal-linked unread messages inherit proactive proposal classification", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      "proposal-proactive",
      PROJECT_ID,
      "Codify LA semantic downgrade",
      "A repeat semantic mismatch could be automated",
      "data-director",
      "low",
      Date.now(),
      "lead_proposal",
    );
    insertUnreadMessage(db, "msg-proactive", {
      metadata: { proposalId: "proposal-proactive" },
    });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const messageItem = summary.items.find((item) => item.sourceId === "msg-proactive");
    expect(messageItem).toMatchObject({
      kind: "proposal",
      urgency: "watching",
      proposalId: "proposal-proactive",
    });

    const decisions = buildDecisionInboxSummary(PROJECT_ID, db);
    expect(decisions.items.find((item) => item.sourceId === "msg-proactive")).toBeUndefined();
  });
});

describe("buildAttentionSummary — REVIEW task detection", () => {
  it("tasks in REVIEW state create action-needed items", () => {
    _reviewTasks = [{ id: "t-review", title: "Needs review", assignedTo: "agent1" }];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const reviewItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "action-needed" && i.focusContext?.taskId === "t-review",
    );
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]!.destination).toBe("/tasks");
    expect(reviewItems[0]!.title).toContain("review");
  });
});

describe("buildAttentionSummary — approved mutations awaiting execution", () => {
  it("surfaces approved workflow mutations that were handled but never applied", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, execution_status, execution_requested_at, execution_updated_at,
        execution_required_generation, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)`,
    ).run(
      "proposal-handled-not-applied",
      PROJECT_ID,
      "Restructure LA verification path",
      "Approved by operator",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        sourceTaskId: "task-la",
        stewardAgentId: "workflow-steward",
      }),
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      "entity-la",
      "workflow_mutation",
      "Repeated verification_environment_blocked",
      now - 1_000,
      now - 1_000,
      "gen-current",
    );
    db.prepare(
      `INSERT INTO tasks (
        id, project_id, title, description, state, priority, assigned_to, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'REVIEW', 'P2', 'los-angeles-owner', 'agent:test', ?, ?)`,
    ).run("task-la", PROJECT_ID, "Remediate Los Angeles", now - 10_000, now - 10_000);
    db.prepare(
      `INSERT INTO events (
        id, project_id, type, source, payload, dedup_key, status, created_at, processed_at
      ) VALUES (?, ?, 'proposal_approved', 'internal', ?, ?, 'handled', ?, ?)`,
    ).run(
      "event-handled-not-applied",
      PROJECT_ID,
      JSON.stringify({ proposalId: "proposal-handled-not-applied" }),
      "proposal-approved:proposal-handled-not-applied",
      now - 900,
      now - 800,
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const item = summary.items.find((entry) => entry.proposalId === "proposal-handled-not-applied");

    expect(item).toMatchObject({
      kind: "info",
      urgency: "watching",
      automationState: "auto_handling",
      title: expect.stringContaining("awaiting execution"),
    });
    expect(item?.metadata?.executionStatus).toBe("pending");
    expect(item?.metadata?.eventStatus).toBe("handled");
  });

  it("surfaces approved proposals that are still queued for controller execution", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "proposal-awaiting",
      PROJECT_ID,
      "Restructure LA verification path",
      "Queued after approval",
      "workflow-steward",
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      "entity-la",
      "workflow_mutation",
      "Repeated verification_environment_blocked",
    );
    db.prepare(
      `INSERT INTO events (
        id, project_id, type, source, payload, dedup_key, status, created_at, processed_at
      ) VALUES (?, ?, 'proposal_approved', 'internal', ?, ?, 'pending', ?, NULL)`,
    ).run(
      "event-awaiting",
      PROJECT_ID,
      JSON.stringify({ proposalId: "proposal-awaiting" }),
      "proposal-approved:proposal-awaiting",
      now,
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const item = summary.items.find((entry) => entry.proposalId === "proposal-awaiting");

    expect(item).toMatchObject({
      kind: "info",
      urgency: "watching",
      automationState: "auto_handling",
      title: expect.stringContaining("awaiting execution"),
    });
    expect(item?.metadata?.eventStatus).toBe("pending");
  });

  it("escalates approved proposals when a stale controller generation still owns the domain", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning, related_goal_id
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "proposal-handoff",
      PROJECT_ID,
      "Restructure SF verification path",
      "Approved but blocked on old controller",
      "workflow-steward",
      "high",
      now - 5_000,
      now - 1_000,
      "jurisdiction",
      "entity-sf",
      "workflow_mutation",
      "Repeated verification_environment_blocked",
    );
    db.prepare(
      `INSERT INTO events (
        id, project_id, type, source, payload, dedup_key, status, created_at, processed_at
      ) VALUES (?, ?, 'proposal_approved', 'internal', ?, ?, 'pending', ?, NULL)`,
    ).run(
      "event-handoff",
      PROJECT_ID,
      JSON.stringify({ proposalId: "proposal-handoff" }),
      "proposal-approved:proposal-handoff",
      now,
    );
    db.prepare(
      `INSERT INTO controller_leases (
        project_id, owner_id, owner_label, purpose, acquired_at, heartbeat_at, expires_at,
        generation, required_generation, generation_requested_at, generation_request_reason, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_ID,
      "controller:old",
      "old-controller",
      "lifecycle",
      now - 10_000,
      now - 2_000,
      now + 60_000,
      "gen-old",
      "gen-new",
      now - 1_500,
      "proposal_approved:proposal-handoff",
      JSON.stringify({}),
    );

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const item = summary.items.find((entry) => entry.proposalId === "proposal-handoff");

    expect(item).toMatchObject({
      kind: "alert",
      urgency: "action-needed",
      automationState: "blocked_for_agent",
      title: expect.stringContaining("awaiting controller handoff"),
    });
    expect(item?.recommendedAction).toContain("restart");
  });
});

describe("buildAttentionSummary — counts accuracy", () => {
  it("counts match item urgency distribution", () => {
    // action-needed: 1 approval + 1 budget (>90%)
    _pendingProposals = [{ id: "p1", title: "X", description: null, proposed_by: "a", risk_tier: null, origin: "risk_gate", created_at: Date.now() }];
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 100, spentCents: 95, remainingCents: 5, usedPercent: 95 },
    };

    const db = freshDb();

    // watching: 1 recently failed task
    const recentlyFailed = Date.now() - 3_600_000;
    insertTask(db, { id: "tf", state: "FAILED", title: "Failed", updatedAt: recentlyFailed });

    // fyi: 1 recently completed task
    const recentDone = Date.now() - 3_600_000;
    insertTask(db, { id: "td", state: "DONE", title: "Done", updatedAt: recentDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);

    // Verify counts match actual items
    expect(summary.counts.actionNeeded).toBe(
      summary.items.filter((i) => i.urgency === "action-needed").length,
    );
    expect(summary.counts.watching).toBe(
      summary.items.filter((i) => i.urgency === "watching").length,
    );
    expect(summary.counts.fyi).toBe(
      summary.items.filter((i) => i.urgency === "fyi").length,
    );

    // At minimum: 1 approval + 1 budget action-needed
    expect(summary.counts.actionNeeded).toBeGreaterThanOrEqual(2);
    // At minimum: 1 failed task watching
    expect(summary.counts.watching).toBeGreaterThanOrEqual(1);
    // At minimum: 1 completed task fyi
    expect(summary.counts.fyi).toBeGreaterThanOrEqual(1);
  });
});

describe("buildAttentionSummary — destinations and focusContext", () => {
  it("approval item has correct destination and focusContext", () => {
    _pendingProposals = [{ id: "p99", title: "Risky deploy", description: "desc", proposed_by: "agent", risk_tier: "HIGH", origin: "risk_gate", created_at: Date.now() }];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const ap = summary.items.find((i) => i.category === "approval");
    expect(ap?.destination).toBe("/approvals");
    expect(ap?.focusContext?.proposalId).toBe("p99");
  });

  it("budget item has /config destination and budget section", () => {
    _budgetStatus = {
      alerts: [],
      monthly: { window: "monthly", limitCents: 5000, spentCents: 4600, remainingCents: 400, usedPercent: 92 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const bi = summary.items.find((i) => i.category === "budget");
    expect(bi?.destination).toBe("/config");
    expect(bi?.focusContext?.section).toBe("budget");
  });

  it("emergency stop item has /ops destination", () => {
    _emergencyStop = true;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const hi = summary.items.find((i) => i.category === "health" && i.urgency === "action-needed");
    expect(hi?.destination).toBe("/ops");
  });

  // -------------------------------------------------------------------------
  // Phase C: pending workflow reviews surface through the canonical feed
  // -------------------------------------------------------------------------

  it("pending workflow reviews surface as action-needed approval items", async () => {
    const { createWorkflow } = await import("../../src/workflow.js");
    const { createWorkflowDraftSession } = await import("../../src/workspace/drafts.js");
    const { createWorkflowReviewFromDraft, approveWorkflowReview } = await import("../../src/workspace/reviews.js");

    const db = freshDb();
    const wf = createWorkflow({
      projectId: PROJECT_ID,
      name: "Pipeline",
      phases: [{ name: "Build" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);
    const draftPending = createWorkflowDraftSession({
      projectId: PROJECT_ID,
      workflowId: wf.id,
      title: "Insert verify",
      createdBy: "agent:pm",
      draftWorkflow: {
        name: wf.name,
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "Verify", taskIds: [], gateCondition: "all_done" },
          { name: "Ship", taskIds: [], gateCondition: "all_done" },
        ],
      },
    }, db);
    const pending = createWorkflowReviewFromDraft({
      projectId: PROJECT_ID,
      draftSessionId: draftPending.id,
      confirmedBy: "user",
    }, db)!;

    // Second review that we'll approve — should not show up in pending items.
    const draftResolved = createWorkflowDraftSession({
      projectId: PROJECT_ID,
      workflowId: wf.id,
      title: "Remove ship",
      createdBy: "agent:pm",
      draftWorkflow: {
        name: wf.name,
        phases: [{ name: "Build", taskIds: [], gateCondition: "all_done" }],
      },
    }, db);
    const approved = createWorkflowReviewFromDraft({
      projectId: PROJECT_ID,
      draftSessionId: draftResolved.id,
      confirmedBy: "user",
    }, db)!;
    approveWorkflowReview({ projectId: PROJECT_ID, reviewId: approved.record.id, actor: "reviewer" }, db);

    const summary = buildAttentionSummary(PROJECT_ID, db);

    const reviewItems = summary.items.filter(
      (i) => i.sourceType === "workflow_review",
    );
    expect(reviewItems).toHaveLength(1);
    const reviewItem = reviewItems[0]!;
    expect(reviewItem.sourceId).toBe(pending.record.id);
    expect(reviewItem.category).toBe("approval");
    expect(reviewItem.kind).toBe("approval");
    expect(reviewItem.urgency).toBe("action-needed");
    expect(reviewItem.title).toContain("Workflow review:");
    expect(reviewItem.metadata?.reviewId).toBe(pending.record.id);
    expect(reviewItem.metadata?.draftSessionId).toBe(draftPending.id);
    expect(reviewItem.metadata?.workflowId).toBe(wf.id);
    expect(reviewItem.metadata?.requiresDecision).toBe(true);
    expect(reviewItem.destination).toBe(`/workspaces/${PROJECT_ID}/workflows/${wf.id}`);
  });
});
