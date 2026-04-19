import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createClawforceTaskTool } = await import("../../src/tools/task-tool.js");
const { approveProposal } = await import("../../src/approval/resolve.js");
const trackerModule = await import("../../src/enforcement/tracker.js");
const { createEntity } = await import("../../src/entities/ops.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { getDefaultRuntimeState } = await import("../../src/runtime/default-runtime.js");

describe("clawforce_task tool", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    getDefaultRuntimeState().taskTool.sessionTaskCreationCounts.clear();
  });

  afterEach(() => {
    try { db.close(); } catch {}
    resetEnforcementConfigForTest();
    getDefaultRuntimeState().taskTool.sessionTaskCreationCounts.clear();
    vi.restoreAllMocks();
  });

  function createTool() {
    return createClawforceTaskTool({ agentSessionKey: "test-session" });
  }

  async function execute(params: Record<string, unknown>) {
    const tool = createTool();
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("create", () => {
    it("creates task with correct defaults", async () => {
      const result = await execute({
        action: "create",
        project_id: PROJECT,
        title: "New task",
        description: "Description here",
      });

      expect(result.ok).toBe(true);
      expect(result.task.title).toBe("New task");
      expect(result.task.state).toBe("OPEN");
      expect(result.task.priority).toBe("P2");
      expect(result.task.createdBy).toBe("test-session");
    });

    it("creates task with all options", async () => {
      const result = await execute({
        action: "create",
        project_id: PROJECT,
        title: "Full task",
        priority: "P0",
        assigned_to: "agent:worker",
        tags: ["urgent"],
        max_retries: 5,
      });

      expect(result.ok).toBe(true);
      expect(result.task.priority).toBe("P0");
      expect(result.task.assignedTo).toBe("agent:worker");
      expect(result.task.state).toBe("ASSIGNED");
      expect(result.task.maxRetries).toBe(5);
    });

    it("auto-links same-entity child work to the current task", async () => {
      registerWorkforceConfig(PROJECT, {
        agents: {},
        entities: {
          jurisdiction: {
            title: "Jurisdiction",
            runtimeCreate: true,
            states: {
              proposed: { initial: true },
            },
            health: {
              values: ["healthy", "warning", "degraded", "blocked"],
              default: "healthy",
            },
            metadataSchema: {},
          },
        },
      });

      const entity = createEntity({
        projectId: PROJECT,
        kind: "jurisdiction",
        title: "Sacramento",
        state: "proposed",
        createdBy: "agent:pm",
      }, db);
      const parent = createTask({
        projectId: PROJECT,
        title: "Create Sacramento owner coverage and bootstrapping scaffold",
        createdBy: "source-onboarding-steward",
        assignedTo: "org-builder",
        entityId: entity.id,
        entityType: "jurisdiction",
      }, db);

      vi.spyOn(trackerModule, "getSession").mockReturnValue({
        sessionKey: "test-session",
        agentId: "org-builder",
        projectId: PROJECT,
        requirements: [],
        satisfied: new Map(),
        metrics: {
          startedAt: Date.now(),
          toolCalls: [],
          firstToolCallAt: null,
          lastToolCallAt: null,
          firstProgressAt: null,
          lastProgressAt: null,
          progressSignalCount: 0,
          requiredCallTimings: [],
          errorCount: 0,
          exploratoryErrorCount: 0,
          significantResults: [],
          toolCallBuffer: [],
        },
        dispatchContext: {
          queueItemId: "queue-1",
          taskId: parent.id,
        },
      } as any);

      const result = await execute({
        action: "create",
        project_id: PROJECT,
        title: "Onboard Sacramento authoritative sources",
        assigned_to: "source-onboarding-steward",
        entity_id: entity.id,
        entity_type: "jurisdiction",
      });

      expect(result.ok).toBe(true);
      expect(result.autoLinkedParentTaskId).toBe(parent.id);
      expect(result.task.parentTaskId).toBe(parent.id);
      expect(result.task.state).toBe("BLOCKED");
    });
  });

  describe("get", () => {
    it("returns existing task with evidence", async () => {
      const createResult = await execute({
        action: "create",
        project_id: PROJECT,
        title: "Get test",
      });

      const getResult = await execute({
        action: "get",
        project_id: PROJECT,
        task_id: createResult.task.id,
      });

      expect(getResult.ok).toBe(true);
      expect(getResult.task.title).toBe("Get test");
      expect(getResult.evidence).toEqual([]);
    });

    it("returns ok:false for missing task", async () => {
      const result = await execute({
        action: "get",
        project_id: PROJECT,
        task_id: "nonexistent",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("Task not found");
    });
  });

  describe("list", () => {
    it("returns tasks filtered by state", async () => {
      await execute({ action: "create", project_id: PROJECT, title: "A" });
      const b = await execute({ action: "create", project_id: PROJECT, title: "B", assigned_to: "worker" });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        state: ["ASSIGNED"],
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(result.tasks[0].title).toBe("B");
    });
  });

  describe("transition", () => {
    it("happy path OPEN → ASSIGNED", async () => {
      const task = await execute({ action: "create", project_id: PROJECT, title: "Transition test" });

      const result = await execute({
        action: "transition",
        project_id: PROJECT,
        task_id: task.task.id,
        to_state: "ASSIGNED",
        assigned_to: "agent:bob",
      });

      expect(result.ok).toBe(true);
      expect(result.task.state).toBe("ASSIGNED");
    });

    it("invalid transition returns error with valid next states", async () => {
      const task = await execute({ action: "create", project_id: PROJECT, title: "Invalid" });

      const result = await execute({
        action: "transition",
        project_id: PROJECT,
        task_id: task.task.id,
        to_state: "DONE",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Cannot transition");
    });
  });

  describe("attach_evidence", () => {
    it("attaches evidence and returns it", async () => {
      const task = await execute({ action: "create", project_id: PROJECT, title: "Evidence test" });

      const result = await execute({
        action: "attach_evidence",
        project_id: PROJECT,
        task_id: task.task.id,
        evidence_type: "output",
        evidence_content: "Test output here",
      });

      expect(result.ok).toBe(true);
      expect(result.evidence.type).toBe("output");
      expect(result.evidence.content).toBe("Test output here");
    });
  });

  describe("history", () => {
    it("returns transitions for a task", async () => {
      const task = await execute({ action: "create", project_id: PROJECT, title: "History test" });

      await execute({
        action: "transition",
        project_id: PROJECT,
        task_id: task.task.id,
        to_state: "ASSIGNED",
      });

      const result = await execute({
        action: "history",
        project_id: PROJECT,
        task_id: task.task.id,
      });

      expect(result.ok).toBe(true);
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].fromState).toBe("OPEN");
      expect(result.transitions[0].toState).toBe("ASSIGNED");
    });
  });

  describe("fail", () => {
    it("transitions to FAILED with reason", async () => {
      const task = await execute({
        action: "create",
        project_id: PROJECT,
        title: "Fail test",
        assigned_to: "test-session",
      });

      const result = await execute({
        action: "fail",
        project_id: PROJECT,
        task_id: task.task.id,
        reason: "Cannot complete",
        evidence_content: "Error log here",
      });

      expect(result.ok).toBe(true);
      expect(result.task.state).toBe("FAILED");
    });
  });

  describe("metrics", () => {
    it("queries metrics for a project", async () => {
      // Record a metric via the DB directly
      const { recordMetric } = await import("../../src/metrics.js");
      recordMetric({ projectId: PROJECT, type: "task_cycle", key: "cycle_time", value: 5000 }, db);

      const result = await execute({
        action: "metrics",
        project_id: PROJECT,
        type: "task_cycle",
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(result.metrics[0].key).toBe("cycle_time");
    });

    it("returns empty metrics when none exist", async () => {
      const result = await execute({
        action: "metrics",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  describe("check_proposal", () => {
    it("returns proposal status after submit_proposal", async () => {
      const submitResult = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Add caching layer",
        description: "Redis-based caching for API responses",
      });

      expect(submitResult.ok).toBe(true);
      const proposalId = submitResult.proposal.id;

      const checkResult = await execute({
        action: "check_proposal",
        project_id: PROJECT,
        proposal_id: proposalId,
      });

      expect(checkResult.ok).toBe(true);
      expect(checkResult.proposal.status).toBe("pending");
    });

    it("returns approved status after external approval", async () => {
      const submitResult = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Deploy to staging",
      });

      approveProposal(PROJECT, submitResult.proposal.id, "Looks good");

      const checkResult = await execute({
        action: "check_proposal",
        project_id: PROJECT,
        proposal_id: submitResult.proposal.id,
      });

      expect(checkResult.ok).toBe(true);
      expect(checkResult.proposal.status).toBe("approved");
    });

    it("returns ok:false for non-existent proposal", async () => {
      const result = await execute({
        action: "check_proposal",
        project_id: PROJECT,
        proposal_id: "nonexistent-id",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("Proposal not found");
    });
  });

  describe("unknown action", () => {
    it("returns error for unknown action", async () => {
      const result = await execute({
        action: "nonexistent",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Unknown action");
    });
  });
});
