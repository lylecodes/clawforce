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

describe("search query dedup", () => {
  let db: DatabaseSync;
  const PROJECT = "dedup-test";
  const AGENT = "frontend";
  const SESSION = "session-123";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("reports no duplicate for first query", async () => {
    const { isDuplicateQuery } = await import("../../src/memory/search-dedup.js");

    const result = isDuplicateQuery(PROJECT, SESSION, "typescript best practices", db);
    expect(result).toBe(false);
  });

  it("logs a query and detects duplicate in same session", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, SESSION, "typescript best practices", db);
    expect(result).toBe(true);
  });

  it("allows same query in different session", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, "different-session", "typescript best practices", db);
    expect(result).toBe(false);
  });

  it("treats different queries as non-duplicate", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, SESSION, "react hooks patterns", db);
    expect(result).toBe(false);
  });
});
