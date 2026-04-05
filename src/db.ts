/**
 * Clawforce — SQLite database management
 *
 * Per-project SQLite databases stored at ~/.clawforce/<projectId>/clawforce.db
 * Uses node:sqlite (DatabaseSync) — requires Node 22+.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations.js";
import { getClawforceHome } from "./paths.js";

const databases: Map<string, DatabaseSync> = new Map();

const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Validate a project ID to prevent path traversal and other filesystem issues.
 * Allows alphanumeric, dots, hyphens, and underscores. Max 64 chars.
 */
export function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `Invalid project ID "${projectId}": must match ${PROJECT_ID_RE} (alphanumeric, dots, hyphens, underscores; 1-64 chars; no path separators)`,
    );
  }
}

function resolveHomeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error(
      "Cannot determine home directory: neither HOME nor USERPROFILE is set. " +
      "Set one of these environment variables or provide an absolute projectsDir.",
    );
  }
  return home;
}

let projectsDir = getClawforceHome();
let dataDir = path.join(getClawforceHome(), "data");

export function setProjectsDir(dir: string): void {
  projectsDir = dir.startsWith("~")
    ? path.join(resolveHomeDir(), dir.slice(1))
    : dir;
}

export function getProjectsDir(): string {
  return projectsDir;
}

export function setDataDir(dir: string): void {
  dataDir = dir.startsWith("~")
    ? path.join(resolveHomeDir(), dir.slice(1))
    : dir;
}

export function getDbByDomain(domainId: string): DatabaseSync {
  const key = `domain:${domainId}`;
  const existing = databases.get(key);
  if (existing) return existing;

  validateProjectId(domainId);
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, `${domainId}.db`);
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);
  databases.set(key, db);
  return db;
}

export function getDb(projectId: string): DatabaseSync {
  const existing = databases.get(projectId);
  if (existing) return existing;

  validateProjectId(projectId);
  const dbDir = path.join(projectsDir, projectId);
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "clawforce.db");
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);
  databases.set(projectId, db);
  return db;
}

/** Open an in-memory database for tests. */
export function getMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function closeDb(projectId: string): void {
  const db = databases.get(projectId);
  if (db) {
    try {
      db.close();
    } catch {
      // already closed
    }
    databases.delete(projectId);
  }
}

export function closeAllDbs(): void {
  for (const [id] of databases) {
    closeDb(id);
  }
}

export function resetDbForTest(): void {
  closeAllDbs();
}
