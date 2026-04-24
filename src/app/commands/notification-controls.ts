import { getDb } from "../../db.js";
import {
  dismissRecurringWorkflowFailureNotifications,
  getNotificationByProject,
  isRecurringWorkflowFailureNotificationId,
  markAllRead,
  markDismissed,
  markRead,
  markRecurringWorkflowFailureNotificationsRead,
} from "../../notifications/store.js";

export type NotificationCommandResult = {
  status: number;
  body: unknown;
};

export function runMarkAllNotificationsReadCommand(projectId: string): NotificationCommandResult {
  const db = getDb(projectId);
  const count = markAllRead(projectId, db);
  return {
    status: 200,
    body: { ok: true, marked: count },
  };
}

export function runMarkNotificationReadCommand(
  projectId: string,
  notificationId: string,
): NotificationCommandResult {
  const db = getDb(projectId);
  if (isRecurringWorkflowFailureNotificationId(notificationId)) {
    const marked = markRecurringWorkflowFailureNotificationsRead(projectId, db);
    return { status: 200, body: { ok: true, marked } };
  }

  const notification = getNotificationByProject(projectId, notificationId, db);
  if (!notification) {
    return { status: 404, body: { error: "Notification not found" } };
  }

  markRead(notificationId, db);
  return { status: 200, body: { ok: true } };
}

export function runDismissNotificationCommand(
  projectId: string,
  notificationId: string,
): NotificationCommandResult {
  const db = getDb(projectId);
  if (isRecurringWorkflowFailureNotificationId(notificationId)) {
    const dismissed = dismissRecurringWorkflowFailureNotifications(projectId, db);
    return { status: 200, body: { ok: true, dismissed } };
  }

  const notification = getNotificationByProject(projectId, notificationId, db);
  if (!notification) {
    return { status: 404, body: { error: "Notification not found" } };
  }

  markDismissed(notificationId, db);
  return { status: 200, body: { ok: true } };
}
