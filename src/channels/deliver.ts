/**
 * Clawforce — Unified Channel Delivery
 *
 * Thin adapter for delivering messages to any channel via OpenClaw's runtime.channel.* APIs.
 * Replaces the three setter-pattern notifiers (approval, messaging, channel).
 */

import { safeLog } from "../diagnostics.js";
import {
  clearDeliveryAdapterPort,
  getDeliveryAdapterPort,
  setDeliveryAdapterPort,
} from "../runtime/integrations.js";

export type DeliveryAdapter = {
  send(
    channel: string,
    content: string,
    target: Record<string, unknown>,
    options?: { buttons?: unknown[]; format?: string },
  ): Promise<{ sent: boolean; messageId?: string; error?: string }>;

  edit?(
    channel: string,
    messageId: string,
    content: string,
    target: Record<string, unknown>,
  ): Promise<{ sent: boolean; error?: string }>;
};

export type DeliveryRequest = {
  channel: string;
  content: string;
  target: Record<string, unknown>;
  options?: { buttons?: unknown[]; format?: string };
};

export type DeliveryResult = {
  delivered: boolean;
  messageId?: string;
  error?: string;
  fallback?: string;
};

export function setDeliveryAdapter(a: DeliveryAdapter | null): void {
  setDeliveryAdapterPort(a);
}

export function getDeliveryAdapter(): DeliveryAdapter | null {
  return getDeliveryAdapterPort();
}

export function clearDeliveryAdapter(): void {
  clearDeliveryAdapterPort();
}

export async function deliverMessage(req: DeliveryRequest): Promise<DeliveryResult> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    safeLog("deliver", `No delivery adapter set — logging message for channel "${req.channel}": ${req.content.slice(0, 100)}`);
    return { delivered: false, fallback: "log" };
  }

  try {
    const result = await adapter.send(req.channel, req.content, req.target, req.options);
    return {
      delivered: result.sent,
      messageId: result.messageId,
      error: result.error,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    safeLog("deliver", `Delivery failed for channel "${req.channel}": ${error}`);
    return { delivered: false, error };
  }
}
