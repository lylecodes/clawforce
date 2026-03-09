import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
const { recordCost, getCostSummary } = await import("../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("cost — provider tracking", () => {
  it("records provider on cost entry", () => {
    const record = recordCost({
      projectId: "p1",
      agentId: "agent-1",
      inputTokens: 1000,
      outputTokens: 500,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    }, db);
    expect(record.provider).toBe("anthropic");
  });

  it("stores provider in database", () => {
    recordCost({
      projectId: "p1",
      agentId: "agent-1",
      inputTokens: 1000,
      outputTokens: 500,
      provider: "openai",
    }, db);

    const rows = db.prepare("SELECT provider FROM cost_records WHERE project_id = 'p1'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("openai");
  });

  it("defaults provider to null when not specified", () => {
    const record = recordCost({
      projectId: "p1",
      agentId: "agent-1",
      inputTokens: 1000,
      outputTokens: 500,
    }, db);
    expect(record.provider).toBeUndefined();

    const rows = db.prepare("SELECT provider FROM cost_records WHERE project_id = 'p1'").all() as Record<string, unknown>[];
    expect(rows[0]!.provider).toBeNull();
  });

  it("getCostSummary can filter by provider", () => {
    recordCost({ projectId: "p1", agentId: "a", inputTokens: 1000, outputTokens: 500, provider: "anthropic" }, db);
    recordCost({ projectId: "p1", agentId: "a", inputTokens: 1000, outputTokens: 500, provider: "openai" }, db);

    const anthropicCost = getCostSummary({ projectId: "p1", provider: "anthropic" }, db);
    const openaiCost = getCostSummary({ projectId: "p1", provider: "openai" }, db);
    const totalCost = getCostSummary({ projectId: "p1" }, db);

    expect(anthropicCost.recordCount).toBe(1);
    expect(openaiCost.recordCount).toBe(1);
    expect(totalCost.recordCount).toBe(2);
  });
});
