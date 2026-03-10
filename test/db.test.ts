import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { validateProjectId, getMemoryDb, getDb, closeDb, setProjectsDir, getProjectsDir, resetDbForTest } = await import("../src/db.js");

describe("validateProjectId", () => {
  it("accepts valid project IDs", () => {
    expect(() => validateProjectId("my-project")).not.toThrow();
    expect(() => validateProjectId("project_v2")).not.toThrow();
    expect(() => validateProjectId("test.project")).not.toThrow();
    expect(() => validateProjectId("Project123")).not.toThrow();
    expect(() => validateProjectId("a")).not.toThrow();
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateProjectId("../escape")).toThrow();
    expect(() => validateProjectId("foo/bar")).toThrow();
    expect(() => validateProjectId("foo\\bar")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateProjectId("")).toThrow();
  });

  it("rejects IDs starting with special characters", () => {
    expect(() => validateProjectId("-leading-dash")).toThrow();
    expect(() => validateProjectId(".leading-dot")).toThrow();
    expect(() => validateProjectId("_leading-underscore")).toThrow();
  });

  it("rejects IDs longer than 64 characters", () => {
    expect(() => validateProjectId("a".repeat(65))).toThrow();
  });

  it("accepts IDs exactly 64 characters", () => {
    expect(() => validateProjectId("a".repeat(64))).not.toThrow();
  });
});

describe("getMemoryDb", () => {
  it("returns a working in-memory database", () => {
    const db = getMemoryDb();
    expect(db).toBeDefined();

    // Verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("schema_version");

    db.close();
  });

  it("returns a fresh database each call", () => {
    const db1 = getMemoryDb();
    const db2 = getMemoryDb();

    // Insert in db1 should not be visible in db2
    db1.prepare(
      "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t1", "p1", "test", "OPEN", "P2", "a", Date.now(), Date.now(), 0, 3);

    const rows = db2.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as Record<string, unknown>;
    expect(rows.cnt).toBe(0);

    db1.close();
    db2.close();
  });
});

describe("setProjectsDir + getProjectsDir", () => {
  let original: string;

  beforeEach(() => {
    original = getProjectsDir();
  });

  afterEach(() => {
    setProjectsDir(original);
  });

  it("roundtrips an absolute path", () => {
    setProjectsDir("/tmp/test-clawforce");
    expect(getProjectsDir()).toBe("/tmp/test-clawforce");
  });

  it("expands ~ in path", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    setProjectsDir("~/.clawforce-test");
    expect(getProjectsDir()).toBe(`${home}/.clawforce-test`);
  });
});

describe("getDb + closeDb", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-db-test-"));
    setProjectsDir(tmpDir);
  });

  afterEach(async () => {
    resetDbForTest();
    const fs = await import("node:fs");
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it("opens a database and closes it", () => {
    const db = getDb("testproj");
    expect(db).toBeDefined();

    // Verify we can query
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);

    closeDb("testproj");
  });

  it("returns same instance on repeated calls", () => {
    const db1 = getDb("testproj2");
    const db2 = getDb("testproj2");
    expect(db1).toBe(db2);

    closeDb("testproj2");
  });

  it("reopens after close", () => {
    getDb("testproj3");
    closeDb("testproj3");

    const db2 = getDb("testproj3");
    expect(db2).toBeDefined();

    // Verify the reopened DB works
    const tables = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);

    closeDb("testproj3");
  });
});
