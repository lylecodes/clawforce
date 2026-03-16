/**
 * Tests for the MessagesNamespace SDK wrapper.
 *
 * Strategy: use getMemoryDb() for an isolated in-memory SQLite database and
 * pass it via opts.db so that no production DB is touched. Internal messaging
 * functions are imported directly to set up state that the namespace methods
 * then verify, ensuring end-to-end coverage of the from/to ↔ fromAgent/toAgent
 * vocabulary mapping.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

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

// Mock safety to allow all messages through
vi.mock("../../src/safety.js", () => ({
  checkMessageRate: vi.fn(() => ({ ok: true })),
  getSafetyConfig: vi.fn(() => ({})),
}));

// ---- Dynamic imports after mocks ----

const { getMemoryDb } = await import("../../src/db.js");
const {
  createMessage,
  getMessage,
  listMessages,
  getPendingMessages,
  markDelivered: internalMarkDelivered,
  markRead: internalMarkRead,
  getThread,
} = await import("../../src/messaging/store.js");

// ---- Constants ----

const DOMAIN = "test-project";

// ---- Helpers ----

/** Create a message via internal function, returns the internal Message. */
function makeMessage(
  db: DatabaseSync,
  overrides: {
    from?: string;
    to?: string;
    content?: string;
    type?: string;
    parentMessageId?: string;
  } = {},
) {
  return createMessage(
    {
      fromAgent: overrides.from ?? "agent:alice",
      toAgent: overrides.to ?? "agent:bob",
      projectId: DOMAIN,
      content: overrides.content ?? "hello",
      type: (overrides.type as any) ?? "direct",
      parentMessageId: overrides.parentMessageId,
    },
    db,
  );
}

// ---- Tests ----

describe("MessagesNamespace (via internal store + opts.db)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- MessagesNamespace constructor ----------

  describe("MessagesNamespace class", () => {
    it("exposes domain string on instance", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace("research-lab");
      expect(ns.domain).toBe("research-lab");
    });

    it("stores arbitrary domain strings", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      expect(new MessagesNamespace("my-project").domain).toBe("my-project");
      expect(new MessagesNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- send ----------

  describe("send", () => {
    it("creates a message and returns public shape with from/to", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msg = ns.send(
        { from: "agent:alice", to: "agent:bob", content: "hello" },
        { db },
      );

      expect(msg.id).toBeTruthy();
      expect(msg.from).toBe("agent:alice");
      expect(msg.to).toBe("agent:bob");
      expect(msg.content).toBe("hello");
      expect(msg.type).toBe("direct");
      expect(msg.status).toBe("queued");
      expect(typeof msg.createdAt).toBe("number");
    });

    it("public Message has no fromAgent/toAgent fields", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);
      const msg = ns.send({ from: "agent:alice", to: "agent:bob", content: "test" }, { db });

      expect((msg as any).fromAgent).toBeUndefined();
      expect((msg as any).toAgent).toBeUndefined();
    });

    it("forwards optional type, channelId, parentMessageId, metadata", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const parent = ns.send({ from: "agent:alice", to: "agent:bob", content: "parent" }, { db });
      const reply = ns.send(
        {
          from: "agent:bob",
          to: "agent:alice",
          content: "reply",
          type: "direct",
          parentMessageId: parent.id,
          metadata: { key: "value" },
        },
        { db },
      );

      expect(reply.type).toBe("direct");
      // Verify the message actually exists in the DB with the parent link
      const raw = getMessage(DOMAIN, reply.id, db);
      expect(raw?.parentMessageId).toBe(parent.id);
      expect(raw?.metadata).toEqual({ key: "value" });
    });
  });

  // ---------- get ----------

  describe("get", () => {
    it("retrieves a message by ID with public from/to", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const created = ns.send({ from: "agent:alice", to: "agent:bob", content: "hi" }, { db });
      const fetched = ns.get(created.id, { db });

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.from).toBe("agent:alice");
      expect(fetched!.to).toBe("agent:bob");
    });

    it("returns undefined for a non-existent message ID", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);
      expect(ns.get("no-such-id", { db })).toBeUndefined();
    });
  });

  // ---------- list ----------

  describe("list", () => {
    beforeEach(() => {
      makeMessage(db, { from: "agent:alice", to: "agent:bob", content: "msg1" });
      makeMessage(db, { from: "agent:carol", to: "agent:bob", content: "msg2" });
      makeMessage(db, { from: "agent:alice", to: "agent:carol", content: "msg3" });
    });

    it("lists all messages to a recipient", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ to: "agent:bob" }, { db });
      expect(msgs).toHaveLength(2);
      expect(msgs.every((m) => m.to === "agent:bob")).toBe(true);
    });

    it("filters by to and from together", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ to: "agent:bob", from: "agent:alice" }, { db });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.from).toBe("agent:alice");
      expect(msgs[0]!.to).toBe("agent:bob");
    });

    it("filters by from only (searches all messages)", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ from: "agent:alice" }, { db });
      expect(msgs.length).toBe(2);
      expect(msgs.every((m) => m.from === "agent:alice")).toBe(true);
    });

    it("respects limit", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ to: "agent:bob", limit: 1 }, { db });
      expect(msgs).toHaveLength(1);
    });

    it("returns public Message objects (from/to, no fromAgent/toAgent)", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ to: "agent:bob" }, { db });
      for (const m of msgs) {
        expect(m.from).toBeTruthy();
        expect(m.to).toBeTruthy();
        expect((m as any).fromAgent).toBeUndefined();
        expect((m as any).toAgent).toBeUndefined();
      }
    });

    it("returns empty array when no messages match", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.list({ to: "agent:nobody" }, { db });
      expect(msgs).toEqual([]);
    });
  });

  // ---------- search ----------

  describe("search", () => {
    beforeEach(() => {
      makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      makeMessage(db, { from: "agent:bob", to: "agent:carol" });
      makeMessage(db, { from: "agent:carol", to: "agent:dave" });
    });

    it("returns messages where the query agent is sender or recipient", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.search("agent:bob", undefined, { db });
      // agent:bob is recipient of msg1 and sender of msg2
      expect(msgs.length).toBe(2);
      expect(msgs.every((m) => m.from === "agent:bob" || m.to === "agent:bob")).toBe(true);
    });

    it("respects limit param", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.search("agent:bob", 1, { db });
      expect(msgs).toHaveLength(1);
    });

    it("returns empty array when agent has no messages", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const msgs = ns.search("agent:nobody", undefined, { db });
      expect(msgs).toEqual([]);
    });
  });

  // ---------- pending ----------

  describe("pending", () => {
    it("returns only queued messages for the agent", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      makeMessage(db, { from: "agent:carol", to: "agent:bob" });

      const msgs = ns.pending("agent:bob", { db });
      expect(msgs.length).toBe(2);
      expect(msgs.every((m) => m.status === "queued")).toBe(true);
      expect(msgs.every((m) => m.to === "agent:bob")).toBe(true);
    });

    it("does not include delivered messages", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const m = makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      internalMarkDelivered(m.id, db);

      const msgs = ns.pending("agent:bob", { db });
      expect(msgs.every((msg) => msg.status === "queued")).toBe(true);
      expect(msgs.find((msg) => msg.id === m.id)).toBeUndefined();
    });
  });

  // ---------- markDelivered ----------

  describe("markDelivered", () => {
    it("sets message status to delivered", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const m = makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      expect(getMessage(DOMAIN, m.id, db)?.status).toBe("queued");

      ns.markDelivered(m.id, { db });

      expect(getMessage(DOMAIN, m.id, db)?.status).toBe("delivered");
    });

    it("is a no-op when called without a db override", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const m = makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      // Should not throw — just a no-op per internal contract
      expect(() => ns.markDelivered(m.id)).not.toThrow();
    });
  });

  // ---------- markRead ----------

  describe("markRead", () => {
    it("sets message status to read", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const m = makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      ns.markRead(m.id, { db });

      expect(getMessage(DOMAIN, m.id, db)?.status).toBe("read");
    });
  });

  // ---------- thread ----------

  describe("thread", () => {
    it("returns replies to a parent message in ascending order", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const parent = makeMessage(db, { from: "agent:alice", to: "agent:bob", content: "parent" });
      makeMessage(db, { from: "agent:bob", to: "agent:alice", content: "reply1", parentMessageId: parent.id });
      makeMessage(db, { from: "agent:alice", to: "agent:bob", content: "reply2", parentMessageId: parent.id });

      const thread = ns.thread(parent.id, { db });
      expect(thread).toHaveLength(2);
      expect(thread[0]!.content).toBe("reply1");
      expect(thread[1]!.content).toBe("reply2");
    });

    it("returns empty array when no replies exist", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const parent = makeMessage(db, { from: "agent:alice", to: "agent:bob", content: "solo" });
      const thread = ns.thread(parent.id, { db });
      expect(thread).toEqual([]);
    });

    it("returns public Message objects with from/to mapping", async () => {
      const { MessagesNamespace } = await import("../../src/sdk/messages.js");
      const ns = new MessagesNamespace(DOMAIN);

      const parent = makeMessage(db, { from: "agent:alice", to: "agent:bob" });
      makeMessage(db, { from: "agent:bob", to: "agent:alice", parentMessageId: parent.id });

      const thread = ns.thread(parent.id, { db });
      expect(thread[0]!.from).toBe("agent:bob");
      expect(thread[0]!.to).toBe("agent:alice");
      expect((thread[0] as any).fromAgent).toBeUndefined();
    });
  });
});
