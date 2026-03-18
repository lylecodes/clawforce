import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { recordCost } = await import("../../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-job-cost";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("per-job cost tracking", () => {
  it("records cost with job_name when provided", () => {
    recordCost({
      projectId: PROJECT,
      agentId: "lead",
      inputTokens: 1000,
      outputTokens: 500,
      jobName: "dispatch",
    }, db);

    const row = db.prepare(
      "SELECT job_name FROM cost_records WHERE project_id = ? AND agent_id = ?"
    ).get(PROJECT, "lead") as { job_name: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.job_name).toBe("dispatch");
  });

  it("records null job_name when not provided", () => {
    recordCost({
      projectId: PROJECT,
      agentId: "lead",
      inputTokens: 500,
      outputTokens: 200,
    }, db);

    const row = db.prepare(
      "SELECT job_name FROM cost_records WHERE project_id = ? AND agent_id = ?"
    ).get(PROJECT, "lead") as { job_name: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.job_name).toBeNull();
  });

  it("can query costs grouped by job", () => {
    recordCost({ projectId: PROJECT, agentId: "lead", inputTokens: 1000, outputTokens: 500, jobName: "dispatch" }, db);
    recordCost({ projectId: PROJECT, agentId: "lead", inputTokens: 2000, outputTokens: 1000, jobName: "reflect" }, db);
    recordCost({ projectId: PROJECT, agentId: "lead", inputTokens: 500, outputTokens: 200, jobName: "dispatch" }, db);

    const rows = db.prepare(
      "SELECT job_name, COUNT(*) as count, SUM(cost_cents) as total_cents FROM cost_records WHERE project_id = ? GROUP BY job_name ORDER BY job_name"
    ).all(PROJECT) as { job_name: string; count: number; total_cents: number }[];

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.job_name === "dispatch")!.count).toBe(2);
    expect(rows.find(r => r.job_name === "reflect")!.count).toBe(1);
  });
});
