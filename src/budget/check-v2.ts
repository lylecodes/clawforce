/**
 * Clawforce — Budget Check v2
 *
 * O(1) counter-based enforcement for time windows (hourly/daily/monthly).
 * Checks all three dimensions (cents, tokens, requests).
 * Accounts for reservations from active dispatch plans.
 */

import type { DatabaseSync } from "node:sqlite";
import type { BudgetCheckResult } from "../types.js";
import { ensureWindowsCurrent } from "./reset.js";

export function checkBudgetV2(
  params: { projectId: string; agentId?: string },
  db: DatabaseSync,
): BudgetCheckResult {
  // Lazy reset first
  ensureWindowsCurrent(params.projectId, params.agentId, db);
  ensureWindowsCurrent(params.projectId, undefined, db);

  let agentResult: BudgetCheckResult | null = null;

  // Check agent-level budget (if agent specified)
  if (params.agentId) {
    agentResult = checkBudgetRow(params.projectId, params.agentId, db);
    if (agentResult && !agentResult.ok) {
      void import("../notifications/integrations.js").then(({ notifyBudgetExceeded }) => {
        const win = agentResult!.reason?.split(" ")[0] ?? "unknown";
        notifyBudgetExceeded(params.projectId, win, 0, 0);
      }).catch(() => { /* non-fatal */ });
      return agentResult;
    }
  }

  // Check project-level budget
  const projectResult = checkBudgetRow(params.projectId, undefined, db);
  if (projectResult && !projectResult.ok) {
    void import("../notifications/integrations.js").then(({ notifyBudgetExceeded }) => {
      const win = projectResult!.reason?.split(" ")[0] ?? "unknown";
      notifyBudgetExceeded(params.projectId, win, 0, 0);
    }).catch(() => { /* non-fatal */ });
    return projectResult;
  }

  // Both pass — return minimum remaining
  const agentRemaining = agentResult?.remaining ?? Infinity;
  const remaining = Math.min(
    projectResult?.remaining ?? Infinity,
    agentRemaining,
  );

  return { ok: true, remaining: remaining === Infinity ? undefined : remaining };
}

function checkBudgetRow(
  projectId: string,
  agentId: string | undefined,
  db: DatabaseSync,
): BudgetCheckResult | null {
  const whereClause = agentId
    ? "project_id = ? AND agent_id = ?"
    : "project_id = ? AND agent_id IS NULL";
  const whereParams = agentId ? [projectId, agentId] : [projectId];

  const row = db.prepare(`SELECT * FROM budgets WHERE ${whereClause}`).get(
    ...whereParams,
  ) as Record<string, number | null> | undefined;

  if (!row) return null;

  const reserved_cents = (row.reserved_cents as number) ?? 0;
  const reserved_tokens = (row.reserved_tokens as number) ?? 0;
  const reserved_requests = (row.reserved_requests as number) ?? 0;

  // Check all windows x all dimensions
  const windows = [
    { prefix: "hourly" },
    { prefix: "daily" },
    { prefix: "monthly" },
  ];
  const dimensions = ["cents", "tokens", "requests"];
  const reservedMap: Record<string, number> = {
    cents: reserved_cents,
    tokens: reserved_tokens,
    requests: reserved_requests,
  };

  let minRemaining = Infinity;

  for (const win of windows) {
    for (const dim of dimensions) {
      const limitCol = `${win.prefix}_limit_${dim}`;
      const spentCol = `${win.prefix}_spent_${dim}`;
      const limit = row[limitCol] as number | null;
      if (limit == null || limit <= 0) continue;

      const spent = (row[spentCol] as number) ?? 0;
      const reserved = reservedMap[dim];
      const remaining = limit - spent - reserved;

      if (remaining <= 0) {
        return {
          ok: false,
          remaining: 0,
          reason: `${win.prefix} ${dim} budget exceeded (${spent}${reserved > 0 ? ` + ${reserved} reserved` : ""} / ${limit})`,
        };
      }

      if (dim === "cents") {
        minRemaining = Math.min(minRemaining, remaining);
      }
    }
  }

  return { ok: true, remaining: minRemaining === Infinity ? undefined : minRemaining };
}
