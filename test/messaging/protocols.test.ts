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
  initiateRequest,
  initiateDelegation,
  initiateFeedback,
  respondToRequest,
  acceptDelegation,
  rejectDelegation,
  completeDelegation,
  submitFeedback,
  getActiveProtocols,
  getExpiredProtocols,
  expireProtocol,
  escalateProtocol,
  validateProtocolTransition,
} = await import("../../src/messaging/protocols.js");
const { getMessage } = await import("../../src/messaging/store.js");

describe("messaging/protocols", () => {
  let db: DatabaseSync;
  const PROJECT = "proto-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // --- Request protocol ---

  describe("request protocol", () => {
    it("initiateRequest creates message with correct fields", () => {
      const msg = initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "What is the Q4 budget?", priority: "high",
        deadlineMs: 30 * 60 * 1000, // 30 minutes
      }, db);

      expect(msg.type).toBe("request");
      expect(msg.protocolStatus).toBe("awaiting_response");
      expect(msg.responseDeadline).toBeGreaterThan(Date.now());
      expect(msg.priority).toBe("high");
      expect(msg.content).toBe("What is the Q4 budget?");
    });

    it("respondToRequest creates reply and transitions to resolved", () => {
      const request = initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "What is the budget?",
      }, db);

      const { original, response } = respondToRequest({
        projectId: PROJECT, originalMessageId: request.id,
        responderAgent: "cfo", content: "Budget is $1M",
      }, db);

      expect(original.protocolStatus).toBe("resolved");
      expect(response.parentMessageId).toBe(request.id);
      expect(response.toAgent).toBe("ceo");
      expect(response.content).toBe("Budget is $1M");

      // Verify in DB
      const updated = getMessage(PROJECT, request.id, db);
      expect(updated!.protocolStatus).toBe("resolved");
      expect(updated!.metadata?.responseMessageId).toBe(response.id);
    });

    it("cannot respond to already-resolved request", () => {
      const request = initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Question?",
      }, db);

      respondToRequest({
        projectId: PROJECT, originalMessageId: request.id,
        responderAgent: "cfo", content: "Answer!",
      }, db);

      expect(() => respondToRequest({
        projectId: PROJECT, originalMessageId: request.id,
        responderAgent: "cfo", content: "Second answer",
      }, db)).toThrow();
    });

    it("cannot respond to non-request message", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Do this work",
      }, db);

      expect(() => respondToRequest({
        projectId: PROJECT, originalMessageId: delegation.id,
        responderAgent: "cfo", content: "response",
      }, db)).toThrow("non-request");
    });
  });

  // --- Delegation protocol ---

  describe("delegation protocol", () => {
    it("initiateDelegation creates message with pending_acceptance", () => {
      const msg = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Prepare financial report", taskId: "task-123",
      }, db);

      expect(msg.type).toBe("delegation");
      expect(msg.protocolStatus).toBe("pending_acceptance");
      expect(msg.metadata?.taskId).toBe("task-123");
    });

    it("acceptDelegation transitions to in_progress", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Do the work",
      }, db);

      const updated = acceptDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        accepterAgent: "cfo", note: "On it!",
      }, db);

      expect(updated.protocolStatus).toBe("in_progress");

      const inDb = getMessage(PROJECT, delegation.id, db);
      expect(inDb!.protocolStatus).toBe("in_progress");
      expect(inDb!.metadata?.acceptanceNote).toBe("On it!");
    });

    it("rejectDelegation transitions to rejected and creates reply", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Do something",
      }, db);

      const { original, rejection } = rejectDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        rejecterAgent: "cfo", reason: "Too busy",
      }, db);

      expect(original.protocolStatus).toBe("rejected");
      expect(rejection.toAgent).toBe("ceo");
      expect(rejection.content).toBe("Too busy");
      expect(rejection.parentMessageId).toBe(delegation.id);
    });

    it("completeDelegation transitions to completed and creates reply", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Prepare report",
      }, db);

      acceptDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        accepterAgent: "cfo",
      }, db);

      const { original, completion } = completeDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        completerAgent: "cfo", content: "Report is ready",
        resultSummary: "Q4 financial report complete",
      }, db);

      expect(original.protocolStatus).toBe("completed");
      expect(completion.toAgent).toBe("ceo");
      expect(completion.content).toBe("Report is ready");

      const inDb = getMessage(PROJECT, delegation.id, db);
      expect(inDb!.protocolStatus).toBe("completed");
      expect(inDb!.metadata?.resultSummary).toBe("Q4 financial report complete");
    });

    it("cannot complete a delegation that hasn't been accepted", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Do work",
      }, db);

      expect(() => completeDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        completerAgent: "cfo", content: "Done",
      }, db)).toThrow();
    });

    it("cannot accept an already rejected delegation", () => {
      const delegation = initiateDelegation({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "Work",
      }, db);

      rejectDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        rejecterAgent: "cfo", reason: "No",
      }, db);

      expect(() => acceptDelegation({
        projectId: PROJECT, originalMessageId: delegation.id,
        accepterAgent: "cfo",
      }, db)).toThrow();
    });
  });

  // --- Feedback protocol ---

  describe("feedback protocol", () => {
    it("initiateFeedback creates message with awaiting_review", () => {
      const msg = initiateFeedback({
        fromAgent: "ceo", toAgent: "reviewer", projectId: PROJECT,
        content: "Please review this document",
        artifact: "docs/q4-report.md",
        reviewCriteria: "Check for accuracy",
      }, db);

      expect(msg.type).toBe("feedback");
      expect(msg.protocolStatus).toBe("awaiting_review");
      expect(msg.metadata?.artifact).toBe("docs/q4-report.md");
      expect(msg.metadata?.reviewCriteria).toBe("Check for accuracy");
    });

    it("submitFeedback with approve transitions to approved", () => {
      const feedback = initiateFeedback({
        fromAgent: "ceo", toAgent: "reviewer", projectId: PROJECT,
        content: "Review this", artifact: "file.ts",
      }, db);

      const { original, review } = submitFeedback({
        projectId: PROJECT, originalMessageId: feedback.id,
        reviewerAgent: "reviewer", content: "Looks good!",
        verdict: "approve",
      }, db);

      expect(original.protocolStatus).toBe("approved");
      expect(review.toAgent).toBe("ceo");

      const inDb = getMessage(PROJECT, feedback.id, db);
      expect(inDb!.metadata?.verdict).toBe("approve");
    });

    it("submitFeedback with revise transitions to revision_requested", () => {
      const feedback = initiateFeedback({
        fromAgent: "ceo", toAgent: "reviewer", projectId: PROJECT,
        content: "Review this", artifact: "file.ts",
      }, db);

      const { original } = submitFeedback({
        projectId: PROJECT, originalMessageId: feedback.id,
        reviewerAgent: "reviewer", content: "Needs changes",
        verdict: "revise",
      }, db);

      expect(original.protocolStatus).toBe("revision_requested");
    });

    it("submitFeedback with reject transitions to reviewed", () => {
      const feedback = initiateFeedback({
        fromAgent: "ceo", toAgent: "reviewer", projectId: PROJECT,
        content: "Review this", artifact: "file.ts",
      }, db);

      const { original } = submitFeedback({
        projectId: PROJECT, originalMessageId: feedback.id,
        reviewerAgent: "reviewer", content: "Not acceptable",
        verdict: "reject",
      }, db);

      expect(original.protocolStatus).toBe("reviewed");
      const inDb = getMessage(PROJECT, feedback.id, db);
      expect(inDb!.metadata?.verdict).toBe("reject");
    });
  });

  // --- Query functions ---

  describe("queries", () => {
    it("getActiveProtocols returns non-terminal protocols for agent", () => {
      // Active request (as recipient)
      initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "question",
      }, db);

      // Active delegation (as sender)
      initiateDelegation({
        fromAgent: "cfo", toAgent: "intern", projectId: PROJECT,
        content: "do this",
      }, db);

      // Resolved request (terminal — should NOT appear)
      const resolved = initiateRequest({
        fromAgent: "cto", toAgent: "cfo", projectId: PROJECT,
        content: "old question",
      }, db);
      respondToRequest({
        projectId: PROJECT, originalMessageId: resolved.id,
        responderAgent: "cfo", content: "answered",
      }, db);

      const active = getActiveProtocols(PROJECT, "cfo", db);
      expect(active).toHaveLength(2);
    });

    it("getExpiredProtocols returns past-deadline protocols", () => {
      // Expired request (deadline in the past)
      initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "urgent question", deadlineMs: -1000, // already expired
      }, db);

      // Future deadline (should NOT appear)
      initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "later question", deadlineMs: 60 * 60 * 1000,
      }, db);

      // No deadline (should NOT appear)
      initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "no deadline question",
      }, db);

      const expired = getExpiredProtocols(PROJECT, Date.now(), db);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.content).toBe("urgent question");
    });
  });

  // --- Lifecycle ---

  describe("lifecycle", () => {
    it("expireProtocol sets status to expired", () => {
      const req = initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "question", deadlineMs: -1000,
      }, db);

      expireProtocol(req.id, db);

      const updated = getMessage(PROJECT, req.id, db);
      expect(updated!.protocolStatus).toBe("expired");
    });

    it("escalateProtocol sets status and stores escalation ref", () => {
      const req = initiateRequest({
        fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
        content: "question", deadlineMs: -1000,
      }, db);

      expireProtocol(req.id, db);
      escalateProtocol(req.id, "esc-msg-123", db);

      const updated = getMessage(PROJECT, req.id, db);
      expect(updated!.protocolStatus).toBe("escalated");
      expect(updated!.metadata?.escalationMessageId).toBe("esc-msg-123");
    });
  });

  // --- Validation ---

  describe("validateProtocolTransition", () => {
    it("allows valid transitions", () => {
      expect(validateProtocolTransition("awaiting_response", "resolved", "request").valid).toBe(true);
      expect(validateProtocolTransition("pending_acceptance", "in_progress", "delegation").valid).toBe(true);
      expect(validateProtocolTransition("in_progress", "completed", "delegation").valid).toBe(true);
      expect(validateProtocolTransition("awaiting_review", "approved", "feedback").valid).toBe(true);
    });

    it("rejects invalid transitions", () => {
      expect(validateProtocolTransition("resolved", "awaiting_response", "request").valid).toBe(false);
      expect(validateProtocolTransition("pending_acceptance", "completed", "delegation").valid).toBe(false);
      expect(validateProtocolTransition("approved", "awaiting_review", "feedback").valid).toBe(false);
    });

    it("rejects non-protocol types", () => {
      expect(validateProtocolTransition("awaiting_response", "resolved", "direct").valid).toBe(false);
    });
  });
});
