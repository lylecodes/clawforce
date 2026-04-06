import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhookDeliveryAdapter } from "../../src/notifications/webhook-adapter.js";
import type { NotificationRecord, DeliveryTarget } from "../../src/notifications/delivery.js";

function makeNotification(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "notif-001",
    category: "budget",
    severity: "warning",
    title: "Budget threshold reached",
    body: "Agent has consumed 80% of daily budget",
    projectId: "proj-123",
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe("webhook-adapter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("reports webhook as supported channel", () => {
    const adapter = createWebhookDeliveryAdapter();
    expect(adapter.supportedChannels()).toEqual(["webhook"]);
  });

  it("returns error when no webhook URL is configured", async () => {
    const adapter = createWebhookDeliveryAdapter();
    const target: DeliveryTarget = { channel: "webhook" };

    const result = await adapter.deliver(makeNotification(), target);

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("webhook");
    expect(result.error).toBe("No webhook URL configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns error when URL is missing from config", async () => {
    const adapter = createWebhookDeliveryAdapter();
    const target: DeliveryTarget = { channel: "webhook", config: { timeout: 5000 } };

    const result = await adapter.deliver(makeNotification(), target);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No webhook URL configured");
  });

  it("delivers notification successfully to webhook URL", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true } as Response);

    const adapter = createWebhookDeliveryAdapter();
    const notification = makeNotification();
    const target: DeliveryTarget = {
      channel: "webhook",
      config: { url: "https://hooks.example.com/notify" },
    };

    const result = await adapter.deliver(notification, target);

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("webhook");
    expect(result.deliveredAt).toBeDefined();
    expect(typeof result.deliveredAt).toBe("number");
  });

  it("POSTs JSON with correct notification fields", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve({ ok: true });
    });

    const adapter = createWebhookDeliveryAdapter();
    const notification = makeNotification({
      id: "notif-xyz",
      severity: "critical",
      title: "Critical alert",
      body: "Something went wrong",
    });

    await adapter.deliver(notification, {
      channel: "webhook",
      config: { url: "https://example.com/hook" },
    });

    expect(capturedUrl).toBe("https://example.com/hook");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.id).toBe("notif-xyz");
    expect(body.severity).toBe("critical");
    expect(body.title).toBe("Critical alert");
    expect(body.body).toBe("Something went wrong");
    expect(body.projectId).toBe("proj-123");
    expect(body.createdAt).toBe(1700000000000);
    expect(body.category).toBe("budget");
  });

  it("returns error on HTTP error status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const adapter = createWebhookDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), {
      channel: "webhook",
      config: { url: "https://example.com/hook" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 503");
  });

  it("returns error on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const adapter = createWebhookDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), {
      channel: "webhook",
      config: { url: "https://example.com/hook" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("handles non-Error thrown objects", async () => {
    fetchMock.mockRejectedValueOnce("string error");

    const adapter = createWebhookDeliveryAdapter();
    const result = await adapter.deliver(makeNotification(), {
      channel: "webhook",
      config: { url: "https://example.com/hook" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("string error");
  });
});
