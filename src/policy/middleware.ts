/**
 * Clawforce — Policy enforcement middleware
 *
 * Wraps tool execute functions with policy checks.
 * Intercepts before execution: if blocked, returns error + records violation.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
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

/**
 * Wrap a tool's execute function with policy checking.
 * The wrapper extracts the "action" param from the tool call,
 * runs checkPolicies(), and either proceeds or blocks.
 */
export function withPolicyCheck(
  execute: ToolExecuteFunction,
  context: PolicyMiddlewareContext,
): ToolExecuteFunction {
  return async (params: Record<string, unknown>) => {
    const action = params.action as string | undefined;

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

    const result = checkPolicies(policyContext);

    if (!result.allowed) {
      // Record violation
      recordViolation({
        projectId: context.projectId,
        policyId: result.policyId,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        actionAttempted: `${context.toolName}:${action ?? "unknown"}`,
        violationDetail: result.reason,
        outcome: "blocked",
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            reason: `Policy violation: ${result.reason}`,
            policyId: result.policyId,
          }),
        }],
        details: null,
      };
    }

    // Risk gate (non-fatal if risk system fails)
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
            actionDetail: `${context.toolName}:${action ?? "unknown"} by ${context.agentId}`,
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
              actionAttempted: `${context.toolName}:${action ?? "unknown"}`,
              violationDetail: reason,
              outcome: gate.action === "block" ? "blocked" : "approval_required",
            });

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  reason,
                  riskTier: classification.tier,
                }),
              }],
              details: null,
            };
          }
        }
      }
    } catch (err) {
      safeLog("policy.riskGate", err);
      // Risk check failure is non-fatal — proceed
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
