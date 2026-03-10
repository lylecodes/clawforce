import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const {
  gatherFailureAnalysis,
  formatFailureAnalysis,
  recordReplanAttempt,
  buildReplanContext,
} = await import("../../src/planning/replan.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-replan";

function makeFailedTask(title: string, retries: number = 3) {
  const task = createTask({
    projectId: PROJECT,
    title,
    createdBy: "agent:manager",
    maxRetries: retries,
  }, db);

  // Transition to ASSIGNED → IN_PROGRESS → FAILED
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker", assignedTo: "agent:worker" }, db);
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);

  // Attach evidence before failing
  attachEvidence({ projectId: PROJECT, taskId: task.id, type: "log", content: "Error: connection timeout", attachedBy: "agent:worker" }, db);
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "Connection timeout" }, db);

  return task;
}

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("gatherFailureAnalysis", () => {
  it("gathers failure evidence from a failed task", () => {
    const task = makeFailedTask("Deploy service");

    const analysis = gatherFailureAnalysis(PROJECT, task.id, db);
    expect(analysis).not.toBeNull();
    expect(analysis!.taskTitle).toBe("Deploy service");
    expect(analysis!.failureEvidence.length).toBeGreaterThanOrEqual(1);
    expect(analysis!.failureEvidence[0].reason).toBe("Connection timeout");
    expect(analysis!.replanCount).toBe(0);
  });

  it("returns null for nonexistent task", () => {
    const analysis = gatherFailureAnalysis(PROJECT, "nonexistent", db);
    expect(analysis).toBeNull();
  });

  it("tracks replan count from metadata", () => {
    const task = makeFailedTask("Deploy service");

    // Simulate a previous replan
    db.prepare(
      "UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.replan_count', 2) WHERE id = ?",
    ).run(task.id);

    const analysis = gatherFailureAnalysis(PROJECT, task.id, db);
    expect(analysis!.replanCount).toBe(2);
  });
});

describe("formatFailureAnalysis", () => {
  it("produces readable markdown", () => {
    const task = makeFailedTask("Deploy service");
    const analysis = gatherFailureAnalysis(PROJECT, task.id, db)!;
    const formatted = formatFailureAnalysis(analysis);

    expect(formatted).toContain("Deploy service");
    expect(formatted).toContain("Connection timeout");
    expect(formatted).toContain("Options");
  });
});

describe("recordReplanAttempt", () => {
  it("increments replan count", () => {
    const task = makeFailedTask("Fix bug");

    const r1 = recordReplanAttempt(PROJECT, task.id, 3, db);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.replanCount).toBe(1);

    const r2 = recordReplanAttempt(PROJECT, task.id, 3, db);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.replanCount).toBe(2);
  });

  it("blocks after max replans", () => {
    const task = makeFailedTask("Fix bug");

    recordReplanAttempt(PROJECT, task.id, 2, db);
    recordReplanAttempt(PROJECT, task.id, 2, db);
    const r3 = recordReplanAttempt(PROJECT, task.id, 2, db);

    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toContain("exhausted");
  });

  it("returns error for nonexistent task", () => {
    const result = recordReplanAttempt(PROJECT, "nonexistent", 3, db);
    expect(result.ok).toBe(false);
  });
});

describe("buildReplanContext", () => {
  it("returns null for empty analyses", () => {
    expect(buildReplanContext([])).toBeNull();
  });

  it("builds context with failure analyses", () => {
    const task = makeFailedTask("Deploy service");
    const analysis = gatherFailureAnalysis(PROJECT, task.id, db)!;
    const context = buildReplanContext([analysis]);

    expect(context).toContain("Re-planning Required");
    expect(context).toContain("Deploy service");
    expect(context).toContain("OODA");
  });
});
