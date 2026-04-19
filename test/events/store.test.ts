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
const { ingestEvent, claimPendingEvents, markHandled, markFailed, markIgnored, listEvents, reclaimStaleEvents, requeueEvents } =
  await import("../../src/events/store.js");

describe("events/store", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("ingests an event in pending status", () => {
    const result = ingestEvent(PROJECT, "ci_failed", "tool", { runId: 123 }, undefined, db);
    expect(result.id).toBeTruthy();
    expect(result.deduplicated).toBe(false);

    const events = listEvents(PROJECT, { status: "pending" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("ci_failed");
    expect(events[0]!.source).toBe("tool");
    expect(events[0]!.payload).toEqual({ runId: 123 });
  });

  it("deduplicates events with same dedup_key", () => {
    const r1 = ingestEvent(PROJECT, "ci_failed", "tool", { runId: 1 }, "ci:run:1", db);
    const r2 = ingestEvent(PROJECT, "ci_failed", "tool", { runId: 1 }, "ci:run:1", db);

    expect(r1.deduplicated).toBe(false);
    expect(r2.deduplicated).toBe(true);
    expect(r2.id).toBe(r1.id);

    const events = listEvents(PROJECT, undefined, db);
    expect(events).toHaveLength(1);
  });

  it("allows different dedup_keys", () => {
    ingestEvent(PROJECT, "ci_failed", "tool", { runId: 1 }, "ci:run:1", db);
    ingestEvent(PROJECT, "ci_failed", "tool", { runId: 2 }, "ci:run:2", db);

    const events = listEvents(PROJECT, undefined, db);
    expect(events).toHaveLength(2);
  });

  it("lists newer events first when timestamps tie", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    try {
      const first = ingestEvent(PROJECT, "ci_failed", "tool", { runId: 1 }, undefined, db);
      const second = ingestEvent(PROJECT, "pr_opened", "tool", { runId: 2 }, undefined, db);

      const events = listEvents(PROJECT, undefined, db);
      expect(events.map((event) => event.id)).toEqual([second.id, first.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims pending events atomically", () => {
    ingestEvent(PROJECT, "ci_failed", "tool", { a: 1 }, undefined, db);
    ingestEvent(PROJECT, "pr_opened", "tool", { b: 2 }, undefined, db);
    ingestEvent(PROJECT, "custom", "tool", { c: 3 }, undefined, db);

    const claimed = claimPendingEvents(PROJECT, 2, db);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]!.status).toBe("processing");
    expect(claimed[1]!.status).toBe("processing");

    // Only 1 remaining pending
    const remaining = listEvents(PROJECT, { status: "pending" }, db);
    expect(remaining).toHaveLength(1);
  });

  it("claims older events first when timestamps tie", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    try {
      const first = ingestEvent(PROJECT, "ci_failed", "tool", { a: 1 }, undefined, db);
      const second = ingestEvent(PROJECT, "pr_opened", "tool", { b: 2 }, undefined, db);

      const claimed = claimPendingEvents(PROJECT, 2, db);
      expect(claimed.map((event) => event.id)).toEqual([first.id, second.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns empty array when no pending events", () => {
    const claimed = claimPendingEvents(PROJECT, 10, db);
    expect(claimed).toHaveLength(0);
  });

  it("marks events as handled", () => {
    const { id } = ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
    const [event] = claimPendingEvents(PROJECT, 1, db);
    markHandled(event!.id, "router", db);

    const handled = listEvents(PROJECT, { status: "handled" }, db);
    expect(handled).toHaveLength(1);
    expect(handled[0]!.handledBy).toBe("router");
  });

  it("marks events as failed", () => {
    ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
    const [event] = claimPendingEvents(PROJECT, 1, db);
    markFailed(event!.id, "Handler crashed", db);

    const failed = listEvents(PROJECT, { status: "failed" }, db);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe("Handler crashed");
  });

  it("marks events as ignored", () => {
    ingestEvent(PROJECT, "custom", "tool", {}, undefined, db);
    const [event] = claimPendingEvents(PROJECT, 1, db);
    markIgnored(event!.id, db);

    const ignored = listEvents(PROJECT, { status: "ignored" }, db);
    expect(ignored).toHaveLength(1);
  });

  it("filters events by type", () => {
    ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
    ingestEvent(PROJECT, "pr_opened", "tool", {}, undefined, db);
    ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);

    const ciEvents = listEvents(PROJECT, { type: "ci_failed" }, db);
    expect(ciEvents).toHaveLength(2);
  });

  describe("reclaimStaleEvents", () => {
    it("reclaims events stuck in processing for longer than threshold", () => {
      // Ingest and claim an event
      ingestEvent(PROJECT, "ci_failed", "tool", { a: 1 }, undefined, db);
      const claimed = claimPendingEvents(PROJECT, 1, db);
      expect(claimed).toHaveLength(1);

      // Backdate the processed_at to simulate a stale event (10 minutes ago)
      const staleTime = Date.now() - 10 * 60 * 1000;
      db.prepare("UPDATE events SET processed_at = ? WHERE id = ?").run(staleTime, claimed[0]!.id);

      // Reclaim with a 5-minute threshold
      const reclaimed = reclaimStaleEvents(PROJECT, 5 * 60 * 1000, db);
      expect(reclaimed).toBe(1);

      // Event should be back to pending
      const pending = listEvents(PROJECT, { status: "pending" }, db);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(claimed[0]!.id);
    });

    it("does not reclaim events still within threshold", () => {
      ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
      claimPendingEvents(PROJECT, 1, db);

      // Reclaim with default threshold — event was just claimed, so should not be reclaimed
      const reclaimed = reclaimStaleEvents(PROJECT, 5 * 60 * 1000, db);
      expect(reclaimed).toBe(0);
    });

    it("returns 0 when no processing events exist", () => {
      const reclaimed = reclaimStaleEvents(PROJECT, 5 * 60 * 1000, db);
      expect(reclaimed).toBe(0);
    });
  });

  describe("requeueEvents", () => {
    it("moves failed events back to pending and clears handler metadata", () => {
      const { id } = ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
      claimPendingEvents(PROJECT, 1, db);
      markFailed(id, "test-error", db);

      const requeued = requeueEvents(PROJECT, { status: "failed", limit: 10 }, db);
      expect(requeued).toHaveLength(1);
      expect(requeued[0]!.status).toBe("failed");

      const pending = listEvents(PROJECT, { status: "pending" }, db);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(id);
      expect(pending[0]!.error).toBeUndefined();
      expect(pending[0]!.handledBy).toBeUndefined();
    });
  });

  describe("atomic dedup", () => {
    it("second ingest with same dedupKey returns deduplicated=true", () => {
      const r1 = ingestEvent(PROJECT, "ci_failed", "tool", { x: 1 }, "key1", db);
      const r2 = ingestEvent(PROJECT, "ci_failed", "tool", { x: 2 }, "key1", db);

      expect(r1.deduplicated).toBe(false);
      expect(r2.deduplicated).toBe(true);
      expect(r2.id).toBe(r1.id);
    });
  });

  describe("markHandled/markFailed/markIgnored require db", () => {
    it("markHandled works with explicit db", () => {
      const { id } = ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
      claimPendingEvents(PROJECT, 1, db);
      markHandled(id, "test-handler", db);
      const events = listEvents(PROJECT, { status: "handled" }, db);
      expect(events).toHaveLength(1);
    });

    it("markFailed works with explicit db", () => {
      const { id } = ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
      claimPendingEvents(PROJECT, 1, db);
      markFailed(id, "test-error", db);
      const events = listEvents(PROJECT, { status: "failed" }, db);
      expect(events).toHaveLength(1);
    });

    it("markIgnored works with explicit db", () => {
      const { id } = ingestEvent(PROJECT, "ci_failed", "tool", {}, undefined, db);
      claimPendingEvents(PROJECT, 1, db);
      markIgnored(id, db);
      const events = listEvents(PROJECT, { status: "ignored" }, db);
      expect(events).toHaveLength(1);
    });
  });
});
