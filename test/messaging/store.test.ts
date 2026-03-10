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
  createMessage,
  getMessage,
  getPendingMessages,
  listMessages,
  listSentMessages,
  markDelivered,
  markBulkDelivered,
  markRead,
  getThread,
  searchMessages,
} = await import("../../src/messaging/store.js");

describe("messaging/store", () => {
  let db: DatabaseSync;
  const PROJECT = "msg-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a message and retrieves it by ID", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Review the budget",
    }, db);

    expect(msg.id).toBeDefined();
    expect(msg.fromAgent).toBe("ceo");
    expect(msg.toAgent).toBe("cfo");
    expect(msg.type).toBe("direct");
    expect(msg.priority).toBe("normal");
    expect(msg.status).toBe("queued");
    expect(msg.content).toBe("Review the budget");

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(msg.id);
    expect(fetched!.content).toBe("Review the budget");
  });

  it("creates a message with custom type and priority", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      type: "delegation",
      priority: "high",
      content: "Handle this ASAP",
    }, db);

    expect(msg.type).toBe("delegation");
    expect(msg.priority).toBe("high");
  });

  it("returns null for non-existent message", () => {
    const msg = getMessage(PROJECT, "nonexistent", db);
    expect(msg).toBeNull();
  });

  it("lists pending messages for an agent", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "msg1" }, db);
    createMessage({ fromAgent: "cto", toAgent: "cfo", projectId: PROJECT, content: "msg2" }, db);
    createMessage({ fromAgent: "ceo", toAgent: "cto", projectId: PROJECT, content: "msg3" }, db);

    const pending = getPendingMessages(PROJECT, "cfo", db);
    expect(pending).toHaveLength(2);
    expect(pending[0]!.content).toBe("msg1");
    expect(pending[1]!.content).toBe("msg2");
  });

  it("lists messages with filters", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, type: "direct", content: "a" }, db);
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, type: "delegation", content: "b" }, db);

    const all = listMessages(PROJECT, "cfo", {}, db);
    expect(all).toHaveLength(2);

    const delegations = listMessages(PROJECT, "cfo", { type: "delegation" }, db);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]!.type).toBe("delegation");
  });

  it("lists sent messages", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "sent1" }, db);
    createMessage({ fromAgent: "ceo", toAgent: "cto", projectId: PROJECT, content: "sent2" }, db);

    const sent = listSentMessages(PROJECT, "ceo", {}, db);
    expect(sent).toHaveLength(2);
  });

  it("marks a message as delivered", () => {
    const msg = createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "test" }, db);
    expect(msg.status).toBe("queued");

    markDelivered(msg.id, db);

    const updated = getMessage(PROJECT, msg.id, db);
    expect(updated!.status).toBe("delivered");
    expect(updated!.deliveredAt).not.toBeNull();
  });

  it("marks multiple messages as delivered in bulk", () => {
    const m1 = createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "a" }, db);
    const m2 = createMessage({ fromAgent: "cto", toAgent: "cfo", projectId: PROJECT, content: "b" }, db);

    markBulkDelivered([m1.id, m2.id], db);

    expect(getMessage(PROJECT, m1.id, db)!.status).toBe("delivered");
    expect(getMessage(PROJECT, m2.id, db)!.status).toBe("delivered");

    // Pending should be empty now
    const pending = getPendingMessages(PROJECT, "cfo", db);
    expect(pending).toHaveLength(0);
  });

  it("marks a message as read", () => {
    const msg = createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "test" }, db);

    markRead(PROJECT, msg.id, db);

    const updated = getMessage(PROJECT, msg.id, db);
    expect(updated!.status).toBe("read");
    expect(updated!.readAt).not.toBeNull();
  });

  it("supports reply threading", () => {
    const original = createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "question?" }, db);
    const reply1 = createMessage({ fromAgent: "cfo", toAgent: "ceo", projectId: PROJECT, content: "answer!", parentMessageId: original.id }, db);
    const reply2 = createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "thanks", parentMessageId: original.id }, db);

    expect(reply1.parentMessageId).toBe(original.id);

    const thread = getThread(PROJECT, original.id, db);
    expect(thread).toHaveLength(2);
    expect(thread[0]!.content).toBe("answer!");
    expect(thread[1]!.content).toBe("thanks");
  });

  it("scopes messages by project", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: "proj-a", content: "a" }, db);
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: "proj-b", content: "b" }, db);

    const messagesA = getPendingMessages("proj-a", "cfo", db);
    expect(messagesA).toHaveLength(1);
    expect(messagesA[0]!.content).toBe("a");

    const messagesB = getPendingMessages("proj-b", "cfo", db);
    expect(messagesB).toHaveLength(1);
    expect(messagesB[0]!.content).toBe("b");
  });

  it("searches messages across agents", () => {
    createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: "hello" }, db);
    createMessage({ fromAgent: "cfo", toAgent: "ceo", projectId: PROJECT, content: "reply" }, db);
    createMessage({ fromAgent: "cto", toAgent: "vp", projectId: PROJECT, content: "other" }, db);

    const { messages, hasMore } = searchMessages(PROJECT, { agentId: "ceo" }, db);
    expect(messages).toHaveLength(2); // ceo as sender + receiver
    expect(hasMore).toBe(false);

    const all = searchMessages(PROJECT, {}, db);
    expect(all.messages).toHaveLength(3);
  });

  it("respects limit in list queries", () => {
    for (let i = 0; i < 5; i++) {
      createMessage({ fromAgent: "ceo", toAgent: "cfo", projectId: PROJECT, content: `msg-${i}` }, db);
    }

    const limited = listMessages(PROJECT, "cfo", { limit: 3 }, db);
    expect(limited).toHaveLength(3);
  });
});
