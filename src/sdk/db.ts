/**
 * Clawforce SDK — DB Namespace
 *
 * Escape hatch providing raw SQLite access via the Node.js built-in
 * `node:sqlite` module. Use this for any query or mutation that the
 * higher-level SDK namespaces don't expose.
 *
 * All methods operate on the domain's database (same instance used
 * internally by Clawforce). Changes made here are visible to all other
 * SDK namespaces immediately.
 */

import { getDb } from "../db.js";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export class DbNamespace {
  constructor(readonly domain: string) {}

  // Execute a raw SQL query and return all rows
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const db = getDb(this.domain);
    const stmt = db.prepare(sql);
    return (params ? stmt.all(...(params as SQLInputValue[])) : stmt.all()) as T[];
  }

  // Execute a raw SQL query and return the first row
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    const db = getDb(this.domain);
    const stmt = db.prepare(sql);
    return (params ? stmt.get(...(params as SQLInputValue[])) : stmt.get()) as T | undefined;
  }

  // Execute a SQL statement (INSERT/UPDATE/DELETE) and return changes info
  execute(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } {
    const db = getDb(this.domain);
    const stmt = db.prepare(sql);
    const result = params ? stmt.run(...(params as SQLInputValue[])) : stmt.run();
    return { changes: result.changes as number, lastInsertRowid: result.lastInsertRowid as number };
  }

  // List all tables in the database
  tables(): string[] {
    return this.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).map(r => r.name);
  }

  // Get the raw DatabaseSync instance (advanced use)
  raw(): DatabaseSync {
    return getDb(this.domain);
  }
}
