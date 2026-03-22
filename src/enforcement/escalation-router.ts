/**
 * Clawforce — Escalation router
 *
 * Routes performance alerts based on the agent's `reports_to` config.
 * Supports escalation chaining: if the immediate manager can't be reached,
 * tries each level up the chain (employee → team lead → director → VP → human).
 * - "parent" (or absent): relies on subagent auto-announce (no action needed here).
 * - "<agentName>": injects a failure message into the named agent's session
 *   via `api.injectAgentMessage()`.
 */

import type { AgentConfig } from "../types.js";
import { emitDiagnosticEvent } from "../diagnostics.js";
import { createMessage, markDelivered } from "../messaging/store.js";
import { notifyMessage } from "../messaging/notify.js";
import { resolveEscalationChain } from "../org.js";

export type EscalationTarget =
  | { kind: "parent" }
  | { kind: "named_agent"; agentId: string };

/**
 * Resolve where a failure should be escalated based on config.
 */
export function resolveEscalationTarget(config: AgentConfig): EscalationTarget {
  if (!config.reports_to || config.reports_to === "parent") {
    return { kind: "parent" };
  }
  return { kind: "named_agent", agentId: config.reports_to };
}

export type EscalationParams = {
  /** Plugin API for injecting messages. */
  injectAgentMessage: (params: {
    sessionKey: string;
    message: string;
  }) => Promise<{ runId?: string }>;
  target: EscalationTarget;
  message: string;
  /** The failing agent's ID (for logging). */
  sourceAgentId: string;
  /** Project ID for chain resolution. */
  projectId?: string;
  /** Logger for warnings. */
  logger: { warn: (msg: string) => void };
};

/**
 * Route an escalation message to the appropriate target.
 * Supports escalation chaining: tries each level up the org chart.
 *
 * - "parent": logs the alert (auto-announce already delivers via subagent_ended).
 * - "named_agent": injects the message into `agent:<agentId>` session.
 *   If injection fails, tries the next level in the escalation chain.
 */
export async function routeEscalation(params: EscalationParams): Promise<void> {
  const { target, message, sourceAgentId, logger } = params;

  if (target.kind === "parent") {
    // Auto-announce from subagent_ended already covers this path.
    emitDiagnosticEvent({ type: "escalation_to_parent", sourceAgentId, message });
    return;
  }

  // Build escalation chain: immediate target + their chain
  const targets = [target.agentId];
  if (params.projectId) {
    const { chain } = resolveEscalationChain(params.projectId, target.agentId);
    targets.push(...chain);
  }

  // Try each level in the chain until one succeeds
  for (const targetAgentId of targets) {
    const sessionKey = `agent:${targetAgentId}`;

    // Step 1: Persist as message for delivery tracking (requires projectId)
    let persisted = false;
    if (params.projectId) {
      try {
        const msg = createMessage({
          fromAgent: `system:escalation:${sourceAgentId}`,
          toAgent: targetAgentId,
          projectId: params.projectId,
          type: "escalation",
          priority: "urgent",
          content: message,
        });
        persisted = true;
        emitDiagnosticEvent({ type: "escalation_queued_as_message", targetAgentId, sourceAgentId, messageId: msg.id });

        // Attempt immediate delivery for active sessions
        try {
          await params.injectAgentMessage({ sessionKey, message });
          markDelivered(msg.id);
          emitDiagnosticEvent({ type: "escalation_delivered", targetAgentId, sourceAgentId });
        } catch {
          // Message stays queued — will be delivered at next session start via pending_messages
          emitDiagnosticEvent({ type: "escalation_queued_for_delivery", targetAgentId, sourceAgentId });
        }

        // Mirror to Telegram (fire-and-forget)
        notifyMessage(msg).catch(() => {});

        return; // Message persisted — stop escalating up the chain
      } catch (err) {
        logger.warn(`Clawforce: failed to persist escalation as message: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 2: Direct injection without persistence — used when projectId is
    // unavailable (no message store) or when createMessage failed above.
    if (!persisted) {
      try {
        await params.injectAgentMessage({ sessionKey, message });
        emitDiagnosticEvent({ type: "escalation_delivered", targetAgentId, sourceAgentId });
        return; // Delivered — stop escalating
      } catch (err) {
        emitDiagnosticEvent({
          type: "escalation_failed",
          targetAgentId,
          sourceAgentId,
          reason: err instanceof Error ? err.message : String(err),
        });
        logger.warn(
          `Clawforce: failed to escalate from ${sourceAgentId} to ${targetAgentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Continue to next level in the chain
      }
    }
  }

  // All levels failed — log final fallback to parent
  emitDiagnosticEvent({ type: "escalation_chain_exhausted", sourceAgentId, message });
}
