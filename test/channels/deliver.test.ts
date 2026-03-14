import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("channel delivery", () => {
  afterEach(async () => {
    const { clearDeliveryAdapter } = await import("../../src/channels/deliver.js");
    clearDeliveryAdapter();
  });

  it("delivers to log when no adapter set", async () => {
    const { deliverMessage } = await import("../../src/channels/deliver.js");
    const result = await deliverMessage({
      channel: "telegram",
      content: "test message",
      target: { chatId: "123" },
    });
    // Falls back to logging, doesn't throw
    expect(result.delivered).toBe(false);
    expect(result.fallback).toBe("log");
  });

  it("delivers via adapter when set", async () => {
    const { setDeliveryAdapter, deliverMessage } = await import("../../src/channels/deliver.js");

    let captured: unknown = null;
    setDeliveryAdapter({
      send: async (channel, content, target) => {
        captured = { channel, content, target };
        return { sent: true };
      },
    });

    const result = await deliverMessage({
      channel: "telegram",
      content: "test",
      target: { chatId: "456" },
    });

    expect(result.delivered).toBe(true);
    expect(captured).toEqual({
      channel: "telegram",
      content: "test",
      target: { chatId: "456" },
    });
  });

  it("returns error when adapter.send throws", async () => {
    const { setDeliveryAdapter, deliverMessage } = await import("../../src/channels/deliver.js");

    setDeliveryAdapter({
      send: async () => {
        throw new Error("network failure");
      },
    });

    const result = await deliverMessage({
      channel: "telegram",
      content: "test",
      target: { chatId: "789" },
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("network failure");
  });

  it("passes options through to adapter", async () => {
    const { setDeliveryAdapter, deliverMessage } = await import("../../src/channels/deliver.js");

    let capturedOptions: unknown = null;
    setDeliveryAdapter({
      send: async (_channel, _content, _target, options) => {
        capturedOptions = options;
        return { sent: true, messageId: "msg-1" };
      },
    });

    const buttons = [{ text: "Approve", callback_data: "approve" }];
    const result = await deliverMessage({
      channel: "telegram",
      content: "test",
      target: { chatId: "123" },
      options: { buttons, format: "markdown" },
    });

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe("msg-1");
    expect(capturedOptions).toEqual({ buttons, format: "markdown" });
  });

  it("clears adapter correctly", async () => {
    const { setDeliveryAdapter, getDeliveryAdapter, clearDeliveryAdapter } = await import("../../src/channels/deliver.js");

    setDeliveryAdapter({
      send: async () => ({ sent: true }),
    });
    expect(getDeliveryAdapter()).not.toBeNull();

    clearDeliveryAdapter();
    expect(getDeliveryAdapter()).toBeNull();
  });
});
