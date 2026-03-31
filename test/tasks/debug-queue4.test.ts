import { it, expect, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({ emitDiagnosticEvent: vi.fn(), safeLog: vi.fn() }));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "sig"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", hmacKey: "x", identityToken: "tok", issuedAt: Date.now() })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

it("check source has cancelQueueItem", async () => {
  // Read the source to verify it's the right version
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/tasks/ops.ts", "utf8");
  expect(src).toContain("isNonDispatchable");
  expect(src).toContain("cancelQueueItem");
  
  const db = getMemoryDb();
  const PROJECT = "test";
  
  const task = createTask({ projectId: PROJECT, title: "t", createdBy: "a", assignedTo: "w" }, db);
  const qi = enqueue(PROJECT, task.id, undefined, undefined, db);
  expect(qi).not.toBeNull();
  
  // Check if the queue item gets cancelled on REVIEW
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "w" }, db);
  
  const midItems = db.prepare("SELECT * FROM dispatch_queue WHERE task_id = ?").all(task.id) as Record<string,unknown>[];
  console.log("After IN_PROGRESS:", midItems.map(i => `${i.status}`));
  
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "w" }, db);
  
  const afterItems = db.prepare("SELECT * FROM dispatch_queue WHERE task_id = ?").all(task.id) as Record<string,unknown>[];
  console.log("After REVIEW:", afterItems.map(i => `${i.status}`));
  
  db.close();
});
