/**
 * Clawforce — Approval notification system
 *
 * Module-level setter pattern (matches setCronService/registerKillFunction).
 * The adapter captures OpenClaw channel APIs and calls setApprovalNotifier()
 * during registration.
 */

import type { ApprovalChannel } from "./channel-router.js";

export type NotificationPayload = {
  proposalId: string;
  projectId: string;
  title: string;
  description?: string;
  proposedBy: string;
  riskTier?: string;
  toolContext?: {
    toolName: string;
    category?: string;
    taskId?: string;
  };
};

export type NotificationResult = {
  sent: boolean;
  channel: ApprovalChannel;
  messageId?: string;
  error?: string;
};

export type ApprovalNotifier = {
  /** Send a notification about a new proposal. */
  sendProposalNotification(payload: NotificationPayload): Promise<NotificationResult>;
  /** Edit an existing notification to show resolution status. */
  editProposalMessage(
    proposalId: string,
    projectId: string,
    resolution: "approved" | "rejected",
    feedback?: string,
  ): Promise<void>;
};

let notifier: ApprovalNotifier | null = null;

/**
 * Register the approval notifier (called by adapter during setup).
 */
export function setApprovalNotifier(n: ApprovalNotifier | null): void {
  notifier = n;
}

/**
 * Get the registered approval notifier, or null if none configured.
 */
export function getApprovalNotifier(): ApprovalNotifier | null {
  return notifier;
}

/**
 * Format a proposal notification message for Telegram (Markdown).
 */
export function formatTelegramMessage(payload: NotificationPayload): string {
  const tier = payload.riskTier ? ` [${payload.riskTier}]` : "";
  const lines = [
    `*Proposal Pending*${tier}`,
    "",
    `*Title:* ${escapeMarkdown(payload.title)}`,
    `*By:* ${escapeMarkdown(payload.proposedBy)}`,
  ];

  if (payload.description) {
    lines.push(`*Description:* ${escapeMarkdown(payload.description)}`);
  }

  if (payload.toolContext) {
    lines.push(`*Tool:* ${escapeMarkdown(payload.toolContext.toolName)}`);
    if (payload.toolContext.category) {
      lines.push(`*Category:* ${escapeMarkdown(payload.toolContext.category)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format the resolution message for editing a Telegram notification.
 */
export function formatResolutionMessage(
  resolution: "approved" | "rejected",
  originalTitle: string,
  proposedBy: string,
  feedback?: string,
): string {
  const status = resolution === "approved" ? "APPROVED" : "REJECTED";
  const lines = [
    `*Proposal ${status}*`,
    "",
    `*Title:* ${escapeMarkdown(originalTitle)}`,
    `*By:* ${escapeMarkdown(proposedBy)}`,
  ];

  if (feedback) {
    lines.push(`*Feedback:* ${escapeMarkdown(feedback)}`);
  }

  return lines.join("\n");
}

/**
 * Build Telegram inline keyboard buttons for approve/reject.
 */
export function buildApprovalButtons(projectId: string, proposalId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: "Approve", callback_data: `cf:approve:${projectId}:${proposalId}` },
    { text: "Reject", callback_data: `cf:reject:${projectId}:${proposalId}` },
  ]];
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
