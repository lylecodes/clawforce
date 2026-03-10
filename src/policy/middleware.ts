/**
 * Clawforce — Policy enforcement middleware
 *
 * Provides two enforcement entry points:
 * 1. `enforceToolPolicy()` — reusable 3-layer check (policy → constraint → risk gate)
 * 2. `withPolicyCheck()` — wraps tool execute functions (defense-in-depth for clawforce tools)
 *
 * The `before_tool_call` hook in the adapter calls `enforceToolPolicy()` directly
 * for MCP/external tools that bypass clawforce's own tool wrappers.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
import { getConstraintsForTool } from "../profiles.js";
import { getAgentConfig } from "../project.js";
import { resolveEffectiveScope } from "../scope.js";
import { checkPolicies, type PolicyContext } from "./engine.js";

export type ToolExecuteFunction = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: unknown;
}>;

export type PolicyMiddlewareContext = {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  toolName: string;
};

export type ToolPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string; source: "policy" | "constraint" | "risk"; policyId?: string; riskTier?: string };

/**
 * Core 3-layer enforcement logic. Runs:
 * 1. Policy check (action scope, transition gate, spend limit, approval required)
 * 2. Constraint check (own_tasks_only, department_only)
 * 3. Risk gate (classifyRisk + applyRiskGate, fail-closed on error)
 *
 * Each violation records to the policy_violations table before returning.
 */
export function enforceToolPolicy(context: PolicyMiddlewareContext, params: Record<string, unknown>): ToolPolicyResult {
  const action = params.action as string | undefined;
  const actionLabel = `${context.toolName}:${action ?? "unknown"}`;

  const policyContext: PolicyContext = {
    projectId: context.projectId,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    toolName: context.toolName,
    toolAction: action,
    taskId: params.task_id as string | undefined ?? params.taskId as string | undefined,
    taskPriority: params.priority as string | undefined,
    fromState: params.from_state as string | undefined,
    toState: params.to_state as string | undefined ?? params.state as string | undefined,
  };

  // Layer 1: Policy check
  const result = checkPolicies(policyContext);
  if (!result.allowed) {
    recordViolation({
      projectId: context.projectId,
      policyId: result.policyId,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      actionAttempted: actionLabel,
      violationDetail: result.reason,
      outcome: "blocked",
    });
    return { allowed: false, reason: `Policy violation: ${result.reason}`, source: "policy", policyId: result.policyId };
  }

  // Layer 2: Constraint enforcement (own_tasks_only, department_only)
  try {
    const scope = resolveEffectiveScope(context.agentId);
    if (scope) {
      const constraints = getConstraintsForTool(scope, context.toolName);
      if (constraints) {
        const constraintViolation = checkConstraints(constraints, context, params);
        if (constraintViolation) {
          recordViolation({
            projectId: context.projectId,
            policyId: "constraint",
            agentId: context.agentId,
            sessionKey: context.sessionKey,
            actionAttempted: actionLabel,
            violationDetail: constraintViolation,
            outcome: "blocked",
          });
          return { allowed: false, reason: `Constraint violation: ${constraintViolation}`, source: "constraint" };
        }
      }
    }
  } catch (err) {
    safeLog("policy.constraintCheck", err);
  }

  // Layer 3: Risk gate (fail-closed if risk system errors)
  try {
    const extConfig = getExtendedProjectConfig(context.projectId);
    const riskConfig = getRiskConfig(extConfig?.riskTiers);
    if (riskConfig.enabled) {
      const classification = classifyRisk({
        actionType: "tool_call",
        toolName: context.toolName,
        toolAction: action,
        actor: context.agentId,
        taskPriority: policyContext.taskPriority,
        fromState: policyContext.fromState,
        toState: policyContext.toState,
      }, riskConfig);

      if (classification.tier !== "low") {
        const gate = applyRiskGate({
          projectId: context.projectId,
          actionType: "tool_call",
          actionDetail: `${actionLabel} by ${context.agentId}`,
          actor: context.agentId,
          classification,
          config: riskConfig,
        });

        if (gate.action === "block" || gate.action === "require_approval") {
          const reason = gate.action === "block"
            ? gate.reason!
            : `Action requires approval (risk tier: ${classification.tier}): ${classification.reasons.join("; ")}`;

          recordViolation({
            projectId: context.projectId,
            policyId: "risk-gate",
            agentId: context.agentId,
            sessionKey: context.sessionKey,
            actionAttempted: actionLabel,
            violationDetail: reason,
            outcome: gate.action === "block" ? "blocked" : "approval_required",
          });

          return { allowed: false, reason, source: "risk", riskTier: classification.tier };
        }
      }
    }
  } catch (err) {
    safeLog("policy.riskGate", err);
    return { allowed: false, reason: "Risk classification failed. Action blocked for safety.", source: "risk" };
  }

  return { allowed: true };
}

/**
 * Wrap a tool's execute function with policy checking (defense-in-depth).
 * Calls enforceToolPolicy() and formats the result as a tool response.
 */
export function withPolicyCheck(
  execute: ToolExecuteFunction,
  context: PolicyMiddlewareContext,
): ToolExecuteFunction {
  return async (params: Record<string, unknown>) => {
    const result = enforceToolPolicy(context, params);

    if (!result.allowed) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            reason: result.reason,
            ...(result.policyId ? { policyId: result.policyId } : {}),
            ...(result.riskTier ? { riskTier: result.riskTier } : {}),
          }),
        }],
        details: null,
      };
    }

    return execute(params);
  };
}

function recordViolation(params: {
  projectId: string;
  policyId: string;
  agentId: string;
  sessionKey?: string;
  actionAttempted: string;
  violationDetail: string;
  outcome: string;
}): void {
  try {
    const db = getDb(params.projectId);
    const id = crypto.randomUUID();
    const now = Date.now();

    db.prepare(`
      INSERT INTO policy_violations (id, project_id, policy_id, agent_id, session_key,
        action_attempted, violation_detail, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.policyId,
      params.agentId,
      params.sessionKey ?? null,
      params.actionAttempted,
      params.violationDetail,
      params.outcome,
      now,
    );
  } catch (err) {
    safeLog("policy.recordViolation", err);
  }
}

/**
 * Check ActionConstraints against the current tool call params.
 * Returns a violation message string, or null if constraints pass.
 */
function checkConstraints(
  constraints: import("../types.js").ActionConstraints,
  context: PolicyMiddlewareContext,
  params: Record<string, unknown>,
): string | null {
  if (constraints.own_tasks_only) {
    const taskId = (params.task_id ?? params.taskId) as string | undefined;
    if (taskId) {
      try {
        const db = getDb(context.projectId);
        const row = db.prepare(
          "SELECT assigned_to FROM tasks WHERE id = ? AND project_id = ?",
        ).get(taskId, context.projectId) as Record<string, unknown> | undefined;
        if (row && row.assigned_to && row.assigned_to !== context.agentId) {
          return `own_tasks_only: task ${taskId} is assigned to "${row.assigned_to}", not "${context.agentId}"`;
        }
      } catch (err) {
        safeLog("policy.constraintOwnTasks", err);
      }
    }
  }

  if (constraints.department_only) {
    const taskId = (params.task_id ?? params.taskId) as string | undefined;
    if (taskId) {
      try {
        const db = getDb(context.projectId);
        const taskRow = db.prepare(
          "SELECT department FROM tasks WHERE id = ? AND project_id = ?",
        ).get(taskId, context.projectId) as Record<string, unknown> | undefined;
        if (taskRow && taskRow.department) {
          const agentCfg = getAgentConfig(context.agentId);
          const agentDept = agentCfg?.config?.department;
          if (agentDept && taskRow.department !== agentDept) {
            return `department_only: task ${taskId} belongs to department "${taskRow.department}", agent is in "${agentDept}"`;
          }
        }
      } catch (err) {
        safeLog("policy.constraintDepartment", err);
      }
    }
  }

  return null;
}
