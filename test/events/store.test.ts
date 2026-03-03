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
const { ingestEvent, claimPendingEvents, markHandled, markFailed, markIgnored, listEvents } =
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
});
