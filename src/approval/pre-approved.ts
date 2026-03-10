/**
 * Clawforce — Pre-approval allowlist
 *
 * Single-use, time-limited pre-approvals for re-dispatched tasks.
 * When a tool gate proposal is approved, a pre-approval is created so the
 * re-dispatched agent can proceed past the gate on the second attempt.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Add a pre-approval for a specific tool call on a task.
 */
export function addPreApproval(
  params: {
    projectId: string;
    taskId: string;
    toolName: string;
    category: string;
    ttlMs?: number;
  },
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;

  db.prepare(`
    INSERT INTO pre_approvals (id, project_id, task_id, tool_name, category, approved_at, expires_at, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, params.projectId, params.taskId, params.toolName, params.category, now, now + ttl);
}

/**
 * Check if a pre-approval exists for a tool call on a task.
 * Does NOT consume the approval — use consumePreApproval for that.
 */
export function checkPreApproval(
  params: {
    projectId: string;
    taskId: string;
    toolName: string;
  },
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(params.projectId);
  const now = Date.now();
  const row = db.prepare(
    "SELECT id FROM pre_approvals WHERE project_id = ? AND task_id = ? AND tool_name = ? AND consumed = 0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
  ).get(params.projectId, params.taskId, params.toolName, now);
  return !!row;
}

/**
 * Consume a pre-approval (single use).
 * Returns true if a valid pre-approval was found and consumed.
 */
export function consumePreApproval(
  params: {
    projectId: string;
    taskId: string;
    toolName: string;
  },
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(params.projectId);
  const now = Date.now();

  // Find and consume in one step
  const row = db.prepare(
    "SELECT id FROM pre_approvals WHERE project_id = ? AND task_id = ? AND tool_name = ? AND consumed = 0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
  ).get(params.projectId, params.taskId, params.toolName, now) as Record<string, unknown> | undefined;

  if (!row) return false;

  const result = db.prepare(
    "UPDATE pre_approvals SET consumed = 1 WHERE id = ?",
  ).run(row.id as string);

  return (result as { changes: number }).changes > 0;
}
