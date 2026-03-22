/**
 * Clawforce — Config version tracking
 *
 * Detects config changes by hashing content, creates version records,
 * and deduplicates on content_hash to avoid duplicate entries.
 */

import crypto from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type ConfigVersion = {
  id: string;
  projectId: string;
  contentHash: string;
  files: string[];
  content: string;
  detectedAt: number;
  detectedBy?: string;
  previousVersionId?: string;
  changeSummary?: string;
};

// --- Compression helpers ---

function compress(text: string): string {
  return deflateSync(Buffer.from(text, "utf-8")).toString("base64");
}

function decompress(data: string): string {
  return inflateSync(Buffer.from(data, "base64")).toString("utf-8");
}

// --- Core functions ---

/**
 * Detect if config content has changed since the last recorded version.
 * If changed, creates a new config_version record.
 * Returns the config_version_id (new or existing).
 */
export function detectConfigChange(
  projectId: string,
  contextContent: string,
  detectedBy?: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);
  const contentHash = crypto.createHash("sha256").update(contextContent).digest("hex");

  // Check if this hash already exists for this project
  const existing = db.prepare(`
    SELECT id FROM config_versions
    WHERE project_id = ? AND content_hash = ?
    LIMIT 1
  `).get(projectId, contentHash) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  // Get previous version for linking
  const previousRow = db.prepare(`
    SELECT id FROM config_versions
    WHERE project_id = ?
    ORDER BY detected_at DESC
    LIMIT 1
  `).get(projectId) as { id: string } | undefined;

  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    db.prepare(`
      INSERT INTO config_versions (
        id, project_id, content_hash, files, content,
        detected_at, detected_by, previous_version_id, change_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      contentHash,
      JSON.stringify(["context"]), // files list — context is the primary tracked file
      compress(contextContent),
      now,
      detectedBy ?? null,
      previousRow?.id ?? null,
      previousRow ? "Config content changed" : "Initial config version",
    );
  } catch (err) {
    // Handle race condition — UNIQUE constraint on (project_id, content_hash)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint")) {
      const row = db.prepare(
        "SELECT id FROM config_versions WHERE project_id = ? AND content_hash = ?",
      ).get(projectId, contentHash) as { id: string } | undefined;
      return row?.id ?? id;
    }
    safeLog("telemetry.config-tracker", err);
    throw err;
  }

  return id;
}

/**
 * Retrieve a specific config version with decompressed content.
 */
export function getConfigVersion(
  projectId: string,
  versionId: string,
  dbOverride?: DatabaseSync,
): ConfigVersion | null {
  const db = dbOverride ?? getDb(projectId);

  const row = db.prepare(`
    SELECT * FROM config_versions
    WHERE project_id = ? AND id = ?
    LIMIT 1
  `).get(projectId, versionId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapConfigVersionRow(row);
}

/**
 * List config version history for a project.
 */
export function getConfigHistory(
  projectId: string,
  since?: number,
  dbOverride?: DatabaseSync,
): ConfigVersion[] {
  const db = dbOverride ?? getDb(projectId);

  const sinceMs = since ?? 0;
  const rows = db.prepare(`
    SELECT * FROM config_versions
    WHERE project_id = ? AND detected_at >= ?
    ORDER BY detected_at DESC
  `).all(projectId, sinceMs) as Record<string, unknown>[];

  return rows.map(mapConfigVersionRow);
}

// --- Helpers ---

function mapConfigVersionRow(row: Record<string, unknown>): ConfigVersion {
  let files: string[] = [];
  try {
    files = JSON.parse(row.files as string);
  } catch { /* empty */ }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    contentHash: row.content_hash as string,
    files,
    content: decompress(row.content as string),
    detectedAt: row.detected_at as number,
    detectedBy: (row.detected_by as string) ?? undefined,
    previousVersionId: (row.previous_version_id as string) ?? undefined,
    changeSummary: (row.change_summary as string) ?? undefined,
  };
}
