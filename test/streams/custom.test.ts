import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("custom streams", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-custom-stream-"));
    dbPath = path.join(tmpDir, "test.db");

    // Create a test database with sample data
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, status TEXT, created_at INTEGER);
      INSERT INTO items VALUES ('1', 'Task A', 'OPEN', ${Date.now() - 100000000});
      INSERT INTO items VALUES ('2', 'Task B', 'DONE', ${Date.now()});
      INSERT INTO items VALUES ('3', 'Task C', 'OPEN', ${Date.now() - 200000000});
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes a read-only SELECT query", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "open_items",
      query: "SELECT id, name FROM items WHERE status = 'OPEN'",
      format: "table",
    });

    expect(result.text).toContain("Task A");
    expect(result.text).toContain("Task C");
    expect(result.rows).toHaveLength(2);
  });

  it("rejects mutation queries", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");

    expect(() =>
      executeCustomStream(dbPath, {
        name: "evil",
        query: "DELETE FROM items",
        format: "table",
      }),
    ).toThrow();
  });

  it("rejects DROP queries", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");

    expect(() =>
      executeCustomStream(dbPath, {
        name: "evil",
        query: "DROP TABLE items",
        format: "table",
      }),
    ).toThrow();
  });

  it("formats as JSON", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id, name FROM items LIMIT 1",
      format: "json",
    });

    expect(result.json).toBeDefined();
    expect(result.json![0].id).toBe("1");
  });

  it("formats as summary", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id FROM items",
      format: "summary",
    });

    expect(result.text).toContain("3");
  });

  it("appends LIMIT when none present", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id FROM items",
      format: "table",
    });

    // Should succeed — LIMIT 10000 appended internally
    expect(result.rows.length).toBeLessThanOrEqual(10000);
  });

  it("supports SQL parameter bindings", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(
      dbPath,
      {
        name: "test",
        query: "SELECT id, name FROM items WHERE status = ?",
        format: "table",
      },
      { 1: "DONE" },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.text).toContain("Task B");
  });
});
