import { describe, expect, it, vi } from "vitest";

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
const { SCHEMA_VERSION, getCurrentVersion, runMigrations } = await import("../src/migrations.js");

describe("db-migration", () => {
  it("creates all expected tables", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("transitions");
    expect(tableNames).toContain("evidence");
    expect(tableNames).toContain("workflows");
    expect(tableNames).toContain("metrics");
    expect(tableNames).toContain("audit_log");
    expect(tableNames).toContain("knowledge");
    expect(tableNames).toContain("audit_runs");
    expect(tableNames).toContain("proposals");
    expect(tableNames).toContain("enforcement_retries");
    expect(tableNames).toContain("tracked_sessions");
    expect(tableNames).toContain("disabled_agents");
    expect(tableNames).toContain("schema_version");
    // V3 tables
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("dispatch_queue");

    // V3 lease columns on tasks
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain("lease_holder");
    expect(columnNames).toContain("lease_acquired_at");
    expect(columnNames).toContain("lease_expires_at");

    // V5 worker_assignments table
    expect(tableNames).toContain("worker_assignments");

    db.close();
  });

  it("records current version in schema_version", () => {
    const db = getMemoryDb();

    const version = getCurrentVersion(db);
    expect(version).toBe(SCHEMA_VERSION);

    // Verify rows exist
    const rows = db.prepare("SELECT * FROM schema_version ORDER BY version").all() as { version: number; applied_at: number }[];
    expect(rows).toHaveLength(SCHEMA_VERSION);
    expect(rows[0]!.version).toBe(1);
    expect(rows[rows.length - 1]!.version).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("idempotency: calling runMigrations twice doesn't error", () => {
    const db1 = getMemoryDb();
    // Calling runMigrations again on the same DB (simulating restart)
    expect(() => runMigrations(db1)).not.toThrow();

    // Version should still be the same
    const version = getCurrentVersion(db1);
    expect(version).toBe(SCHEMA_VERSION);

    db1.close();
  });
});
