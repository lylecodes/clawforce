import { it, expect, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({ emitDiagnosticEvent: vi.fn(), safeLog: vi.fn() }));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "sig"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", hmacKey: "x", identityToken: "tok", issuedAt: Date.now() })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

it("debug: full queue state inspection", () => {
  const db = getMemoryDb();
  const PROJECT = "test";
  
  const task = createTask({ projectId: PROJECT, title: "t", createdBy: "a", assignedTo: "w" }, db);
  const qi = enqueue(PROJECT, task.id, undefined, undefined, db);
  
  // Check full row
  const row = db.prepare("SELECT * FROM dispatch_queue WHERE task_id = ?").get(task.id) as Record<string,unknown>;
  console.log("Queue row:", JSON.stringify(row));
  
  // Test the EXACT query from our new code
  const pendingItems = db.prepare(
    "SELECT id FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status = 'queued'"
  ).all(PROJECT, task.id) as Record<string,unknown>[];
  console.log("Pending items query result:", pendingItems.length, pendingItems);
  
  // Transition
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "w" }, db);
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "w" }, db);
  
  const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(qi!.id) as Record<string,unknown>;
  console.log("After REVIEW:", after?.status);
  
  db.close();
});
