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
const { createTask, transitionTask, getTask } = await import("../../src/tasks/ops.js");
const { autoAssign } = await import("../../src/assignment/engine.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const { listEvents } = await import("../../src/events/store.js");

describe("assignment/engine", () => {
  let db: DatabaseSync;
  const PROJECT = "assignment-test";

  function registerAgents(agents: Record<string, { extends?: string; tools?: string[]; department?: string; team?: string }>) {
    const agentConfig: Record<string, any> = {};
    for (const [id, cfg] of Object.entries(agents)) {
      agentConfig[id] = {
        extends: cfg.extends ?? "employee",
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
        tools: cfg.tools,
        department: cfg.department,
        team: cfg.team,
      };
    }
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: agentConfig,
    });
  }

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  describe("config checks", () => {
    it("returns assigned: false when config.enabled is false", () => {
      registerAgents({ "worker-1": {} });
      const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "pm" }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: false,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("returns assigned: false when task is not OPEN", () => {
      registerAgents({ "worker-1": {} });
      const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "pm", assignedTo: "worker-1" }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(false);
      expect(result.reason).toContain("not in OPEN");
    });

    it("returns assigned: false when task already has assignedTo", () => {
      registerAgents({ "worker-1": {} });
      // Create a task that's in OPEN but has assignedTo set (edge case)
      const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "pm" }, db);

      // Manually set assignedTo without changing state
      db.prepare("UPDATE tasks SET assigned_to = ? WHERE id = ?").run("someone", task.id);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(false);
      expect(result.reason).toContain("already assigned");
    });

    it("returns assigned: false when no eligible agents", () => {
      // Register only a manager (not employee) — shouldn't be eligible
      registerWorkforceConfig(PROJECT, {
        name: "test",
        agents: {
          "manager-1": { extends: "manager", coordination: { enabled: true }, briefing: [], expectations: [], performance_policy: { action: "alert" } },
        },
      });

      const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "pm" }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(false);
      expect(result.reason).toContain("No eligible agents");
    });
  });

  describe("workload_balanced strategy", () => {
    it("picks agent with fewest active tasks", () => {
      registerAgents({ "worker-1": {}, "worker-2": {} });

      // Give worker-1 an existing active task
      createTask({ projectId: PROJECT, title: "Existing", createdBy: "pm", assignedTo: "worker-1" }, db);

      // New OPEN task
      const task = createTask({ projectId: PROJECT, title: "New task", createdBy: "pm" }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("worker-2"); // worker-2 has 0 tasks vs worker-1's 1
    });

    it("assigns when only one agent is eligible", () => {
      registerAgents({ "worker-1": {} });

      const task = createTask({ projectId: PROJECT, title: "Solo task", createdBy: "pm" }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("worker-1");
    });

    it("transitions task to ASSIGNED on success", () => {
      registerAgents({ "worker-1": {} });

      const task = createTask({ projectId: PROJECT, title: "Transition task", createdBy: "pm" }, db);

      autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      const updated = getTask(PROJECT, task.id, db);
      expect(updated?.state).toBe("ASSIGNED");
      expect(updated?.assignedTo).toBe("worker-1");
    });
  });

  describe("round_robin strategy", () => {
    it("rotates through agents", () => {
      registerAgents({ "alpha": {}, "beta": {}, "gamma": {} });

      // First assignment
      const t1 = createTask({ projectId: PROJECT, title: "RR1", createdBy: "pm" }, db);
      const r1 = autoAssign(PROJECT, t1.id, {
        enabled: true,
        strategy: "round_robin",
      }, db);
      expect(r1.assigned).toBe(true);

      // Second assignment — should pick a different agent
      const t2 = createTask({ projectId: PROJECT, title: "RR2", createdBy: "pm" }, db);
      const r2 = autoAssign(PROJECT, t2.id, {
        enabled: true,
        strategy: "round_robin",
      }, db);
      expect(r2.assigned).toBe(true);
      expect(r2.agentId).not.toBe(r1.agentId);
    });
  });

  describe("skill_matched strategy", () => {
    it("matches task tags to agent tools", () => {
      registerAgents({
        "frontend-dev": { tools: ["react", "css", "typescript"] },
        "backend-dev": { tools: ["python", "sql", "docker"] },
      });

      const task = createTask({
        projectId: PROJECT,
        title: "Frontend fix",
        createdBy: "pm",
        tags: ["react", "css"],
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "skill_matched",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("frontend-dev");
    });

    it("falls back to workload_balanced when task has no tags", () => {
      registerAgents({
        "worker-1": { tools: ["react"] },
        "worker-2": { tools: ["python"] },
      });

      // Give worker-1 an existing task
      createTask({ projectId: PROJECT, title: "Existing", createdBy: "pm", assignedTo: "worker-1" }, db);

      const task = createTask({
        projectId: PROJECT,
        title: "No tags task",
        createdBy: "pm",
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "skill_matched",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("worker-2"); // less loaded
    });

    it("falls back to workload_balanced when no agents match tags", () => {
      registerAgents({
        "worker-1": { tools: ["react"] },
        "worker-2": { tools: ["python"] },
      });

      const task = createTask({
        projectId: PROJECT,
        title: "Unmatched tags",
        createdBy: "pm",
        tags: ["rust", "wasm"],
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "skill_matched",
      }, db);

      expect(result.assigned).toBe(true);
      // Falls back to workload balanced — either agent is fine
      expect(result.agentId).toBeDefined();
    });
  });

  describe("department/team filtering", () => {
    it("filters agents by department match", () => {
      registerAgents({
        "eng-worker": { department: "engineering" },
        "sales-worker": { department: "sales" },
      });

      const task = createTask({
        projectId: PROJECT,
        title: "Engineering task",
        createdBy: "pm",
        department: "engineering",
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("eng-worker");
    });

    it("filters agents by team match", () => {
      registerAgents({
        "team-a": { team: "alpha" },
        "team-b": { team: "beta" },
      });

      const task = createTask({
        projectId: PROJECT,
        title: "Team task",
        createdBy: "pm",
        team: "beta",
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("team-b");
    });

    it("agents without department can be assigned to any department task", () => {
      registerAgents({
        "general-worker": {}, // no department
        "sales-worker": { department: "sales" },
      });

      const task = createTask({
        projectId: PROJECT,
        title: "Engineering task",
        createdBy: "pm",
        department: "engineering",
      }, db);

      const result = autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      expect(result.assigned).toBe(true);
      expect(result.agentId).toBe("general-worker"); // sales-worker filtered out, general passes
    });
  });

  describe("assignment triggers auto-dispatch", () => {
    it("assignment emits task_assigned event", () => {
      registerAgents({ "worker-1": {} });

      const task = createTask({ projectId: PROJECT, title: "Dispatch trigger", createdBy: "pm" }, db);

      autoAssign(PROJECT, task.id, {
        enabled: true,
        strategy: "workload_balanced",
      }, db);

      // Check that task_assigned event was emitted
      const events = listEvents(PROJECT, { status: "pending" }, db);
      const assignedEvents = events.filter((e) => e.type === "task_assigned");
      expect(assignedEvents.length).toBeGreaterThanOrEqual(1);
      expect(assignedEvents.some((e) => e.payload.taskId === task.id)).toBe(true);
    });
  });
});
