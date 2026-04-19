import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const { persistToolCallIntent, getIntentByProposalForProject, resolveIntentForProject } = await import("../../src/approval/intent-store.js");
const { addPreApproval, checkPreApproval, consumePreApproval } = await import("../../src/approval/pre-approved.js");
const { approveProposal, rejectProposal, getProposal } = await import("../../src/approval/resolve.js");
const { processEvents } = await import("../../src/events/router.js");
const { evaluateCommandExecution, evaluateToolExecution } = await import("../../src/execution/intercept.js");
const { getSimulatedActionByProposal } = await import("../../src/execution/simulated-actions.js");
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const { processAndDispatch } = await import("../../src/dispatch/dispatcher.js");
const { attachEvidence, createTask, getTask, transitionTask } = await import("../../src/tasks/ops.js");
const { submitVerdict } = await import("../../src/tasks/verify.js");
const { buildAttentionSummary } = await import("../../src/attention/builder.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { acquireControllerLease, getControllerLease, resetControllerIdentityForTest } = await import("../../src/runtime/controller-leases.js");
const { getEntityIssue } = await import("../../src/entities/ops.js");

describe("approval/e2e-flow", () => {
  let db: DatabaseSync;
  const PROJECT = "e2e-approval";
  let tmpDir: string;
  const originalGeneration = process.env.CLAWFORCE_CONTROLLER_GENERATION;

  beforeEach(async () => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = originalGeneration;
    resetControllerIdentityForTest();
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-approval-"));
    registerWorkforceConfig(PROJECT, {
      name: "approval-e2e",
      agents: {
        worker: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performancePolicy: { action: "retry" },
        },
        "workflow-steward": {
          extends: "manager",
          briefing: [],
          expectations: [],
          performancePolicy: { action: "retry" },
        },
      },
      review: {
        workflowSteward: {
          agentId: "workflow-steward",
          autoProposalThreshold: 2,
          autoProposalReasonCodes: ["verification_environment_blocked"],
          proposalCooldownHours: 24,
        },
      },
      execution: {
        mode: "dry_run",
        defaultMutationPolicy: "simulate",
        policies: {
          tools: {
            clawforce_task: {
              actions: {
                transition: "require_approval",
              },
            },
          },
          commands: [
            { match: "node *", effect: "require_approval" },
          ],
        },
      },
    }, tmpDir);
  });

  afterEach(() => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = originalGeneration;
    resetControllerIdentityForTest();
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { db.close(); } catch { /* already closed */ }
  });

  it("full flow: tool gate → proposal → approve → pre-approval → re-dispatch", () => {
    // Step 1: Create a task
    const task = createTask({ projectId: PROJECT, title: "Send email campaign", createdBy: "agent:pm" }, db);
    processEvents(PROJECT, db); // drain task_created event

    // Step 2: Simulate tool gate blocking — create proposal + intent
    const proposalId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(proposalId, PROJECT, "Tool gate: email:send (high)", "mcp:gmail:send call requires approval", "agent:worker", "high", Date.now());

    persistToolCallIntent({
      proposalId,
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: task.id,
      toolName: "mcp:gmail:send",
      toolParams: { to: "user@test.com", body: "Hello" },
      category: "email:send",
      riskTier: "high",
    }, db);

    // Step 3: Approve the proposal
    const approved = approveProposal(PROJECT, proposalId, "Looks good");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");

    // Step 4: Process the proposal_approved event
    const processed = processEvents(PROJECT, db);
    expect(processed).toBeGreaterThan(0);

    // Step 5: Verify intent was resolved as approved
    const intent = getIntentByProposalForProject(PROJECT, proposalId, db);
    expect(intent!.status).toBe("approved");

    // Step 6: Verify pre-approval was created
    const hasPreApproval = checkPreApproval({ projectId: PROJECT, taskId: task.id, toolName: "mcp:gmail:send" }, db);
    expect(hasPreApproval).toBe(true);

    // Step 7: Verify task was re-enqueued
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBeGreaterThanOrEqual(1);
  });

  it("rejection flow: tool gate → proposal → reject → intent rejected", () => {
    const task = createTask({ projectId: PROJECT, title: "Deploy to prod", createdBy: "agent:pm" }, db);
    processEvents(PROJECT, db); // drain

    const proposalId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(proposalId, PROJECT, "Tool gate: deploy:run (critical)", "mcp:deploy:run requires approval", "agent:worker", "critical", Date.now());

    persistToolCallIntent({
      proposalId,
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: task.id,
      toolName: "mcp:deploy:run",
      toolParams: {},
      category: "deploy:run",
      riskTier: "critical",
    }, db);

    // Reject the proposal
    rejectProposal(PROJECT, proposalId, "Too risky");
    processEvents(PROJECT, db);

    // Intent should be rejected
    const intent = getIntentByProposalForProject(PROJECT, proposalId, db);
    expect(intent!.status).toBe("rejected");

    // No pre-approval created
    const hasPreApproval = checkPreApproval({ projectId: PROJECT, taskId: task.id, toolName: "mcp:deploy:run" }, db);
    expect(hasPreApproval).toBe(false);
  });

  it("pre-approval is consumed on use", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-consume",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    // First check + consume works
    expect(checkPreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(true);
    expect(consumePreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(true);

    // Second attempt fails
    expect(checkPreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(false);
    expect(consumePreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(false);
  });

  it("approving a workflow-mutation proposal creates a steward task and blocks the failing source task", () => {
    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "degraded", "agent:pm", Date.now(), Date.now());
    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-oak", PROJECT, "jurisdiction", "Oakland", "shadow", "degraded", "agent:pm", Date.now(), Date.now());

    const issue = {
      id: "issue-la",
      issueType: "verification_environment_blocked",
    };
    const siblingIssue = {
      id: "issue-oak",
      issueType: "verification_environment_blocked",
    };
    db.prepare(`
      INSERT INTO entity_issues (
        id, issue_key, project_id, entity_id, entity_kind, issue_type, source,
        severity, status, title, owner_agent_id, blocking, approval_required,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, 0, ?, ?)
    `).run(
      issue.id,
      "la.workflow.verifier",
      PROJECT,
      "entity-la",
      "jurisdiction",
      issue.issueType,
      "pipeline_health",
      "medium",
      "Verifier environment could not run the decisive check",
      "worker",
      Date.now(),
      Date.now(),
    );
    db.prepare(`
      INSERT INTO entity_issues (
        id, issue_key, project_id, entity_id, entity_kind, issue_type, source,
        severity, status, title, owner_agent_id, blocking, approval_required,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, 0, ?, ?)
    `).run(
      siblingIssue.id,
      "oak.workflow.verifier",
      PROJECT,
      "entity-oak",
      "jurisdiction",
      siblingIssue.issueType,
      "pipeline_health",
      "medium",
      "Verifier environment could not run the decisive check",
      "worker",
      Date.now(),
      Date.now(),
    );

    const task = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Missing field: rate_period_start_day",
      description: "Acceptance criteria:\n- Fix the missing field workflow for Los Angeles.",
      createdBy: "agent:pm",
      assignedTo: "worker",
      entityType: "jurisdiction",
      entityId: "entity-la",
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
    processEvents(PROJECT, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempted fix", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Verifier environment could not run the decisive check",
    }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "log", content: "retry attempt", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Verifier environment could not run the decisive check again",
    }, db);

    const proposal = db.prepare(`
      SELECT id, status
      FROM proposals
      WHERE project_id = ?
        AND origin = 'workflow_mutation'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT) as { id: string; status: string } | undefined;
    expect(proposal?.status).toBe("pending");

    db.prepare(`
      UPDATE proposals
      SET approval_policy_snapshot = json_set(approval_policy_snapshot, '$.affectedIssueIds', json_array(?, ?))
      WHERE id = ? AND project_id = ?
    `).run(issue.id, siblingIssue.id, proposal!.id, PROJECT);

    approveProposal(PROJECT, proposal!.id, "Restructure the workflow", db);
    processEvents(PROJECT, db);

    const stewardTask = db.prepare(`
      SELECT id, title, assigned_to, origin, origin_id
      FROM tasks
      WHERE project_id = ?
        AND origin = 'lead_proposal'
        AND origin_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT, proposal!.id) as { id: string; title: string; assigned_to: string; origin: string; origin_id: string } | undefined;
    expect(stewardTask?.assigned_to).toBe("workflow-steward");
    expect(stewardTask?.title).toContain("Restructure workflow");

    const appliedProposal = getProposal(PROJECT, proposal!.id, db);
    expect(appliedProposal?.execution_status).toBe("applied");
    expect(appliedProposal?.execution_task_id).toBe(stewardTask?.id);
    expect(getEntityIssue(PROJECT, issue.id, db)?.proposalId).toBe(proposal!.id);
    expect(getEntityIssue(PROJECT, siblingIssue.id, db)?.proposalId).toBe(proposal!.id);

    const blockedSource = getTask(PROJECT, task.id, db);
    expect(blockedSource?.state).toBe("BLOCKED");
  });

  it("approval follow-on can take over from a stale controller generation", async () => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = "gen-new";
    resetControllerIdentityForTest();

    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-sf", PROJECT, "jurisdiction", "San Francisco", "shadow", "degraded", "agent:pm", Date.now(), Date.now());

    const task = createTask({
      projectId: PROJECT,
      title: "Remediate San Francisco: verification path blocked",
      description: "Acceptance criteria:\n- Fix the verification workflow for San Francisco.",
      createdBy: "agent:pm",
      assignedTo: "worker",
      entityType: "jurisdiction",
      entityId: "entity-sf",
      kind: "bug",
      origin: "reactive",
    }, db);
    processEvents(PROJECT, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempted fix", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Verifier environment could not run the decisive check",
    }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "log", content: "retry attempt", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reasonCode: "verification_environment_blocked",
      reason: "Verifier environment could not run the decisive check again",
    }, db);

    const proposal = db.prepare(`
      SELECT id
      FROM proposals
      WHERE project_id = ?
        AND origin = 'workflow_mutation'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT) as { id: string } | undefined;
    expect(proposal?.id).toBeDefined();

    acquireControllerLease(PROJECT, {
      ownerId: "controller:stale",
      ownerLabel: "stale-controller",
      purpose: "lifecycle",
      ttlMs: 60_000,
      generation: "gen-old",
    }, db);

    approveProposal(PROJECT, proposal!.id, "Apply the workflow fix", db);
    const result = await processAndDispatch(PROJECT, db);

    expect(result.eventsProcessed).toBeGreaterThan(0);

    const stewardTask = db.prepare(`
      SELECT id, assigned_to
      FROM tasks
      WHERE project_id = ?
        AND origin = 'lead_proposal'
        AND origin_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT, proposal!.id) as { id: string; assigned_to: string } | undefined;
    expect(stewardTask?.assigned_to).toBe("workflow-steward");

    const appliedProposal = getProposal(PROJECT, proposal!.id, db);
    expect(appliedProposal?.execution_status).toBe("applied");
    expect(appliedProposal?.execution_task_id).toBe(stewardTask?.id);

    const blockedSource = getTask(PROJECT, task.id, db);
    expect(blockedSource?.state).toBe("BLOCKED");

    const lease = getControllerLease(PROJECT, db);
    expect(lease?.requiredGeneration == null).toBe(true);
  });

  it("accepted workflow-mutation review creates an implementation task and suppresses operator action on the blocked source issue", () => {
    db.prepare(`
      INSERT INTO entities (
        id, project_id, kind, title, state, health, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("entity-la", PROJECT, "jurisdiction", "Los Angeles", "shadow", "warning", "agent:pm", Date.now(), Date.now());

    db.prepare(`
      INSERT INTO entity_issues (
        id, project_id, entity_id, entity_kind, issue_key, issue_type, check_id, severity, status, title, description,
        field_name, blocking, approval_required, playbook, owner_agent_id, evidence, source, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      "issue-la",
      PROJECT,
      "entity-la",
      "jurisdiction",
      "pipeline-health:completeness-gap:rate-period-start-day",
      "completeness_gap",
      "pipeline_health",
      "medium",
      "Missing field: rate_period_start_day",
      "A required field is missing.",
      "rate_period_start_day",
      "jurisdiction-onboarding",
      "los-angeles-owner",
      JSON.stringify({ issue: { field: "rate_period_start_day" } }),
      "test",
      Date.now(),
      Date.now(),
    );

    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Missing field: rate_period_start_day",
      description: "Acceptance criteria:\n- Fix the missing field workflow for Los Angeles.",
      createdBy: "agent:pm",
      assignedTo: "los-angeles-owner",
      entityType: "jurisdiction",
      entityId: "entity-la",
      kind: "bug",
      origin: "reactive",
      originId: "issue-la",
      metadata: {
        entityIssue: {
          issueId: "issue-la",
          issueType: "completeness_gap",
          rerunCheckIds: ["pipeline_health"],
          rerunOnStates: ["DONE"],
          closeTaskOnResolved: true,
        },
      },
    }, db);
    processEvents(PROJECT, db);
    transitionTask({ projectId: PROJECT, taskId: sourceTask.id, toState: "BLOCKED", actor: "system:test", verificationRequired: false }, db);

    const proposalId = crypto.randomUUID();
    const snapshot = {
      replayType: "workflow_mutation",
      stewardAgentId: "workflow-steward",
      sourceTaskId: sourceTask.id,
      sourceTaskTitle: sourceTask.title,
      reasonCode: "verification_environment_blocked",
      mutationCategory: "verification_path",
      failureCount: 4,
      entityType: "jurisdiction",
      entityId: "entity-la",
      entityTitle: "Los Angeles",
      recommendedChanges: ["Provide a DB/socket-capable verifier path."],
      stewardTask: {
        title: "Restructure workflow for Los Angeles: verification environment blocked",
        description: "Investigate the blocked verifier path.",
        priority: "P1",
        kind: "infra",
      },
    } as const;

    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, status, created_at, resolved_at,
        origin, entity_type, entity_id, execution_status, execution_task_id, approval_policy_snapshot
      ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, 'workflow_mutation', ?, ?, 'applied', ?, ?)
    `).run(
      proposalId,
      PROJECT,
      "Workflow mutation review: repeated verification environment blocked for Los Angeles",
      "workflow mutation",
      "workflow-steward",
      Date.now(),
      Date.now(),
      "jurisdiction",
      "entity-la",
      "review-task-la",
      JSON.stringify(snapshot),
    );

    const reviewTask = createTask({
      projectId: PROJECT,
      title: snapshot.stewardTask.title,
      description: "Accepted review task",
      createdBy: "workflow-steward",
      assignedTo: "workflow-steward",
      entityType: "jurisdiction",
      entityId: "entity-la",
      kind: "infra",
      origin: "lead_proposal",
      originId: proposalId,
      metadata: {
        sourceTaskId: sourceTask.id,
        reasonCode: "verification_environment_blocked",
        mutationCategory: "verification_path",
      },
    }, db);
    processEvents(PROJECT, db);
    transitionTask({ projectId: PROJECT, taskId: reviewTask.id, toState: "IN_PROGRESS", actor: "workflow-steward", verificationRequired: false }, db);
    attachEvidence({
      projectId: PROJECT,
      taskId: reviewTask.id,
      type: "output",
      content: "Create a verifier-path follow-up and rerun pipeline_health after it lands.",
      attachedBy: "workflow-steward",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: reviewTask.id, toState: "REVIEW", actor: "workflow-steward" }, db);
    submitVerdict({
      projectId: PROJECT,
      taskId: reviewTask.id,
      verifier: "operator:cli",
      passed: true,
      reason: "Accepted workflow mutation recommendation.",
    }, db);
    processEvents(PROJECT, db);

    const implementationTask = db.prepare(`
      SELECT id, title, description, state, assigned_to, metadata
      FROM tasks
      WHERE project_id = ?
        AND origin = 'lead_proposal'
        AND origin_id = ?
        AND json_extract(metadata, '$.workflowMutationStage') = 'implementation'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT, proposalId) as { id: string; title: string; description: string; state: string; assigned_to: string; metadata: string } | undefined;
    expect(implementationTask?.assigned_to).toBe("workflow-steward");
    expect(implementationTask?.state).toBe("ASSIGNED");
    expect(implementationTask?.title).toContain("Implement workflow mutation");
    expect(implementationTask?.description).toContain("Accepted recommendation summary:");
    expect(implementationTask?.description).toContain("See review task");
    expect(implementationTask?.description).not.toContain("OpenAI Codex");
    expect(implementationTask?.description).toContain("Create a verifier-path follow-up");

    const refreshedSourceTask = getTask(PROJECT, sourceTask.id, db);
    expect(refreshedSourceTask?.state).toBe("BLOCKED");
    expect((refreshedSourceTask?.metadata as Record<string, unknown>)?.workflowMutation).toMatchObject({
      status: "implementation_in_progress",
      followUpTaskId: implementationTask?.id,
      reviewTaskId: reviewTask.id,
    });

    const attention = buildAttentionSummary(PROJECT, db);
    const issueItem = attention.items.find((item) => item.issueId === "issue-la");
    expect(issueItem?.automationState).toBe("auto_handling");
    expect(issueItem?.urgency).toBe("watching");
    expect(issueItem?.recommendedAction).toContain("workflow mutation task");
    expect(issueItem?.metadata).toMatchObject({
      workflowMutationFollowUpTaskId: implementationTask?.id,
      workflowMutationFollowUpTaskState: "ASSIGNED",
    });
  });

  it("proposal_created event is handled (no-op acknowledgment)", () => {
    ingestEvent(PROJECT, "proposal_created", "internal", {
      proposalId: "p-1",
      proposedBy: "agent:worker",
      riskTier: "high",
    }, undefined, db);

    const processed = processEvents(PROJECT, db);
    expect(processed).toBe(1);

    const handled = listEvents(PROJECT, { status: "handled" }, db);
    expect(handled).toHaveLength(1);
  });

  it("approving a dry-run command proposal replays the command live", () => {
    const outputPath = path.join(tmpDir, "replayed.txt");
    const decision = evaluateCommandExecution(
      { projectId: PROJECT, actor: "agent:worker", summary: "Would write replay marker" },
      `node -e "require('fs').writeFileSync(process.argv[1], 'ok')" "${outputPath}"`,
      { workingDir: tmpDir },
      db,
    );

    expect(decision.effect).toBe("require_approval");
    if (decision.effect === "allow") return;
    const proposalId = decision.proposal!.id;
    approveProposal(PROJECT, proposalId, "run it");
    processEvents(PROJECT, db);

    expect(fs.readFileSync(outputPath, "utf-8")).toBe("ok");
    const action = getSimulatedActionByProposal(PROJECT, proposalId, db);
    expect(action?.status).toBe("approved_for_live");
  });

  it("approving a dry-run internal tool proposal creates pre-approval and re-dispatch", () => {
    const task = createTask({ projectId: PROJECT, title: "Do governed work", createdBy: "agent:pm" }, db);
    processEvents(PROJECT, db);

    const decision = evaluateToolExecution({
      projectId: PROJECT,
      agentId: "worker",
      sessionKey: "agent:worker:task:123",
      toolName: "clawforce_task",
      taskId: task.id,
    }, {
      action: "transition",
      task_id: task.id,
      state: "IN_PROGRESS",
    }, db);

    expect(decision.effect).toBe("require_approval");
    if (decision.effect === "allow") return;
    const proposalId = decision.proposal!.id;
    approveProposal(PROJECT, proposalId, "allow one live run");
    processEvents(PROJECT, db);

    const action = getSimulatedActionByProposal(PROJECT, proposalId, db);
    expect(action?.status).toBe("approved_for_live");
    expect(checkPreApproval({ projectId: PROJECT, taskId: task.id, toolName: "clawforce_task" }, db)).toBe(true);

    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBeGreaterThanOrEqual(1);
  });

  it("rejecting a dry-run proposal discards the simulated action", () => {
    const decision = evaluateCommandExecution(
      { projectId: PROJECT, actor: "agent:worker", summary: "Would write replay marker" },
      `node -e "process.exit(0)"`,
      { workingDir: tmpDir },
      db,
    );

    expect(decision.effect).toBe("require_approval");
    if (decision.effect === "allow") return;
    const proposalId = decision.proposal!.id;
    rejectProposal(PROJECT, proposalId, "no");
    processEvents(PROJECT, db);

    const action = getSimulatedActionByProposal(PROJECT, proposalId, db);
    expect(action?.status).toBe("discarded");
  });
});
