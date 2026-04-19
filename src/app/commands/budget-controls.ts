import { writeAuditEntry } from "../../audit.js";
import { allocateBudget, type BudgetAllocation } from "../../budget-cascade.js";
import { normalizeBudgetConfig } from "../../budget/normalize.js";
import { withActionTrackingSync } from "../../dashboard/action-status.js";
import { recordChange } from "../../history/store.js";

export type AllocateBudgetCommandResult =
  | {
      ok: true;
      status: 200;
      actionId: string | undefined;
      parentAgentId: string;
      childAgentId: string;
      allocationConfig: Record<string, unknown>;
    }
  | {
      ok: false;
      status: number;
      error: string;
      actionId?: string;
    };

export function runAllocateBudgetCommand(
  projectId: string,
  body: Record<string, unknown>,
): AllocateBudgetCommandResult {
  const parentAgentId = readStringBody(body, "parentAgentId", "parent_agent_id");
  const childAgentId = readStringBody(body, "childAgentId", "child_agent_id");
  const actor = readStringBody(body, "actor") ?? "dashboard";

  if (!parentAgentId || !childAgentId) {
    return {
      ok: false,
      status: 400,
      error: "parentAgentId and childAgentId are required",
    };
  }

  const dailyLimitCents = readIntegerBody(body, "dailyLimitCents", "daily_limit_cents");
  const rawAllocationConfig = body.allocationConfig ?? body.allocation_config;

  let allocationConfig: BudgetAllocation | undefined;
  if (rawAllocationConfig != null) {
    try {
      const parsed = typeof rawAllocationConfig === "string"
        ? JSON.parse(rawAllocationConfig)
        : rawAllocationConfig;
      const normalized = normalizeBudgetConfig(parsed as Parameters<typeof normalizeBudgetConfig>[0]);
      allocationConfig = {
        hourly: normalized.hourly,
        daily: normalized.daily,
        monthly: normalized.monthly,
      };
    } catch {
      return {
        ok: false,
        status: 400,
        error: "allocationConfig must be valid JSON or an object",
      };
    }
  } else if (dailyLimitCents == null) {
    return {
      ok: false,
      status: 400,
      error: "Either allocationConfig or dailyLimitCents is required",
    };
  }

  let actionId: string | undefined;
  let result: ReturnType<typeof allocateBudget>;
  try {
    const tracked = withActionTrackingSync(
      projectId,
      "budget_allocate",
      actor,
      () => allocateBudget({
        projectId,
        parentAgentId,
        childAgentId,
        dailyLimitCents: dailyLimitCents ?? undefined,
        allocationConfig,
      }),
    );
    actionId = tracked.actionId;
    result = tracked.result;
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      status: 400,
      error: result.reason,
      actionId,
    };
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "allocate_budget",
      targetType: "budget",
      targetId: childAgentId,
      detail: JSON.stringify({
        parentAgentId,
        childAgentId,
        dailyLimitCents,
        allocationConfig,
      }),
    });
  } catch {
    // non-fatal
  }

  try {
    recordChange(projectId, {
      resourceType: "budget",
      resourceId: childAgentId,
      action: "update",
      provenance: "human",
      actor,
      after: { parentAgentId, childAgentId, dailyLimitCents, allocationConfig },
      reversible: true,
    });
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    status: 200,
    actionId,
    parentAgentId,
    childAgentId,
    allocationConfig: (allocationConfig ?? { daily: { cents: dailyLimitCents } }) as Record<string, unknown>,
  };
}

function readStringBody(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readIntegerBody(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
