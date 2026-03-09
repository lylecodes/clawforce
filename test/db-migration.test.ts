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

    // V13 messages table
    expect(tableNames).toContain("messages");

    // V14 protocol columns on messages
    const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    const msgColumnNames = msgColumns.map(c => c.name);
    expect(msgColumnNames).toContain("protocol_status");
    expect(msgColumnNames).toContain("response_deadline");
    expect(msgColumnNames).toContain("metadata");

    // V15 goals table
    expect(tableNames).toContain("goals");

    // V15 goal_id column on tasks
    expect(columnNames).toContain("goal_id");

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

  it("all migrations apply cleanly from scratch", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");

    // Run migrations from scratch
    runMigrations(db);

    const version = getCurrentVersion(db);
    expect(version).toBe(SCHEMA_VERSION);
    expect(version).toBe(22);

    db.close();
  });

  it("schema_version tracks each migration individually", () => {
    const db = getMemoryDb();

    const rows = db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all() as { version: number; applied_at: number }[];
    expect(rows).toHaveLength(SCHEMA_VERSION);

    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.version).toBe(i + 1);
      expect(rows[i]!.applied_at).toBeGreaterThan(0);
    }

    db.close();
  });

  it("V8 drops the memory table", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);

    db.close();
  });

  it("V4 tables exist (cost_records, budgets, policies, etc.)", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("cost_records");
    expect(tableNames).toContain("budgets");
    expect(tableNames).toContain("policies");
    expect(tableNames).toContain("policy_violations");
    expect(tableNames).toContain("slo_evaluations");
    expect(tableNames).toContain("alert_rules");
    expect(tableNames).toContain("risk_assessments");

    db.close();
  });

  it("V6 department and team columns exist on tasks", () => {
    const db = getMemoryDb();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("department");
    expect(columnNames).toContain("team");

    db.close();
  });

  it("V16 channels table exists with correct schema", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='channels'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const columns = db.prepare("PRAGMA table_info(channels)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("project_id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("type");
    expect(columnNames).toContain("members");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("created_by");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("concluded_at");
    expect(columnNames).toContain("metadata");

    // Check indexes
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='channels'",
    ).all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_channels_project");
    expect(indexNames).toContain("idx_channels_project_status");
    expect(indexNames).toContain("idx_channels_name");

    // Check idx_messages_channel index on messages table
    const msgIndexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND name='idx_messages_channel'",
    ).all() as { name: string }[];
    expect(msgIndexes).toHaveLength(1);

    db.close();
  });

  it("V17 task_dependencies table exists with correct schema", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const columns = db.prepare("PRAGMA table_info(task_dependencies)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("project_id");
    expect(columnNames).toContain("task_id");
    expect(columnNames).toContain("depends_on_task_id");
    expect(columnNames).toContain("type");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("created_by");

    // Check indexes
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_dependencies'",
    ).all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_task_deps_task");
    expect(indexNames).toContain("idx_task_deps_depends");
    expect(indexNames).toContain("idx_task_deps_pair");

    db.close();
  });

  it("V18 project_metadata table exists with correct schema", () => {
    const db = getMemoryDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_metadata'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const columns = db.prepare("PRAGMA table_info(project_metadata)").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("project_id");
    expect(columnNames).toContain("key");
    expect(columnNames).toContain("value");

    db.close();
  });
});
