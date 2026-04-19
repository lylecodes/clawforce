import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { createTask } = await import("../../src/tasks/ops.js");
const {
  addDependency,
  removeDependency,
  getTaskDependencies,
  getTaskDependents,
  getUnresolvedBlockers,
  cascadeUnblock,
} = await import("../../src/tasks/deps.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-deps";

function makeTask(title: string, state?: string) {
  const task = createTask({
    projectId: PROJECT,
    title,
    createdBy: "agent:test",
  }, db);
  if (state && state !== "OPEN") {
    db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, task.id);
  }
  return task;
}

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("addDependency", () => {
  it("creates a dependency between two tasks", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    const result = addDependency({
      projectId: PROJECT,
      taskId: b.id,
      dependsOnTaskId: a.id,
      createdBy: "agent:mgr",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dependency.taskId).toBe(b.id);
      expect(result.dependency.dependsOnTaskId).toBe(a.id);
      expect(result.dependency.type).toBe("blocks");
    }
  });

  it("supports soft dependencies", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    const result = addDependency({
      projectId: PROJECT,
      taskId: b.id,
      dependsOnTaskId: a.id,
      type: "soft",
      createdBy: "agent:mgr",
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dependency.type).toBe("soft");
    }
  });

  it("rejects self-dependency", () => {
    const a = makeTask("Task A");
    const result = addDependency({
      projectId: PROJECT,
      taskId: a.id,
      dependsOnTaskId: a.id,
      createdBy: "agent:mgr",
    }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("itself");
  });

  it("rejects duplicate dependency", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    const result = addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("already exists");
  });

  it("rejects nonexistent task", () => {
    const a = makeTask("Task A");
    const result = addDependency({
      projectId: PROJECT,
      taskId: "nonexistent",
      dependsOnTaskId: a.id,
      createdBy: "agent:mgr",
    }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not found");
  });

  it("detects direct cycles", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    const result = addDependency({ projectId: PROJECT, taskId: a.id, dependsOnTaskId: b.id, createdBy: "agent:mgr" }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cycle");
  });

  it("detects transitive cycles", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");
    const c = makeTask("Task C");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: b.id, createdBy: "agent:mgr" }, db);
    // a → b → c, now try c → a (cycle)
    const result = addDependency({ projectId: PROJECT, taskId: a.id, dependsOnTaskId: c.id, createdBy: "agent:mgr" }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cycle");
  });
});

describe("removeDependency", () => {
  it("removes an existing dependency", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    const result = removeDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id }, db);

    expect(result.ok).toBe(true);
    expect(getTaskDependencies(PROJECT, b.id, db)).toHaveLength(0);
  });

  it("returns error for nonexistent dependency", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");

    const result = removeDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id }, db);
    expect(result.ok).toBe(false);
  });
});

describe("getTaskDependencies / getTaskDependents", () => {
  it("returns dependencies in both directions", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");
    const c = makeTask("Task C");

    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: b.id, createdBy: "agent:mgr" }, db);

    // C depends on A and B
    const deps = getTaskDependencies(PROJECT, c.id, db);
    expect(deps).toHaveLength(2);

    // A has one dependent (C)
    const dependents = getTaskDependents(PROJECT, a.id, db);
    expect(dependents).toHaveLength(1);
    expect(dependents[0].taskId).toBe(c.id);
  });
});

describe("getUnresolvedBlockers", () => {
  it("returns only hard blockers in non-DONE state", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B", "DONE");
    const c = makeTask("Task C");

    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: b.id, createdBy: "agent:mgr" }, db);

    const blockers = getUnresolvedBlockers(PROJECT, c.id, db);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].dependency.dependsOnTaskId).toBe(a.id);
  });

  it("ignores soft dependencies", () => {
    const a = makeTask("Task A");
    const c = makeTask("Task C");

    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: a.id, type: "soft", createdBy: "agent:mgr" }, db);

    const blockers = getUnresolvedBlockers(PROJECT, c.id, db);
    expect(blockers).toHaveLength(0);
  });
});

describe("cascadeUnblock", () => {
  it("unblocks a BLOCKED task when its last dependency completes", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B", "BLOCKED");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);

    // Mark A as DONE
    db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(a.id);

    const unblocked = cascadeUnblock(PROJECT, a.id, "system:test", db);
    expect(unblocked).toContain(b.id);

    // Verify B is now OPEN
    const bRow = db.prepare("SELECT state FROM tasks WHERE id = ?").get(b.id) as Record<string, unknown>;
    expect(bRow.state).toBe("OPEN");
  });

  it("does NOT unblock when other hard blockers remain", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B");
    const c = makeTask("Task C", "BLOCKED");

    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: b.id, createdBy: "agent:mgr" }, db);

    // Only A completes
    db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(a.id);

    const unblocked = cascadeUnblock(PROJECT, a.id, "system:test", db);
    expect(unblocked).toHaveLength(0);

    // C should still be BLOCKED
    const cRow = db.prepare("SELECT state FROM tasks WHERE id = ?").get(c.id) as Record<string, unknown>;
    expect(cRow.state).toBe("BLOCKED");
  });

  it("unblocks multiple dependents at once", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B", "BLOCKED");
    const c = makeTask("Task C", "BLOCKED");

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);
    addDependency({ projectId: PROJECT, taskId: c.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);

    db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(a.id);

    const unblocked = cascadeUnblock(PROJECT, a.id, "system:test", db);
    expect(unblocked).toHaveLength(2);
    expect(unblocked).toContain(b.id);
    expect(unblocked).toContain(c.id);
  });

  it("ignores non-BLOCKED dependents", () => {
    const a = makeTask("Task A");
    const b = makeTask("Task B"); // OPEN, not BLOCKED

    addDependency({ projectId: PROJECT, taskId: b.id, dependsOnTaskId: a.id, createdBy: "agent:mgr" }, db);

    db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(a.id);

    const unblocked = cascadeUnblock(PROJECT, a.id, "system:test", db);
    expect(unblocked).toHaveLength(0);
  });
});
