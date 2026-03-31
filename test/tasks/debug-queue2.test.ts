import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it, expect, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { enqueue, cancelItem } = await import("../../src/dispatch/queue.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => { db = getMemoryDb(); });
afterEach(() => { try { db.close(); } catch {} });

it("debug: cancelItem directly works", () => {
  const task = createTask(
    { projectId: PROJECT, title: "Queue cancel test", createdBy: "agent:pm", assignedTo: "agent:worker" },
    db,
  );
  const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db);
  expect(queueItem).not.toBeNull();
  
  const before = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
  expect(before.status).toBe("queued");
  
  // Directly call cancelItem
  cancelItem(queueItem!.id, db);
  
  const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
  console.log("After direct cancel:", after.status);
  expect(after.status).toBe("cancelled");
});

it("debug: transitionTask to REVIEW cancels queued items", () => {
  const task = createTask(
    { projectId: PROJECT, title: "Queue cancel test 2", createdBy: "agent:pm", assignedTo: "agent:worker" },
    db,
  );
  const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db);
  expect(queueItem).not.toBeNull();
  
  const all = db.prepare("SELECT * FROM dispatch_queue WHERE task_id = ?").all(task.id) as Record<string, unknown>[];
  console.log("Queue items:", all.map(i => `${i.id?.toString().slice(0,8)} status=${i.status}`));
  
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
  
  const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
  console.log("After REVIEW transition:", after.status);
  expect(after.status).toBe("cancelled");
});
