/**
 * Clawforce — Channel notification / Telegram mirroring
 *
 * Module-level setter for channel message delivery to Telegram groups.
 * Follows the same pattern as src/messaging/notify.ts.
 */

import { safeLog } from "../diagnostics.js";
import type { Channel, Message } from "../types.js";

export type ChannelNotifier = {
  sendChannelNotification(params: {
    channel: Channel;
    message: Message;
  }): Promise<{ sent: boolean; error?: string }>;
};

let notifier: ChannelNotifier | null = null;

export function setChannelNotifier(n: ChannelNotifier | null): void {
  notifier = n;
}

export function getChannelNotifier(): ChannelNotifier | null {
  return notifier;
}

/**
 * Format a channel message for Telegram (Markdown V2 safe).
 */
export function formatChannelMessage(channel: Channel, message: Message): string {
  const lines = [
    `*\\#${channel.name}* — ${message.fromAgent}`,
    "",
    message.content.length > 500
      ? message.content.slice(0, 497) + "\\.\\.\\."
      : message.content,
  ];
  return lines.join("\n");
}

/**
 * Format a meeting transcript for Telegram.
 */
export function formatMeetingTranscript(channel: Channel, messages: Message[]): string {
  const lines = [
    `*Meeting Summary: \\#${channel.name}*`,
    `_${messages.length} message\\(s\\)_`,
    "",
  ];

  for (const msg of messages) {
    lines.push(`*${msg.fromAgent}:* ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Attempt to notify a channel message via Telegram.
 * Fire-and-forget with error boundary.
 */
export async function notifyChannelMessage(channel: Channel, message: Message): Promise<void> {
  const n = notifier;
  if (!n) return;

  // Only mirror if channel has a Telegram group configured
  const telegramGroupId = channel.metadata?.telegramGroupId as string | undefined;
  if (!telegramGroupId) return;

  try {
    await n.sendChannelNotification({ channel, message });
  } catch (err) {
    safeLog("channel.notify", err);
  }
}
