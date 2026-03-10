/**
 * Clawforce — Preference store
 *
 * Structured user preferences for assistant mode.
 * Categories: scheduling, communication, financial, notifications.
 * Sources: explicit (user-set), learned (pattern-detected), inferred (confidence-scored).
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// --- Types ---

export type PreferenceSource = "explicit" | "learned" | "inferred";

export type Preference = {
  id: string;
  projectId: string;
  agentId: string;
  category: string;
  key: string;
  value: string;
  source: PreferenceSource;
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

export type SetPreferenceParams = {
  projectId: string;
  agentId: string;
  category: string;
  key: string;
  value: string;
  source?: PreferenceSource;
  confidence?: number;
};

// --- Core functions ---

/**
 * Set or update a preference. Upserts by (projectId, agentId, category, key).
 */
export function setPreference(
  params: SetPreferenceParams,
  dbOverride?: DatabaseSync,
): Preference {
  const db = dbOverride ?? getDb(params.projectId);
  const source = params.source ?? "explicit";
  const confidence = params.confidence ?? (source === "explicit" ? 1.0 : 0.5);
  const now = Date.now();

  // Check for existing
  const existing = db.prepare(`
    SELECT id FROM preferences
    WHERE project_id = ? AND agent_id = ? AND category = ? AND key = ?
  `).get(params.projectId, params.agentId, params.category, params.key) as Record<string, unknown> | undefined;

  if (existing) {
    const id = existing.id as string;
    db.prepare(`
      UPDATE preferences SET value = ?, source = ?, confidence = ?, updated_at = ?
      WHERE id = ?
    `).run(params.value, source, confidence, now, id);

    return {
      id,
      projectId: params.projectId,
      agentId: params.agentId,
      category: params.category,
      key: params.key,
      value: params.value,
      source,
      confidence,
      createdAt: now, // not accurate for update, but fine
      updatedAt: now,
    };
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO preferences (id, project_id, agent_id, category, key, value, source, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.projectId, params.agentId, params.category, params.key, params.value, source, confidence, now, now);

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    category: params.category,
    key: params.key,
    value: params.value,
    source,
    confidence,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get a specific preference.
 */
export function getPreference(
  projectId: string,
  agentId: string,
  category: string,
  key: string,
  dbOverride?: DatabaseSync,
): Preference | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT * FROM preferences
    WHERE project_id = ? AND agent_id = ? AND category = ? AND key = ?
  `).get(projectId, agentId, category, key) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : null;
}

/**
 * List preferences, optionally filtered by category.
 */
export function listPreferences(
  projectId: string,
  agentId: string,
  category?: string,
  dbOverride?: DatabaseSync,
): Preference[] {
  const db = dbOverride ?? getDb(projectId);

  if (category) {
    const rows = db.prepare(`
      SELECT * FROM preferences
      WHERE project_id = ? AND agent_id = ? AND category = ?
      ORDER BY category, key
    `).all(projectId, agentId, category) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  const rows = db.prepare(`
    SELECT * FROM preferences
    WHERE project_id = ? AND agent_id = ?
    ORDER BY category, key
  `).all(projectId, agentId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Delete a preference.
 */
export function deletePreference(
  projectId: string,
  agentId: string,
  category: string,
  key: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const result = db.prepare(`
    DELETE FROM preferences
    WHERE project_id = ? AND agent_id = ? AND category = ? AND key = ?
  `).run(projectId, agentId, category, key);

  return (result as { changes: number }).changes > 0;
}

/**
 * Render preferences as markdown for context injection.
 */
export function renderPreferences(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): string | null {
  const prefs = listPreferences(projectId, agentId, undefined, dbOverride);
  if (prefs.length === 0) return null;

  const lines = ["## User Preferences", ""];

  // Group by category
  const byCategory = new Map<string, Preference[]>();
  for (const p of prefs) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  for (const [category, categoryPrefs] of byCategory) {
    lines.push(`### ${category}`);
    for (const p of categoryPrefs) {
      const sourceTag = p.source !== "explicit"
        ? ` _(${p.source}, ${Math.round(p.confidence * 100)}% confidence)_`
        : "";
      lines.push(`- **${p.key}**: ${p.value}${sourceTag}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Helpers ---

function mapRow(row: Record<string, unknown>): Preference {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    category: row.category as string,
    key: row.key as string,
    value: row.value as string,
    source: row.source as PreferenceSource,
    confidence: row.confidence as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
