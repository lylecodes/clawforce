/**
 * Clawforce — Policy engine
 *
 * Evaluates all active policies for a project/agent against a proposed action.
 * Returns allowed/blocked with reason.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { checkBudget } from "../budget.js";
import { getDb } from "../db.js";
import type { PolicyCheckResult, PolicyDefinition } from "../types.js";
import { getPolicies } from "./registry.js";

export type PolicyContext = {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  toolName: string;
  toolAction?: string;
  taskId?: string;
  taskPriority?: string;
  fromState?: string;
  toState?: string;
  dbOverride?: DatabaseSync;
};

/**
 * Check all active policies against a proposed action.
 * Returns first violation found (sorted by priority), or { allowed: true }.
 */
export function checkPolicies(context: PolicyContext): PolicyCheckResult {
  const policies = getPolicies(context.projectId, context.agentId);
  if (policies.length === 0) return { allowed: true };

  // Sort by priority (higher priority = check first)
  const sorted = [...policies].sort((a, b) => b.priority - a.priority);

  for (const policy of sorted) {
    const result = evaluatePolicy(policy, context);
    if (!result.allowed) return result;
  }

  return { allowed: true };
}

function evaluatePolicy(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyCheckResult {
  switch (policy.type) {
    case "action_scope":
      return evaluateActionScope(policy, context);
    case "transition_gate":
      return evaluateTransitionGate(policy, context);
    case "spend_limit":
      return evaluateSpendLimit(policy, context);
    case "approval_required":
      return evaluateApprovalRequired(policy, context);
    default:
      return { allowed: true };
  }
}

function evaluateActionScope(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyCheckResult {
  const config = policy.config;
  const rawAllowed = config.allowed_tools;
  const deniedTools = config.denied_tools as string[] | undefined;

  // Deny list takes precedence (always string[])
  if (deniedTools && deniedTools.includes(context.toolName)) {
    return {
      allowed: false,
      reason: `Tool "${context.toolName}" is denied by policy "${policy.name}"`,
      policyId: policy.id,
    };
  }

  if (!rawAllowed) return { allowed: true };

  // Legacy format: string[] — tool-name-only check
  if (Array.isArray(rawAllowed)) {
    if (!(rawAllowed as string[]).includes(context.toolName)) {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is not in the allowed list for policy "${policy.name}"`,
        policyId: policy.id,
      };
    }
    return { allowed: true };
  }

  // New ActionScope format: Record<string, string[] | "*" | ActionConstraint>
  if (typeof rawAllowed === "object") {
    const scope = rawAllowed as Record<string, unknown>;

    // Tool must be a key in the scope
    if (!(context.toolName in scope)) {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is not in the allowed list for policy "${policy.name}"`,
        policyId: policy.id,
      };
    }

    let allowedActions: string[] | "*";
    const entry = scope[context.toolName]!;

    // ActionConstraint shape: { actions: ..., constraints?: ... }
    if (typeof entry === "object" && !Array.isArray(entry) && entry !== null && "actions" in (entry as Record<string, unknown>)) {
      allowedActions = (entry as { actions: string[] | "*" }).actions;
    } else {
      allowedActions = entry as string[] | "*";
    }

    // Wildcard: all actions allowed
    if (allowedActions === "*") return { allowed: true };

    // Action-level check (only if toolAction is provided)
    if (context.toolAction && !allowedActions.includes(context.toolAction)) {
      return {
        allowed: false,
        reason: `Action "${context.toolAction}" on tool "${context.toolName}" is not allowed by policy "${policy.name}"`,
        policyId: policy.id,
      };
    }

    return { allowed: true };
  }

  return { allowed: true };
}

function evaluateTransitionGate(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyCheckResult {
  if (context.toolName !== "clawforce_task" || (context.toolAction !== "transition" && context.toolAction !== "bulk_transition")) {
    return { allowed: true };
  }

  const transitions = policy.config.transitions as Array<{
    from?: string;
    to?: string;
    conditions?: {
      min_priority?: string;
      require_different_actor?: boolean;
    };
  }> | undefined;

  if (!transitions) return { allowed: true };

  for (const gate of transitions) {
    const fromMatch = !gate.from || gate.from === context.fromState;
    const toMatch = !gate.to || gate.to === context.toState;

    if (fromMatch && toMatch) {
      // Check conditions
      if (gate.conditions?.min_priority && context.taskPriority) {
        const priorityOrder = ["P0", "P1", "P2", "P3"];
        const minIdx = priorityOrder.indexOf(gate.conditions.min_priority);
        const taskIdx = priorityOrder.indexOf(context.taskPriority);
        if (taskIdx <= minIdx) {
          return {
            allowed: false,
            reason: `Transition ${context.fromState} → ${context.toState} requires approval for priority ${context.taskPriority} (policy: "${policy.name}")`,
            policyId: policy.id,
          };
        }
      }
    }
  }

  return { allowed: true };
}

function evaluateSpendLimit(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyCheckResult {
  const db = context.dbOverride ?? getDb(context.projectId);
  const result = checkBudget(
    { projectId: context.projectId, agentId: context.agentId, taskId: context.taskId },
    db,
  );

  if (!result.ok) {
    return {
      allowed: false,
      reason: result.reason ?? "Budget exceeded",
      policyId: policy.id,
    };
  }

  return { allowed: true };
}

function evaluateApprovalRequired(
  policy: PolicyDefinition,
  context: PolicyContext,
): PolicyCheckResult {
  const config = policy.config;
  const tools = config.tools as string[] | undefined;
  const actions = config.actions as string[] | undefined;

  const toolMatch = !tools || tools.includes(context.toolName);
  const actionMatch = !actions || (context.toolAction !== undefined && actions.includes(context.toolAction));

  if (toolMatch && actionMatch) {
    return {
      allowed: false,
      reason: `Action requires approval per policy "${policy.name}"`,
      policyId: policy.id,
    };
  }

  return { allowed: true };
}
