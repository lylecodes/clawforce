/**
 * Clawforce — Knowledge Demotion
 *
 * Agents flag wrong structured knowledge (SOUL.md, skills, project docs)
 * for manager review and correction.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { KnowledgeFlag, PromotionTarget } from "../types.js";

function rowToFlag(row: Record<string, unknown>): KnowledgeFlag {
  const f: KnowledgeFlag = {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    sourceType: row.source_type as PromotionTarget,
    sourceRef: row.source_ref as string,
    flaggedContent: row.flagged_content as string,
    correction: row.correction as string,
    severity: row.severity as KnowledgeFlag["severity"],
    status: row.status as KnowledgeFlag["status"],
    createdAt: row.created_at as number,
  };
  if (row.resolved_at != null) f.resolvedAt = row.resolved_at as number;
  return f;
}

export type CreateFlagParams = {
  projectId: string;
  agentId: string;
  sourceType: PromotionTarget;
  sourceRef: string;
  flaggedContent: string;
  correction: string;
  severity: KnowledgeFlag["severity"];
};

export function createFlag(params: CreateFlagParams, dbOverride?: DatabaseSync): KnowledgeFlag {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO knowledge_flags (id, project_id, agent_id, source_type, source_ref, flagged_content, correction, severity, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, params.projectId, params.agentId, params.sourceType, params.sourceRef, params.flaggedContent, params.correction, params.severity, now);

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    sourceType: params.sourceType,
    sourceRef: params.sourceRef,
    flaggedContent: params.flaggedContent,
    correction: params.correction,
    severity: params.severity,
    status: "pending",
    createdAt: now,
  };
}

export function getFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): KnowledgeFlag | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM knowledge_flags WHERE id = ? AND project_id = ?")
    .get(flagId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToFlag(row) : null;
}

export function listFlags(projectId: string, statusFilter?: KnowledgeFlag["status"], dbOverride?: DatabaseSync): KnowledgeFlag[] {
  const db = dbOverride ?? getDb(projectId);
  let query = "SELECT * FROM knowledge_flags WHERE project_id = ?";
  const params: (string | number)[] = [projectId];
  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY created_at DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToFlag);
}

export function resolveFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE knowledge_flags SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);
}

export function dismissFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE knowledge_flags SET status = 'dismissed', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);
}
