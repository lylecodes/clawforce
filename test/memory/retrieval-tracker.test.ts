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
const { clearSessionTracker } = await import("../../src/memory/retrieval-tracker.js");

describe("retrieval tracker", () => {
  let db: DatabaseSync;
  const PROJECT = "tracker-test";
  const AGENT = "frontend";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    clearSessionTracker();
    try { db.close(); } catch { /* already closed */ }
  });

  it("tracks a new retrieval and creates a stats entry", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "This is a memory about TypeScript preferences", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(1);
    expect(stats[0].sessionCount).toBe(1);
    expect(stats[0].contentSnippet).toContain("TypeScript");
  });

  it("increments count on repeated retrieval in same session", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "Same memory content", db);
    trackRetrieval(PROJECT, AGENT, "session-1", "Same memory content", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(2);
    expect(stats[0].sessionCount).toBe(1); // same session
  });

  it("increments session count on retrieval from different session", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "Cross-session memory", db);
    trackRetrieval(PROJECT, AGENT, "session-2", "Cross-session memory", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(2);
    expect(stats[0].sessionCount).toBe(2);
  });

  it("returns stats above threshold", async () => {
    const { trackRetrieval, getStatsAboveThreshold } = await import("../../src/memory/retrieval-tracker.js");

    // Memory A: 5 retrievals across 3 sessions
    for (let i = 0; i < 5; i++) {
      trackRetrieval(PROJECT, AGENT, `session-${i % 3}`, "Frequently retrieved", db);
    }
    // Memory B: 1 retrieval
    trackRetrieval(PROJECT, AGENT, "session-0", "Rarely retrieved", db);

    const above = getStatsAboveThreshold(PROJECT, 4, 2, db);
    expect(above).toHaveLength(1);
    expect(above[0].contentSnippet).toContain("Frequently");
  });
});
