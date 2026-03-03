import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countRecentRetries,
  MAX_ENFORCEMENT_RETRIES,
  recordRetryAttempt,
  resolveMaxRetries,
} from "../../src/enforcement/retry-store.js";

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");

describe("retry-store", () => {
  let db: ReturnType<typeof getMemoryDb>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
  });

  it("records and counts retry attempts", () => {
    recordRetryAttempt("proj1", "coder", "sess1", "retry");
    recordRetryAttempt("proj1", "coder", "sess2", "retry");

    expect(countRecentRetries("proj1", "coder")).toBe(2);
  });

  it("counts only for the specified agent", () => {
    recordRetryAttempt("proj1", "coder", "sess1", "retry");
    recordRetryAttempt("proj1", "other", "sess2", "retry");

    expect(countRecentRetries("proj1", "coder")).toBe(1);
    expect(countRecentRetries("proj1", "other")).toBe(1);
  });

  it("counts only for the specified project", () => {
    recordRetryAttempt("proj1", "coder", "sess1", "retry");
    recordRetryAttempt("proj2", "coder", "sess2", "retry");

    expect(countRecentRetries("proj1", "coder")).toBe(1);
    expect(countRecentRetries("proj2", "coder")).toBe(1);
  });

  it("excludes retries outside the 4-hour window", () => {
    // Insert old retry directly with a timestamp older than 4 hours
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO enforcement_retries (id, project_id, agent_id, session_key, attempted_at, outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("old-retry", "proj1", "coder", "old-sess", fiveHoursAgo, "retry");

    // Add a recent one
    recordRetryAttempt("proj1", "coder", "sess1", "retry");

    // Only the recent one should count
    expect(countRecentRetries("proj1", "coder")).toBe(1);
  });

  it("returns 0 for unknown agent", () => {
    expect(countRecentRetries("proj1", "nonexistent")).toBe(0);
  });
});

describe("resolveMaxRetries", () => {
  it("uses config value when within hard cap", () => {
    expect(resolveMaxRetries(5)).toBe(5);
  });

  it("defaults to 1 when undefined", () => {
    expect(resolveMaxRetries(undefined)).toBe(1);
  });

  it("clamps to hard cap", () => {
    expect(resolveMaxRetries(999)).toBe(MAX_ENFORCEMENT_RETRIES);
  });

  it("clamps minimum to 1", () => {
    expect(resolveMaxRetries(0)).toBe(1);
    expect(resolveMaxRetries(-5)).toBe(1);
  });
});
