import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { createTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { queryAuditLog, verifyAuditChain } = await import("../../src/audit.js");

describe("audit trail at mutation points", () => {
  let db: DatabaseSync;
  const PROJECT = "audit-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it("writes audit entry with action task.create after createTask", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Test task", createdBy: "agent:a" },
      db,
    );

    const entries = queryAuditLog({ projectId: PROJECT, action: "task.create" }, db);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].targetId).toBe(task.id);
    expect(entries[0].targetType).toBe("task");
    expect(entries[0].actor).toBe("agent:a");
    expect(entries[0].detail).toBe("Test task");
  });

  it("writes audit entry with action evidence.attach after attachEvidence", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Task with evidence", createdBy: "agent:a" },
      db,
    );

    const evidence = attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "result data", attachedBy: "agent:b" },
      db,
    );

    const entries = queryAuditLog({ projectId: PROJECT, action: "evidence.attach" }, db);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].targetId).toBe(evidence.id);
    expect(entries[0].targetType).toBe("evidence");
    expect(entries[0].actor).toBe("agent:b");
    expect(entries[0].detail).toBe("output");
  });

  it("writes audit entry with action proposal.approve after approveProposal", async () => {
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);

    // Insert a pending proposal directly
    const proposalId = "prop-1";
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(proposalId, PROJECT, "Test proposal", null, "agent:a", "session-1", Date.now());

    const { approveProposal } = await import("../../src/approval/resolve.js");
    approveProposal(PROJECT, proposalId, "Looks good");

    const entries = queryAuditLog({ projectId: PROJECT, action: "proposal.approve" }, db);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].targetId).toBe(proposalId);
    expect(entries[0].targetType).toBe("proposal");
    expect(entries[0].detail).toBe("Looks good");

    vi.restoreAllMocks();
  });

  it("verifyAuditChain returns intact:true for a single audit entry", () => {
    createTask(
      { projectId: PROJECT, title: "Single task", createdBy: "agent:a" },
      db,
    );

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(1);
  });
});
