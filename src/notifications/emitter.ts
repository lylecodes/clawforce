/**
 * Clawforce — Notification emitter
 *
 * Creates notification records and attempts routed delivery.
 * Dashboard delivery is always implicit (the record exists in the inbox).
 * External delivery (Telegram, email, etc.) is pluggable via setNotificationDeliveryAdapter.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  createNotification,
  updateDeliveryStatus,
  type CreateNotificationParams,
} from "./store.js";
import type { NotificationRecord } from "./types.js";
import { safeLog } from "../diagnostics.js";

// --- Delivery adapter ---

export type NotificationDeliveryAdapter = (
  record: NotificationRecord,
) => Promise<void>;

let deliveryAdapter: NotificationDeliveryAdapter | null = null;

/**
 * Register a delivery adapter for external channels (Telegram, email, etc.).
 * The adapter is called after the notification record is persisted.
 * Any error thrown by the adapter is caught and recorded on the notification.
 */
export function setNotificationDeliveryAdapter(
  fn: NotificationDeliveryAdapter | null,
): void {
  deliveryAdapter = fn;
}

/**
 * Get the currently registered delivery adapter (for testing).
 */
export function getNotificationDeliveryAdapter(): NotificationDeliveryAdapter | null {
  return deliveryAdapter;
}

// --- Emitter ---

export type EmitNotificationParams = Omit<
  CreateNotificationParams,
  "deliveryStatus"
>;

/**
 * Emit a notification: persist to inbox and attempt external delivery.
 *
 * Dashboard delivery is implicit — the record in the DB is the inbox entry.
 * If a delivery adapter is registered, it is called and its success/failure
 * is recorded on the notification record.
 */
export function emitNotification(
  projectId: string,
  params: EmitNotificationParams,
  dbOverride?: DatabaseSync,
): NotificationRecord {
  // Persist the record — delivery status starts as "pending"
  const record = createNotification(
    projectId,
    { ...params, deliveryStatus: "pending" },
    dbOverride,
  );

  // Attempt external delivery asynchronously — never blocks the caller
  if (deliveryAdapter) {
    const adapter = deliveryAdapter;
    Promise.resolve()
      .then(() => adapter(record))
      .then(() => {
        updateDeliveryStatus(
          record.id,
          "delivered",
          null,
          dbOverride,
          projectId,
        );
      })
      .catch((err: unknown) => {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        safeLog("notification.delivery.failed", { id: record.id, error: errorMessage });
        updateDeliveryStatus(
          record.id,
          "failed",
          errorMessage,
          dbOverride,
          projectId,
        );
      });
  }

  return record;
}
