import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/channels/deliver.js", () => ({
  deliverMessage: vi.fn(() => ({ sent: true })),
}));

const {
  setMessageNotifier,
  formatMessageNotification,
  notifyMessage,
} = await import("../../src/messaging/notify.js");

import type { Message } from "../../src/types.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    fromAgent: "ceo",
    toAgent: "cfo",
    projectId: "test-proj",
    channelId: null,
    type: "direct",
    priority: "normal",
    content: "Hello from the CEO",
    status: "queued",
    parentMessageId: null,
    createdAt: Date.now(),
    deliveredAt: null,
    readAt: null,
    protocolStatus: null,
    responseDeadline: null,
    metadata: null,
    ...overrides,
  };
}

describe("messaging/notify", () => {
  afterEach(() => {
    setMessageNotifier(null);
  });

  // --- formatMessageNotification ---

  describe("formatMessageNotification", () => {
    it("formats a basic direct message", () => {
      const msg = makeMessage();
      const formatted = formatMessageNotification(msg);

      expect(formatted).toContain("*New Message*");
      expect(formatted).toContain("*From:* ceo");
      expect(formatted).toContain("*To:* cfo");
      expect(formatted).toContain("Hello from the CEO");
    });

    it("adds URGENT flag for urgent priority", () => {
      const msg = makeMessage({ priority: "urgent" });
      const formatted = formatMessageNotification(msg);

      expect(formatted).toContain("URGENT");
    });

    it("adds HIGH flag for high priority", () => {
      const msg = makeMessage({ priority: "high" });
      const formatted = formatMessageNotification(msg);

      expect(formatted).toContain("HIGH");
    });

    it("no priority flag for normal priority", () => {
      const msg = makeMessage({ priority: "normal" });
      const formatted = formatMessageNotification(msg);

      expect(formatted).not.toContain("URGENT");
      expect(formatted).not.toContain("HIGH");
    });

    it("no priority flag for low priority", () => {
      const msg = makeMessage({ priority: "low" });
      const formatted = formatMessageNotification(msg);

      expect(formatted).not.toContain("URGENT");
      expect(formatted).not.toContain("HIGH");
    });

    it("includes type tag for non-direct messages", () => {
      const msg = makeMessage({ type: "delegation" });
      const formatted = formatMessageNotification(msg);

      expect(formatted).toContain("delegation");
    });

    it("no type tag for direct messages", () => {
      const msg = makeMessage({ type: "direct" });
      const formatted = formatMessageNotification(msg);

      // Should not have a parenthetical type tag
      expect(formatted).not.toMatch(/\(direct\)/);
    });

    it("truncates content longer than 500 chars", () => {
      const longContent = "a".repeat(600);
      const msg = makeMessage({ content: longContent });
      const formatted = formatMessageNotification(msg);

      expect(formatted).toContain("...");
      // Should be truncated to 497 + "..."
      expect(formatted.length).toBeLessThan(600 + 100); // some header overhead
    });

    it("does not truncate content under 500 chars", () => {
      const shortContent = "b".repeat(100);
      const msg = makeMessage({ content: shortContent });
      const formatted = formatMessageNotification(msg);

      expect(formatted).not.toContain("...");
      expect(formatted).toContain(shortContent);
    });
  });

  // --- notifyMessage ---

  describe("notifyMessage", () => {
    it("calls custom notifier when set", async () => {
      const mockNotifier = {
        sendMessageNotification: vi.fn().mockResolvedValue({ sent: true }),
      };
      setMessageNotifier(mockNotifier);

      const msg = makeMessage();
      await notifyMessage(msg);

      expect(mockNotifier.sendMessageNotification).toHaveBeenCalledWith(msg);
    });

    it("handles notifier errors gracefully (fire-and-forget)", async () => {
      const failingNotifier = {
        sendMessageNotification: vi.fn().mockRejectedValue(new Error("network down")),
      };
      setMessageNotifier(failingNotifier);

      const msg = makeMessage();
      // Should not throw
      await expect(notifyMessage(msg)).resolves.toBeUndefined();
    });

    it("falls back to logging when no notifier is set", async () => {
      setMessageNotifier(null);

      const msg = makeMessage();
      // Should not throw — just logs
      await expect(notifyMessage(msg)).resolves.toBeUndefined();
    });

    it("clears notifier when set to null", async () => {
      const mockNotifier = {
        sendMessageNotification: vi.fn().mockResolvedValue({ sent: true }),
      };
      setMessageNotifier(mockNotifier);
      setMessageNotifier(null);

      const msg = makeMessage();
      await notifyMessage(msg);

      // Should NOT have called the previously-set notifier
      expect(mockNotifier.sendMessageNotification).not.toHaveBeenCalled();
    });
  });
});
