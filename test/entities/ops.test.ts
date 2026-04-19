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
const {
  createEntity,
  getChildEntities,
  getEntity,
  getEntityIssue,
  listEntityIssues,
  listEntities,
  recordEntityIssue,
  resolveEntityIssue,
  requestEntityTransition,
  summarizeEntityIssues,
  transitionEntity,
  updateEntity,
} = await import("../../src/entities/ops.js");
const { listEntityCheckRuns } = await import("../../src/entities/checks.js");
const { attachEvidence, createTask, getTask, listTasks, transitionTask } = await import("../../src/tasks/ops.js");
const { createGoal, listGoals } = await import("../../src/goals/ops.js");
const { approveProposal, listPendingProposals } = await import("../../src/approval/resolve.js");
const { processEvents } = await import("../../src/events/router.js");

describe("entities/ops", () => {
  const PROJECT = "entities-ops-test";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      agents: {
        "workflow-steward": {
          title: "Workflow Steward",
          department: "governance",
          team: "workflow",
        },
      },
      entities: {
        jurisdiction: {
          title: "Jurisdiction",
          runtimeCreate: true,
          states: {
            bootstrapping: { initial: true },
            shadow: {},
            active: {},
            retired: { terminal: true },
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
            { from: "active", to: "retired", reasonRequired: true },
          ],
          health: {
            values: ["healthy", "warning", "blocked"],
            default: "healthy",
          },
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
                command: "node -e \"console.log(JSON.stringify({jurisdictions:[{name:'Los Angeles',issues:[]},{name:'San Francisco',issues:[]},{name:'Oakland',issues:[]},{name:'Berkeley',issues:[]},{name:'California',issues:[]}]}))\"",
                issueTypes: ["bundle_regression", "extraction_failure"],
                parser: {
                  type: "json_record_issues",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  issueArrayPath: "issues",
                  issueTypeField: "category",
                },
                playbook: "rentright-bundle-verify",
              },
            },
            types: {
              bundle_regression: {
                defaultSeverity: "high",
                blocking: true,
                approvalRequired: true,
                health: "blocked",
                playbook: "rentright-bundle-verify",
                task: {
                  enabled: true,
                  titleTemplate: "Remediate {{entity.title}} / {{issue.issueType}}",
                  tags: ["rentright", "jurisdiction-remediation"],
                  rerunOnStates: ["DONE"],
                  closeTaskOnResolved: true,
                },
              },
              extraction_failure: {
                defaultSeverity: "medium",
                blocking: true,
                approvalRequired: false,
                health: "warning",
                playbook: "source-onboarding",
                task: {
                  enabled: true,
                  titleTemplate: "Remediate {{entity.title}} / {{issue.issueType}}",
                  tags: ["rentright", "jurisdiction-remediation"],
                  rerunOnStates: ["DONE"],
                  closeTaskOnResolved: true,
                },
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
            tenantProtected: { type: "boolean" },
          },
          relationships: {
            parent: {
              allowedKinds: ["jurisdiction"],
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

  it("creates entities with config-driven initial state and health defaults", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      metadata: { region: "ca-la" },
    }, db);

    expect(entity.kind).toBe("jurisdiction");
    expect(entity.state).toBe("bootstrapping");
    expect(entity.health).toBe("healthy");
    expect(entity.metadata).toEqual({ region: "ca-la" });
    expect(getEntity(PROJECT, entity.id, db)?.title).toBe("Los Angeles");
  });

  it("enforces transition graph and reason-required transitions", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Oakland",
      createdBy: "test",
      metadata: { region: "ca-oak" },
    }, db);

    expect(() => transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "active",
      actor: "test",
    }, db)).toThrow('Transition bootstrapping -> active is not allowed');

    const shadow = transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "shadow",
      actor: "test",
    }, db);
    expect(shadow.state).toBe("shadow");

    expect(() => transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "active",
      actor: "test",
    }, db)).toThrow("requires a reason");

    const active = transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "active",
      actor: "test",
      reason: "Initial verification complete",
    }, db);
    expect(active.state).toBe("active");
  });

  it("supports parent relationships and prevents cycles", () => {
    const parent = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      metadata: { region: "ca" },
    }, db);
    const child = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "San Francisco",
      createdBy: "test",
      parentEntityId: parent.id,
      metadata: { region: "ca-sf" },
    }, db);

    expect(getChildEntities(PROJECT, parent.id, db).map((entity) => entity.id)).toContain(child.id);

    expect(() => updateEntity(PROJECT, parent.id, {
      parentEntityId: child.id,
    }, "test", db)).toThrow("would create a cycle");
  });

  it("links tasks and goals to entities and filters by entity", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Berkeley",
      createdBy: "test",
      metadata: { region: "ca-berk" },
    }, db);

    const task = createTask({
      projectId: PROJECT,
      title: "Refresh bundle",
      createdBy: "test",
      entityId: entity.id,
    }, db);
    const goal = createGoal({
      projectId: PROJECT,
      title: "Own Berkeley rollout",
      createdBy: "test",
      entityId: entity.id,
    }, db);

    expect(task.entityId).toBe(entity.id);
    expect(task.entityType).toBe("jurisdiction");
    expect(goal.entityId).toBe(entity.id);
    expect(goal.entityType).toBe("jurisdiction");

    expect(listTasks(PROJECT, { entityId: entity.id }, db)).toHaveLength(1);
    expect(listTasks(PROJECT, { entityType: "jurisdiction" }, db)).toHaveLength(1);
    expect(listGoals(PROJECT, { entityId: entity.id }, db)).toHaveLength(1);
    expect(listGoals(PROJECT, { entityType: "jurisdiction" }, db)).toHaveLength(1);
    expect(listEntities(PROJECT, { kind: "jurisdiction" }, db)).toHaveLength(1);
  });

  it("records entity issues, synthesizes health, and summarizes open blockers", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      metadata: { region: "ca-la" },
    }, db);

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.bundle_regression.max_annual_increase_percentage",
      issueType: "bundle_regression",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Multiple current values for max_annual_increase_percentage",
      actor: "test",
      fieldName: "max_annual_increase_percentage",
      recommendedAction: "Resolve duplicate current value and rerun bundle verification",
    }, db);

    expect(issue.severity).toBe("high");
    expect(issue.blocking).toBe(true);
    expect(issue.approvalRequired).toBe(true);
    expect(issue.playbook).toBe("rentright-bundle-verify");

    const updatedEntity = getEntity(PROJECT, entity.id, db)!;
    expect(updatedEntity.health).toBe("blocked");

    const summary = summarizeEntityIssues(PROJECT, entity.id, db);
    expect(summary).toMatchObject({
      openCount: 1,
      blockingOpenCount: 1,
      approvalRequiredCount: 1,
      highestSeverity: "high",
      suggestedHealth: "blocked",
    });
    expect(summary.openIssueTypes).toEqual(["bundle_regression"]);
    expect(listEntityIssues(PROJECT, { entityId: entity.id, status: "open" }, db)).toHaveLength(1);
  });

  it("creates an approval proposal for gated entity promotion and applies it after approval", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "San Francisco",
      createdBy: "test",
      metadata: { region: "ca-sf" },
    }, db);

    transitionEntity({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "shadow",
      actor: "test",
    }, db);

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "sf.bundle_regression.overlap",
      issueType: "bundle_regression",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Overlapping periods for max_annual_increase_percentage",
      actor: "test",
    }, db);

    const result = requestEntityTransition({
      projectId: PROJECT,
      entityId: entity.id,
      toState: "active",
      actor: "sf-owner",
      reason: "Shadow verification complete",
      sessionKey: "agent:sf-owner:interactive:123",
    }, db);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected approval requirement");
    expect(result.proposal.entity_id).toBe(entity.id);
    expect(result.proposal.entity_type).toBe("jurisdiction");
    expect(result.proposal.origin).toBe("entity_transition");
    expect(result.blockingIssues.map((item) => item.id)).toContain(issue.id);

    const linkedIssue = listEntityIssues(PROJECT, { entityId: entity.id, status: "open" }, db)[0]!;
    expect(linkedIssue.proposalId).toBe(result.proposal.id);

    approveProposal(PROJECT, result.proposal.id, "Override for controlled rollout");
    processEvents(PROJECT, db);

    const activated = getEntity(PROJECT, entity.id, db)!;
    expect(activated.state).toBe("active");
  });

  it("creates, closes, and reruns remediation tasks for entity issues", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
      metadata: { region: "ca-la" },
    }, db);

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.bundle_regression.current-value-conflict",
      issueType: "bundle_regression",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Multiple current values for max_annual_increase_percentage",
      actor: "test",
      recommendedAction: "Resolve the duplicate current value and rerun the pipeline health check",
    }, db);

    processEvents(PROJECT, db);
    const remediationTask = listTasks(PROJECT, {
      entityId: entity.id,
      origin: "reactive",
      originId: issue.id,
    }, db)[0]!;
    expect(remediationTask).toBeDefined();
    expect(remediationTask.title).toBe("Remediate Los Angeles / bundle_regression");
    expect(remediationTask.assignedTo).toBe("los-angeles-owner");
    expect(remediationTask.tags).toEqual(expect.arrayContaining([
      "entity-issue",
      "entity:jurisdiction",
      "issue:bundle_regression",
      "rentright",
      "jurisdiction-remediation",
    ]));
    expect(remediationTask.description).toContain("Acceptance criteria:");
    expect(remediationTask.description).toContain("Rerun and review: pipeline_health.");
    expect(remediationTask.metadata).toMatchObject({
      entityIssue: {
        issueId: issue.id,
        issueType: "bundle_regression",
        checkId: "pipeline_health",
        rerunCheckIds: ["pipeline_health"],
        rerunOnStates: ["DONE"],
        closeTaskOnResolved: true,
      },
    });

    const resolved = resolveEntityIssue({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "test",
    }, db);
    expect(resolved.status).toBe("resolved");

    processEvents(PROJECT, db);

    const cancelledTask = listTasks(PROJECT, {
      entityId: entity.id,
      origin: "reactive",
      originId: issue.id,
    }, db)[0]!;
    expect(cancelledTask.state).toBe("CANCELLED");

    const reopened = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: issue.issueKey,
      issueType: issue.issueType,
      source: issue.source,
      checkId: issue.checkId,
      title: issue.title,
      actor: "test",
      recommendedAction: issue.recommendedAction,
    }, db);
    expect(reopened.status).toBe("open");

    processEvents(PROJECT, db);

    const followupTask = listTasks(PROJECT, {
      entityId: entity.id,
      origin: "reactive",
      originId: reopened.id,
    }, db).find((task) => task.state !== "CANCELLED");
    expect(followupTask).toBeDefined();

    const started = transitionTask({
      projectId: PROJECT,
      taskId: followupTask!.id,
      toState: "IN_PROGRESS",
      actor: "los-angeles-owner",
      reason: "Starting remediation",
    }, db);
    expect(started.ok).toBe(true);

    attachEvidence({
      projectId: PROJECT,
      taskId: followupTask!.id,
      type: "note",
      content: "Resolved duplicate current value and verified supporting evidence.",
      attachedBy: "los-angeles-owner",
    }, db);

    const readyForReview = transitionTask({
      projectId: PROJECT,
      taskId: followupTask!.id,
      toState: "REVIEW",
      actor: "los-angeles-owner",
      reason: "Ready for verification",
    }, db);
    expect(readyForReview.ok).toBe(true);

    const completion = transitionTask({
      projectId: PROJECT,
      taskId: followupTask!.id,
      toState: "DONE",
      actor: "los-angeles-owner",
      reason: "Applied remediation",
      verificationRequired: false,
    }, db);
    expect(completion.ok).toBe(true);

    processEvents(PROJECT, db);

    const resolvedIssue = getEntityIssue(PROJECT, reopened.id, db)!;
    expect(resolvedIssue.status).toBe("resolved");
    const checkRuns = listEntityCheckRuns(PROJECT, entity.id, 5, db);
    expect(checkRuns[0]?.checkId).toBe("pipeline_health");
    expect(checkRuns[0]?.status).toBe("passed");
  });

  it("escalates repeated unresolved remediation loops into a workflow-mutation proposal", () => {
    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      createdBy: "test",
      ownerAgentId: "los-angeles-owner",
      metadata: { region: "ca-la" },
    }, db);

    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.pipeline.extraction-loop",
      issueType: "extraction_failure",
      source: "pipeline_health",
      checkId: "pipeline_health",
      title: "Los Angeles bulletin extraction is still failed",
      actor: "test",
      recommendedAction: "Repair the failed bulletin source and rerun pipeline health",
    }, db);

    processEvents(PROJECT, db);

    const firstRemediation = listTasks(PROJECT, {
      entityId: entity.id,
      origin: "reactive",
      originId: issue.id,
    }, db)[0]!;
    expect(firstRemediation).toBeDefined();

    db.prepare(`
      UPDATE tasks
      SET state = 'DONE', updated_at = ?
      WHERE project_id = ? AND id = ?
    `).run(Date.now(), PROJECT, firstRemediation.id);

    db.prepare(`
      INSERT INTO tasks (
        id, project_id, title, description, state, priority, assigned_to, created_by,
        created_at, updated_at, entity_id, entity_type, kind, origin, origin_id, tags, metadata
      ) VALUES (?, ?, ?, ?, 'DONE', 'P2', ?, 'system:entity-remediation', ?, ?, ?, ?, 'bug', 'reactive', ?, ?, ?)
    `).run(
      "done-remediation-2",
      PROJECT,
      firstRemediation.title,
      firstRemediation.description ?? null,
      "los-angeles-owner",
      Date.now(),
      Date.now(),
      entity.id,
      "jurisdiction",
      issue.id,
      JSON.stringify(firstRemediation.tags ?? []),
      JSON.stringify(firstRemediation.metadata ?? {}),
    );

    db.prepare(`
      INSERT INTO events (
        id, project_id, type, source, payload, dedup_key, status, created_at
      ) VALUES (?, ?, 'entity_issue_updated', 'internal', ?, ?, 'pending', ?)
    `).run(
      "event-remediation-loop",
      PROJECT,
      JSON.stringify({
        entityId: entity.id,
        entityKind: "jurisdiction",
        issueId: issue.id,
        issueType: issue.issueType,
        status: "open",
      }),
      `entity-issue-updated:${issue.id}:loop`,
      Date.now(),
    );

    processEvents(PROJECT, db);

    const refreshedIssue = getEntityIssue(PROJECT, issue.id, db)!;
    expect(refreshedIssue.proposalId).toBeTruthy();

    const proposals = listPendingProposals(PROJECT, db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.origin).toBe("workflow_mutation");
    expect(proposals[0]!.title).toContain("repeated unresolved extraction_failure loop");

    const activeRemediation = listTasks(PROJECT, {
      entityId: entity.id,
      origin: "reactive",
      originId: issue.id,
    }, db).find((task) => !["DONE", "FAILED", "CANCELLED"].includes(task.state));
    expect(activeRemediation).toBeUndefined();
  });

  it("escalates repeated cross-entity issue patterns into one workflow-mutation proposal", () => {
    const california = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "California",
      createdBy: "test",
      ownerAgentId: "california-owner",
      metadata: { region: "ca" },
    }, db);
    const oakland = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Oakland",
      createdBy: "test",
      ownerAgentId: "oakland-owner",
      metadata: { region: "ca-oak" },
    }, db);
    const sanFrancisco = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "San Francisco",
      createdBy: "test",
      ownerAgentId: "sf-owner",
      metadata: { region: "ca-sf" },
    }, db);

    const issues = [
      recordEntityIssue({
        projectId: PROJECT,
        entityId: california.id,
        issueKey: "ca.semantic.rate-authority",
        issueType: "extraction_failure",
        source: "pipeline_health",
        checkId: "pipeline_health",
        title: "[Rate Authority] rate_authority=cpi_formula but max_annual_increase_percentage is present - this field is ignored for CPI-based jurisdictions",
        actor: "test",
        recommendedAction: "Review whether this semantic mismatch should block promotion.",
      }, db),
      recordEntityIssue({
        projectId: PROJECT,
        entityId: oakland.id,
        issueKey: "oak.semantic.rate-authority",
        issueType: "extraction_failure",
        source: "pipeline_health",
        checkId: "pipeline_health",
        title: "[Rate Authority] rate_authority=cpi_formula but max_annual_increase_percentage is present - this field is ignored for CPI-based jurisdictions",
        actor: "test",
        recommendedAction: "Review whether this semantic mismatch should block promotion.",
      }, db),
      recordEntityIssue({
        projectId: PROJECT,
        entityId: sanFrancisco.id,
        issueKey: "sf.semantic.rate-authority",
        issueType: "extraction_failure",
        source: "pipeline_health",
        checkId: "pipeline_health",
        title: "[Rate Authority] rate_authority=cpi_formula but max_annual_increase_percentage is present - this field is ignored for CPI-based jurisdictions",
        actor: "test",
        recommendedAction: "Review whether this semantic mismatch should block promotion.",
      }, db),
    ];

    processEvents(PROJECT, db);

    const proposals = listPendingProposals(PROJECT, db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.origin).toBe("workflow_mutation");
    expect(proposals[0]!.title).toContain("repeated extraction_failure pattern");
    const snapshot = JSON.parse(proposals[0]!.approval_policy_snapshot ?? "{}") as Record<string, unknown>;
    const representativeIssueId = typeof snapshot.sourceIssueId === "string" ? snapshot.sourceIssueId : undefined;
    const affectedIssueIds = Array.isArray(snapshot.affectedIssueIds)
      ? snapshot.affectedIssueIds.filter((value): value is string => typeof value === "string")
      : [];
    const representativeTaskId = typeof snapshot.sourceTaskId === "string" ? snapshot.sourceTaskId : undefined;
    const representativeTask = representativeTaskId ? getTask(PROJECT, representativeTaskId, db) : null;
    expect(representativeIssueId).toBeDefined();
    expect(representativeIssueId).toBe((representativeTask?.metadata as Record<string, unknown>)?.entityIssue
      ? ((representativeTask?.metadata as Record<string, unknown>).entityIssue as Record<string, unknown>).issueId
      : undefined);
    expect(new Set(affectedIssueIds)).toEqual(new Set(issues.map((item) => item.id)));

    const refreshedIssues = issues.map((issue) => getEntityIssue(PROJECT, issue.id, db)!);
    expect(new Set(refreshedIssues.map((issue) => issue.proposalId))).toEqual(new Set([proposals[0]!.id]));

    const activeReactiveTasks = refreshedIssues.flatMap((issue) =>
      listTasks(PROJECT, {
        entityId: issue.entityId,
        origin: "reactive",
        originId: issue.id,
      }, db).filter((task) => !["DONE", "FAILED", "CANCELLED"].includes(task.state)),
    );
    expect(activeReactiveTasks).toHaveLength(1);
    expect(new Set(activeReactiveTasks.map((task) => task.state))).toEqual(new Set(["BLOCKED"]));
  });
});
