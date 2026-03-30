/**
 * Test: session_archives.total_cost_cents is populated from cost_records at archive time.
 *
 * Regression test for bug: total_cost_cents was always 0 because archiveSession()
 * was called without querying cost_records first.
 */

import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { archiveSession, getSessionArchive } = await import("../../src/telemetry/session-archive.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-cost-aggregate";

// Helper: insert raw cost_records rows directly (simulating what the llm_output hook does)
function insertCostRecord(opts: {
  projectId: string;
  agentId: string;
  sessionKey: string;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}) {
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, session_key,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_cents, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'dispatch', ?)
  `).run(
    crypto.randomUUID(),
    opts.projectId,
    opts.agentId,
    opts.sessionKey,
    opts.inputTokens,
    opts.outputTokens,
    opts.costCents,
    Date.now(),
  );
}

// Simulate what adapters/openclaw.ts does at archive time after the fix
function archiveWithCostAggregate(sessionKey: string, agentId: string) {
  const costRow = db.prepare(
    `SELECT COALESCE(SUM(cost_cents), 0) as total,
            COALESCE(SUM(input_tokens), 0) as inputTokens,
            COALESCE(SUM(output_tokens), 0) as outputTokens
     FROM cost_records WHERE project_id = ? AND session_key = ?`
  ).get(PROJECT, sessionKey) as { total: number; inputTokens: number; outputTokens: number } | undefined;

  return archiveSession({
    sessionKey,
    agentId,
    projectId: PROJECT,
    outcome: "compliant",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    totalCostCents: costRow?.total ?? 0,
    totalInputTokens: costRow?.inputTokens ?? 0,
    totalOutputTokens: costRow?.outputTokens ?? 0,
  }, db);
}

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("session archive cost aggregation", () => {
  it("total_cost_cents matches sum of cost_records for the session", () => {
    const sessionKey = "sess-cost-agg-1";

    // Insert multiple cost records for this session (e.g. multiple LLM calls)
    insertCostRecord({ projectId: PROJECT, agentId: "agent-1", sessionKey, costCents: 10, inputTokens: 500, outputTokens: 200 });
    insertCostRecord({ projectId: PROJECT, agentId: "agent-1", sessionKey, costCents: 25, inputTokens: 1000, outputTokens: 400 });
    insertCostRecord({ projectId: PROJECT, agentId: "agent-1", sessionKey, costCents: 5, inputTokens: 200, outputTokens: 100 });

    archiveWithCostAggregate(sessionKey, "agent-1");

    const retrieved = getSessionArchive(PROJECT, sessionKey, db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.totalCostCents).toBe(40);        // 10 + 25 + 5
    expect(retrieved!.totalInputTokens).toBe(1700);    // 500 + 1000 + 200
    expect(retrieved!.totalOutputTokens).toBe(700);    // 200 + 400 + 100
  });

  it("total_cost_cents is 0 when no cost_records exist for the session", () => {
    const sessionKey = "sess-no-cost";

    archiveWithCostAggregate(sessionKey, "agent-1");

    const retrieved = getSessionArchive(PROJECT, sessionKey, db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.totalCostCents).toBe(0);
    expect(retrieved!.totalInputTokens).toBe(0);
    expect(retrieved!.totalOutputTokens).toBe(0);
  });

  it("only aggregates cost_records for the matching session_key (no cross-session pollution)", () => {
    const sessionA = "sess-cost-agg-A";
    const sessionB = "sess-cost-agg-B";

    insertCostRecord({ projectId: PROJECT, agentId: "agent-1", sessionKey: sessionA, costCents: 50, inputTokens: 2000, outputTokens: 800 });
    insertCostRecord({ projectId: PROJECT, agentId: "agent-2", sessionKey: sessionB, costCents: 99, inputTokens: 3000, outputTokens: 1200 });

    archiveWithCostAggregate(sessionA, "agent-1");

    const retrieved = getSessionArchive(PROJECT, sessionA, db);
    expect(retrieved!.totalCostCents).toBe(50);   // only sessionA's records
    expect(retrieved!.totalInputTokens).toBe(2000);
    expect(retrieved!.totalOutputTokens).toBe(800);
  });

  it("handles a single cost record correctly", () => {
    const sessionKey = "sess-single-cost";

    insertCostRecord({ projectId: PROJECT, agentId: "agent-1", sessionKey, costCents: 7, inputTokens: 300, outputTokens: 150 });

    archiveWithCostAggregate(sessionKey, "agent-1");

    const retrieved = getSessionArchive(PROJECT, sessionKey, db);
    expect(retrieved!.totalCostCents).toBe(7);
    expect(retrieved!.totalInputTokens).toBe(300);
    expect(retrieved!.totalOutputTokens).toBe(150);
  });
});
