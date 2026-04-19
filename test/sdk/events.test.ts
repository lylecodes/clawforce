/**
 * Tests for the EventsNamespace SDK wrapper.
 *
 * Strategy: import internal event store functions with a shared in-memory DB
 * (via the db option on each method) to keep tests deterministic and isolated.
 * The in-process subscription system (on/off) is exercised purely in-memory —
 * it does not touch the DB.
 */

import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

// ---- Dynamic imports after mocks ----

const { getMemoryDb } = await import("../../src/db.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");

// ---- Constants ----

const DOMAIN = "test-events-project";

// ---- Tests ----

describe("EventsNamespace", () => {
  let db: DatabaseSync;
  let ns: InstanceType<typeof EventsNamespace>;

  beforeEach(() => {
    db = getMemoryDb();
    ns = new EventsNamespace(DOMAIN);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("stores arbitrary domain strings", () => {
      expect(new EventsNamespace("research-lab").domain).toBe("research-lab");
      expect(new EventsNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- emit + list (persistence) ----------

  describe("emit persists an event", () => {
    it("returns a ClawforceEvent with the correct type and payload", () => {
      const event = ns.emit("task.completed", { taskId: "t-1" }, { db });
      expect(event.id).toBeTruthy();
      expect(event.type).toBe("task.completed");
      expect(event.payload).toEqual({ taskId: "t-1" });
      expect(event.status).toBe("pending");
      expect(typeof event.createdAt).toBe("number");
    });

    it("persisted event is retrievable via list()", () => {
      const emitted = ns.emit("agent.started", { agentId: "a-1" }, { db });
      const events = ns.list({ db });
      expect(events.length).toBe(1);
      expect(events[0]!.id).toBe(emitted.id);
      expect(events[0]!.type).toBe("agent.started");
    });

    it("defaults source to 'internal'", () => {
      const event = ns.emit("test.event", {}, { db });
      expect(event.source).toBe("internal");
    });

    it("uses provided source option", () => {
      const event = ns.emit("webhook.received", {}, { source: "webhook", db });
      expect(event.source).toBe("webhook");
    });

    it("uses empty payload when none provided", () => {
      const event = ns.emit("ping", undefined, { db });
      expect(event.payload).toEqual({});
    });
  });

  // ---------- list with filters ----------

  describe("list", () => {
    beforeEach(() => {
      ns.emit("task.created", { id: "t-1" }, { db });
      ns.emit("task.completed", { id: "t-2" }, { db });
      ns.emit("agent.error", { msg: "oops" }, { db });
    });

    it("lists all events when no filter is provided", () => {
      const events = ns.list({ db });
      expect(events.length).toBe(3);
    });

    it("filters by type", () => {
      const events = ns.list({ type: "task.created", db });
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("task.created");
    });

    it("filters by status (all start as pending)", () => {
      const events = ns.list({ status: "pending", db });
      expect(events.length).toBe(3);
    });

    it("filters by status that matches nothing", () => {
      const events = ns.list({ status: "handled", db });
      expect(events.length).toBe(0);
    });

    it("respects limit", () => {
      const events = ns.list({ limit: 1, db });
      expect(events.length).toBe(1);
    });

    it("respects offset for pagination", () => {
      const all = ns.list({ db });
      const page2 = ns.list({ limit: 2, offset: 1, db });
      expect(page2.length).toBe(2);
      // first result in page2 should be the second-newest event
      expect(page2[0]!.id).toBe(all[1]!.id);
    });

    it("returns public ClawforceEvent shape with required fields", () => {
      const events = ns.list({ db });
      for (const e of events) {
        expect(typeof e.id).toBe("string");
        expect(typeof e.type).toBe("string");
        expect(typeof e.source).toBe("string");
        expect(typeof e.payload).toBe("object");
        expect(typeof e.status).toBe("string");
        expect(typeof e.createdAt).toBe("number");
      }
    });
  });

  // ---------- count ----------

  describe("count", () => {
    it("returns 0 for an empty store", () => {
      expect(ns.count({ db })).toBe(0);
    });

    it("returns correct total count", () => {
      ns.emit("a", {}, { db });
      ns.emit("b", {}, { db });
      ns.emit("c", {}, { db });
      expect(ns.count({ db })).toBe(3);
    });

    it("filters count by type", () => {
      ns.emit("task.created", {}, { db });
      ns.emit("task.created", {}, { db });
      ns.emit("agent.error", {}, { db });
      expect(ns.count({ type: "task.created", db })).toBe(2);
      expect(ns.count({ type: "agent.error", db })).toBe(1);
    });

    it("filters count by status", () => {
      ns.emit("evt", {}, { db });
      expect(ns.count({ status: "pending", db })).toBe(1);
      expect(ns.count({ status: "handled", db })).toBe(0);
    });
  });

  // ---------- on — fires callback on matching event ----------

  describe("on", () => {
    it("fires callback when matching event is emitted", () => {
      const handler = vi.fn();
      ns.on("task.completed", handler);
      ns.emit("task.completed", { id: "t-1" }, { db });
      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]![0];
      expect(received.type).toBe("task.completed");
      expect(received.payload).toEqual({ id: "t-1" });
    });

    it("does NOT fire callback for non-matching event types", () => {
      const handler = vi.fn();
      ns.on("task.completed", handler);
      ns.emit("agent.started", {}, { db });
      expect(handler).not.toHaveBeenCalled();
    });

    it("fires multiple handlers registered for the same type", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      ns.on("ping", h1);
      ns.on("ping", h2);
      ns.emit("ping", {}, { db });
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("fires the same handler multiple times for multiple emits", () => {
      const handler = vi.fn();
      ns.on("tick", handler);
      ns.emit("tick", {}, { db });
      ns.emit("tick", {}, { db });
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // ---------- off — stops callback from firing ----------

  describe("off", () => {
    it("removes handler so it no longer fires on emit", () => {
      const handler = vi.fn();
      ns.on("task.done", handler);
      ns.off("task.done", handler);
      ns.emit("task.done", {}, { db });
      expect(handler).not.toHaveBeenCalled();
    });

    it("removing one handler does not affect other handlers for the same type", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      ns.on("task.done", h1);
      ns.on("task.done", h2);
      ns.off("task.done", h1);
      ns.emit("task.done", {}, { db });
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("off is a no-op for an unregistered handler", () => {
      const handler = vi.fn();
      // Never registered — calling off should not throw
      expect(() => ns.off("task.done", handler)).not.toThrow();
    });

    it("off is a no-op for an unknown event type", () => {
      const handler = vi.fn();
      expect(() => ns.off("nonexistent.type", handler)).not.toThrow();
    });
  });

  // ---------- wildcard "*" ----------

  describe('wildcard "*"', () => {
    it("wildcard handler receives all event types", () => {
      const handler = vi.fn();
      ns.on("*", handler);
      ns.emit("task.created", {}, { db });
      ns.emit("agent.error", {}, { db });
      ns.emit("webhook.received", {}, { db });
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("wildcard handler receives events alongside type-specific handlers", () => {
      const typeHandler = vi.fn();
      const wildcardHandler = vi.fn();
      ns.on("task.created", typeHandler);
      ns.on("*", wildcardHandler);
      ns.emit("task.created", {}, { db });
      expect(typeHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });

    it("wildcard handler can be removed with off", () => {
      const handler = vi.fn();
      ns.on("*", handler);
      ns.off("*", handler);
      ns.emit("anything", {}, { db });
      expect(handler).not.toHaveBeenCalled();
    });

    it("emitting a literal '*' type event does not double-fire wildcard handlers", () => {
      // Wildcard handlers should not be fired twice when type === "*"
      const handler = vi.fn();
      ns.on("*", handler);
      ns.emit("*", {}, { db });
      // The event type is "*" — type-specific fires for "*", wildcard check skips (type === "*")
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- subscriber error isolation ----------

  describe("subscriber error isolation", () => {
    it("a throwing handler does not crash emit()", () => {
      const badHandler = vi.fn(() => { throw new Error("subscriber exploded"); });
      const goodHandler = vi.fn();
      ns.on("crash.test", badHandler);
      ns.on("crash.test", goodHandler);
      expect(() => ns.emit("crash.test", {}, { db })).not.toThrow();
    });

    it("good handlers still run after a throwing handler", () => {
      const badHandler = vi.fn(() => { throw new Error("boom"); });
      const goodHandler = vi.fn();
      // Register bad first, good second
      ns.on("crash.test", badHandler);
      ns.on("crash.test", goodHandler);
      ns.emit("crash.test", {}, { db });
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it("wildcard throwing handler does not prevent other handlers from running", () => {
      const badWildcard = vi.fn(() => { throw new Error("wildcard boom"); });
      const goodHandler = vi.fn();
      ns.on("*", badWildcard);
      ns.on("crash.wildcard", goodHandler);
      ns.emit("crash.wildcard", {}, { db });
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it("event is still persisted even if all handlers throw", () => {
      ns.on("persist.test", () => { throw new Error("throw 1"); });
      ns.on("persist.test", () => { throw new Error("throw 2"); });
      expect(() => ns.emit("persist.test", { data: 42 }, { db })).not.toThrow();
      const events = ns.list({ type: "persist.test", db });
      expect(events.length).toBe(1);
    });
  });

  // ---------- dedup key ----------

  describe("dedup key", () => {
    it("second emit with same dedupKey returns the original event id", () => {
      const first = ns.emit("idempotent.op", { v: 1 }, { dedupKey: "op-123", db });
      const second = ns.emit("idempotent.op", { v: 2 }, { dedupKey: "op-123", db });
      expect(second.id).toBe(first.id);
    });

    it("dedup prevents duplicate events from accumulating in the store", () => {
      ns.emit("idempotent.op", {}, { dedupKey: "key-abc", db });
      ns.emit("idempotent.op", {}, { dedupKey: "key-abc", db });
      ns.emit("idempotent.op", {}, { dedupKey: "key-abc", db });
      expect(ns.count({ type: "idempotent.op", db })).toBe(1);
    });

    it("dedup does NOT fire listeners for the duplicate emit", () => {
      const handler = vi.fn();
      ns.on("idempotent.op", handler);
      ns.emit("idempotent.op", {}, { dedupKey: "dup-key", db });
      ns.emit("idempotent.op", {}, { dedupKey: "dup-key", db });
      // Only the first (non-deduplicated) emit should trigger the handler
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("different dedupKeys are treated as distinct events", () => {
      ns.emit("unique.op", {}, { dedupKey: "key-1", db });
      ns.emit("unique.op", {}, { dedupKey: "key-2", db });
      expect(ns.count({ type: "unique.op", db })).toBe(2);
    });

    it("emit without dedupKey is never deduplicated", () => {
      ns.emit("no.dedup", {}, { db });
      ns.emit("no.dedup", {}, { db });
      expect(ns.count({ type: "no.dedup", db })).toBe(2);
    });
  });
});
