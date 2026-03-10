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
const { createClawforceMessageTool } = await import("../../src/tools/message-tool.js");
const { getMessage, getPendingMessages } = await import("../../src/messaging/store.js");

describe("clawforce_message tool", () => {
  let db: DatabaseSync;
  const PROJECT = "msg-tool-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  function createTool(agentId = "ceo") {
    return createClawforceMessageTool({
      agentSessionKey: `agent:${agentId}`,
      agentId,
      projectId: PROJECT,
    });
  }

  it("send creates a message", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-1", {
      action: "send",
      to: "cfo",
      content: "Please review the budget",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.message.to).toBe("cfo");
    expect(parsed.message.type).toBe("direct");

    // Verify message in DB
    const pending = getPendingMessages(PROJECT, "cfo", db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe("Please review the budget");
  });

  it("send requires 'to' parameter", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-2", {
      action: "send",
      content: "Missing recipient",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("to");
  });

  it("send requires 'content' parameter", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-3", {
      action: "send",
      to: "cfo",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("content");
  });

  it("send rejects invalid message type", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-4", {
      action: "send",
      to: "cfo",
      content: "test",
      type: "invalid_type",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("Invalid message type");
  });

  it("send rejects invalid priority", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-5", {
      action: "send",
      to: "cfo",
      content: "test",
      priority: "mega_urgent",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("Invalid priority");
  });

  it("list returns inbox messages", async () => {
    const tool = createTool("cfo");

    // Create some messages to cfo
    const sendTool = createTool("ceo");
    await sendTool.execute("tc-s1", { action: "send", to: "cfo", content: "msg1" });
    await sendTool.execute("tc-s2", { action: "send", to: "cfo", content: "msg2" });

    const result = await tool.execute("tc-6", { action: "list" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.messages).toHaveLength(2);
  });

  it("read marks message as read and returns content", async () => {
    const sendTool = createTool("ceo");
    const sendResult = await sendTool.execute("tc-s3", {
      action: "send",
      to: "cfo",
      content: "Important message",
    });
    const messageId = JSON.parse(sendResult.content[0].text).message.id;

    const tool = createTool("cfo");
    const result = await tool.execute("tc-7", {
      action: "read",
      message_id: messageId,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.message.content).toBe("Important message");
    expect(parsed.message.status).toBe("read");

    // Verify in DB
    const msg = getMessage(PROJECT, messageId, db);
    expect(msg!.status).toBe("read");
  });

  it("read returns error for non-existent message", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-8", {
      action: "read",
      message_id: "nonexistent",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("not found");
  });

  it("reply creates a linked message to the original sender", async () => {
    // CEO sends to CFO
    const sendTool = createTool("ceo");
    const sendResult = await sendTool.execute("tc-s4", {
      action: "send",
      to: "cfo",
      content: "Question?",
    });
    const originalId = JSON.parse(sendResult.content[0].text).message.id;

    // CFO replies
    const replyTool = createTool("cfo");
    const result = await replyTool.execute("tc-9", {
      action: "reply",
      message_id: originalId,
      content: "Answer!",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.message.to).toBe("ceo"); // Reply goes to original sender
    expect(parsed.message.inReplyTo).toBe(originalId);

    // Verify reply message exists in CEO's inbox
    const ceoPending = getPendingMessages(PROJECT, "ceo", db);
    expect(ceoPending).toHaveLength(1);
    expect(ceoPending[0]!.content).toBe("Answer!");
    expect(ceoPending[0]!.parentMessageId).toBe(originalId);
  });

  it("send with custom type and priority", async () => {
    const tool = createTool();
    const result = await tool.execute("tc-10", {
      action: "send",
      to: "cfo",
      content: "Delegate this work",
      type: "delegation",
      priority: "high",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.message.type).toBe("delegation");
    expect(parsed.message.priority).toBe("high");
  });
});
