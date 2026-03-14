/**
 * Clawforce — Knowledge Demotion
 *
 * Agents flag wrong structured knowledge (SOUL.md, skills, project docs)
 * for manager review and correction.
 * On resolution, the flagged content is replaced with the correction in
 * the source file.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb, getProjectsDir } from "../db.js";
import { safeLog } from "../diagnostics.js";
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

/**
 * Resolve the source file path for a knowledge flag.
 * Returns null if the path can't be determined.
 */
function resolveSourcePath(flag: KnowledgeFlag): string | null {
  const projectDir = path.join(getProjectsDir(), flag.projectId);

  switch (flag.sourceType) {
    case "soul": {
      // sourceRef is typically "SOUL.md" — the agent's identity doc
      return path.join(projectDir, "agents", flag.agentId, flag.sourceRef || "SOUL.md");
    }
    case "skill": {
      // sourceRef is the skill file name or skill ID
      return path.join(projectDir, "skills", flag.sourceRef);
    }
    case "project_doc": {
      // sourceRef is the doc file path relative to project dir
      return path.join(projectDir, "knowledge", flag.sourceRef);
    }
    case "rule": {
      return path.join(projectDir, "rules", flag.sourceRef);
    }
    default:
      return null;
  }
}

/**
 * Apply the correction to the source file.
 * Reads the file, replaces flaggedContent with the correction, writes it back.
 * Logs a warning if the flagged content isn't found (still marks as resolved).
 */
function applyCorrection(flag: KnowledgeFlag): void {
  const filePath = resolveSourcePath(flag);
  if (!filePath) {
    safeLog("demotion:resolve", `Cannot resolve source path for flag ${flag.id} (type=${flag.sourceType}, ref=${flag.sourceRef})`);
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      safeLog("demotion:resolve", `Source file not found: ${filePath} — marking as resolved anyway`);
      return;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(flag.flaggedContent)) {
      safeLog("demotion:resolve", `Flagged content not found in ${filePath} — it may have been manually edited. Marking as resolved anyway.`);
      return;
    }

    const updated = content.replace(flag.flaggedContent, flag.correction);
    fs.writeFileSync(filePath, updated, "utf-8");
  } catch (err) {
    safeLog("demotion:resolve", err);
  }
}

export function resolveFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);

  // Fetch the flag before updating so we can apply the correction
  const flag = getFlag(projectId, flagId, dbOverride);

  db.prepare("UPDATE knowledge_flags SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);

  // Apply the correction to the source file
  if (flag && flag.status === "pending") {
    applyCorrection(flag);
  }
}

export function dismissFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE knowledge_flags SET status = 'dismissed', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);
}
