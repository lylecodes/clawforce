import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { getMemoryDb } = await import("../../src/db.js");
const { addPreApproval, checkPreApproval, consumePreApproval } = await import("../../src/approval/pre-approved.js");

describe("approval/pre-approved", () => {
  let db: DatabaseSync;
  const PROJECT = "preapproval-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("adds and checks a pre-approval", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-1",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    const exists = checkPreApproval({ projectId: PROJECT, taskId: "task-1", toolName: "mcp:gmail:send" }, db);
    expect(exists).toBe(true);
  });

  it("returns false for non-existent pre-approval", () => {
    const exists = checkPreApproval({ projectId: PROJECT, taskId: "task-1", toolName: "mcp:nonexistent" }, db);
    expect(exists).toBe(false);
  });

  it("consumes a pre-approval (single use)", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-2",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    // First consume succeeds
    const consumed = consumePreApproval({ projectId: PROJECT, taskId: "task-2", toolName: "mcp:gmail:send" }, db);
    expect(consumed).toBe(true);

    // Second consume fails — already consumed
    const consumed2 = consumePreApproval({ projectId: PROJECT, taskId: "task-2", toolName: "mcp:gmail:send" }, db);
    expect(consumed2).toBe(false);

    // Check also returns false now
    const exists = checkPreApproval({ projectId: PROJECT, taskId: "task-2", toolName: "mcp:gmail:send" }, db);
    expect(exists).toBe(false);
  });

  it("returns false for expired pre-approval", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-3",
      toolName: "mcp:gmail:send",
      category: "email:send",
      ttlMs: 1, // 1ms TTL — expires immediately
    }, db);

    // Wait a tick for expiry (SQLite stores as integer, Date.now() advances)
    // Backdate the expires_at
    db.prepare("UPDATE pre_approvals SET expires_at = ? WHERE task_id = ?").run(Date.now() - 1000, "task-3");

    const exists = checkPreApproval({ projectId: PROJECT, taskId: "task-3", toolName: "mcp:gmail:send" }, db);
    expect(exists).toBe(false);
  });

  it("does not consume an expired pre-approval", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-4",
      toolName: "mcp:tool",
      category: "misc",
    }, db);

    // Expire it
    db.prepare("UPDATE pre_approvals SET expires_at = ? WHERE task_id = ?").run(Date.now() - 1000, "task-4");

    const consumed = consumePreApproval({ projectId: PROJECT, taskId: "task-4", toolName: "mcp:tool" }, db);
    expect(consumed).toBe(false);
  });

  it("scopes pre-approvals by tool name", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-5",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    const wrongTool = checkPreApproval({ projectId: PROJECT, taskId: "task-5", toolName: "mcp:slack:post" }, db);
    expect(wrongTool).toBe(false);

    const rightTool = checkPreApproval({ projectId: PROJECT, taskId: "task-5", toolName: "mcp:gmail:send" }, db);
    expect(rightTool).toBe(true);
  });

  it("scopes pre-approvals by task ID", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-6",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    const wrongTask = checkPreApproval({ projectId: PROJECT, taskId: "other-task", toolName: "mcp:gmail:send" }, db);
    expect(wrongTask).toBe(false);
  });
});
