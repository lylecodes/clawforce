import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../src/db.js");
const { setBudget, checkBudget } = await import("../src/budget.js");
const { recordCost } = await import("../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("session budget enforcement", () => {
  it("checkBudget with sessionKey checks session_limit_cents", () => {
    setBudget({ projectId: "p1", config: { sessionLimitCents: 500 } }, db);

    // Record cost for a specific session
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      sessionKey: "sess-1",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: "sonnet",
    }, db);

    // 1800 cents > 500 limit
    const result = checkBudget({ projectId: "p1", sessionKey: "sess-1" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Session budget exceeded");
  });

  it("returns ok:false when session cost exceeds session limit", () => {
    setBudget({ projectId: "p1", config: { sessionLimitCents: 100 } }, db);

    // Record enough cost to exceed 100 cents
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      sessionKey: "sess-2",
      inputTokens: 500_000,
      outputTokens: 500_000,
      model: "sonnet",
    }, db);

    const result = checkBudget({ projectId: "p1", sessionKey: "sess-2" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Session budget exceeded");
  });

  it("returns ok:true when session cost is within limit", () => {
    setBudget({ projectId: "p1", config: { sessionLimitCents: 50000 } }, db);

    // Record a small cost
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      sessionKey: "sess-3",
      inputTokens: 100,
      outputTokens: 50,
      model: "sonnet",
    }, db);

    const result = checkBudget({ projectId: "p1", sessionKey: "sess-3" }, db);
    expect(result.ok).toBe(true);
  });

  it("with no sessionKey, skips session check even if session limit is set", () => {
    setBudget({ projectId: "p1", config: { sessionLimitCents: 1 } }, db);

    // Record a large cost but without sessionKey in the check
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      sessionKey: "sess-4",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: "sonnet",
    }, db);

    // Check without sessionKey — session limit should not trigger
    const result = checkBudget({ projectId: "p1" }, db);
    expect(result.ok).toBe(true);
  });

  it("session limit is independent of daily limit", () => {
    // Set a generous daily limit but tight session limit
    setBudget({ projectId: "p1", config: { dailyLimitCents: 100000, sessionLimitCents: 50 } }, db);

    // Record cost that exceeds session limit but stays within daily limit
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      sessionKey: "sess-5",
      inputTokens: 500_000,
      outputTokens: 500_000,
      model: "sonnet",
    }, db);

    // Session should be blocked (session limit exceeded) even though daily is fine
    const result = checkBudget({ projectId: "p1", sessionKey: "sess-5" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Session budget exceeded");

    // A different session with no cost should still pass
    const result2 = checkBudget({ projectId: "p1", sessionKey: "sess-other" }, db);
    expect(result2.ok).toBe(true);
  });
});
