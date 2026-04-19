/**
 * Clawforce — Notification store
 *
 * SQLite-backed CRUD for the notifications table.
 * Notifications are the canonical in-app inbox for operator-facing events.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import type {
  NotificationCategory,
  NotificationDeliveryStatus,
  NotificationRecord,
  NotificationSeverity,
  NotificationActionability,
} from "./types.js";

// --- Table setup ---

/**
 * Ensure the notifications table exists. Called lazily before first write.
 * Safe to call multiple times (IF NOT EXISTS).
 */
export function ensureNotificationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      actionability TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      destination TEXT,
      focus_context TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_channel TEXT,
      delivery_error TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      dismissed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_project_created
      ON notifications(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_notifications_project_read
      ON notifications(project_id, read, dismissed);
  `);
}

// --- Row mapping ---

function rowToRecord(row: Record<string, unknown>): NotificationRecord {
  let focusContext: Record<string, string> | undefined;
  if (row.focus_context) {
    try {
      focusContext = JSON.parse(row.focus_context as string);
    } catch {
      /* invalid JSON — skip */
    }
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    category: row.category as NotificationCategory,
    severity: row.severity as NotificationSeverity,
    actionability: row.actionability as NotificationActionability,
    title: row.title as string,
    body: row.body as string,
    destination: (row.destination as string | null) ?? undefined,
    focusContext,
    deliveryStatus: row.delivery_status as NotificationDeliveryStatus,
    deliveryChannel: (row.delivery_channel as string | null) ?? undefined,
    deliveryError: (row.delivery_error as string | null) ?? undefined,
    read: (row.read as number) === 1,
    dismissed: (row.dismissed as number) === 1,
    createdAt: row.created_at as number,
    readAt: (row.read_at as number | null) ?? undefined,
    dismissedAt: (row.dismissed_at as number | null) ?? undefined,
  };
}

// --- CRUD ---

export type CreateNotificationParams = Omit<
  NotificationRecord,
  "id" | "read" | "dismissed" | "createdAt" | "readAt" | "dismissedAt" | "deliveryStatus"
> & {
  deliveryStatus?: NotificationDeliveryStatus;
};

/**
 * Insert a notification record.
 */
export function createNotification(
  projectId: string,
  params: CreateNotificationParams,
  dbOverride?: DatabaseSync,
): NotificationRecord {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);

  const id = crypto.randomUUID();
  const now = Date.now();
  const deliveryStatus = params.deliveryStatus ?? "pending";
  const focusContextJson = params.focusContext
    ? JSON.stringify(params.focusContext)
    : null;

  db.prepare(`
    INSERT INTO notifications (
      id, project_id, category, severity, actionability, title, body,
      destination, focus_context, delivery_status, delivery_channel,
      delivery_error, read, dismissed, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `).run(
    id,
    projectId,
    params.category,
    params.severity,
    params.actionability,
    params.title,
    params.body,
    params.destination ?? null,
    focusContextJson,
    deliveryStatus,
    params.deliveryChannel ?? null,
    params.deliveryError ?? null,
    now,
  );

  return {
    id,
    projectId,
    category: params.category,
    severity: params.severity,
    actionability: params.actionability,
    title: params.title,
    body: params.body,
    destination: params.destination,
    focusContext: params.focusContext,
    deliveryStatus,
    deliveryChannel: params.deliveryChannel,
    deliveryError: params.deliveryError,
    read: false,
    dismissed: false,
    createdAt: now,
  };
}

/**
 * Get a notification by ID (scoped to project).
 */
export function getNotification(
  notificationId: string,
  dbOverride?: DatabaseSync,
): NotificationRecord | null {
  // We don't require projectId for lookup since IDs are globally unique UUIDs.
  // However callers should use this with a known projectId for safety.
  // We look up by ID only and let callers filter if needed.
  if (!dbOverride) {
    // Without a db override we can't look up since we don't have a projectId here.
    // This signature is designed to be called with a db override in practice.
    return null;
  }
  ensureNotificationTable(dbOverride);
  const row = dbOverride
    .prepare("SELECT * FROM notifications WHERE id = ?")
    .get(notificationId) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Get a notification by ID scoped to a project.
 */
export function getNotificationByProject(
  projectId: string,
  notificationId: string,
  dbOverride?: DatabaseSync,
): NotificationRecord | null {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);
  const row = db
    .prepare("SELECT * FROM notifications WHERE id = ? AND project_id = ?")
    .get(notificationId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export type ListNotificationsOptions = {
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  read?: boolean;
  dismissed?: boolean;
  limit?: number;
  offset?: number;
};

/**
 * List notifications for a project with optional filters.
 */
export function listNotifications(
  projectId: string,
  opts: ListNotificationsOptions = {},
  dbOverride?: DatabaseSync,
): NotificationRecord[] {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);

  const conditions: string[] = ["project_id = ?"];
  const values: unknown[] = [projectId];

  if (opts.category !== undefined) {
    conditions.push("category = ?");
    values.push(opts.category);
  }
  if (opts.severity !== undefined) {
    conditions.push("severity = ?");
    values.push(opts.severity);
  }
  if (opts.read !== undefined) {
    conditions.push("read = ?");
    values.push(opts.read ? 1 : 0);
  }
  if (opts.dismissed !== undefined) {
    conditions.push("dismissed = ?");
    values.push(opts.dismissed ? 1 : 0);
  }

  const where = conditions.join(" AND ");
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...(values as Array<string | number | null>), limit, offset) as Record<string, unknown>[];

  return rows.map(rowToRecord);
}

/**
 * Mark a notification as read.
 */
export function markRead(
  notificationId: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): boolean {
  const db = dbOverride ?? (projectId ? getDb(projectId) : null);
  if (!db) return false;
  ensureNotificationTable(db);

  const now = Date.now();
  const result = db
    .prepare("UPDATE notifications SET read = 1, read_at = ? WHERE id = ? AND read = 0")
    .run(now, notificationId) as { changes: number };

  return result.changes > 0;
}

/**
 * Mark a notification as dismissed.
 */
export function markDismissed(
  notificationId: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): boolean {
  const db = dbOverride ?? (projectId ? getDb(projectId) : null);
  if (!db) return false;
  ensureNotificationTable(db);

  const now = Date.now();
  const result = db
    .prepare("UPDATE notifications SET dismissed = 1, dismissed_at = ? WHERE id = ? AND dismissed = 0")
    .run(now, notificationId) as { changes: number };

  return result.changes > 0;
}

/**
 * Mark all notifications as read for a project.
 */
export function markAllRead(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);

  const now = Date.now();
  const result = db
    .prepare("UPDATE notifications SET read = 1, read_at = ? WHERE project_id = ? AND read = 0")
    .run(now, projectId) as { changes: number };

  return result.changes;
}

/**
 * Get the count of unread notifications for a project.
 */
export function getUnreadCount(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);

  const row = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE project_id = ? AND read = 0 AND dismissed = 0")
    .get(projectId) as { count: number };

  return row.count;
}

/**
 * Update delivery status on a notification record.
 */
export function updateDeliveryStatus(
  notificationId: string,
  deliveryStatus: NotificationDeliveryStatus,
  deliveryError: string | null,
  dbOverride?: DatabaseSync,
  projectId?: string,
): boolean {
  const db = dbOverride ?? (projectId ? getDb(projectId) : null);
  if (!db) return false;
  ensureNotificationTable(db);

  const result = db
    .prepare("UPDATE notifications SET delivery_status = ?, delivery_error = ? WHERE id = ?")
    .run(deliveryStatus, deliveryError, notificationId) as { changes: number };

  return result.changes > 0;
}

/**
 * Prune old dismissed notifications beyond maxAgeDays (default: 30).
 */
export function cleanupOldNotifications(
  projectId: string,
  maxAgeDays = 30,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  ensureNotificationTable(db);

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = db
    .prepare(
      "DELETE FROM notifications WHERE project_id = ? AND dismissed = 1 AND created_at < ?",
    )
    .run(projectId, cutoff) as { changes: number };

  return result.changes;
}
