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
const { initiateRequest, initiateDelegation, initiateFeedback } = await import("../../src/messaging/protocols.js");
const { assembleContext } = await import("../../src/context/assembler.js");

describe("protocol messages context rendering", () => {
  let db: DatabaseSync;
  const PROJECT = "proto-ctx-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("renders request messages with respond instruction", () => {
    initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "What is the Q4 budget?",
    }, db);

    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("REQUEST from ceo");
    expect(context).toContain("What is the Q4 budget?");
    expect(context).toContain("clawforce_message respond");
  });

  it("renders delegation messages with accept/reject instruction", () => {
    initiateDelegation({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "Prepare the annual report",
    }, db);

    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("DELEGATION from ceo");
    expect(context).toContain("Prepare the annual report");
    expect(context).toContain("clawforce_message accept");
    expect(context).toContain("reject");
  });

  it("renders feedback messages with artifact and submit_review instruction", () => {
    initiateFeedback({
      fromAgent: "ceo", toAgent: "reviewer", projectId: PROJECT,
      content: "Please review this document",
      artifact: "docs/q4-report.md",
      reviewCriteria: "Check for accuracy",
    }, db);

    const context = assembleContext("reviewer", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("REVIEW REQUEST from ceo");
    expect(context).toContain("docs/q4-report.md");
    expect(context).toContain("Check for accuracy");
    expect(context).toContain("clawforce_message submit_review");
    expect(context).toContain("approve|revise|reject");
  });

  it("renders request with deadline info", () => {
    initiateRequest({
      fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT,
      content: "Urgent question", priority: "high",
      deadlineMs: 30 * 60 * 1000, // 30 minutes
    }, db);

    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("REQUEST from ceo");
    expect(context).toContain("[HIGH]");
    expect(context).toContain("deadline:");
  });
});
