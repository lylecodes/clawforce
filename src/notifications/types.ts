/**
 * Clawforce — Notification types
 *
 * Canonical type definitions for the notification model.
 * Notifications are the persistent record of things that happened
 * that the operator should know about.
 */

export type NotificationCategory =
  | "approval"
  | "task"
  | "budget"
  | "health"
  | "comms"
  | "compliance"
  | "system";

export type NotificationSeverity = "critical" | "warning" | "info";

export type NotificationActionability =
  | "action-required"
  | "dismissible"
  | "informational";

export type NotificationDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "skipped";

export type NotificationRecord = {
  id: string;
  projectId: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  actionability: NotificationActionability;
  title: string;
  body: string;
  /** Route to navigate to for action */
  destination?: string;
  focusContext?: Record<string, string>;
  /** Delivery tracking */
  deliveryStatus: NotificationDeliveryStatus;
  deliveryChannel?: string; // "dashboard" | "telegram" | "email" etc.
  deliveryError?: string;
  /** State */
  read: boolean;
  dismissed: boolean;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
};

export type NotificationPreferences = {
  /** Global defaults */
  defaults: {
    delivery: NotificationDeliveryStatus; // "pending" = deliver, "skipped" = suppress
    channels: string[]; // ["dashboard", "telegram"]
  };
  /** Per-business overrides */
  businessOverrides?: Record<
    string,
    {
      delivery?: NotificationDeliveryStatus;
      channels?: string[];
      suppressCategories?: NotificationCategory[];
    }
  >;
};
