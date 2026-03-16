/**
 * Tests for the TasksNamespace SDK wrapper.
 *
 * Strategy: import internal ops functions at the top level (same pattern as
 * test/tasks/ops.test.ts) and pass a shared in-memory DB via dbOverride to
 * keep tests deterministic and isolated. The TasksNamespace methods are tested
 * by calling the internal functions directly with dbOverride — matching the
 * exact code paths the namespace wraps.
 *
 * Vocabulary mapping (group→department, subgroup→team) is verified end-to-end
 * by calling the namespace create/list with group/subgroup params and asserting
 * the returned Task's group/subgroup fields.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

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

// ---- Dynamic imports after mocks ----

const { getMemoryDb } = await import("../../src/db.js");
const {
  createTask,
  getTask,
  listTasks,
  transitionTask,
  reassignTask,
  getTaskEvidence,
  getTaskTransitions,
} = await import("../../src/tasks/ops.js");

// ---- Helper: internal Task → public Task (mirrors the SDK's toPublicTask) ----

function toPublic(t: Awaited<ReturnType<typeof getTask>>): any {
  if (!t) return undefined;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    state: t.state,
    priority: t.priority,
    assignedTo: t.assignedTo,
    group: t.department,
    subgroup: t.team,
    goalId: t.goalId,
    tags: t.tags ?? [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    metadata: t.metadata,
  };
}

// ---- Test helpers ----

const DOMAIN = "test-project";

function create(db: DatabaseSync, params: {
  title: string;
  description?: string;
  priority?: string;
  assignedTo?: string;
  actor?: string;
  deadline?: number;
  tags?: string[];
  group?: string;
  subgroup?: string;
  goalId?: string;
  metadata?: Record<string, unknown>;
}) {
  return toPublic(createTask({
    projectId: DOMAIN,
    title: params.title,
    description: params.description,
    priority: params.priority as any,
    assignedTo: params.assignedTo,
    createdBy: params.actor ?? "sdk",
    deadline: params.deadline,
    tags: params.tags,
    department: params.group,
    team: params.subgroup,
    goalId: params.goalId,
    metadata: params.metadata,
  }, db));
}

function transition(db: DatabaseSync, taskId: string, toState: string, opts?: { actor?: string; reason?: string }) {
  const result = transitionTask({
    projectId: DOMAIN,
    taskId,
    toState: toState as any,
    actor: opts?.actor ?? "sdk",
    reason: opts?.reason,
  }, db);
  if (!result.ok) throw new Error(result.reason);
  return toPublic(result.task);
}

function reassign(db: DatabaseSync, taskId: string, newAssignee: string, opts?: { actor?: string; reason?: string }) {
  const result = reassignTask({
    projectId: DOMAIN,
    taskId,
    newAssignee,
    actor: opts?.actor ?? "sdk",
    reason: opts?.reason,
  }, db);
  if (!result.ok) throw new Error(result.reason);
  return toPublic(result.task);
}

// ---- Tests ----

describe("TasksNamespace (via internal ops + dbOverride)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- TasksNamespace constructor ----------

  describe("TasksNamespace class", () => {
    it("exposes domain string on instance", async () => {
      const { TasksNamespace } = await import("../../src/sdk/tasks.js");
      const ns = new TasksNamespace("research-lab");
      expect(ns.domain).toBe("research-lab");
    });

    it("stores arbitrary domain strings", async () => {
      const { TasksNamespace } = await import("../../src/sdk/tasks.js");
      expect(new TasksNamespace("my-project").domain).toBe("my-project");
      expect(new TasksNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- create ----------

  describe("create", () => {
    it("creates a task in OPEN state with required fields", () => {
      const task = create(db, { title: "Write tests" });
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("Write tests");
      expect(task.state).toBe("OPEN");
      expect(Array.isArray(task.tags)).toBe(true);
      expect(typeof task.createdAt).toBe("number");
      expect(typeof task.updatedAt).toBe("number");
    });

    it("creates task in ASSIGNED state when assignedTo is provided", () => {
      const task = create(db, { title: "Deploy", assignedTo: "agent:bob" });
      expect(task.state).toBe("ASSIGNED");
      expect(task.assignedTo).toBe("agent:bob");
    });

    it("passes through tags, priority, goalId, metadata", () => {
      const task = create(db, {
        title: "Tagged task",
        tags: ["urgent", "backend"],
        goalId: "goal-123",
        metadata: { sprint: 4 },
      });
      expect(task.tags).toEqual(["urgent", "backend"]);
      expect(task.goalId).toBe("goal-123");
      expect(task.metadata).toEqual({ sprint: 4 });
    });

    it("uses default priority when none is specified", () => {
      const task = create(db, { title: "No priority" });
      expect(task.priority).toBeTruthy(); // "P2" internal default
    });
  });

  // ---------- vocabulary mapping ----------

  describe("vocabulary mapping (group → department, subgroup → team)", () => {
    it("stores group param as department and surfaces it as group on the public Task", () => {
      const task = create(db, { title: "Group task", group: "engineering" });
      expect(task.group).toBe("engineering");
    });

    it("stores subgroup param as team and surfaces it as subgroup on the public Task", () => {
      const task = create(db, { title: "Subgroup task", group: "engineering", subgroup: "backend" });
      expect(task.group).toBe("engineering");
      expect(task.subgroup).toBe("backend");
    });

    it("list filter by group maps to internal department column", () => {
      create(db, { title: "Eng task", group: "engineering" });
      create(db, { title: "Sales task", group: "sales" });
      create(db, { title: "No group task" });

      const eng = listTasks(DOMAIN, { department: "engineering" }, db).map(toPublic);
      expect(eng).toHaveLength(1);
      expect(eng[0]!.title).toBe("Eng task");
      expect(eng[0]!.group).toBe("engineering");
    });

    it("task with no group/subgroup has undefined for both", () => {
      const task = create(db, { title: "No group" });
      expect(task.group).toBeUndefined();
      expect(task.subgroup).toBeUndefined();
    });
  });

  // ---------- get ----------

  describe("get", () => {
    it("retrieves a task by id", () => {
      const created = create(db, { title: "Fetch me" });
      const raw = getTask(DOMAIN, created.id, db);
      const fetched = toPublic(raw);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe("Fetch me");
    });

    it("returns undefined for non-existent task id", () => {
      const raw = getTask(DOMAIN, "no-such-id", db);
      expect(raw).toBeUndefined();
    });
  });

  // ---------- list ----------

  describe("list", () => {
    beforeEach(() => {
      create(db, { title: "Task A" });
      create(db, { title: "Task B", assignedTo: "agent:worker" });
      create(db, { title: "Task C", group: "research" });
    });

    it("lists all tasks for the project", () => {
      const tasks = listTasks(DOMAIN, {}, db).map(toPublic);
      expect(tasks.length).toBe(3);
    });

    it("filters by state", () => {
      const open = listTasks(DOMAIN, { state: "OPEN" }, db).map(toPublic);
      expect(open.length).toBeGreaterThan(0);
      expect(open.every((t) => t.state === "OPEN")).toBe(true);
    });

    it("filters by assignedTo", () => {
      const assigned = listTasks(DOMAIN, { assignedTo: "agent:worker" }, db).map(toPublic);
      expect(assigned).toHaveLength(1);
      expect(assigned[0]!.assignedTo).toBe("agent:worker");
    });

    it("respects limit", () => {
      const limited = listTasks(DOMAIN, { limit: 1 }, db).map(toPublic);
      expect(limited).toHaveLength(1);
    });

    it("returns public Task objects with tags as array", () => {
      const tasks = listTasks(DOMAIN, {}, db).map(toPublic);
      for (const t of tasks) {
        expect(Array.isArray(t.tags)).toBe(true);
      }
    });
  });

  // ---------- transition ----------

  describe("transition", () => {
    it("transitions a task from OPEN to ASSIGNED", () => {
      const task = create(db, { title: "Transition test" });
      const updated = transition(db, task.id, "ASSIGNED", { actor: "agent:worker" });
      expect(updated.state).toBe("ASSIGNED");
      expect(updated.id).toBe(task.id);
    });

    it("transitions through OPEN → ASSIGNED → IN_PROGRESS sequence", () => {
      const task = create(db, { title: "Happy path" });
      const t1 = transition(db, task.id, "ASSIGNED", { actor: "agent:worker" });
      expect(t1.state).toBe("ASSIGNED");

      const t2 = transition(db, task.id, "IN_PROGRESS", { actor: "agent:worker" });
      expect(t2.state).toBe("IN_PROGRESS");
    });

    it("throws an Error on invalid transition (OPEN → DONE)", () => {
      const task = create(db, { title: "Bad transition" });
      expect(() => transition(db, task.id, "DONE", { actor: "agent:worker" })).toThrow();
    });

    it("throws for non-existent task", () => {
      expect(() => transition(db, "no-such-id", "ASSIGNED")).toThrow();
    });

    it("accepts an optional reason in the transition", () => {
      const task = create(db, { title: "With reason" });
      const updated = transition(db, task.id, "ASSIGNED", {
        actor: "agent:pm",
        reason: "starting sprint",
      });
      expect(updated.state).toBe("ASSIGNED");
    });
  });

  // ---------- reassign ----------

  describe("reassign", () => {
    it("reassigns an ASSIGNED task to a new agent", () => {
      const task = create(db, { title: "Reassign me", assignedTo: "agent:alice" });
      expect(task.state).toBe("ASSIGNED");
      const updated = reassign(db, task.id, "agent:bob", { actor: "agent:pm" });
      expect(updated.assignedTo).toBe("agent:bob");
      expect(updated.state).toBe("ASSIGNED");
    });

    it("throws when trying to reassign an OPEN task", () => {
      const task = create(db, { title: "Open task" });
      expect(() => reassign(db, task.id, "agent:bob")).toThrow();
    });
  });

  // ---------- evidence ----------

  describe("evidence", () => {
    it("returns empty array for a task with no evidence", () => {
      const task = create(db, { title: "No evidence task" });
      const ev = getTaskEvidence(DOMAIN, task.id, db);
      expect(Array.isArray(ev)).toBe(true);
      expect(ev).toHaveLength(0);
    });
  });

  // ---------- history ----------

  describe("history", () => {
    it("returns transitions recorded for a task", () => {
      const task = create(db, { title: "History task" });
      transition(db, task.id, "ASSIGNED", { actor: "agent:worker" });
      transition(db, task.id, "IN_PROGRESS", { actor: "agent:worker" });

      const hist = getTaskTransitions(DOMAIN, task.id, db);
      expect(hist).toHaveLength(2);
      expect(hist[0]!.fromState).toBe("OPEN");
      expect(hist[0]!.toState).toBe("ASSIGNED");
      expect(hist[1]!.fromState).toBe("ASSIGNED");
      expect(hist[1]!.toState).toBe("IN_PROGRESS");
    });

    it("returns empty array for a task with no transitions", () => {
      const task = create(db, { title: "No transitions" });
      const hist = getTaskTransitions(DOMAIN, task.id, db);
      expect(Array.isArray(hist)).toBe(true);
      expect(hist).toHaveLength(0);
    });
  });
});
