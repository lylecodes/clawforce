/**
 * Clawforce — Message notification
 *
 * Module-level setter for message delivery to external channels (Telegram, etc.).
 * Follows the same pattern as setApprovalNotifier() in src/approval/notify.ts.
 */

import { safeLog } from "../diagnostics.js";
import type { Message } from "../types.js";

export type MessageNotifier = {
  sendMessageNotification(message: Message): Promise<{ sent: boolean; error?: string }>;
};

let notifier: MessageNotifier | null = null;

export function setMessageNotifier(n: MessageNotifier | null): void {
  notifier = n;
}

export function getMessageNotifier(): MessageNotifier | null {
  return notifier;
}

/**
 * Format a message notification for Telegram (Markdown V2 safe).
 */
export function formatMessageNotification(message: Message): string {
  const priorityFlag = message.priority === "urgent"
    ? " *\\[URGENT\\]*"
    : message.priority === "high"
      ? " \\[HIGH\\]"
      : "";
  const typeTag = message.type !== "direct" ? ` \\(${message.type}\\)` : "";

  const lines = [
    `*New Message*${priorityFlag}`,
    `*From:* ${message.fromAgent}${typeTag}`,
    `*To:* ${message.toAgent}`,
    "",
    message.content.length > 500
      ? message.content.slice(0, 497) + "..."
      : message.content,
  ];

  return lines.join("\n");
}

/**
 * Attempt to notify the recipient via their configured channel.
 * Fire-and-forget with error boundary.
 */
export async function notifyMessage(message: Message): Promise<void> {
  const n = notifier;
  if (!n) return;

  try {
    await n.sendMessageNotification(message);
  } catch (err) {
    safeLog("messaging.notify", err);
  }
}
