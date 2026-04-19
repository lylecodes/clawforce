import crypto from "node:crypto";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const ingestEventMock = vi.fn(() => ({ id: "mock-event-id", deduplicated: false }));
vi.mock("../../src/events/store.js", () => ({
  ingestEvent: (...args: unknown[]) => ingestEventMock(...args),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const {
  approveProposal,
  rejectProposal,
  getProposal,
  listPendingProposals,
  markProposalExecutionApplied,
} =
  await import("../../src/approval/resolve.js");
const {
  acquireControllerLease,
  getControllerLease,
} = await import("../../src/runtime/controller-leases.js");

describe("approval/resolve", () => {
  let db: DatabaseSync;
  const PROJECT = "resolve-test";

  function insertProposal(overrides: Partial<{
    id: string;
    status: string;
    title: string;
    description: string;
  }> = {}): string {
    const id = overrides.id ?? crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, approval_policy_snapshot, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      PROJECT,
      overrides.title ?? "Test proposal",
      overrides.description ?? "Test description",
      "agent:proposer",
      "session-key-1",
      overrides.status ?? "pending",
      '{"policy":"test policy"}',
      "low",
      now,
    );
    return id;
  }

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    ingestEventMock.mockClear();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    vi.restoreAllMocks();
  });

  it("approveProposal changes status to 'approved'", () => {
    const proposalId = insertProposal();

    const result = approveProposal(PROJECT, proposalId, "Looks good");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
    expect(result!.user_feedback).toBe("Looks good");
    expect(result!.resolved_at).toBeGreaterThan(0);
    expect(result!.execution_status).toBe("pending");
    expect(result!.execution_requested_at).toBeGreaterThan(0);
    expect(result!.execution_updated_at).toBeGreaterThan(0);
    expect(result!.execution_required_generation).toMatch(/^gen-/);
  });

  it("approveProposal returns null for non-existent proposal", () => {
    const result = approveProposal(PROJECT, "nonexistent-id");
    expect(result).toBeNull();
  });

  it("approveProposal returns null for already-approved proposal", () => {
    const proposalId = insertProposal();

    // First approval succeeds
    const first = approveProposal(PROJECT, proposalId, "ok");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("approved");

    // Second approval returns null (no longer pending)
    const second = approveProposal(PROJECT, proposalId, "duplicate");
    expect(second).toBeNull();
  });

  it("rejectProposal changes status to 'rejected'", () => {
    const proposalId = insertProposal();

    const result = rejectProposal(PROJECT, proposalId, "Not now");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
    expect(result!.user_feedback).toBe("Not now");
    expect(result!.resolved_at).toBeGreaterThan(0);
  });

  it("approveProposal emits a proposal_approved event", () => {
    const proposalId = insertProposal();

    approveProposal(PROJECT, proposalId, "LGTM");

    expect(ingestEventMock).toHaveBeenCalled();
    const call = ingestEventMock.mock.calls.find(
      (c) => c[1] === "proposal_approved",
    );
    expect(call).toBeDefined();
    expect(call![0]).toBe(PROJECT);
    // Payload should include proposalId
    expect((call![3] as Record<string, unknown>).proposalId).toBe(proposalId);
    expect((call![3] as Record<string, unknown>).requiredGeneration).toMatch(/^gen-/);
  });

  it("clears the controller generation floor when execution is applied", () => {
    const proposalId = insertProposal();
    const approved = approveProposal(PROJECT, proposalId, "LGTM");
    expect(approved).not.toBeNull();
    if (!approved) return;

    acquireControllerLease(PROJECT, {
      ownerId: "controller:test",
      ownerLabel: "controller-test",
      purpose: "sweep",
      generation: approved.execution_required_generation ?? undefined,
    }, db);

    markProposalExecutionApplied(PROJECT, proposalId, { taskId: "task-1" }, db);

    const proposal = getProposal(PROJECT, proposalId, db);
    expect(proposal?.execution_status).toBe("applied");
    expect(getControllerLease(PROJECT, db)?.requiredGeneration).toBeNull();
  });

  it("listPendingProposals returns only pending proposals", () => {
    const p1 = insertProposal({ title: "Pending 1" });
    const p2 = insertProposal({ title: "Pending 2" });
    const p3 = insertProposal({ title: "Approved" });

    // Approve p3
    approveProposal(PROJECT, p3, "ok");

    const pending = listPendingProposals(PROJECT);
    expect(pending).toHaveLength(2);
    const ids = pending.map((p) => p.id);
    expect(ids).toContain(p1);
    expect(ids).toContain(p2);
    expect(ids).not.toContain(p3);
  });
});
