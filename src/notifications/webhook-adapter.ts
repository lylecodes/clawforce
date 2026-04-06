/**
 * ClawForce — Webhook Notification Delivery Adapter
 *
 * Delivers notifications via HTTP POST to a configured webhook URL.
 * Suitable for standalone deployments that don't use OpenClaw channels.
 */

import type { NotificationDeliveryAdapter, NotificationRecord, DeliveryTarget, DeliveryResult } from "./delivery.js";

export function createWebhookDeliveryAdapter(): NotificationDeliveryAdapter {
  return {
    supportedChannels(): string[] {
      return ["webhook"];
    },

    async deliver(notification: NotificationRecord, target: DeliveryTarget): Promise<DeliveryResult> {
      const url = target.config?.url as string | undefined;
      if (!url) {
        return { ok: false, channel: "webhook", error: "No webhook URL configured" };
      }

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: notification.id,
            category: notification.category,
            severity: notification.severity,
            title: notification.title,
            body: notification.body,
            projectId: notification.projectId,
            createdAt: notification.createdAt,
          }),
        });

        if (!resp.ok) {
          return { ok: false, channel: "webhook", error: `HTTP ${resp.status}` };
        }

        return { ok: true, channel: "webhook", deliveredAt: Date.now() };
      } catch (err) {
        return {
          ok: false,
          channel: "webhook",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
