import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { buildWorkerContext } = await import("../../src/context/worker.js");
const { createTask, attachEvidence, transitionTask } = await import("../../src/tasks/ops.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => {
  db = getMemoryDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch {}
});

describe("buildWorkerContext", () => {
  it("returns structured prompt with task details", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Fix authentication bug",
      description: "The login flow is broken",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      tags: ["backend", "auth"],
    }, db);

    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: task.id,
      instructions: "Fix the auth bug",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("Fix authentication bug");
    expect(result!.prompt).toContain("The login flow is broken");
    expect(result!.prompt).toContain("agent:worker");
    expect(result!.prompt).toContain("backend, auth");
    expect(result!.prompt).toContain("Fix the auth bug");
    expect(result!.prompt).toContain("Deliverables");
    expect(result!.task.id).toBe(task.id);
  });

  it("returns null for missing task", () => {
    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: "nonexistent",
      instructions: "do something",
      dbOverride: db,
    });
    expect(result).toBeNull();
  });

  it("includes retry context when retryCount > 0", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Flaky task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    // Simulate a failure cycle: ASSIGNED → FAILED → OPEN (retry) → ASSIGNED
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "crash" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);

    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: task.id,
      instructions: "Try again",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.task.retryCount).toBe(1);
    // Should contain retry-related content (Previous Attempts section)
    expect(result!.prompt.toLowerCase()).toContain("attempt");
  });

  it("truncates evidence at maxEvidenceChars", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Evidence task",
      createdBy: "agent:pm",
    }, db);

    attachEvidence({
      projectId: PROJECT,
      taskId: task.id,
      type: "output",
      content: "x".repeat(10000),
      attachedBy: "agent:worker",
    }, db);

    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: task.id,
      instructions: "Process it",
      maxEvidenceChars: 100,
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    // The evidence should be truncated — full content is 10000 chars
    const evidenceSection = result!.prompt;
    // Count the x's in evidence — should be capped
    const xCount = (evidenceSection.match(/x/g) || []).length;
    expect(xCount).toBeLessThan(10000);
  });

  it("shows deadline info (remaining)", () => {
    const future = Date.now() + 7_200_000; // 2 hours from now
    const task = createTask({
      projectId: PROJECT,
      title: "Deadline task",
      createdBy: "agent:pm",
      deadline: future,
    }, db);

    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: task.id,
      instructions: "hurry",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("remaining");
  });

  it("shows overdue for past deadline", () => {
    const past = Date.now() - 3_600_000; // 1 hour ago
    const task = createTask({
      projectId: PROJECT,
      title: "Overdue task",
      createdBy: "agent:pm",
      deadline: past,
    }, db);

    const result = buildWorkerContext({
      projectId: PROJECT,
      taskId: task.id,
      instructions: "hurry",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("OVERDUE");
  });
});
