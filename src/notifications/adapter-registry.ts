/**
 * ClawForce — Notification Delivery Adapter Registry
 *
 * Central registry for notification delivery adapters. Adapters register
 * themselves by name; the registry routes delivery requests to the adapter
 * that supports the requested channel.
 */

import type { NotificationDeliveryAdapter } from "./delivery.js";

const adapters: Map<string, NotificationDeliveryAdapter> = new Map();

/**
 * Register a delivery adapter under a given name.
 * Replaces any existing adapter with the same name.
 */
export function registerDeliveryAdapter(name: string, adapter: NotificationDeliveryAdapter): void {
  adapters.set(name, adapter);
}

/**
 * Find the first registered adapter that supports the given channel.
 * Returns null if no adapter handles that channel.
 */
export function getDeliveryAdapterForChannel(channel: string): NotificationDeliveryAdapter | null {
  for (const adapter of adapters.values()) {
    if (adapter.supportedChannels().includes(channel)) {
      return adapter;
    }
  }
  return null;
}

/**
 * List all channels supported across all registered adapters.
 * Deduplicates channels that appear in multiple adapters.
 */
export function listAvailableChannels(): string[] {
  const seen = new Set<string>();
  for (const adapter of adapters.values()) {
    for (const channel of adapter.supportedChannels()) {
      seen.add(channel);
    }
  }
  return [...seen].sort();
}

/**
 * Remove all registered adapters. Used in tests to reset state between runs.
 */
export function clearDeliveryAdapters(): void {
  adapters.clear();
}
