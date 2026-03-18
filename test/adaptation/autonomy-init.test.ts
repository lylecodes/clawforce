import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { initializeAutonomy } = await import("../../src/adaptation/autonomy-init.js");
const { getActiveTrustOverrides } = await import("../../src/trust/tracker.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-autonomy";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("initializeAutonomy", () => {
  it("creates no overrides for low autonomy", () => {
    initializeAutonomy(PROJECT, "low", db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides).toHaveLength(0);
  });

  it("creates medium-tier overrides for medium autonomy", () => {
    initializeAutonomy(PROJECT, "medium", db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides.every((o: any) => o.overrideTier === "medium")).toBe(true);
  });

  it("creates high-tier overrides for high autonomy", () => {
    initializeAutonomy(PROJECT, "high", db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides.every((o: any) => o.overrideTier === "high")).toBe(true);
  });

  it("creates overrides for all 6 adaptation categories", () => {
    initializeAutonomy(PROJECT, "high", db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides).toHaveLength(6);
  });
});
