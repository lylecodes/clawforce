/**
 * ClawForce — OpenClaw Notification Delivery Adapter
 *
 * Routes ClawForce notifications through OpenClaw's unified channel delivery
 * when ClawForce is running as an OpenClaw plugin. Falls back gracefully when
 * the OpenClaw delivery adapter is not available (standalone mode).
 */

import { getDeliveryAdapter, deliverMessage } from "../channels/deliver.js";
import type { NotificationDeliveryAdapter, NotificationRecord, DeliveryTarget, DeliveryResult } from "./delivery.js";

const OPENCLAW_CHANNELS = ["telegram", "discord", "slack"] as const;

export function createOpenClawDeliveryAdapter(): NotificationDeliveryAdapter {
  return {
    supportedChannels(): string[] {
      const adapter = getDeliveryAdapter();
      return adapter ? [...OPENCLAW_CHANNELS] : [];
    },

    async deliver(notification: NotificationRecord, target: DeliveryTarget): Promise<DeliveryResult> {
      const adapter = getDeliveryAdapter();
      if (!adapter) {
        return {
          ok: false,
          channel: target.channel,
          error: "No OpenClaw delivery adapter available",
        };
      }

      try {
        const content = formatNotificationForChannel(notification, target.channel);
        const result = await deliverMessage({
          channel: target.channel,
          content,
          target: (target.config as Record<string, unknown>) ?? {},
        });

        if (!result.delivered) {
          return {
            ok: false,
            channel: target.channel,
            error: result.error ?? "Delivery returned delivered=false",
          };
        }

        return { ok: true, channel: target.channel, deliveredAt: Date.now() };
      } catch (err) {
        return {
          ok: false,
          channel: target.channel,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function formatNotificationForChannel(notification: NotificationRecord, channel: string): string {
  const severity =
    notification.severity === "critical"
      ? "🔴"
      : notification.severity === "warning"
        ? "🟡"
        : "ℹ️";

  // Slack and Discord support markdown; Telegram uses its own subset
  if (channel === "slack" || channel === "discord") {
    return `${severity} *${notification.title}*\n${notification.body}`;
  }

  return `${severity} ${notification.title}\n${notification.body}`;
}
