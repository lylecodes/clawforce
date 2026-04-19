/**
 * Clawforce — Tool call intent store
 *
 * Persists blocked tool call intents for the async approval → re-dispatch pattern.
 * When a tool gate blocks a call, the intent is stored. On approval, the intent
 * is resolved and the task is re-dispatched with a pre-approval.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

export type ToolCallIntent = {
  id: string;
  proposalId: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  category: string;
  riskTier: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: number;
  resolvedAt?: number;
};

/**
 * Persist a blocked tool call intent.
 */
export function persistToolCallIntent(
  params: {
    proposalId: string;
    projectId: string;
    agentId: string;
    taskId?: string;
    toolName: string;
    toolParams: Record<string, unknown>;
    category: string;
    riskTier: string;
  },
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    params.proposalId,
    params.projectId,
    params.agentId,
    params.taskId ?? null,
    params.toolName,
    JSON.stringify(params.toolParams),
    params.category,
    params.riskTier,
    now,
  );

  return id;
}

/**
 * Get a tool call intent by proposal ID.
 */
export function getIntentByProposal(proposalId: string, dbOverride?: DatabaseSync): ToolCallIntent | null {
  // Intent store needs to search across projects — use provided db or try from proposal
  try {
    const db = dbOverride;
    if (!db) return null;
    const row = db.prepare(
      "SELECT * FROM tool_call_intents WHERE proposal_id = ? LIMIT 1",
    ).get(proposalId) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  } catch (err) {
    safeLog("intentStore.getByProposal", err);
    return null;
  }
}

/**
 * Get a tool call intent by proposal ID, searching within a specific project.
 */
export function getIntentByProposalForProject(projectId: string, proposalId: string, dbOverride?: DatabaseSync): ToolCallIntent | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM tool_call_intents WHERE proposal_id = ? AND project_id = ? LIMIT 1",
  ).get(proposalId, projectId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Get approved intents for a task (used for context injection).
 */
export function getApprovedIntentsForTask(projectId: string, taskId: string, dbOverride?: DatabaseSync): ToolCallIntent[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM tool_call_intents WHERE project_id = ? AND task_id = ? AND status = 'approved' ORDER BY created_at DESC",
  ).all(projectId, taskId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Resolve an intent (approve or reject).
 */
export function resolveIntent(intentId: string, status: "approved" | "rejected", dbOverride?: DatabaseSync): void {
  // We need a db — try to find the intent's project first
  if (dbOverride) {
    dbOverride.prepare(
      "UPDATE tool_call_intents SET status = ?, resolved_at = ? WHERE id = ?",
    ).run(status, Date.now(), intentId);
  }
}

/**
 * Resolve an intent by project ID.
 */
export function resolveIntentForProject(projectId: string, intentId: string, status: "approved" | "rejected", dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "UPDATE tool_call_intents SET status = ?, resolved_at = ? WHERE id = ?",
  ).run(status, Date.now(), intentId);
}

function mapRow(row: Record<string, unknown>): ToolCallIntent {
  return {
    id: row.id as string,
    proposalId: row.proposal_id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    taskId: (row.task_id as string) ?? undefined,
    toolName: row.tool_name as string,
    toolParams: row.tool_params ? JSON.parse(row.tool_params as string) : {},
    category: row.category as string,
    riskTier: row.risk_tier as string,
    status: row.status as ToolCallIntent["status"],
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number) ?? undefined,
  };
}
