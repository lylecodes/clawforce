/**
 * Clawforce — Approval channel router
 *
 * Resolves which notification channel to use for a given agent's proposals.
 * Reads the `channel` field from AgentConfig, defaults to "dashboard" (silent).
 */

import { getAgentConfig } from "../project.js";

export type ApprovalChannel = "inline" | "telegram" | "slack" | "discord" | "dashboard";

export type ChannelConfig = {
  channel: ApprovalChannel;
  /** Target identifier (e.g. Telegram chat ID, Slack channel). */
  target?: string;
  /** Thread/topic ID for threaded channels. */
  threadId?: number;
};

const KNOWN_CHANNELS = new Set<ApprovalChannel>(["inline", "telegram", "slack", "discord", "dashboard"]);

/**
 * Resolve the approval notification channel for an agent.
 * Falls back to "dashboard" when unset or unknown.
 */
export function resolveApprovalChannel(projectId: string, agentId: string): ChannelConfig {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry || !entry.config.channel) {
    return { channel: "dashboard" };
  }

  const raw = entry.config.channel.toLowerCase().trim();

  if (KNOWN_CHANNELS.has(raw as ApprovalChannel)) {
    return { channel: raw as ApprovalChannel };
  }

  // Unknown channel type → dashboard fallback
  return { channel: "dashboard" };
}
