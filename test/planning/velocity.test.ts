import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { attachEvidence } = await import("../../src/tasks/ops.js");
const { transitionTask } = await import("../../src/tasks/ops.js");
const { addDependency } = await import("../../src/tasks/deps.js");
const {
  computeVelocity,
  computeAvgCycleTime,
  estimateETA,
  analyzeBlockerImpact,
  computeCostTrajectory,
  buildVelocityReport,
  renderVelocityReport,
} = await import("../../src/planning/velocity.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-velocity";

/**
 * Create a task and optionally transition it to a target state.
 * For DONE: follows the full valid path with evidence and verifier gate.
 */
function makeTask(title: string, state?: string) {
  const task = createTask({ projectId: PROJECT, title, createdBy: "agent:test" }, db);
  if (state && state !== "OPEN") {
    if (state === "DONE") {
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
      attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:reviewer" }, db);
    } else if (state === "BLOCKED") {
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "BLOCKED", actor: "agent:test" }, db);
    } else if (state === "ASSIGNED") {
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:test" }, db);
    } else if (state === "IN_PROGRESS") {
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    }
  }
  return task;
}

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("computeVelocity", () => {
  it("returns zero windows when no tasks completed", () => {
    makeTask("t1");
    const { windows, trend } = computeVelocity(PROJECT, db);
    expect(windows).toHaveLength(4);
    for (const w of windows) {
      expect(w.completed).toBe(0);
      expect(w.tasksPerHour).toBe(0);
    }
    expect(trend).toBe("insufficient_data");
  });

  it("counts completed tasks in windows", () => {
    makeTask("t1", "DONE");
    makeTask("t2", "DONE");
    makeTask("t3"); // still open

    const { windows } = computeVelocity(PROJECT, db);
    const last1h = windows.find((w) => w.label === "last_1h")!;
    const last24h = windows.find((w) => w.label === "last_24h")!;

    // Both completed within the test so should be in all windows
    expect(last1h.completed).toBe(2);
    expect(last24h.completed).toBe(2);
    expect(last1h.tasksPerHour).toBeGreaterThan(0);
  });
});

describe("computeAvgCycleTime", () => {
  it("returns null when no completed tasks", () => {
    makeTask("t1");
    const avg = computeAvgCycleTime(PROJECT, db);
    expect(avg).toBeNull();
  });

  it("returns average cycle time for completed tasks", () => {
    makeTask("t1", "DONE");
    const avg = computeAvgCycleTime(PROJECT, db);
    // Should be a non-null number (the time between create and DONE transition)
    expect(avg).not.toBeNull();
    expect(avg).toBeGreaterThanOrEqual(0);
  });
});

describe("estimateETA", () => {
  it("returns null when velocity is zero", () => {
    expect(estimateETA(10, 0)).toBeNull();
  });

  it("returns null when no tasks remaining", () => {
    expect(estimateETA(0, 5)).toBeNull();
  });

  it("computes hours correctly", () => {
    expect(estimateETA(10, 2)).toBe(5);
    expect(estimateETA(1, 0.5)).toBe(2);
  });
});

describe("analyzeBlockerImpact", () => {
  it("returns empty array when no blockers", () => {
    makeTask("t1", "DONE");
    const impact = analyzeBlockerImpact(PROJECT, db);
    expect(impact).toHaveLength(0);
  });

  it("identifies blocker with downstream count", () => {
    const blocker = makeTask("blocker");
    const blocked1 = makeTask("blocked1", "BLOCKED");
    const blocked2 = makeTask("blocked2", "BLOCKED");

    addDependency({
      projectId: PROJECT,
      taskId: blocked1.id,
      dependsOnTaskId: blocker.id,
      type: "blocks",
      createdBy: "test",
    }, db);
    addDependency({
      projectId: PROJECT,
      taskId: blocked2.id,
      dependsOnTaskId: blocker.id,
      type: "blocks",
      createdBy: "test",
    }, db);

    const impact = analyzeBlockerImpact(PROJECT, db);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.taskId).toBe(blocker.id);
    expect(impact[0]!.downstreamCount).toBe(2);
    expect(impact[0]!.directlyBlocked).toHaveLength(2);
  });

  it("counts transitive downstream impact", () => {
    const t1 = makeTask("root blocker");
    const t2 = makeTask("mid", "BLOCKED");
    const t3 = makeTask("leaf", "BLOCKED");

    addDependency({ projectId: PROJECT, taskId: t2.id, dependsOnTaskId: t1.id, type: "blocks", createdBy: "test" }, db);
    addDependency({ projectId: PROJECT, taskId: t3.id, dependsOnTaskId: t2.id, type: "blocks", createdBy: "test" }, db);

    const impact = analyzeBlockerImpact(PROJECT, db);
    // t1 blocks t2 (which blocks t3) → downstream = 2
    const rootBlocker = impact.find((b) => b.taskId === t1.id)!;
    expect(rootBlocker).toBeDefined();
    expect(rootBlocker.downstreamCount).toBe(2);
    expect(rootBlocker.directlyBlocked).toEqual([t2.id]);
  });

  it("sorts by downstream impact descending", () => {
    const b1 = makeTask("small blocker");
    const b2 = makeTask("big blocker");
    const d1 = makeTask("d1", "BLOCKED");
    const d2 = makeTask("d2", "BLOCKED");
    const d3 = makeTask("d3", "BLOCKED");

    addDependency({ projectId: PROJECT, taskId: d1.id, dependsOnTaskId: b1.id, type: "blocks", createdBy: "test" }, db);
    addDependency({ projectId: PROJECT, taskId: d2.id, dependsOnTaskId: b2.id, type: "blocks", createdBy: "test" }, db);
    addDependency({ projectId: PROJECT, taskId: d3.id, dependsOnTaskId: b2.id, type: "blocks", createdBy: "test" }, db);

    const impact = analyzeBlockerImpact(PROJECT, db);
    expect(impact[0]!.taskId).toBe(b2.id);
    expect(impact[0]!.downstreamCount).toBe(2);
    expect(impact[1]!.taskId).toBe(b1.id);
    expect(impact[1]!.downstreamCount).toBe(1);
  });
});

describe("computeCostTrajectory", () => {
  it("returns null when no cost records", () => {
    const result = computeCostTrajectory(PROJECT, db);
    expect(result).toBeNull();
  });

  it("computes cost trajectory with records", () => {
    // Insert some cost records
    const now = Date.now();
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, cost_cents, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("cr1", PROJECT, "agent:test", 500, "claude", now - 3600000);
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, cost_cents, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("cr2", PROJECT, "agent:test", 300, "claude", now);

    const result = computeCostTrajectory(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result!.totalSpentCents).toBe(800);
    expect(result!.todaySpentCents).toBeGreaterThanOrEqual(0);
  });

  it("detects over-budget projection", () => {
    const now = Date.now();
    // Insert budget (all NOT NULL columns)
    db.prepare(`
      INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, 100, 0, now, now, now);

    // Insert high spending
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO cost_records (id, project_id, agent_id, cost_cents, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`cr-${i}`, PROJECT, "agent:test", 500, "claude", now - i * 60000);
    }

    const result = computeCostTrajectory(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result!.overBudget).toBe(true);
  });
});

describe("buildVelocityReport", () => {
  it("builds complete report", () => {
    makeTask("t1", "DONE");
    makeTask("t2", "DONE");
    makeTask("t3"); // remaining

    const report = buildVelocityReport(PROJECT, db);
    expect(report.windows).toHaveLength(4);
    expect(report.tasksRemaining).toBe(1);
    expect(report.etaHours).not.toBeNull();
  });
});

describe("renderVelocityReport", () => {
  it("returns null when nothing to report", () => {
    const report = buildVelocityReport(PROJECT, db);
    const md = renderVelocityReport(report);
    expect(md).toBeNull();
  });

  it("renders markdown with throughput and projection", () => {
    makeTask("t1", "DONE");
    makeTask("t2");

    const report = buildVelocityReport(PROJECT, db);
    const md = renderVelocityReport(report);
    expect(md).not.toBeNull();
    expect(md).toContain("## Velocity Report");
    expect(md).toContain("Throughput");
    expect(md).toContain("Tasks remaining");
  });

  it("includes blocker section when blockers exist", () => {
    const blocker = makeTask("important-blocker");
    const blocked = makeTask("blocked-task", "BLOCKED");

    addDependency({
      projectId: PROJECT,
      taskId: blocked.id,
      dependsOnTaskId: blocker.id,
      type: "blocks",
      createdBy: "test",
    }, db);

    // Need at least one completed task in 7d for report to render
    makeTask("done-task", "DONE");

    const report = buildVelocityReport(PROJECT, db);
    const md = renderVelocityReport(report);
    expect(md).toContain("Critical Blockers");
    expect(md).toContain("important-blocker");
  });
});
