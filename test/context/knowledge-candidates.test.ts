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

describe("knowledge_candidates briefing source", () => {
  let db: DatabaseSync;
  const PROJECT = "kc-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("shows pending promotions and flags", async () => {
    const { resolveKnowledgeCandidatesSource } = await import("../../src/context/assembler.js");

    // Insert a promotion candidate
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h1', 'Always use strict TypeScript', 15, 8, 'soul', 'pending', ?)`).run(randomUUID(), PROJECT, Date.now());

    // Insert a knowledge flag
    db.prepare(`INSERT INTO knowledge_flags (id, project_id, agent_id, source_type, source_ref, flagged_content, correction, severity, status, created_at) VALUES (?, ?, 'frontend', 'soul', 'SOUL.md', 'Use REST', 'Use GraphQL', 'high', 'pending', ?)`).run(randomUUID(), PROJECT, Date.now());

    const result = resolveKnowledgeCandidatesSource(PROJECT, db);
    expect(result).toContain("Knowledge Review");
    expect(result).toContain("strict TypeScript");
    expect(result).toContain("REST");
    expect(result).toContain("GraphQL");
  });

  it("returns no-items message when nothing pending", async () => {
    const { resolveKnowledgeCandidatesSource } = await import("../../src/context/assembler.js");

    const result = resolveKnowledgeCandidatesSource(PROJECT, db);
    expect(result).toContain("No pending");
  });
});
