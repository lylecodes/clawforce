/**
 * Tests for the DbNamespace SDK escape hatch.
 *
 * Strategy: use setProjectsDir with a temp directory so getDb creates a
 * real (but ephemeral) file-based SQLite DB. Reset between tests via
 * resetDbForTest + tmpDir cleanup. This exercises the actual code paths
 * that end users will hit, including migrations (so tables() returns the
 * real schema tables rather than an empty list).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// ---- Dynamic imports after mocks ----

const { setProjectsDir, getProjectsDir, resetDbForTest } = await import("../../src/db.js");
const { DbNamespace } = await import("../../src/sdk/db.js");

// ---- Constants ----

const DOMAIN = "test-db-ns";

// ---- Tests ----

describe("DbNamespace", () => {
  let tmpDir: string;
  let originalDir: string;

  beforeEach(() => {
    originalDir = getProjectsDir();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-db-ns-test-"));
    setProjectsDir(tmpDir);
  });

  afterEach(() => {
    resetDbForTest();
    setProjectsDir(originalDir);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      const ns = new DbNamespace(DOMAIN);
      expect(ns.domain).toBe(DOMAIN);
    });

    it("stores arbitrary domain strings", () => {
      expect(new DbNamespace("research-lab").domain).toBe("research-lab");
      expect(new DbNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- tables ----------

  describe("tables()", () => {
    it("returns an array of table names", () => {
      const ns = new DbNamespace(DOMAIN);
      const result = ns.tables();
      expect(Array.isArray(result)).toBe(true);
    });

    it("includes core schema tables created by migrations", () => {
      const ns = new DbNamespace(DOMAIN);
      const tables = ns.tables();
      // migrations create these tables at minimum
      expect(tables).toContain("tasks");
      expect(tables).toContain("schema_version");
    });

    it("returns tables sorted by name", () => {
      const ns = new DbNamespace(DOMAIN);
      const tables = ns.tables();
      const sorted = [...tables].sort();
      expect(tables).toEqual(sorted);
    });
  });

  // ---------- query ----------

  describe("query()", () => {
    it("returns all rows matching a SELECT", () => {
      const ns = new DbNamespace(DOMAIN);
      const rows = ns.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(typeof rows[0]!.name).toBe("string");
    });

    it("returns empty array when no rows match", () => {
      const ns = new DbNamespace(DOMAIN);
      const rows = ns.query(
        "SELECT * FROM tasks WHERE project_id = 'nonexistent-domain-xyz'"
      );
      expect(rows).toEqual([]);
    });

    it("passes bound parameters correctly", () => {
      const ns = new DbNamespace(DOMAIN);
      // Insert a row with known values
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["qtest-1", DOMAIN, "Query Test", "OPEN", "P2", "sdk", Date.now(), Date.now(), 0, 3]
      );
      const rows = ns.query<{ title: string }>(
        "SELECT title FROM tasks WHERE id = ?",
        ["qtest-1"]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("Query Test");
    });

    it("returns typed rows via generic parameter", () => {
      const ns = new DbNamespace(DOMAIN);
      const rows = ns.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 1"
      );
      if (rows.length > 0) {
        // TypeScript type: rows[0].name should be a string
        expect(typeof rows[0]!.name).toBe("string");
      }
    });
  });

  // ---------- queryOne ----------

  describe("queryOne()", () => {
    it("returns the first row when rows exist", () => {
      const ns = new DbNamespace(DOMAIN);
      const row = ns.queryOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      expect(row).toBeDefined();
      expect(typeof row!.name).toBe("string");
    });

    it("returns undefined when no rows match", () => {
      const ns = new DbNamespace(DOMAIN);
      const row = ns.queryOne(
        "SELECT * FROM tasks WHERE id = 'absolutely-does-not-exist'"
      );
      expect(row).toBeUndefined();
    });

    it("passes bound parameters correctly", () => {
      const ns = new DbNamespace(DOMAIN);
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["qone-1", DOMAIN, "QueryOne Test", "OPEN", "P2", "sdk", Date.now(), Date.now(), 0, 3]
      );
      const row = ns.queryOne<{ title: string }>(
        "SELECT title FROM tasks WHERE id = ?",
        ["qone-1"]
      );
      expect(row).toBeDefined();
      expect(row!.title).toBe("QueryOne Test");
    });

    it("returns only one row even when multiple match", () => {
      const ns = new DbNamespace(DOMAIN);
      const now = Date.now();
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["multi-1", DOMAIN, "First", "OPEN", "P2", "sdk", now, now, 0, 3]
      );
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["multi-2", DOMAIN, "Second", "OPEN", "P2", "sdk", now, now, 0, 3]
      );
      const allRows = ns.query("SELECT * FROM tasks WHERE project_id = ?", [DOMAIN]);
      expect(allRows.length).toBe(2);

      const oneRow = ns.queryOne("SELECT * FROM tasks WHERE project_id = ?", [DOMAIN]);
      expect(oneRow).toBeDefined();
      // only one row returned
    });
  });

  // ---------- execute ----------

  describe("execute()", () => {
    it("inserts a row and returns changes = 1", () => {
      const ns = new DbNamespace(DOMAIN);
      const now = Date.now();
      const result = ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["exec-1", DOMAIN, "Execute Test", "OPEN", "P2", "sdk", now, now, 0, 3]
      );
      expect(result.changes).toBe(1);
      expect(typeof result.lastInsertRowid).toBe("number");
    });

    it("updates a row and returns changes = 1", () => {
      const ns = new DbNamespace(DOMAIN);
      const now = Date.now();
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["upd-1", DOMAIN, "Before Update", "OPEN", "P2", "sdk", now, now, 0, 3]
      );
      const result = ns.execute(
        "UPDATE tasks SET title = ? WHERE id = ?",
        ["After Update", "upd-1"]
      );
      expect(result.changes).toBe(1);

      const row = ns.queryOne<{ title: string }>(
        "SELECT title FROM tasks WHERE id = ?",
        ["upd-1"]
      );
      expect(row!.title).toBe("After Update");
    });

    it("deletes a row and returns changes = 1", () => {
      const ns = new DbNamespace(DOMAIN);
      const now = Date.now();
      ns.execute(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["del-1", DOMAIN, "To Delete", "OPEN", "P2", "sdk", now, now, 0, 3]
      );
      const result = ns.execute(
        "DELETE FROM tasks WHERE id = ?",
        ["del-1"]
      );
      expect(result.changes).toBe(1);

      const row = ns.queryOne("SELECT * FROM tasks WHERE id = ?", ["del-1"]);
      expect(row).toBeUndefined();
    });

    it("returns changes = 0 when no rows are affected", () => {
      const ns = new DbNamespace(DOMAIN);
      const result = ns.execute(
        "DELETE FROM tasks WHERE id = ?",
        ["does-not-exist"]
      );
      expect(result.changes).toBe(0);
    });

    it("works without params for parameterless statements", () => {
      // Create a temp table, insert without params, then clean up
      const ns = new DbNamespace(DOMAIN);
      ns.raw().exec("CREATE TEMPORARY TABLE test_no_params (val INTEGER)");
      const result = ns.execute("INSERT INTO test_no_params VALUES (42)");
      expect(result.changes).toBe(1);
    });
  });

  // ---------- raw ----------

  describe("raw()", () => {
    it("returns a DatabaseSync instance", () => {
      const ns = new DbNamespace(DOMAIN);
      const db = ns.raw();
      expect(db).toBeDefined();
      // DatabaseSync has prepare and exec methods
      expect(typeof db.prepare).toBe("function");
      expect(typeof db.exec).toBe("function");
    });

    it("returns the same instance on repeated calls (same underlying DB)", () => {
      const ns = new DbNamespace(DOMAIN);
      const db1 = ns.raw();
      const db2 = ns.raw();
      expect(db1).toBe(db2);
    });

    it("allows direct SQL execution on the raw instance", () => {
      const ns = new DbNamespace(DOMAIN);
      const db = ns.raw();
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it("mutations via raw() are visible via query()", () => {
      const ns = new DbNamespace(DOMAIN);
      const db = ns.raw();
      const now = Date.now();
      db.prepare(
        "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("raw-1", DOMAIN, "Raw Insert", "OPEN", "P2", "sdk", now, now, 0, 3);

      const row = ns.queryOne<{ title: string }>(
        "SELECT title FROM tasks WHERE id = ?",
        ["raw-1"]
      );
      expect(row!.title).toBe("Raw Insert");
    });
  });

  // ---------- Clawforce integration ----------

  describe("Clawforce.db accessor", () => {
    it("is accessible via the top-level Clawforce class", async () => {
      const { Clawforce } = await import("../../src/sdk/index.js");
      const cf = Clawforce.init({ domain: DOMAIN });
      expect(cf.db).toBeDefined();
      expect(cf.db.domain).toBe(DOMAIN);
    });

    it("returns the same DbNamespace instance on repeated access", async () => {
      const { Clawforce } = await import("../../src/sdk/index.js");
      const cf = Clawforce.init({ domain: DOMAIN });
      expect(cf.db).toBe(cf.db);
    });

    it("can query tables through the Clawforce entry point", async () => {
      const { Clawforce } = await import("../../src/sdk/index.js");
      const cf = Clawforce.init({ domain: DOMAIN });
      const tables = cf.db.tables();
      expect(Array.isArray(tables)).toBe(true);
      expect(tables).toContain("tasks");
    });
  });
});
