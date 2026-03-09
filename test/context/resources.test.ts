import { describe, it, expect, beforeEach } from "vitest";
import { buildResourcesContext } from "../../src/context/sources/resources.js";
import { updateProviderUsage, clearAllUsage } from "../../src/rate-limits.js";
import { getDb } from "../../src/db.js";

describe("resources context source", () => {
  const projectId = "test-resources-ctx";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("renders budget status as markdown", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 800, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    const md = buildResourcesContext(projectId);
    expect(md).toContain("## Resource Capacity");
    expect(md).toContain("$12.00 remaining");
    expect(md).toContain("$20.00");
  });

  it("includes provider rate limit status", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', ?, NULL, 2000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 25 },
        { label: "TPM", usedPercent: 40 },
      ],
      plan: "tier-4",
    });

    const md = buildResourcesContext(projectId);
    expect(md).toContain("anthropic");
    expect(md).toContain("RPM");
    expect(md).toContain("25%");
  });

  it("shows throttle risk warning", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 92 }],
    });

    const md = buildResourcesContext(projectId);
    expect(md).toContain("WARNING");
  });

  it("shows estimated remaining sessions", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b3', ?, NULL, 2000, 500, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Insert historical session data
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO cost_records (id, project_id, agent_id, session_key, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_cents, source, created_at)
        VALUES (?, ?, 'worker', ?, 50000, 10000, 0, 0, 100, 'llm_output', ?)
      `).run(`cr-${i}`, projectId, `sess-${i}`, Date.now() - i * 3600000);
    }

    const md = buildResourcesContext(projectId);
    expect(md).toContain("remaining sessions");
  });

  it("returns null when no budget configured", () => {
    const md = buildResourcesContext(projectId);
    expect(md).toBeNull();
  });
});
