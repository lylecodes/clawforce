/**
 * Clawforce — Persistent disabled agent store
 *
 * Persists disabled agents to SQLite so the state survives restarts.
 * Replaces the in-memory Set<string> that was previously used in index.ts.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

export type DisabledAgent = {
  agentId: string;
  reason: string;
  disabledAt: number;
};

export function disableAgent(projectId: string, agentId: string, reason: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, projectId, agentId, reason, now);
}

export function isAgentDisabled(projectId: string, agentId: string, dbOverride?: DatabaseSync): boolean {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT 1 FROM disabled_agents WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId);
  return !!row;
}

export function listDisabledAgents(projectId: string, dbOverride?: DatabaseSync): DisabledAgent[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT agent_id, reason, disabled_at FROM disabled_agents WHERE project_id = ? ORDER BY disabled_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  return rows.map((row) => ({
    agentId: row.agent_id as string,
    reason: row.reason as string,
    disabledAt: row.disabled_at as number,
  }));
}

export function enableAgent(projectId: string, agentId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "DELETE FROM disabled_agents WHERE project_id = ? AND agent_id = ?",
  ).run(projectId, agentId);
}
