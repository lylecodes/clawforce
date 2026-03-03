import type { DatabaseSync } from "node:sqlite";
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
const { createClawforceOpsTool } = await import("../../src/tools/ops-tool.js");
const trackerModule = await import("../../src/enforcement/tracker.js");
const disabledStoreModule = await import("../../src/enforcement/disabled-store.js");
const stuckDetectorModule = await import("../../src/audit/stuck-detector.js");
const autoKillModule = await import("../../src/audit/auto-kill.js");
const sweepModule = await import("../../src/sweep/actions.js");
const workerRegistryModule = await import("../../src/worker-registry.js");

describe("clawforce_ops tool", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
    workerRegistryModule.resetWorkerRegistryForTest();
    trackerModule.resetTrackerForTest();
  });

  function createTool() {
    return createClawforceOpsTool({ agentSessionKey: "orchestrator-session" });
  }

  async function execute(params: Record<string, unknown>) {
    const tool = createTool();
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("agent_status", () => {
    it("returns empty state when nothing is active", async () => {
      vi.spyOn(trackerModule, "getActiveSessions").mockReturnValue([]);
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([]);

      const result = await execute({
        action: "agent_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.activeSessionCount).toBe(0);
      expect(result.activeSessions).toEqual([]);
      expect(result.disabledAgents).toEqual([]);
      expect(result.stuckAgents).toEqual([]);
      expect(result.workerAssignments).toEqual([]);
    });

    it("returns active sessions filtered by project", async () => {
      vi.spyOn(trackerModule, "getActiveSessions").mockReturnValue([
        {
          sessionKey: "sess-1",
          agentId: "worker-1",
          projectId: PROJECT,
          requirements: [],
          satisfied: new Map(),
          metrics: {
            startedAt: Date.now() - 60_000,
            toolCalls: [{ toolName: "t", action: null, timestamp: Date.now(), durationMs: 10, success: true }],
            firstToolCallAt: Date.now(),
            lastToolCallAt: Date.now(),
            requiredCallTimings: [],
            errorCount: 0,
          },
        },
        {
          sessionKey: "sess-other",
          agentId: "worker-other",
          projectId: "other-project",
          requirements: [],
          satisfied: new Map(),
          metrics: {
            startedAt: Date.now() - 30_000,
            toolCalls: [],
            firstToolCallAt: null,
            lastToolCallAt: null,
            requiredCallTimings: [],
            errorCount: 0,
          },
        },
      ]);
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([]);

      const result = await execute({
        action: "agent_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.activeSessionCount).toBe(1);
      expect(result.activeSessions).toHaveLength(1);
      expect(result.activeSessions[0].agentId).toBe("worker-1");
      expect(result.activeSessions[0].toolCalls).toBe(1);
    });

    it("includes disabled agents", async () => {
      vi.spyOn(trackerModule, "getActiveSessions").mockReturnValue([]);
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([]);

      disabledStoreModule.disableAgent(PROJECT, "bad-agent", "Failed compliance", db);

      const result = await execute({
        action: "agent_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.disabledAgents).toHaveLength(1);
      expect(result.disabledAgents[0].agentId).toBe("bad-agent");
    });

    it("includes stuck agents filtered by project", async () => {
      vi.spyOn(trackerModule, "getActiveSessions").mockReturnValue([]);
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([
        {
          sessionKey: "stuck-sess",
          agentId: "stuck-agent",
          projectId: PROJECT,
          runtimeMs: 500_000,
          lastToolCallMs: null,
          requiredCallsMade: 0,
          requiredCallsTotal: 2,
          reason: "Running 500s with zero tool calls",
        },
        {
          sessionKey: "other-stuck",
          agentId: "other-agent",
          projectId: "other-project",
          runtimeMs: 600_000,
          lastToolCallMs: null,
          requiredCallsMade: 0,
          requiredCallsTotal: 1,
          reason: "Running 600s with zero tool calls",
        },
      ]);

      const result = await execute({
        action: "agent_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.stuckAgents).toHaveLength(1);
      expect(result.stuckAgents[0].agentId).toBe("stuck-agent");
    });
  });

  describe("kill_agent", () => {
    it("returns error when session not found", async () => {
      vi.spyOn(trackerModule, "getSession").mockReturnValue(null);

      const result = await execute({
        action: "kill_agent",
        project_id: PROJECT,
        session_key: "nonexistent",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Session not found");
    });

    it("rejects kill of non-stuck agent without force", async () => {
      vi.spyOn(trackerModule, "getSession").mockReturnValue({
        sessionKey: "sess-1",
        agentId: "worker-1",
        projectId: PROJECT,
        requirements: [],
        satisfied: new Map(),
        metrics: {
          startedAt: Date.now() - 10_000,
          toolCalls: [],
          firstToolCallAt: null,
          lastToolCallAt: null,
          requiredCallTimings: [],
          errorCount: 0,
        },
      });
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([]);

      const result = await execute({
        action: "kill_agent",
        project_id: PROJECT,
        session_key: "sess-1",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not stuck");
    });

    it("kills a stuck agent", async () => {
      vi.spyOn(trackerModule, "getSession").mockReturnValue({
        sessionKey: "sess-stuck",
        agentId: "worker-1",
        projectId: PROJECT,
        requirements: [],
        satisfied: new Map(),
        metrics: {
          startedAt: Date.now() - 600_000,
          toolCalls: [],
          firstToolCallAt: null,
          lastToolCallAt: null,
          requiredCallTimings: [],
          errorCount: 0,
        },
      });
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([
        {
          sessionKey: "sess-stuck",
          agentId: "worker-1",
          projectId: PROJECT,
          runtimeMs: 600_000,
          lastToolCallMs: null,
          requiredCallsMade: 0,
          requiredCallsTotal: 0,
          reason: "Stuck",
        },
      ]);
      vi.spyOn(autoKillModule, "killStuckAgent").mockResolvedValue(true);

      const result = await execute({
        action: "kill_agent",
        project_id: PROJECT,
        session_key: "sess-stuck",
      });

      expect(result.ok).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.agentId).toBe("worker-1");
      expect(result.warning).toBeUndefined();
    });

    it("force-kills with warning when agent is not stuck", async () => {
      vi.spyOn(trackerModule, "getSession").mockReturnValue({
        sessionKey: "sess-1",
        agentId: "worker-1",
        projectId: PROJECT,
        requirements: [],
        satisfied: new Map(),
        metrics: {
          startedAt: Date.now() - 10_000,
          toolCalls: [],
          firstToolCallAt: null,
          lastToolCallAt: null,
          requiredCallTimings: [],
          errorCount: 0,
        },
      });
      vi.spyOn(stuckDetectorModule, "detectStuckAgents").mockReturnValue([]);
      vi.spyOn(autoKillModule, "killStuckAgent").mockResolvedValue(true);

      const result = await execute({
        action: "kill_agent",
        project_id: PROJECT,
        session_key: "sess-1",
        force: true,
      });

      expect(result.ok).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.warning).toContain("not stuck");
    });

    it("rejects kill when session belongs to different project", async () => {
      vi.spyOn(trackerModule, "getSession").mockReturnValue({
        sessionKey: "sess-1",
        agentId: "worker-1",
        projectId: "other-project",
        requirements: [],
        satisfied: new Map(),
        metrics: {
          startedAt: Date.now(),
          toolCalls: [],
          firstToolCallAt: null,
          lastToolCallAt: null,
          requiredCallTimings: [],
          errorCount: 0,
        },
      });

      const result = await execute({
        action: "kill_agent",
        project_id: PROJECT,
        session_key: "sess-1",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("belongs to project other-project");
    });
  });

  describe("disable_agent", () => {
    it("disables an agent", async () => {
      const result = await execute({
        action: "disable_agent",
        project_id: PROJECT,
        agent_id: "worker-1",
        reason: "Misbehaving",
      });

      expect(result.ok).toBe(true);
      expect(result.agentId).toBe("worker-1");
      expect(result.disabled).toBe(true);
      expect(result.reason).toBe("Misbehaving");

      // Verify it's actually disabled
      expect(disabledStoreModule.isAgentDisabled(PROJECT, "worker-1", db)).toBe(true);
    });

    it("uses default reason when none provided", async () => {
      const result = await execute({
        action: "disable_agent",
        project_id: PROJECT,
        agent_id: "worker-1",
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe("Terminated by manager");
    });
  });

  describe("enable_agent", () => {
    it("enables a disabled agent", async () => {
      disabledStoreModule.disableAgent(PROJECT, "worker-1", "Test disable", db);

      const result = await execute({
        action: "enable_agent",
        project_id: PROJECT,
        agent_id: "worker-1",
      });

      expect(result.ok).toBe(true);
      expect(result.agentId).toBe("worker-1");
      expect(result.disabled).toBe(false);

      // Verify it's re-enabled
      expect(disabledStoreModule.isAgentDisabled(PROJECT, "worker-1", db)).toBe(false);
    });

    it("returns error for non-disabled agent", async () => {
      const result = await execute({
        action: "enable_agent",
        project_id: PROJECT,
        agent_id: "worker-1",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not disabled");
    });
  });

  describe("reassign", () => {
    async function createTask(assignedTo?: string) {
      const { createTask: createTaskFn } = await import("../../src/tasks/ops.js");
      return createTaskFn({
        projectId: PROJECT,
        title: "Test task",
        createdBy: "orchestrator",
        assignedTo,
      }, db);
    }

    it("reassigns an ASSIGNED task", async () => {
      const task = await createTask("agent:old");

      const result = await execute({
        action: "reassign",
        project_id: PROJECT,
        task_id: task.id,
        new_assignee: "agent:new",
      });

      expect(result.ok).toBe(true);
      expect(result.previousAssignee).toBe("agent:old");
      expect(result.newAssignee).toBe("agent:new");
      expect(result.newState).toBe("ASSIGNED");

      // Verify worker registry updated
      expect(workerRegistryModule.getWorkerAssignment("agent:old")).toBeNull();
      expect(workerRegistryModule.getWorkerAssignment("agent:new")).not.toBeNull();
    });

    it("reassigns an IN_PROGRESS task (reverts to ASSIGNED)", async () => {
      const { transitionTask } = await import("../../src/tasks/ops.js");
      const task = await createTask("agent:old");

      // Move to IN_PROGRESS
      transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "IN_PROGRESS",
        actor: "agent:old",
      }, db);

      const result = await execute({
        action: "reassign",
        project_id: PROJECT,
        task_id: task.id,
        new_assignee: "agent:new",
      });

      expect(result.ok).toBe(true);
      expect(result.previousState).toBe("IN_PROGRESS");
      expect(result.newState).toBe("ASSIGNED");
      expect(result.newAssignee).toBe("agent:new");
    });

    it("rejects reassign of task in invalid state", async () => {
      const task = await createTask();

      const result = await execute({
        action: "reassign",
        project_id: PROJECT,
        task_id: task.id,
        new_assignee: "agent:new",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Cannot reassign task in state OPEN");
    });

    it("returns error for non-existent task", async () => {
      const result = await execute({
        action: "reassign",
        project_id: PROJECT,
        task_id: "nonexistent",
        new_assignee: "agent:new",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("Task not found");
    });
  });

  describe("query_audit", () => {
    it("returns empty results when no audit entries", async () => {
      const result = await execute({
        action: "query_audit",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.table).toBe("audit_log");
      expect(result.count).toBe(0);
      expect(result.entries).toEqual([]);
    });

    it("returns audit entries filtered by actor", async () => {
      const { writeAuditEntry: writeAudit } = await import("../../src/audit.js");
      writeAudit({
        projectId: PROJECT,
        actor: "agent:alice",
        action: "create",
        targetType: "task",
        targetId: "task-1",
      }, db);
      writeAudit({
        projectId: PROJECT,
        actor: "agent:bob",
        action: "transition",
        targetType: "task",
        targetId: "task-2",
      }, db);

      const result = await execute({
        action: "query_audit",
        project_id: PROJECT,
        actor: "agent:alice",
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(result.entries[0].actor).toBe("agent:alice");
    });

    it("queries audit_runs table when it exists", async () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("run-1", PROJECT, "worker-1", "sess-1", "compliant", now - 5000, now, 5000);

      const result = await execute({
        action: "query_audit",
        project_id: PROJECT,
        audit_table: "audit_runs",
      });

      expect(result.ok).toBe(true);
      expect(result.table).toBe("audit_runs");
      expect(result.count).toBe(1);
    });

    it("respects since and limit filters", async () => {
      const { writeAuditEntry: writeAudit } = await import("../../src/audit.js");
      const now = Date.now();

      writeAudit({
        projectId: PROJECT,
        actor: "agent:a",
        action: "create",
        targetType: "task",
        targetId: "task-1",
      }, db);
      writeAudit({
        projectId: PROJECT,
        actor: "agent:b",
        action: "create",
        targetType: "task",
        targetId: "task-2",
      }, db);

      const result = await execute({
        action: "query_audit",
        project_id: PROJECT,
        limit: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
    });
  });

  describe("trigger_sweep", () => {
    it("runs sweep and returns result", async () => {
      const mockResult = {
        stale: 0,
        autoBlocked: 0,
        deadlineExpired: 0,
        workflowsAdvanced: 0,
        escalated: 0,
        complianceBlocked: 0,
        stuckKilled: 0,
      };
      vi.spyOn(sweepModule, "sweep").mockResolvedValue(mockResult);

      const result = await execute({
        action: "trigger_sweep",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.sweep).toEqual(mockResult);
    });

    it("creates audit entry for sweep", async () => {
      vi.spyOn(sweepModule, "sweep").mockResolvedValue({
        stale: 1,
        autoBlocked: 0,
        deadlineExpired: 0,
        workflowsAdvanced: 0,
        escalated: 0,
        complianceBlocked: 0,
        stuckKilled: 0,
      });

      await execute({
        action: "trigger_sweep",
        project_id: PROJECT,
      });

      // Verify audit entry was created
      const { queryAuditLog: queryAudit } = await import("../../src/audit.js");
      const entries = queryAudit({ projectId: PROJECT, action: "trigger_sweep" }, db);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.actor).toBe("orchestrator-session");
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

  describe("dispatch_metrics", () => {
    it("returns dispatch health dashboard with zero counts", async () => {
      const result = await execute({
        action: "dispatch_metrics",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.timeWindow).toBeDefined();
      expect(result.timeWindow.since).toBeLessThan(result.timeWindow.until);
      expect(result.dispatchSuccess.count).toBe(0);
      expect(result.dispatchFailure.count).toBe(0);
      expect(result.deadLetterCount).toBe(0);
      expect(result.stateStuckCount).toBe(0);
      expect(result.leaseExpiredCount).toBe(0);
      expect(result.successRate).toBeNull();
      expect(result.recentFailures).toEqual([]);
    });

    it("returns populated metrics after recording dispatch data", async () => {
      const { recordMetric } = await import("../../src/metrics.js");

      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_success", value: 1, subject: "task-1" }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_success", value: 1, subject: "task-2" }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_failure", value: 1, subject: "task-3", tags: { reason: "agent_error" } }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_dead_letter", value: 1, subject: "task-3" }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_state_stuck", value: 1, subject: "task-4" }, db);

      const result = await execute({
        action: "dispatch_metrics",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.dispatchSuccess.count).toBe(2);
      expect(result.dispatchFailure.count).toBe(1);
      expect(result.deadLetterCount).toBe(1);
      expect(result.stateStuckCount).toBe(1);
      expect(result.successRate).toBeCloseTo(66.67, 0);
      expect(result.recentFailures).toHaveLength(1);
    });

    it("respects custom since parameter", async () => {
      const { recordMetric } = await import("../../src/metrics.js");

      // Record a metric in the past (beyond 1h window)
      const oldMetric = recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_success", value: 1 }, db);
      // Backdating by updating created_at
      db.prepare("UPDATE metrics SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 60 * 60 * 1000, oldMetric.id);

      // Record a recent metric
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_success", value: 1 }, db);

      const result = await execute({
        action: "dispatch_metrics",
        project_id: PROJECT,
        since: Date.now() - 60 * 60 * 1000, // last 1 hour
      });

      expect(result.ok).toBe(true);
      expect(result.dispatchSuccess.count).toBe(1);
    });
  });

  describe("queue_status alerts", () => {
    it("includes alerts in queue_status response", async () => {
      const result = await execute({
        action: "queue_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.alerts).toBeDefined();
      expect(result.alerts.deadLettersLast1h).toBe(0);
      expect(result.alerts.stateStuckLast1h).toBe(0);
    });

    it("reflects recent dead letter and state stuck counts in alerts", async () => {
      const { recordMetric } = await import("../../src/metrics.js");

      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_dead_letter", value: 1 }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_dead_letter", value: 1 }, db);
      recordMetric({ projectId: PROJECT, type: "dispatch", key: "dispatch_state_stuck", value: 1 }, db);

      const result = await execute({
        action: "queue_status",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.alerts.deadLettersLast1h).toBe(2);
      expect(result.alerts.stateStuckLast1h).toBe(1);
    });
  });

  describe("missing required params", () => {
    it("returns error when project_id is missing", async () => {
      const result = await execute({
        action: "agent_status",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("project_id");
    });
  });
});
