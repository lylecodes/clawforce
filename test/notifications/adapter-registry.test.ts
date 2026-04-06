import { afterEach, describe, expect, it } from "vitest";
import {
  clearDeliveryAdapters,
  getDeliveryAdapterForChannel,
  listAvailableChannels,
  registerDeliveryAdapter,
} from "../../src/notifications/adapter-registry.js";
import type { NotificationDeliveryAdapter } from "../../src/notifications/delivery.js";

function makeAdapter(channels: string[]): NotificationDeliveryAdapter {
  return {
    supportedChannels: () => channels,
    deliver: async (_notification, target) => ({
      ok: true,
      channel: target.channel,
      deliveredAt: Date.now(),
    }),
  };
}

describe("adapter-registry", () => {
  afterEach(() => {
    clearDeliveryAdapters();
  });

  it("registers and retrieves an adapter by channel", () => {
    const adapter = makeAdapter(["telegram", "discord"]);
    registerDeliveryAdapter("openclaw", adapter);

    expect(getDeliveryAdapterForChannel("telegram")).toBe(adapter);
    expect(getDeliveryAdapterForChannel("discord")).toBe(adapter);
  });

  it("returns null for an unknown channel", () => {
    const adapter = makeAdapter(["webhook"]);
    registerDeliveryAdapter("webhook", adapter);

    expect(getDeliveryAdapterForChannel("telegram")).toBeNull();
    expect(getDeliveryAdapterForChannel("email")).toBeNull();
  });

  it("returns null when no adapters are registered", () => {
    expect(getDeliveryAdapterForChannel("telegram")).toBeNull();
  });

  it("lists all available channels across adapters, deduplicated and sorted", () => {
    registerDeliveryAdapter("openclaw", makeAdapter(["telegram", "slack"]));
    registerDeliveryAdapter("webhook", makeAdapter(["webhook", "slack"]));

    const channels = listAvailableChannels();
    expect(channels).toEqual(["slack", "telegram", "webhook"]);
  });

  it("returns empty channel list when no adapters registered", () => {
    expect(listAvailableChannels()).toEqual([]);
  });

  it("replaces an existing adapter registered under the same name", () => {
    const adapterA = makeAdapter(["telegram"]);
    const adapterB = makeAdapter(["discord"]);

    registerDeliveryAdapter("my-adapter", adapterA);
    registerDeliveryAdapter("my-adapter", adapterB);

    // adapterB replaces adapterA; telegram no longer available
    expect(getDeliveryAdapterForChannel("telegram")).toBeNull();
    expect(getDeliveryAdapterForChannel("discord")).toBe(adapterB);
  });

  it("clear removes all adapters", () => {
    registerDeliveryAdapter("a", makeAdapter(["telegram"]));
    registerDeliveryAdapter("b", makeAdapter(["webhook"]));

    clearDeliveryAdapters();

    expect(getDeliveryAdapterForChannel("telegram")).toBeNull();
    expect(getDeliveryAdapterForChannel("webhook")).toBeNull();
    expect(listAvailableChannels()).toEqual([]);
  });
});
