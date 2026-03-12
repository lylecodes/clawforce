/**
 * Clawforce — Cost Averages Engine
 *
 * Computes session cost estimates with fallback chain:
 * initiative + agent + model → initiative + model → initiative only → global → hardcoded default.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

const DEFAULT_COST_CENTS = 150;
const MIN_SESSIONS_FOR_ESTIMATE = 3;
const MIN_SESSIONS_FOR_HIGH_CONFIDENCE = 10;

export type CostEstimate = {
  averageCents: number;
  sessionCount: number;
  confidence: "high" | "medium" | "low";
};

/**
 * Collect all goal IDs in a goal tree (BFS from root down through children).
 */
function collectGoalTreeIds(projectId: string, rootGoalId: string, db: DatabaseSync): string[] {
  const ids: string[] = [];
  const queue: string[] = [rootGoalId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ids.push(id);

    const children = db.prepare(
      "SELECT id FROM goals WHERE parent_goal_id = ? AND project_id = ?",
    ).all(id, projectId) as { id: string }[];

    for (const child of children) {
      queue.push(child.id);
    }
  }

  return ids;
}

type AvgRow = { avg_cost: number; session_count: number };

function queryAverage(
  db: DatabaseSync,
  projectId: string,
  goalIds: string[],
  agentId?: string,
  model?: string,
): AvgRow | null {
  if (goalIds.length === 0) return null;

  const placeholders = goalIds.map(() => "?").join(", ");
  let query = `
    SELECT AVG(cr.cost_cents) as avg_cost, COUNT(*) as session_count
    FROM cost_records cr
    INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
    WHERE t.goal_id IN (${placeholders})
      AND cr.project_id = ?
  `;
  const params: (string | number)[] = [...goalIds, projectId];

  if (agentId) {
    query += " AND cr.agent_id = ?";
    params.push(agentId);
  }
  if (model) {
    query += " AND cr.model = ?";
    params.push(model);
  }

  const row = db.prepare(query).get(...params) as AvgRow | undefined;
  if (!row || row.session_count === 0) return null;
  return row;
}

function queryGlobalAverage(db: DatabaseSync, projectId: string): AvgRow | null {
  const row = db.prepare(`
    SELECT AVG(cost_cents) as avg_cost, COUNT(*) as session_count
    FROM cost_records
    WHERE project_id = ?
  `).get(projectId) as AvgRow | undefined;

  if (!row || row.session_count === 0) return null;
  return row;
}

export function getCostEstimate(
  projectId: string,
  initiativeGoalId: string,
  agentId: string,
  model: string,
  dbOverride?: DatabaseSync,
): CostEstimate {
  const db = dbOverride ?? getDb(projectId);
  const goalIds = collectGoalTreeIds(projectId, initiativeGoalId, db);

  // Level 1: initiative + agent + model
  const level1 = queryAverage(db, projectId, goalIds, agentId, model);
  if (level1 && level1.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level1.avg_cost),
      sessionCount: level1.session_count,
      confidence: level1.session_count >= MIN_SESSIONS_FOR_HIGH_CONFIDENCE ? "high" : "medium",
    };
  }

  // Level 2: initiative + model
  const level2 = queryAverage(db, projectId, goalIds, undefined, model);
  if (level2 && level2.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level2.avg_cost),
      sessionCount: level2.session_count,
      confidence: level2.session_count >= MIN_SESSIONS_FOR_HIGH_CONFIDENCE ? "high" : "medium",
    };
  }

  // Level 3: initiative only
  const level3 = queryAverage(db, projectId, goalIds);
  if (level3 && level3.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level3.avg_cost),
      sessionCount: level3.session_count,
      confidence: "medium",
    };
  }

  // Level 4: global average
  const global = queryGlobalAverage(db, projectId);
  if (global && global.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(global.avg_cost),
      sessionCount: global.session_count,
      confidence: "low",
    };
  }

  // Level 5: hardcoded default
  return {
    averageCents: DEFAULT_COST_CENTS,
    sessionCount: 0,
    confidence: "low",
  };
}
