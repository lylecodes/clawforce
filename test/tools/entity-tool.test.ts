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
const { approveProposal, createProposal, getProposal } = await import("../../src/approval/resolve.js");
const { createTask, getTask } = await import("../../src/tasks/ops.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createClawforceEntityTool } = await import("../../src/tools/entity-tool.js");

describe("tools/entity-tool", () => {
  const PROJECT = "entity-tool-test";
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
            {
              from: "shadow",
              to: "active",
              reasonRequired: true,
              approvalRequired: true,
              blockedByOpenIssues: true,
              blockedBySeverities: ["high", "critical"],
            },
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
                health: "blocked",
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
          },
        },
      },
    }, "/tmp/entity-tool-test");
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  async function execute(params: Record<string, unknown>) {
    const tool = createClawforceEntityTool({ agentSessionKey: "entity-session", projectId: PROJECT });
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  it("lists configured kinds", async () => {
    const result = await execute({ action: "kinds" });

    expect(result.ok).toBe(true);
    expect(result.kinds).toHaveLength(1);
    expect(result.kinds[0].kind).toBe("jurisdiction");
  });

  it("creates and lists entities", async () => {
    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
    });

    expect(created.ok).toBe(true);
    expect(created.entity.state).toBe("bootstrapping");

    const listed = await execute({ action: "list", kind: "jurisdiction" });
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
    expect(listed.entities[0].title).toBe("Los Angeles");
  });

  it("transitions an entity with required reason and exposes history", async () => {
    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Oakland",
      metadata: { region: "ca-oak" },
    });

    const shadow = await execute({
      action: "transition",
      entity_id: created.entity.id,
      state: "shadow",
    });
    expect(shadow.ok).toBe(true);
    expect(shadow.entity.state).toBe("shadow");

    const failed = await execute({
      action: "transition",
      entity_id: created.entity.id,
      state: "active",
    });
    expect(failed.ok).toBe(true);
    expect(failed.approvalRequired).toBe(true);
    expect(failed.reason).toContain("requires approval");

    const history = await execute({
      action: "history",
      entity_id: created.entity.id,
    });
    expect(history.ok).toBe(true);
    expect(history.count).toBe(1);
    expect(history.transitions[0].toState).toBe("shadow");
  });

  it("reports and resolves entity issues", async () => {
    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
    });

    const reported = await execute({
      action: "report_issue",
      entity_id: created.entity.id,
      issue_key: "la.bundle_regression.max_annual_increase_percentage",
      issue_type: "bundle_regression",
      source: "pipeline_health",
      check_id: "pipeline_health",
      title: "Multiple current values for max_annual_increase_percentage",
    });
    expect(reported.ok).toBe(true);
    expect(reported.issue.blocking).toBe(true);
    expect(reported.issueSummary.blockingOpenCount).toBe(1);

    const issues = await execute({
      action: "issues",
      entity_id: created.entity.id,
      status: "open",
    });
    expect(issues.ok).toBe(true);
    expect(issues.count).toBe(1);
    expect(issues.issues[0].issueType).toBe("bundle_regression");

    const resolved = await execute({
      action: "resolve_issue",
      issue_id: issues.issues[0].id,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.issue.status).toBe("resolved");
    expect(resolved.issueSummary.openCount).toBe(0);
  });

  it("runs configured checks and exposes recent check runs", async () => {
    vi.mocked(childProcess.execSync).mockReturnValue(JSON.stringify({
      jurisdictions: [{ name: "Los Angeles", verdict: "blocked" }],
    }));

    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
    });

    const ran = await execute({
      action: "run_checks",
      entity_id: created.entity.id,
    });
    expect(ran.ok).toBe(true);
    expect(ran.results).toHaveLength(1);
    expect(ran.results[0].checkId).toBe("pipeline_health");
    expect(ran.issueSummary.openCount).toBe(1);

    const runs = await execute({
      action: "check_runs",
      entity_id: created.entity.id,
    });
    expect(runs.ok).toBe(true);
    expect(runs.count).toBe(1);
    expect(runs.runs[0].status).toBe("issues");
  });

  it("captures snapshots, reopens issues, resets remediation, and clears check runs", async () => {
    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
    });

    const reported = await execute({
      action: "report_issue",
      entity_id: created.entity.id,
      issue_key: "la.bundle_regression.max_annual_increase_percentage",
      issue_type: "bundle_regression",
      source: "pipeline_health",
      check_id: "pipeline_health",
      title: "Multiple current values for max_annual_increase_percentage",
      playbook: "rentright-bundle-verify",
    });
    const issueId = reported.issue.id as string;

    const firstReset = await execute({
      action: "reset_remediation",
      issue_id: issueId,
    });
    expect(firstReset.ok).toBe(true);
    expect(firstReset.recreatedTaskIds).toHaveLength(1);

    const snapshot = await execute({
      action: "snapshot",
      entity_id: created.entity.id,
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.snapshot.entity.id).toBe(created.entity.id);
    expect(snapshot.snapshot.issues).toHaveLength(1);
    expect(snapshot.snapshot.reactiveTasks).toHaveLength(1);

    const resolved = await execute({
      action: "resolve_issue",
      issue_id: issueId,
    });
    expect(resolved.ok).toBe(true);

    const reopened = await execute({
      action: "reopen_issue",
      issue_id: issueId,
      reason: "rerun experiment",
    });
    expect(reopened.ok).toBe(true);
    expect(reopened.issue.status).toBe("open");

    const secondReset = await execute({
      action: "reset_remediation",
      issue_id: issueId,
    });
    expect(secondReset.ok).toBe(true);
    expect(secondReset.cancelledTaskIds).toContain(firstReset.recreatedTaskIds[0]);

    db.prepare(`
      INSERT INTO entity_check_runs (
        id, project_id, entity_id, entity_kind, check_id, status, command, parser_type,
        exit_code, issue_count, stdout, stderr, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run-clear",
      PROJECT,
      created.entity.id,
      "jurisdiction",
      "pipeline_health",
      "issues",
      "npm run pipeline:health -- --json",
      "json_record_status",
      0,
      1,
      "{}",
      null,
      25,
      Date.now(),
    );

    const cleared = await execute({
      action: "clear_check_runs",
      entity_id: created.entity.id,
    });
    expect(cleared.ok).toBe(true);
    expect(cleared.cleared).toBe(1);
  });

  it("replays terminal workflow-mutation implementation tasks", async () => {
    const created = await execute({
      action: "create",
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
    });

    const reported = await execute({
      action: "report_issue",
      entity_id: created.entity.id,
      issue_key: "la.bundle_regression.max_annual_increase_percentage",
      issue_type: "bundle_regression",
      source: "pipeline_health",
      check_id: "pipeline_health",
      title: "Multiple current values for max_annual_increase_percentage",
      playbook: "rentright-bundle-verify",
      owner_agent_id: "los-angeles-owner",
    });
    const issueId = reported.issue.id as string;

    const sourceTask = createTask({
      projectId: PROJECT,
      title: "Remediate Los Angeles: Multiple current values for max_annual_increase_percentage",
      description: "Acceptance criteria:\n- Narrow or resolve the issue.",
      priority: "P1",
      assignedTo: "los-angeles-owner",
      createdBy: "tester",
      entityType: "jurisdiction",
      entityId: created.entity.id,
      kind: "bug",
      origin: "reactive",
      originId: issueId,
      metadata: {
        entityIssue: {
          issueId,
          issueType: "bundle_regression",
        },
      },
    }, db);
    db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE project_id = ? AND id = ?")
      .run(Date.now(), PROJECT, sourceTask.id);

    const proposal = createProposal({
      projectId: PROJECT,
      title: "Workflow mutation review: repeated unresolved bundle_regression loop for Los Angeles",
      proposedBy: "workflow-steward",
      origin: "workflow_mutation",
      entityType: "jurisdiction",
      entityId: created.entity.id,
      approvalPolicySnapshot: JSON.stringify({
        replayType: "workflow_mutation",
        stewardAgentId: "workflow-steward",
        sourceTaskId: sourceTask.id,
        sourceTaskTitle: sourceTask.title,
        sourceIssueId: issueId,
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        failureCount: 4,
        entityType: "jurisdiction",
        entityId: created.entity.id,
        entityTitle: "Los Angeles",
        latestReason: "Multiple current values",
        recommendedChanges: ["Stop reopening identical remediation tasks."],
        stewardTask: {
          title: "Restructure workflow for Los Angeles",
          description: "Acceptance criteria:\n- Restore the loop.",
          priority: "P1",
          kind: "infra",
        },
      }),
    }, db);
    approveProposal(PROJECT, proposal.id, "approved", db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for Los Angeles: workflow gap",
      description: "Acceptance criteria:\n- Restore the loop.",
      priority: "P1",
      assignedTo: "workflow-steward",
      createdBy: "system:workflow-mutation",
      entityType: "jurisdiction",
      entityId: created.entity.id,
      kind: "infra",
      origin: "lead_proposal",
      originId: proposal.id,
      tags: ["workflow-mutation", "workflow-mutation-implementation"],
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: sourceTask.id,
        sourceIssueId: issueId,
        reviewTaskId: "review-1",
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
        workflowMutationPostCondition: {
          verifiedAt: Date.now(),
        },
      },
    }, db);
    db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE project_id = ? AND id = ?")
      .run(Date.now(), PROJECT, implementationTask.id);

    const replayed = await execute({
      action: "replay_workflow_mutation",
      task_id: implementationTask.id,
      reason: "rerun under corrected workflow-mutation verifier",
    });
    expect(replayed.ok).toBe(true);
    expect(replayed.replayedTaskId).not.toBe(implementationTask.id);

    const replayTask = getTask(PROJECT, replayed.replayedTaskId, db);
    expect(replayTask?.state).toBe("ASSIGNED");
    expect((replayTask?.metadata as Record<string, unknown>)?.workflowMutationReplayOfTaskId).toBe(implementationTask.id);

    const refreshedProposal = getProposal(PROJECT, proposal.id, db);
    expect(refreshedProposal?.execution_task_id).toBe(replayed.replayedTaskId);
  });
});
