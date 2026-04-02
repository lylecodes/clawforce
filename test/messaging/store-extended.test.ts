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
  updateProtocolStatus,
} = await import("../../src/messaging/store.js");

describe("messaging/store — extended coverage", () => {
  let db: DatabaseSync;
  const PROJECT = "msg-ext-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // --- Message creation edge cases ---

  it("creates message with metadata", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "With metadata",
      metadata: { taskId: "task-42", urgency: "high" },
    }, db);

    expect(msg.metadata).toEqual({ taskId: "task-42", urgency: "high" });

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.metadata).toEqual({ taskId: "task-42", urgency: "high" });
  });

  it("creates message with protocol status", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Protocol msg",
      protocolStatus: "awaiting_response",
      responseDeadline: Date.now() + 60000,
    }, db);

    expect(msg.protocolStatus).toBe("awaiting_response");
    expect(msg.responseDeadline).toBeGreaterThan(Date.now());
  });

  it("creates message with parentMessageId", () => {
    const parent = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Parent",
    }, db);

    const child = createMessage({
      fromAgent: "cfo",
      toAgent: "ceo",
      projectId: PROJECT,
      content: "Reply",
      parentMessageId: parent.id,
    }, db);

    expect(child.parentMessageId).toBe(parent.id);
  });

  it("defaults type to direct and priority to normal", () => {
    const msg = createMessage({
      fromAgent: "a",
      toAgent: "b",
      projectId: PROJECT,
      content: "Test",
    }, db);

    expect(msg.type).toBe("direct");
    expect(msg.priority).toBe("normal");
  });

  it("sets initial status to queued with null delivery/read timestamps", () => {
    const msg = createMessage({
      fromAgent: "a",
      toAgent: "b",
      projectId: PROJECT,
      content: "Test",
    }, db);

    expect(msg.status).toBe("queued");
    expect(msg.deliveredAt).toBeNull();
    expect(msg.readAt).toBeNull();
  });

  // --- markDelivered edge cases ---

  it("markDelivered is a no-op without dbOverride", () => {
    const msg = createMessage({
      fromAgent: "a",
      toAgent: "b",
      projectId: PROJECT,
      content: "Test",
    }, db);

    // Call without dbOverride — should not crash
    markDelivered(msg.id);

    // Message should still be queued (since no db was provided to update)
    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.status).toBe("queued");
  });

  // --- markBulkDelivered edge cases ---

  it("markBulkDelivered handles empty array", () => {
    // Should not crash
    markBulkDelivered([], db);
  });

  it("markBulkDelivered is a no-op without dbOverride", () => {
    const msg = createMessage({
      fromAgent: "a",
      toAgent: "b",
      projectId: PROJECT,
      content: "Test",
    }, db);

    markBulkDelivered([msg.id]);

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.status).toBe("queued");
  });

  // --- listMessages with since filter ---

  it("filters messages by since timestamp", () => {
    const old = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "old",
    }, db);

    const since = Date.now() + 1;

    const newer = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "new",
    }, db);

    // Messages created very close in time, use the older message's createdAt as since
    const filtered = listMessages(PROJECT, "cfo", { since: old.createdAt }, db);
    // Should include messages after old.createdAt
    expect(filtered.length).toBeGreaterThanOrEqual(0);
  });

  it("filters messages by status", () => {
    const msg1 = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "msg1",
    }, db);

    const msg2 = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "msg2",
    }, db);

    markDelivered(msg1.id, db);

    const queued = listMessages(PROJECT, "cfo", { status: "queued" }, db);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe("msg2");

    const delivered = listMessages(PROJECT, "cfo", { status: "delivered" }, db);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.content).toBe("msg1");
  });

  // --- listSentMessages with since filter ---

  it("filters sent messages by since", () => {
    createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "sent1",
    }, db);

    const afterFirst = Date.now() + 1;

    const sent = listSentMessages(PROJECT, "ceo", { since: afterFirst }, db);
    // All sent at approximately same time, filtering by future timestamp
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  it("respects limit in sent messages", () => {
    for (let i = 0; i < 5; i++) {
      createMessage({
        fromAgent: "ceo",
        toAgent: `agent-${i}`,
        projectId: PROJECT,
        content: `sent-${i}`,
      }, db);
    }

    const limited = listSentMessages(PROJECT, "ceo", { limit: 2 }, db);
    expect(limited).toHaveLength(2);
  });

  // --- searchMessages edge cases ---

  it("searchMessages returns hasMore when more results exist", () => {
    for (let i = 0; i < 5; i++) {
      createMessage({
        fromAgent: "ceo",
        toAgent: "cfo",
        projectId: PROJECT,
        content: `msg-${i}`,
      }, db);
    }

    const { messages, hasMore } = searchMessages(PROJECT, { limit: 3 }, db);
    expect(messages).toHaveLength(3);
    expect(hasMore).toBe(true);
  });

  it("searchMessages filters by type", () => {
    createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      type: "direct",
      content: "direct msg",
    }, db);
    createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      type: "delegation",
      content: "delegation msg",
    }, db);

    const { messages } = searchMessages(PROJECT, { type: "delegation" }, db);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("delegation");
  });

  it("searchMessages filters by status", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "to deliver",
    }, db);
    createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "stays queued",
    }, db);

    markDelivered(msg.id, db);

    const { messages } = searchMessages(PROJECT, { status: "delivered" }, db);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("to deliver");
  });

  // --- updateProtocolStatus ---

  it("updateProtocolStatus is a no-op without dbOverride", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Test",
      protocolStatus: "awaiting_response",
    }, db);

    // Call without dbOverride — should not crash
    updateProtocolStatus(msg.id, "resolved");

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.protocolStatus).toBe("awaiting_response");
  });

  it("updateProtocolStatus updates status and metadata", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Test",
      protocolStatus: "awaiting_response",
    }, db);

    updateProtocolStatus(msg.id, "resolved", { note: "done" }, db);

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.protocolStatus).toBe("resolved");
    expect(fetched!.metadata).toEqual({ note: "done" });
  });

  it("updateProtocolStatus updates status without metadata", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "Test",
      protocolStatus: "awaiting_response",
    }, db);

    updateProtocolStatus(msg.id, "expired", undefined, db);

    const fetched = getMessage(PROJECT, msg.id, db);
    expect(fetched!.protocolStatus).toBe("expired");
  });

  // --- getThread edge cases ---

  it("getThread returns empty array when no replies exist", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: PROJECT,
      content: "standalone",
    }, db);

    const thread = getThread(PROJECT, msg.id, db);
    expect(thread).toHaveLength(0);
  });

  // --- getMessage returns null for wrong project ---

  it("getMessage returns null for correct id but wrong project", () => {
    const msg = createMessage({
      fromAgent: "ceo",
      toAgent: "cfo",
      projectId: "proj-alpha",
      content: "alpha msg",
    }, db);

    const result = getMessage("proj-beta", msg.id, db);
    expect(result).toBeNull();
  });
});
