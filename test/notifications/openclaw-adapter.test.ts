import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

import { createOpenClawDeliveryAdapter } from "../../src/notifications/openclaw-adapter.js";
import type { NotificationRecord } from "../../src/notifications/delivery.js";

function makeNotification(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "notif-001",
    category: "slo",
    severity: "info",
    title: "SLO check passed",
    body: "All systems nominal",
    projectId: "proj-abc",
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe("openclaw-adapter", () => {
  afterEach(async () => {
    const { clearDeliveryAdapter } = await import("../../src/channels/deliver.js");
    clearDeliveryAdapter();
  });

  it("returns empty channels when no OpenClaw delivery adapter is available", async () => {
    const adapter = createOpenClawDeliveryAdapter();
    expect(adapter.supportedChannels()).toEqual([]);
  });

  it("returns supported channels when OpenClaw adapter is available", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");
    setDeliveryAdapter({
      send: async () => ({ sent: true }),
    });

    const adapter = createOpenClawDeliveryAdapter();
    const channels = adapter.supportedChannels();

    expect(channels).toContain("telegram");
    expect(channels).toContain("discord");
    expect(channels).toContain("slack");
  });

  it("returns failure when no OpenClaw adapter is registered", async () => {
    const adapter = createOpenClawDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), { channel: "telegram" });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.error).toBe("No OpenClaw delivery adapter available");
  });

  it("delivers notification via OpenClaw when adapter is available", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    let captured: { channel: string; content: string; target: Record<string, unknown> } | null = null;
    setDeliveryAdapter({
      send: async (channel, content, target) => {
        captured = { channel, content, target };
        return { sent: true, messageId: "msg-99" };
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    const notification = makeNotification({ severity: "warning", title: "Budget low", body: "Under 20%" });

    const result = await adapter.deliver(notification, {
      channel: "telegram",
      config: { chatId: "chat-123" },
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(result.deliveredAt).toBeDefined();
    expect(captured?.channel).toBe("telegram");
    expect(captured?.content).toContain("Budget low");
    expect(captured?.content).toContain("🟡");
    expect(captured?.target).toEqual({ chatId: "chat-123" });
  });

  it("includes 🔴 emoji for critical notifications", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    let capturedContent = "";
    setDeliveryAdapter({
      send: async (_channel, content) => {
        capturedContent = content;
        return { sent: true };
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    await adapter.deliver(makeNotification({ severity: "critical", title: "CRITICAL" }), {
      channel: "telegram",
    });

    expect(capturedContent).toContain("🔴");
    expect(capturedContent).toContain("CRITICAL");
  });

  it("includes ℹ️ emoji for info notifications", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    let capturedContent = "";
    setDeliveryAdapter({
      send: async (_channel, content) => {
        capturedContent = content;
        return { sent: true };
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    await adapter.deliver(makeNotification({ severity: "info", title: "Info notice" }), {
      channel: "discord",
    });

    expect(capturedContent).toContain("ℹ️");
  });

  it("returns failure when OpenClaw adapter send returns delivered=false", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    setDeliveryAdapter({
      send: async () => ({ sent: false, error: "channel unavailable" }),
    });

    const adapter = createOpenClawDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), { channel: "telegram" });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.error).toBeDefined();
  });

  it("handles delivery failure gracefully when adapter.send throws", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    setDeliveryAdapter({
      send: async () => {
        throw new Error("network timeout");
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), { channel: "slack" });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("slack");
    expect(result.error).toBe("network timeout");
  });

  it("handles non-Error thrown objects gracefully", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    setDeliveryAdapter({
      send: async () => {
        throw "raw string error"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), { channel: "telegram" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("raw string error");
  });

  it("uses empty object as target when no config provided", async () => {
    const { setDeliveryAdapter } = await import("../../src/channels/deliver.js");

    let capturedTarget: Record<string, unknown> | null = null;
    setDeliveryAdapter({
      send: async (_channel, _content, target) => {
        capturedTarget = target;
        return { sent: true };
      },
    });

    const adapter = createOpenClawDeliveryAdapter();
    await adapter.deliver(makeNotification(), { channel: "telegram" });

    expect(capturedTarget).toEqual({});
  });
});
