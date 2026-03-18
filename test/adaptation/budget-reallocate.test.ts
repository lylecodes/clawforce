import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { reallocateBudget } = await import("../../src/adaptation/budget-reallocate.js");
const { setBudget } = await import("../../src/budget.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-realloc";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
  setBudget({ projectId: PROJECT, agentId: "dev-1", config: { daily: { cents: 1000 } } }, db);
  setBudget({ projectId: PROJECT, agentId: "dev-2", config: { daily: { cents: 500 } } }, db);
});

describe("reallocateBudget", () => {
  it("transfers budget from one agent to another", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: 200,
      window: "daily",
      reason: "dev-2 needs more capacity",
    }, db);

    expect(result.success).toBe(true);
    expect(result.from_new_limit).toBe(800);
    expect(result.to_new_limit).toBe(700);
  });

  it("rejects if source has insufficient budget", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: 2000,
      window: "daily",
      reason: "too much",
    }, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient");
  });

  it("rejects negative amount", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: -100,
      window: "daily",
      reason: "negative",
    }, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("positive");
  });

  it("rejects if source agent has no budget", () => {
    const result = reallocateBudget(PROJECT, {
      from: "nonexistent",
      to: "dev-2",
      amount_cents: 100,
      window: "daily",
      reason: "ghost agent",
    }, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No budget");
  });
});
