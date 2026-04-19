/**
 * Clawforce — Risk gate
 *
 * Maps risk tier classification to enforcement actions:
 * allow, delay, require_approval, or block.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import type { RiskClassification, RiskGateResult, RiskTierConfig } from "../types.js";

export type RiskGateContext = {
  projectId: string;
  actionType: string;
  actionDetail: string;
  actor: string;
  classification: RiskClassification;
  config: RiskTierConfig;
  dbOverride?: DatabaseSync;
};

/**
 * Apply the risk gate for a classified action.
 * Records the assessment to risk_assessments table.
 */
export function applyRiskGate(context: RiskGateContext): RiskGateResult {
  const { classification, config } = context;
  const db = context.dbOverride ?? getDb(context.projectId);
  const tierPolicy = config.policies[classification.tier];

  let result: RiskGateResult;

  switch (tierPolicy?.gate) {
    case "none":
      result = { action: "allow" };
      break;
    case "delay":
      result = { action: "delay", delayMs: tierPolicy.delayMs ?? 30000 };
      break;
    case "confirm":
      result = {
        action: "require_approval",
        proposalTitle: `Confirm: ${context.actionDetail} (${classification.tier})`,
      };
      break;
    case "approval":
      result = {
        action: "require_approval",
        proposalTitle: `Risk gate: ${context.actionDetail} (${classification.tier})`,
      };
      break;
    case "human_approval":
      result = {
        action: "block",
        reason: `Action requires human approval (risk tier: ${classification.tier}): ${classification.reasons.join("; ")}`,
      };
      break;
    default:
      result = { action: "allow" };
  }

  // Record risk assessment
  recordAssessment(context, result, db);

  return result;
}

function recordAssessment(
  context: RiskGateContext,
  result: RiskGateResult,
  db: DatabaseSync,
): void {
  try {
    const id = crypto.randomUUID();
    const now = Date.now();
    const decision = result.action === "allow" ? "allowed"
      : result.action === "delay" ? "delayed"
      : result.action === "require_approval" ? "pending_approval"
      : "blocked";

    db.prepare(`
      INSERT INTO risk_assessments (id, project_id, action_type, action_detail,
        risk_tier, classification_reason, decision, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      context.projectId,
      context.actionType,
      context.actionDetail,
      context.classification.tier,
      context.classification.reasons.join("; "),
      decision,
      context.actor,
      now,
    );
  } catch (err) {
    safeLog("risk.recordAssessment", err);
  }
}
