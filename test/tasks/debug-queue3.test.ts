import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, it, expect, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn((tag: string, err: unknown) => {
    console.error("SAFELOG:", tag, err);
  }),
}));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => { db = getMemoryDb(); });
afterEach(() => { try { db.close(); } catch {} });

it("debug: shows safeLog errors on REVIEW transition", () => {
  const task = createTask(
    { projectId: PROJECT, title: "debug", createdBy: "agent:pm", assignedTo: "agent:worker" },
    db,
  );
  const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db);
  expect(queueItem).not.toBeNull();
  
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
  attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
  transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

  const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
  console.log("After REVIEW:", after.status);
  expect(after.status).toBe("cancelled");
});
