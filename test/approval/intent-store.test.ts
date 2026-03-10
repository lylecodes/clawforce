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
const {
  persistToolCallIntent,
  getIntentByProposal,
  getIntentByProposalForProject,
  getApprovedIntentsForTask,
  resolveIntent,
  resolveIntentForProject,
} = await import("../../src/approval/intent-store.js");

describe("approval/intent-store", () => {
  let db: DatabaseSync;
  const PROJECT = "intent-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("persists and retrieves an intent by proposal", () => {
    const intentId = persistToolCallIntent({
      proposalId: "prop-1",
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: "task-1",
      toolName: "mcp:gmail:send",
      toolParams: { to: "user@example.com", body: "Hello" },
      category: "email:send",
      riskTier: "high",
    }, db);

    expect(intentId).toBeDefined();

    const intent = getIntentByProposalForProject(PROJECT, "prop-1", db);
    expect(intent).not.toBeNull();
    expect(intent!.proposalId).toBe("prop-1");
    expect(intent!.toolName).toBe("mcp:gmail:send");
    expect(intent!.toolParams).toEqual({ to: "user@example.com", body: "Hello" });
    expect(intent!.status).toBe("pending");
    expect(intent!.category).toBe("email:send");
    expect(intent!.riskTier).toBe("high");
  });

  it("resolves intent as approved", () => {
    const intentId = persistToolCallIntent({
      proposalId: "prop-2",
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: "task-1",
      toolName: "mcp:gcal:create",
      toolParams: {},
      category: "calendar:write",
      riskTier: "medium",
    }, db);

    resolveIntentForProject(PROJECT, intentId, "approved", db);

    const intent = getIntentByProposalForProject(PROJECT, "prop-2", db);
    expect(intent!.status).toBe("approved");
    expect(intent!.resolvedAt).toBeTypeOf("number");
  });

  it("resolves intent as rejected", () => {
    const intentId = persistToolCallIntent({
      proposalId: "prop-3",
      projectId: PROJECT,
      agentId: "agent:worker",
      toolName: "mcp:deploy:run",
      toolParams: {},
      category: "deploy:run",
      riskTier: "critical",
    }, db);

    resolveIntentForProject(PROJECT, intentId, "rejected", db);

    const intent = getIntentByProposalForProject(PROJECT, "prop-3", db);
    expect(intent!.status).toBe("rejected");
  });

  it("lists approved intents for a task", () => {
    // Create two intents for same task, approve one
    const id1 = persistToolCallIntent({
      proposalId: "prop-4",
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: "task-2",
      toolName: "mcp:gmail:send",
      toolParams: {},
      category: "email:send",
      riskTier: "high",
    }, db);

    persistToolCallIntent({
      proposalId: "prop-5",
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: "task-2",
      toolName: "mcp:slack:post",
      toolParams: {},
      category: "messaging:send",
      riskTier: "medium",
    }, db);

    // Approve only the first one
    resolveIntentForProject(PROJECT, id1, "approved", db);

    const approved = getApprovedIntentsForTask(PROJECT, "task-2", db);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.toolName).toBe("mcp:gmail:send");
  });

  it("returns null for non-existent proposal", () => {
    const intent = getIntentByProposalForProject(PROJECT, "non-existent", db);
    expect(intent).toBeNull();
  });

  it("returns empty array when no approved intents for task", () => {
    const approved = getApprovedIntentsForTask(PROJECT, "no-task", db);
    expect(approved).toHaveLength(0);
  });

  it("persists intent without taskId", () => {
    const intentId = persistToolCallIntent({
      proposalId: "prop-6",
      projectId: PROJECT,
      agentId: "agent:worker",
      toolName: "mcp:tool",
      toolParams: {},
      category: "misc",
      riskTier: "low",
    }, db);

    const intent = getIntentByProposalForProject(PROJECT, "prop-6", db);
    expect(intent!.taskId).toBeUndefined();
  });
});
