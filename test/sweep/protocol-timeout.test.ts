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
const { initiateRequest, initiateDelegation, getExpiredProtocols, expireProtocol, escalateProtocol, respondToRequest } = await import("../../src/messaging/protocols.js");
const { createMessage, getMessage, getPendingMessages } = await import("../../src/messaging/store.js");

describe("protocol timeout sweep", () => {
  let db: DatabaseSync;
  const PROJECT = "sweep-proto-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("detects expired protocols past deadline", () => {
    // Create a request with past deadline
    initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "urgent question", deadlineMs: -5000, // 5 seconds ago
    }, db);

    const expired = getExpiredProtocols(PROJECT, Date.now(), db);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.type).toBe("request");
  });

  it("expire + escalate creates escalation message to initiator", () => {
    const req = initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "question", deadlineMs: -1000,
    }, db);

    // Simulate sweep: expire → create escalation → escalate
    expireProtocol(req.id, db);

    const escalationMsg = createMessage({
      fromAgent: "system:sweep",
      toAgent: "ceo", // goes to initiator
      projectId: PROJECT,
      type: "escalation",
      priority: "high",
      content: `Protocol expired: your request to cfo received no response`,
      parentMessageId: req.id,
    }, db);

    escalateProtocol(req.id, escalationMsg.id, db);

    // Verify protocol is escalated
    const updated = getMessage(PROJECT, req.id, db);
    expect(updated!.protocolStatus).toBe("escalated");

    // Verify escalation message exists in CEO's pending
    const pending = getPendingMessages(PROJECT, "ceo", db);
    expect(pending.some((m) => m.type === "escalation" && m.parentMessageId === req.id)).toBe(true);
  });

  it("does not expire protocols with future deadline", () => {
    initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "later question", deadlineMs: 60 * 60 * 1000, // 1 hour from now
    }, db);

    const expired = getExpiredProtocols(PROJECT, Date.now(), db);
    expect(expired).toHaveLength(0);
  });

  it("does not expire already-terminal protocols", () => {
    const req = initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "question", deadlineMs: -1000,
    }, db);

    // Manually resolve it
    respondToRequest({
      projectId: PROJECT, originalMessageId: req.id,
      responderAgent: "cfo", content: "answered",
    }, db);

    // Should not appear in expired
    const expired = getExpiredProtocols(PROJECT, Date.now(), db);
    expect(expired).toHaveLength(0);
  });

  it("handles delegation protocol expiry", () => {
    initiateDelegation({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "do this work", deadlineMs: -2000,
    }, db);

    const expired = getExpiredProtocols(PROJECT, Date.now(), db);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.type).toBe("delegation");
  });
});
