import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");

describe("available_capacity context source", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const PROJECT = "capacity-test";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
  });

  it("returns no-config message when no resources configured", async () => {
    const { resolveAvailableCapacitySource } = await import("../../src/context/assembler.js");

    const result = resolveAvailableCapacitySource(PROJECT, db);
    expect(result).toContain("Available Capacity");
    expect(result).toContain("No resource/model configuration");
  });

  it("renders capacity table when resource config exists", async () => {
    const { resolveAvailableCapacitySource } = await import("../../src/context/assembler.js");

    // Insert model config via project_metadata
    db.prepare(`
      INSERT INTO project_metadata (project_id, key, value)
      VALUES (?, 'resources_models', ?)
    `).run(PROJECT, JSON.stringify({
      "claude-opus-4-6": { rpm: 60, tpm: 200000, cost_per_1k_input: 15, cost_per_1k_output: 75 },
      "claude-sonnet-4-6": { rpm: 120, tpm: 400000, cost_per_1k_input: 3, cost_per_1k_output: 15 },
    }));

    const result = resolveAvailableCapacitySource(PROJECT, db);
    expect(result).toContain("Available Capacity");
    expect(result).toContain("claude-opus-4-6");
    expect(result).toContain("claude-sonnet-4-6");
    expect(result).toContain("Available Slots");
  });

  it("accounts for active sessions in slot calculation", async () => {
    const { resolveAvailableCapacitySource } = await import("../../src/context/assembler.js");

    const now = Date.now();

    // Insert model config
    db.prepare(`
      INSERT INTO project_metadata (project_id, key, value)
      VALUES (?, 'resources_models', ?)
    `).run(PROJECT, JSON.stringify({
      "claude-opus-4-6": { rpm: 60, tpm: 200000, cost_per_1k_input: 15, cost_per_1k_output: 75 },
    }));

    // Insert leased dispatch queue entries (active sessions)
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, payload, status, created_at)
      VALUES ('dq1', ?, 't1', 1, ?, 'leased', ?)
    `).run(PROJECT, JSON.stringify({ model: "claude-opus-4-6" }), now);
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, payload, status, created_at)
      VALUES ('dq2', ?, 't2', 1, ?, 'leased', ?)
    `).run(PROJECT, JSON.stringify({ model: "claude-opus-4-6" }), now);

    const result = resolveAvailableCapacitySource(PROJECT, db);
    expect(result).toContain("claude-opus-4-6");
    // With 2 active sessions: RPM used = 2*5 = 10, so "10/60" should appear
    expect(result).toContain("10/60");
  });

  it("uses average tokens from cost_records when available", async () => {
    const { resolveAvailableCapacitySource } = await import("../../src/context/assembler.js");

    const now = Date.now();

    // Insert model config
    db.prepare(`
      INSERT INTO project_metadata (project_id, key, value)
      VALUES (?, 'resources_models', ?)
    `).run(PROJECT, JSON.stringify({
      "claude-sonnet-4-6": { rpm: 120, tpm: 400000, cost_per_1k_input: 3, cost_per_1k_output: 15 },
    }));

    // Insert cost records with token data
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, input_tokens, output_tokens, cost_cents, model, source, created_at)
      VALUES ('c1', ?, 'worker', 5000, 3000, 50, 'claude-sonnet-4-6', 'dispatch', ?)
    `).run(PROJECT, now);
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, input_tokens, output_tokens, cost_cents, model, source, created_at)
      VALUES ('c2', ?, 'worker', 7000, 5000, 80, 'claude-sonnet-4-6', 'dispatch', ?)
    `).run(PROJECT, now);

    const result = resolveAvailableCapacitySource(PROJECT, db);
    expect(result).toContain("claude-sonnet-4-6");
    // Average tokens = (5000+3000 + 7000+5000) / 2 = 10000
    expect(result).toContain("10,000");
  });
});
