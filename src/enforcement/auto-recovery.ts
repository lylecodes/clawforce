/**
 * Clawforce — Auto-recovery for disabled agents
 *
 * After cooldown expires, re-enables disabled agents and resets
 * their consecutive failure state. Emits escalation events if
 * an agent keeps failing after recovery.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { enableAgent, listDisabledAgents, isAgentEffectivelyDisabled } from "./disabled-store.js";
import { getAgentConfig } from "../project.js";
import { ingestEvent } from "../events/store.js";
import { writeAuditEntry } from "../audit.js";

export type RecoveryCheck = {
  recovered: number;
  escalated: number;
};

/**
 * Check disabled agents for auto-recovery eligibility.
 * Called on each sweep tick.
 */
export function checkAutoRecovery(
  projectId: string,
  dbOverride?: DatabaseSync,
): RecoveryCheck {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  let recovered = 0;
  let escalated = 0;

  const disabledAgents = listDisabledAgents(projectId, db);

  for (const agent of disabledAgents) {
    const config = getAgentConfig(agent.agentId);
    if (!config?.config.auto_recovery?.enabled) continue;

    const cooldownMs = (config.config.auto_recovery.cooldown_minutes ?? 10) * 60 * 1000;
    const elapsed = now - agent.disabledAt;

    if (elapsed >= cooldownMs) {
      // Check if this is a repeated recovery (escalation check)
      // If agent was disabled for > 2x cooldown, it means it was re-disabled
      // after a previous recovery — escalate
      const isRepeatedFailure = elapsed >= cooldownMs * 2;

      // Before re-enabling, check if a broader scope (team/department) still
      // covers this agent. If so, skip recovery — those are intentional admin actions.
      const team = config.config.team;
      const department = config.config.department;
      const stillCoveredByScope = (() => {
        try {
          // Check disabled_scopes for team/department — but NOT the agent-level
          // legacy row we're about to remove. We only check broader scopes.
          if (team) {
            const teamRow = db.prepare(
              "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'team' AND scope_value = ?",
            ).get(projectId, team);
            if (teamRow) return "team";
          }
          if (department) {
            const deptRow = db.prepare(
              "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'department' AND scope_value = ?",
            ).get(projectId, department);
            if (deptRow) return "department";
          }
          return null;
        } catch {
          return null;
        }
      })();

      if (stillCoveredByScope) {
        safeLog("auto-recovery", `Agent ${agent.agentId} recovery skipped: ${stillCoveredByScope} ${stillCoveredByScope === "team" ? team : department} is disabled.`);
        continue;
      }

      try {
        // Re-enable the agent
        enableAgent(projectId, agent.agentId, db);

        // Reset consecutive failure counter by inserting a recovery marker
        try {
          db.prepare(`
            INSERT INTO audit_log (id, project_id, actor, action, target_type, target_id, detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            projectId,
            "system:auto-recovery",
            "agent.recovered",
            "agent",
            agent.agentId,
            JSON.stringify({
              reason: agent.reason,
              disabledAt: agent.disabledAt,
              cooldownMinutes: config.config.auto_recovery.cooldown_minutes ?? 10,
              elapsedMinutes: Math.round(elapsed / 60_000),
            }),
            now,
          );
        } catch (err) {
          safeLog("auto-recovery.auditMarker", err);
        }

        recovered++;
        safeLog("auto-recovery", `Recovered agent ${agent.agentId} after ${Math.round(elapsed / 60_000)}m cooldown`);

        // Emit recovery event
        ingestEvent(projectId, "agent_recovered", "internal", {
          agentId: agent.agentId,
          reason: agent.reason,
          disabledAt: agent.disabledAt,
          cooldownMinutes: config.config.auto_recovery.cooldown_minutes ?? 10,
          elapsedMinutes: Math.round(elapsed / 60_000),
        }, undefined, db);

      } catch (err) {
        safeLog("auto-recovery.enable", err);
      }

      // Emit escalation if this is a repeated failure
      if (isRepeatedFailure) {
        try {
          ingestEvent(projectId, "agent_recovery_escalation", "internal", {
            agentId: agent.agentId,
            reason: agent.reason,
            totalDisableMinutes: Math.round(elapsed / 60_000),
            recoveryAttempts: 1, // We don't track count yet — future enhancement
          }, undefined, db);
          escalated++;
        } catch (err) {
          safeLog("auto-recovery.escalation", err);
        }
      }
    }
  }

  return { recovered, escalated };
}

// Node.js crypto
import crypto from "node:crypto";
