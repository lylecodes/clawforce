/**
 * Clawforce — Cost tracking
 *
 * Records token usage and inference cost per dispatch.
 * Dual-writes to cost_records table and recordMetric() for aggregation.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { recordMetric } from "./metrics.js";
import { safeLog } from "./diagnostics.js";
import { getPricing } from "./pricing.js";
import type { CostRecord } from "./types.js";

/**
 * Calculate cost in cents from token counts and model.
 */
export function calculateCostCents(params: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}): number {
  const pricing = getPricing(params.model ?? "");
  const input = Math.max(0, params.inputTokens);
  const output = Math.max(0, params.outputTokens);
  const cacheRead = Math.max(0, params.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, params.cacheWriteTokens ?? 0);
  const cost =
    (input / 1_000_000) * pricing.inputPerM +
    (output / 1_000_000) * pricing.outputPerM +
    (cacheRead / 1_000_000) * pricing.cacheReadPerM +
    (cacheWrite / 1_000_000) * pricing.cacheWritePerM;
  return Math.round(cost); // round to nearest whole cent (matches INTEGER column)
}

/**
 * Record a cost entry. Dual-writes to cost_records + metrics.
 */
export function recordCost(
  params: {
    projectId: string;
    agentId: string;
    sessionKey?: string;
    taskId?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
    provider?: string;
    source?: string;
  },
  dbOverride?: DatabaseSync,
): CostRecord {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const costCents = calculateCostCents(params);

  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, session_key, task_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_cents, model, provider, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.agentId,
    params.sessionKey ?? null,
    params.taskId ?? null,
    params.inputTokens,
    params.outputTokens,
    params.cacheReadTokens ?? 0,
    params.cacheWriteTokens ?? 0,
    costCents,
    params.model ?? null,
    params.provider ?? null,
    params.source ?? "dispatch",
    now,
  );

  // Also update budget daily_spent if a budget exists
  try {
    db.prepare(`
      UPDATE budgets SET daily_spent_cents = daily_spent_cents + ?, updated_at = ?
      WHERE project_id = ? AND (agent_id = ? OR agent_id IS NULL) AND daily_reset_at > ?
    `).run(costCents, now, params.projectId, params.agentId, now);
  } catch (err) {
    safeLog("cost.updateBudget", err);
  }

  // Dual-write to metrics for aggregation
  try {
    recordMetric({
      projectId: params.projectId,
      type: "cost",
      subject: params.agentId,
      key: "cost_cents",
      value: costCents,
      unit: "cents",
      tags: {
        taskId: params.taskId,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
      },
    }, db);
  } catch (err) {
    safeLog("cost.metric", err);
  }

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens ?? 0,
    cacheWriteTokens: params.cacheWriteTokens ?? 0,
    costCents,
    model: params.model,
    provider: params.provider,
    source: params.source ?? "dispatch",
    createdAt: now,
  };
}

/**
 * Record cost from an OpenClaw llm_output hook event.
 * Convenience wrapper that maps hook event fields to recordCost params.
 */
export function recordCostFromLlmOutput(params: {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): CostRecord {
  return recordCost({
    projectId: params.projectId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    provider: params.provider,
    model: params.model,
    inputTokens: params.usage.input ?? 0,
    outputTokens: params.usage.output ?? 0,
    cacheReadTokens: params.usage.cacheRead ?? 0,
    cacheWriteTokens: params.usage.cacheWrite ?? 0,
    source: "llm_output",
  });
}

export type CostSummary = {
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  recordCount: number;
};

/**
 * Get cost summary for a project, optionally filtered by agent/task/time range.
 */
export function getCostSummary(
  params: {
    projectId: string;
    agentId?: string;
    taskId?: string;
    provider?: string;
    since?: number;
    until?: number;
  },
  dbOverride?: DatabaseSync,
): CostSummary {
  const db = dbOverride ?? getDb(params.projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: (string | number)[] = [params.projectId];

  if (params.agentId) {
    conditions.push("agent_id = ?");
    values.push(params.agentId);
  }
  if (params.taskId) {
    conditions.push("task_id = ?");
    values.push(params.taskId);
  }
  if (params.provider) {
    conditions.push("provider = ?");
    values.push(params.provider);
  }
  if (params.since) {
    conditions.push("created_at >= ?");
    values.push(params.since);
  }
  if (params.until) {
    conditions.push("created_at <= ?");
    values.push(params.until);
  }

  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_cents), 0) as total_cost,
           COALESCE(SUM(input_tokens), 0) as total_input,
           COALESCE(SUM(output_tokens), 0) as total_output,
           COUNT(*) as cnt
    FROM cost_records WHERE ${conditions.join(" AND ")}
  `).get(...values) as Record<string, unknown>;

  return {
    totalCostCents: row.total_cost as number,
    totalInputTokens: row.total_input as number,
    totalOutputTokens: row.total_output as number,
    recordCount: row.cnt as number,
  };
}

/**
 * Get cost for a specific task.
 */
export function getTaskCost(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): CostSummary {
  return getCostSummary({ projectId, taskId }, dbOverride);
}
