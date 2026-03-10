/**
 * Clawforce — Undo registry
 *
 * Tracks executed actions with undo handlers and TTL.
 * Enables reversibility for assistant mode actions.
 * Leverages OpenClaw's after_tool_call hook for registration.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type UndoStatus = "available" | "expired" | "executed" | "not_available";

export type UndoEntry = {
  id: string;
  projectId: string;
  agentId: string;
  category: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  /** Description of what was done */
  actionSummary: string;
  /** Tool name + params to invoke for undo, or null if no undo available */
  undoToolName: string | null;
  undoToolParams: Record<string, unknown> | null;
  status: UndoStatus;
  createdAt: number;
  expiresAt: number;
  executedAt?: number;
};

export type RegisterUndoParams = {
  projectId: string;
  agentId: string;
  category: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  actionSummary: string;
  undoToolName?: string;
  undoToolParams?: Record<string, unknown>;
  ttlMs?: number;
};

// Default TTL per category (ms)
const DEFAULT_TTL: Record<string, number> = {
  "email:send": 30_000, // 30s (Gmail unsend window)
  "calendar:create_event": 86_400_000, // 24h
  "calendar:cancel_event": 86_400_000,
  "message:send": 60_000, // 1m
};

const FALLBACK_TTL = 300_000; // 5 minutes

// --- Core functions ---

/**
 * Register an executed action with optional undo handler.
 */
export function registerUndo(
  params: RegisterUndoParams,
  dbOverride?: DatabaseSync,
): UndoEntry {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const ttl = params.ttlMs ?? DEFAULT_TTL[params.category] ?? FALLBACK_TTL;
  const expiresAt = now + ttl;

  const status: UndoStatus = params.undoToolName ? "available" : "not_available";

  db.prepare(`
    INSERT INTO undo_registry (id, project_id, agent_id, category, tool_name, tool_params,
      action_summary, undo_tool_name, undo_tool_params, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.projectId, params.agentId, params.category,
    params.toolName, JSON.stringify(params.toolParams),
    params.actionSummary,
    params.undoToolName ?? null,
    params.undoToolParams ? JSON.stringify(params.undoToolParams) : null,
    status, now, expiresAt,
  );

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    category: params.category,
    toolName: params.toolName,
    toolParams: params.toolParams,
    actionSummary: params.actionSummary,
    undoToolName: params.undoToolName ?? null,
    undoToolParams: params.undoToolParams ?? null,
    status,
    createdAt: now,
    expiresAt,
  };
}

/**
 * Find the most recent undoable action for a category.
 * Only returns actions that are still within their TTL window.
 */
export function findUndoable(
  projectId: string,
  category: string,
  dbOverride?: DatabaseSync,
): UndoEntry | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const row = db.prepare(`
    SELECT * FROM undo_registry
    WHERE project_id = ? AND category = ? AND status = 'available' AND expires_at > ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(projectId, category, now) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : null;
}

/**
 * Find the most recent undoable action across all categories.
 */
export function findMostRecentUndoable(
  projectId: string,
  dbOverride?: DatabaseSync,
): UndoEntry | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const row = db.prepare(`
    SELECT * FROM undo_registry
    WHERE project_id = ? AND status = 'available' AND expires_at > ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(projectId, now) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : null;
}

/**
 * Mark an undo entry as executed.
 */
export function markUndoExecuted(
  projectId: string,
  undoId: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const result = db.prepare(`
    UPDATE undo_registry SET status = 'executed', executed_at = ?
    WHERE id = ? AND project_id = ? AND status = 'available'
  `).run(now, undoId, projectId);

  return (result as { changes: number }).changes > 0;
}

/**
 * Expire undo entries that have passed their TTL.
 * Returns count of expired entries.
 */
export function expireUndoEntries(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const result = db.prepare(`
    UPDATE undo_registry SET status = 'expired'
    WHERE project_id = ? AND status = 'available' AND expires_at <= ?
  `).run(projectId, now);

  return (result as { changes: number }).changes;
}

/**
 * List recent actions with their undo status.
 */
export function listRecentActions(
  projectId: string,
  limit = 20,
  dbOverride?: DatabaseSync,
): UndoEntry[] {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(`
    SELECT * FROM undo_registry
    WHERE project_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(projectId, limit) as Record<string, unknown>[];

  const now = Date.now();
  return rows.map((row) => {
    const entry = mapRow(row);
    // Auto-compute expired status for display
    if (entry.status === "available" && entry.expiresAt <= now) {
      entry.status = "expired";
    }
    return entry;
  });
}

/**
 * Get an undo entry by ID.
 */
export function getUndoEntry(
  projectId: string,
  undoId: string,
  dbOverride?: DatabaseSync,
): UndoEntry | null {
  const db = dbOverride ?? getDb(projectId);

  const row = db.prepare(
    "SELECT * FROM undo_registry WHERE id = ? AND project_id = ?",
  ).get(undoId, projectId) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : null;
}

/**
 * Render recent actions as markdown for context/dashboard.
 */
export function renderRecentActions(
  projectId: string,
  limit = 10,
  dbOverride?: DatabaseSync,
): string | null {
  const actions = listRecentActions(projectId, limit, dbOverride);
  if (actions.length === 0) return null;

  const lines = ["## Recent Actions", ""];
  const now = Date.now();

  for (const a of actions) {
    const ago = formatAgo(now - a.createdAt);
    const statusTag = a.status === "available"
      ? " [UNDO AVAILABLE]"
      : a.status === "executed"
        ? " [UNDONE]"
        : "";

    lines.push(`- ${a.actionSummary} (${a.category}, ${ago})${statusTag}`);
  }

  return lines.join("\n");
}

// --- Helpers ---

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function mapRow(row: Record<string, unknown>): UndoEntry {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    category: row.category as string,
    toolName: row.tool_name as string,
    toolParams: row.tool_params ? JSON.parse(row.tool_params as string) : {},
    actionSummary: row.action_summary as string,
    undoToolName: (row.undo_tool_name as string) ?? null,
    undoToolParams: row.undo_tool_params ? JSON.parse(row.undo_tool_params as string) : null,
    status: row.status as UndoStatus,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    executedAt: (row.executed_at as number) ?? undefined,
  };
}
