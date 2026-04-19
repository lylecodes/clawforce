import { randomUUID } from "node:crypto";
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

describe("promotion pipeline", () => {
  let db: DatabaseSync;
  const PROJECT = "promo-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("detects candidates from retrieval stats above threshold", async () => {
    const { checkPromotionCandidates, listCandidates } = await import("../../src/memory/promotion.js");

    // Insert retrieval stat that exceeds threshold
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash1', ?, 'frontend', 'Always use TypeScript strict mode', 15, 8, ?, ?)
    `).run(PROJECT, Date.now() - 86400000, Date.now());

    // Below threshold
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash2', ?, 'frontend', 'Rarely used fact', 2, 1, ?, ?)
    `).run(PROJECT, Date.now(), Date.now());

    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);

    const candidates = listCandidates(PROJECT, db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].contentSnippet).toContain("TypeScript");
    expect(candidates[0].status).toBe("pending");
  });

  it("does not create duplicate candidates", async () => {
    const { checkPromotionCandidates, listCandidates } = await import("../../src/memory/promotion.js");

    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash1', ?, 'frontend', 'Frequently used', 15, 8, ?, ?)
    `).run(PROJECT, Date.now() - 86400000, Date.now());

    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);
    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);

    const candidates = listCandidates(PROJECT, db);
    expect(candidates).toHaveLength(1); // no duplicate
  });

  it("approves and dismisses candidates", async () => {
    const { approveCandidate, dismissCandidate, getCandidate } = await import("../../src/memory/promotion.js");

    const id1 = randomUUID();
    const id2 = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h1', 'Memory 1', 10, 5, 'soul', 'pending', ?)`).run(id1, PROJECT, now);
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h2', 'Memory 2', 10, 5, 'skill', 'pending', ?)`).run(id2, PROJECT, now);

    approveCandidate(PROJECT, id1, db);
    dismissCandidate(PROJECT, id2, db);

    expect(getCandidate(PROJECT, id1, db)!.status).toBe("approved");
    expect(getCandidate(PROJECT, id2, db)!.status).toBe("dismissed");
  });
});
