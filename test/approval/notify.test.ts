import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const {
  setApprovalNotifier,
  getApprovalNotifier,
  formatTelegramMessage,
  formatResolutionMessage,
  buildApprovalButtons,
} = await import("../../src/approval/notify.js");

describe("approval/notify", () => {
  describe("module-level setter", () => {
    it("returns fallback notifier when none set", () => {
      setApprovalNotifier(null);
      // Falls back to unified delivery adapter instead of null
      const n = getApprovalNotifier();
      expect(n).not.toBeNull();
      expect(n!.sendProposalNotification).toBeDefined();
    });

    it("stores and retrieves notifier", () => {
      const notifier = {
        sendProposalNotification: vi.fn(),
        editProposalMessage: vi.fn(),
      };
      setApprovalNotifier(notifier);
      expect(getApprovalNotifier()).toBe(notifier);
      setApprovalNotifier(null); // cleanup
    });
  });

  describe("formatTelegramMessage", () => {
    it("formats basic proposal", () => {
      const msg = formatTelegramMessage({
        proposalId: "p-1",
        projectId: "proj",
        title: "Deploy to production",
        proposedBy: "agent:worker",
      });
      expect(msg).toContain("*Proposal Pending*");
      expect(msg).toContain("Deploy to production");
      expect(msg).toContain("agent:worker");
    });

    it("includes risk tier", () => {
      const msg = formatTelegramMessage({
        proposalId: "p-1",
        projectId: "proj",
        title: "Risky action",
        proposedBy: "agent:worker",
        riskTier: "high",
      });
      expect(msg).toContain("[high]");
    });

    it("includes description when present", () => {
      const msg = formatTelegramMessage({
        proposalId: "p-1",
        projectId: "proj",
        title: "Action",
        proposedBy: "agent:worker",
        description: "This is a detailed description",
      });
      expect(msg).toContain("This is a detailed description");
    });

    it("includes tool context when present", () => {
      const msg = formatTelegramMessage({
        proposalId: "p-1",
        projectId: "proj",
        title: "Tool gate",
        proposedBy: "agent:worker",
        toolContext: {
          toolName: "mcp:gmail:send",
          category: "email:send",
        },
      });
      expect(msg).toContain("mcp:gmail:send");
      expect(msg).toContain("email:send");
    });
  });

  describe("formatResolutionMessage", () => {
    it("formats approved message", () => {
      const msg = formatResolutionMessage("approved", "Deploy to prod", "agent:worker", "Looks good");
      expect(msg).toContain("*Proposal APPROVED*");
      expect(msg).toContain("Deploy to prod");
      expect(msg).toContain("Looks good");
    });

    it("formats rejected message", () => {
      const msg = formatResolutionMessage("rejected", "Deploy to prod", "agent:worker");
      expect(msg).toContain("*Proposal REJECTED*");
    });
  });

  describe("buildApprovalButtons", () => {
    it("builds approve/reject inline buttons", () => {
      const buttons = buildApprovalButtons("proj-1", "proposal-1");
      expect(buttons).toHaveLength(1); // one row
      expect(buttons[0]).toHaveLength(2); // two buttons
      expect(buttons[0]![0]!.text).toBe("Approve");
      expect(buttons[0]![0]!.callback_data).toBe("cf:approve:proj-1:proposal-1");
      expect(buttons[0]![1]!.text).toBe("Reject");
      expect(buttons[0]![1]!.callback_data).toBe("cf:reject:proj-1:proposal-1");
    });
  });
});
