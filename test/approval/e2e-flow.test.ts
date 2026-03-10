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
const { persistToolCallIntent, getIntentByProposalForProject, resolveIntentForProject } = await import("../../src/approval/intent-store.js");
const { addPreApproval, checkPreApproval, consumePreApproval } = await import("../../src/approval/pre-approved.js");
const { approveProposal, rejectProposal, getProposal } = await import("../../src/approval/resolve.js");
const { processEvents } = await import("../../src/events/router.js");
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const { createTask } = await import("../../src/tasks/ops.js");

describe("approval/e2e-flow", () => {
  let db: DatabaseSync;
  const PROJECT = "e2e-approval";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("full flow: tool gate → proposal → approve → pre-approval → re-dispatch", () => {
    // Step 1: Create a task
    const task = createTask({ projectId: PROJECT, title: "Send email campaign", createdBy: "agent:pm" }, db);
    processEvents(PROJECT, db); // drain task_created event

    // Step 2: Simulate tool gate blocking — create proposal + intent
    const proposalId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(proposalId, PROJECT, "Tool gate: email:send (high)", "mcp:gmail:send call requires approval", "agent:worker", "high", Date.now());

    persistToolCallIntent({
      proposalId,
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: task.id,
      toolName: "mcp:gmail:send",
      toolParams: { to: "user@test.com", body: "Hello" },
      category: "email:send",
      riskTier: "high",
    }, db);

    // Step 3: Approve the proposal
    const approved = approveProposal(PROJECT, proposalId, "Looks good");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");

    // Step 4: Process the proposal_approved event
    const processed = processEvents(PROJECT, db);
    expect(processed).toBeGreaterThan(0);

    // Step 5: Verify intent was resolved as approved
    const intent = getIntentByProposalForProject(PROJECT, proposalId, db);
    expect(intent!.status).toBe("approved");

    // Step 6: Verify pre-approval was created
    const hasPreApproval = checkPreApproval({ projectId: PROJECT, taskId: task.id, toolName: "mcp:gmail:send" }, db);
    expect(hasPreApproval).toBe(true);

    // Step 7: Verify task was re-enqueued
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBeGreaterThanOrEqual(1);
  });

  it("rejection flow: tool gate → proposal → reject → intent rejected", () => {
    const task = createTask({ projectId: PROJECT, title: "Deploy to prod", createdBy: "agent:pm" }, db);
    processEvents(PROJECT, db); // drain

    const proposalId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(proposalId, PROJECT, "Tool gate: deploy:run (critical)", "mcp:deploy:run requires approval", "agent:worker", "critical", Date.now());

    persistToolCallIntent({
      proposalId,
      projectId: PROJECT,
      agentId: "agent:worker",
      taskId: task.id,
      toolName: "mcp:deploy:run",
      toolParams: {},
      category: "deploy:run",
      riskTier: "critical",
    }, db);

    // Reject the proposal
    rejectProposal(PROJECT, proposalId, "Too risky");
    processEvents(PROJECT, db);

    // Intent should be rejected
    const intent = getIntentByProposalForProject(PROJECT, proposalId, db);
    expect(intent!.status).toBe("rejected");

    // No pre-approval created
    const hasPreApproval = checkPreApproval({ projectId: PROJECT, taskId: task.id, toolName: "mcp:deploy:run" }, db);
    expect(hasPreApproval).toBe(false);
  });

  it("pre-approval is consumed on use", () => {
    addPreApproval({
      projectId: PROJECT,
      taskId: "task-consume",
      toolName: "mcp:gmail:send",
      category: "email:send",
    }, db);

    // First check + consume works
    expect(checkPreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(true);
    expect(consumePreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(true);

    // Second attempt fails
    expect(checkPreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(false);
    expect(consumePreApproval({ projectId: PROJECT, taskId: "task-consume", toolName: "mcp:gmail:send" }, db)).toBe(false);
  });

  it("proposal_created event is handled (no-op acknowledgment)", () => {
    ingestEvent(PROJECT, "proposal_created", "internal", {
      proposalId: "p-1",
      proposedBy: "agent:worker",
      riskTier: "high",
    }, undefined, db);

    const processed = processEvents(PROJECT, db);
    expect(processed).toBe(1);

    const handled = listEvents(PROJECT, { status: "handled" }, db);
    expect(handled).toHaveLength(1);
  });
});
