/**
 * Tests for the GoalsNamespace SDK wrapper.
 *
 * Strategy: call internal ops functions directly with a shared in-memory DB
 * via dbOverride to keep tests deterministic and isolated. The GoalsNamespace
 * methods are tested by calling the internal functions directly with dbOverride
 * — matching the exact code paths the namespace wraps.
 *
 * Vocabulary mapping (group → department) is verified end-to-end by calling
 * create/list with group params and asserting the returned Goal's group field.
 */

import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
  createGoal,
  getGoal,
  listGoals,
  achieveGoal,
  abandonGoal,
  linkTaskToGoal,
  getGoalTasks,
  getChildGoals,
  getInitiativeSpend,
} = await import("../../src/goals/ops.js");
const { createTask } = await import("../../src/tasks/ops.js");

// ---- Helper: internal Goal → public Goal (mirrors the SDK's toPublicGoal) ----

function toPublic(g: ReturnType<typeof getGoal>): any {
  if (!g) return undefined;
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    status: g.status,
    group: g.department,
    owner: g.ownerAgentId,
    priority: g.priority ?? "medium",
    createdAt: g.createdAt,
  };
}

// ---- Test helpers ----

const DOMAIN = "test-project";

function mkGoal(db: DatabaseSync, params: {
  title: string;
  description?: string;
  group?: string;
  owner?: string;
  priority?: string;
  parentGoalId?: string;
  metadata?: Record<string, unknown>;
  allocation?: number;
  actor?: string;
}) {
  return toPublic(createGoal({
    projectId: DOMAIN,
    title: params.title,
    description: params.description,
    department: params.group,
    ownerAgentId: params.owner,
    priority: params.priority as any,
    parentGoalId: params.parentGoalId,
    metadata: params.metadata,
    allocation: params.allocation,
    createdBy: params.actor ?? "sdk",
  }, db));
}

// ---- Tests ----

describe("GoalsNamespace (via internal ops + dbOverride)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- GoalsNamespace class ----------

  describe("GoalsNamespace class", () => {
    it("exposes domain string on instance", async () => {
      const { GoalsNamespace } = await import("../../src/sdk/goals.js");
      const ns = new GoalsNamespace("research-lab");
      expect(ns.domain).toBe("research-lab");
    });

    it("stores arbitrary domain strings", async () => {
      const { GoalsNamespace } = await import("../../src/sdk/goals.js");
      expect(new GoalsNamespace("my-project").domain).toBe("my-project");
      expect(new GoalsNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- create ----------

  describe("create", () => {
    it("creates a goal in active status with required fields", () => {
      const goal = mkGoal(db, { title: "Launch product" });
      expect(goal.id).toBeTruthy();
      expect(goal.title).toBe("Launch product");
      expect(goal.status).toBe("active");
      expect(typeof goal.createdAt).toBe("number");
    });

    it("passes through description, owner, priority", () => {
      const goal = mkGoal(db, {
        title: "Detailed goal",
        description: "Make it great",
        owner: "agent:alice",
        priority: "P0",
      });
      expect(goal.description).toBe("Make it great");
      expect(goal.owner).toBe("agent:alice");
      expect(goal.priority).toBe("P0");
    });

    it("assigns a unique id to each goal", () => {
      const a = mkGoal(db, { title: "Goal A" });
      const b = mkGoal(db, { title: "Goal B" });
      expect(a.id).not.toBe(b.id);
    });

    it("creates a child goal linked via parentGoalId", () => {
      const parent = mkGoal(db, { title: "Parent" });
      const child = mkGoal(db, { title: "Child", parentGoalId: parent.id });
      expect(child.id).toBeTruthy();

      const raw = getGoal(DOMAIN, child.id, db);
      expect(raw?.parentGoalId).toBe(parent.id);
    });

    it("throws when parentGoalId does not exist", () => {
      expect(() => mkGoal(db, { title: "Orphan", parentGoalId: "no-such-goal" })).toThrow();
    });
  });

  // ---------- vocabulary mapping ----------

  describe("vocabulary mapping (group → department)", () => {
    it("stores group param as department and surfaces it as group on the public Goal", () => {
      const goal = mkGoal(db, { title: "Group goal", group: "engineering" });
      expect(goal.group).toBe("engineering");
    });

    it("goal with no group has undefined group", () => {
      const goal = mkGoal(db, { title: "No group" });
      expect(goal.group).toBeUndefined();
    });

    it("list filter by group maps to internal department column", () => {
      mkGoal(db, { title: "Eng goal", group: "engineering" });
      mkGoal(db, { title: "Sales goal", group: "sales" });
      mkGoal(db, { title: "No group goal" });

      const eng = listGoals(DOMAIN, { department: "engineering" }, db).map(toPublic);
      expect(eng).toHaveLength(1);
      expect(eng[0]!.title).toBe("Eng goal");
      expect(eng[0]!.group).toBe("engineering");
    });
  });

  // ---------- get ----------

  describe("get", () => {
    it("retrieves a goal by id", () => {
      const created = mkGoal(db, { title: "Fetch me" });
      const raw = getGoal(DOMAIN, created.id, db);
      const fetched = toPublic(raw);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe("Fetch me");
    });

    it("returns null for a non-existent goal id", () => {
      const raw = getGoal(DOMAIN, "no-such-id", db);
      expect(raw).toBeNull();
    });
  });

  // ---------- list ----------

  describe("list", () => {
    beforeEach(() => {
      mkGoal(db, { title: "Goal A" });
      mkGoal(db, { title: "Goal B", owner: "agent:bob" });
      mkGoal(db, { title: "Goal C", group: "research" });
    });

    it("lists all goals for the project", () => {
      const goals = listGoals(DOMAIN, {}, db).map(toPublic);
      expect(goals.length).toBe(3);
    });

    it("filters by status", () => {
      const active = listGoals(DOMAIN, { status: "active" }, db).map(toPublic);
      expect(active.length).toBeGreaterThan(0);
      expect(active.every((g) => g.status === "active")).toBe(true);
    });

    it("filters by ownerAgentId", () => {
      const owned = listGoals(DOMAIN, { ownerAgentId: "agent:bob" }, db).map(toPublic);
      expect(owned).toHaveLength(1);
      expect(owned[0]!.owner).toBe("agent:bob");
    });

    it("respects limit", () => {
      const limited = listGoals(DOMAIN, { limit: 1 }, db).map(toPublic);
      expect(limited).toHaveLength(1);
    });

    it("filters by department (group)", () => {
      const research = listGoals(DOMAIN, { department: "research" }, db).map(toPublic);
      expect(research).toHaveLength(1);
      expect(research[0]!.group).toBe("research");
    });
  });

  // ---------- achieve ----------

  describe("achieve", () => {
    it("transitions an active goal to achieved", () => {
      const goal = mkGoal(db, { title: "To achieve" });
      const achieved = toPublic(achieveGoal(DOMAIN, goal.id, "agent:pm", db));
      expect(achieved.status).toBe("achieved");
    });

    it("throws when trying to achieve a non-existent goal", () => {
      expect(() => achieveGoal(DOMAIN, "no-such-id", "agent:pm", db)).toThrow();
    });

    it("throws when trying to achieve an already-achieved goal", () => {
      const goal = mkGoal(db, { title: "Already done" });
      achieveGoal(DOMAIN, goal.id, "agent:pm", db);
      expect(() => achieveGoal(DOMAIN, goal.id, "agent:pm", db)).toThrow();
    });
  });

  // ---------- abandon ----------

  describe("abandon", () => {
    it("transitions an active goal to abandoned", () => {
      const goal = mkGoal(db, { title: "To abandon" });
      const abandoned = toPublic(abandonGoal(DOMAIN, goal.id, "agent:pm", undefined, db));
      expect(abandoned.status).toBe("abandoned");
    });

    it("stores abandon reason in metadata", () => {
      const goal = mkGoal(db, { title: "Abandoned with reason" });
      abandonGoal(DOMAIN, goal.id, "agent:pm", "budget cut", db);
      const raw = getGoal(DOMAIN, goal.id, db);
      expect(raw?.metadata?.abandonReason).toBe("budget cut");
    });

    it("throws when trying to abandon an already-abandoned goal", () => {
      const goal = mkGoal(db, { title: "Already abandoned" });
      abandonGoal(DOMAIN, goal.id, "agent:pm", undefined, db);
      expect(() => abandonGoal(DOMAIN, goal.id, "agent:pm", undefined, db)).toThrow();
    });
  });

  // ---------- linkTask ----------

  describe("linkTask", () => {
    it("links a task to a goal", () => {
      const goal = mkGoal(db, { title: "Goal with tasks" });
      const task = createTask({
        projectId: DOMAIN,
        title: "Task to link",
        createdBy: "sdk",
      }, db);

      linkTaskToGoal(DOMAIN, task.id, goal.id, db);

      const linkedTasks = getGoalTasks(DOMAIN, goal.id, db);
      expect(linkedTasks).toHaveLength(1);
      expect(linkedTasks[0]!.id).toBe(task.id);
    });

    it("returns all tasks linked to a goal", () => {
      const goal = mkGoal(db, { title: "Multi-task goal" });
      const t1 = createTask({ projectId: DOMAIN, title: "Task 1", createdBy: "sdk" }, db);
      const t2 = createTask({ projectId: DOMAIN, title: "Task 2", createdBy: "sdk" }, db);

      linkTaskToGoal(DOMAIN, t1.id, goal.id, db);
      linkTaskToGoal(DOMAIN, t2.id, goal.id, db);

      const linkedTasks = getGoalTasks(DOMAIN, goal.id, db);
      expect(linkedTasks).toHaveLength(2);
    });

    it("throws when goal does not exist", () => {
      const task = createTask({ projectId: DOMAIN, title: "Orphan task", createdBy: "sdk" }, db);
      expect(() => linkTaskToGoal(DOMAIN, task.id, "no-such-goal", db)).toThrow();
    });

    it("throws when task does not exist", () => {
      const goal = mkGoal(db, { title: "Goal for missing task" });
      expect(() => linkTaskToGoal(DOMAIN, "no-such-task", goal.id, db)).toThrow();
    });

    it("returns empty array for a goal with no tasks", () => {
      const goal = mkGoal(db, { title: "Empty goal" });
      const tasks = getGoalTasks(DOMAIN, goal.id, db);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks).toHaveLength(0);
    });
  });

  // ---------- children ----------

  describe("children", () => {
    it("returns direct child goals", () => {
      const parent = mkGoal(db, { title: "Parent goal" });
      mkGoal(db, { title: "Child 1", parentGoalId: parent.id });
      mkGoal(db, { title: "Child 2", parentGoalId: parent.id });
      mkGoal(db, { title: "Unrelated goal" });

      const children = getChildGoals(DOMAIN, parent.id, db).map(toPublic);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.title).sort()).toEqual(["Child 1", "Child 2"]);
    });

    it("returns empty array for a leaf goal", () => {
      const goal = mkGoal(db, { title: "Leaf" });
      const children = getChildGoals(DOMAIN, goal.id, db);
      expect(children).toHaveLength(0);
    });
  });

  // ---------- spend ----------

  describe("spend", () => {
    it("returns 0 for a goal with no linked tasks", () => {
      const goal = mkGoal(db, { title: "Empty spend goal", allocation: 10000 });
      const spend = getInitiativeSpend(DOMAIN, goal.id, db);
      expect(spend).toBe(0);
    });

    it("returns 0 for an unknown goal", () => {
      const spend = getInitiativeSpend(DOMAIN, "no-such-id", db);
      expect(spend).toBe(0);
    });
  });
});
