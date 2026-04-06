/**
 * ClawForce — Notification Delivery Adapter Interface
 *
 * Defines the contract for delivering notifications to external channels.
 * Adapters bridge ClawForce notifications to specific delivery systems
 * (OpenClaw channels, webhooks, email, etc.) without coupling to any one.
 */

export type { NotificationRecord } from "./types.js";

export type DeliveryTarget = {
  channel: string;
  config?: Record<string, unknown>;
};

export type DeliveryResult = {
  ok: boolean;
  channel: string;
  error?: string;
  deliveredAt?: number;
};

export type NotificationDeliveryAdapter = {
  deliver(notification: import("./types.js").NotificationRecord, target: DeliveryTarget): Promise<DeliveryResult>;
  supportedChannels(): string[];
};
