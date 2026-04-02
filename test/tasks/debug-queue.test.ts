import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it, expect } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => { db = getMemoryDb(); });
afterEach(() => { try { db.close(); } catch {} });

it("debug: cancels pending queue items on REVIEW", () => {
  const task = createTask(
    { projectId: PROJECT, title: "Queue cancel test", createdBy: "agent:pm", assignedTo: "agent:worker" },
    db,
  );
  console.log("Task state:", task.state);

  const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db);
  console.log("Queue item:", queueItem?.id ?? "null");

  if (queueItem) {
    const before = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem.id) as Record<string, unknown>;
    console.log("Before:", before.status);

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    const mid = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem.id) as Record<string, unknown>;
    console.log("After IN_PROGRESS:", mid.status);

    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem.id) as Record<string, unknown>;
    console.log("After REVIEW:", after.status);
    
    expect(after.status).toBe("cancelled");
  }
});
