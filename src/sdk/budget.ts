/**
 * Clawforce SDK — Budget Namespace
 *
 * Wraps internal budget and cost functions with a clean public API.
 * The `domain` property maps to the internal `projectId` param.
 */

import {
  checkBudget as internalCheckBudget,
  setBudget as internalSetBudget,
} from "../budget.js";
import {
  recordCost as internalRecordCost,
  getCostSummary as internalGetCostSummary,
  getTaskCost as internalGetTaskCost,
} from "../cost.js";
import { getBudgetStatus as internalGetBudgetStatus } from "../budget-windows.js";

import type { BudgetCheckResult, BudgetConfig, CostParams } from "./types.js";
import type { BudgetCheckResult as InternalBudgetCheckResult } from "../types.js";

/** Map internal BudgetCheckResult (remaining is a flat cents number) to SDK type. */
function toPublicCheckResult(internal: InternalBudgetCheckResult): BudgetCheckResult {
  return {
    ok: internal.ok,
    remaining: internal.remaining !== undefined ? { cents: internal.remaining } : undefined,
    reason: internal.reason,
  };
}

export class BudgetNamespace {
  constructor(readonly domain: string) {}

  /**
   * Check if the project (or a specific agent) is within budget.
   * Returns { ok: true } when within limits or no budget is configured.
   */
  check(agentId?: string): BudgetCheckResult {
    return toPublicCheckResult(internalCheckBudget({
      projectId: this.domain,
      agentId,
    }));
  }

  /**
   * Record a cost entry for the given agent.
   * The domain (projectId) is pre-filled from the namespace instance.
   */
  recordCost(params: CostParams): any {
    return internalRecordCost({
      projectId: this.domain,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      taskId: params.taskId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      model: params.model,
      provider: params.provider,
    });
  }

  /**
   * Get current budget status (spent vs. limits) for the project or a specific agent.
   * Includes per-window (hourly/daily/monthly) breakdown and threshold alerts.
   */
  status(agentId?: string): any {
    return internalGetBudgetStatus(this.domain, agentId);
  }

  /**
   * Set or update a budget configuration for the project or a specific agent.
   */
  set(config: BudgetConfig, agentId?: string): void {
    internalSetBudget({
      projectId: this.domain,
      agentId,
      config,
    });
  }

  /**
   * Get cost summary for the project, optionally filtered.
   */
  costSummary(filters?: {
    agentId?: string;
    taskId?: string;
    since?: number;
    until?: number;
  }): any {
    return internalGetCostSummary({
      projectId: this.domain,
      agentId: filters?.agentId,
      taskId: filters?.taskId,
      since: filters?.since,
      until: filters?.until,
    });
  }

  /**
   * Get cost summary for a specific task.
   */
  taskCost(taskId: string): any {
    return internalGetTaskCost(this.domain, taskId);
  }
}
