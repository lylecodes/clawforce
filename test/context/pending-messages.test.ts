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
const { createMessage, getMessage } = await import("../../src/messaging/store.js");
const { assembleContext } = await import("../../src/context/assembler.js");

describe("pending_messages context source", () => {
  let db: DatabaseSync;
  const PROJECT = "pending-msg-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns empty string when no pending messages", () => {
    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    // No pending messages section
    expect(context).not.toContain("Pending Messages");
  });

  it("renders pending messages in context", () => {
    createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Review the Q4 budget proposal",
      type: "delegation",
      priority: "high",
    }, db);

    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("Pending Messages");
    expect(context).toContain("1 unread message");
    expect(context).toContain("ceo");
    expect(context).toContain("delegation");
    expect(context).toContain("[HIGH]");
    expect(context).toContain("Review the Q4 budget proposal");
    expect(context).toContain("clawforce_message");
  });

  it("marks messages as delivered after assembly", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "test message",
    }, db);

    // First assembly delivers the message
    assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    // Message should be marked delivered
    const updated = getMessage(PROJECT, msg.id, db);
    expect(updated!.status).toBe("delivered");

    // Second assembly should not show the message again
    const context2 = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context2).not.toContain("Pending Messages");
  });

  it("flags urgent priority messages", () => {
    createMessage({
      fromAgent: "system:escalation:worker",
      toAgent: "manager",
      projectId: PROJECT,
      content: "Agent failed compliance check",
      type: "escalation",
      priority: "urgent",
    }, db);

    const context = assembleContext("manager", {
      extends: "manager",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("**[URGENT]**");
    expect(context).toContain("escalation");
  });

  it("renders multiple messages", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "msg1" }, db);
    createMessage({ fromAgent: "cto", toAgent: "cfo", projectId: PROJECT, content: "msg2" }, db);

    const context = assembleContext("cfo", {
      extends: "employee",
      briefing: [{ source: "pending_messages" }],
      expectations: [],
      performance_policy: { action: "alert" },
    }, { projectId: PROJECT });

    expect(context).toContain("2 unread message");
    expect(context).toContain("msg1");
    expect(context).toContain("msg2");
  });
});
