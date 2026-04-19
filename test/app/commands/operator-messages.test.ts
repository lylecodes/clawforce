import { beforeEach, describe, expect, it, vi } from "vitest";

let assistantSettings: { enabled: boolean; agentId?: string } = { enabled: true };
let assistantTarget: { agentId: string; title?: string; explicit: boolean; source: "explicit" | "configured" | "lead" } | null = {
  agentId: "lead-root",
  title: "Root Lead",
  explicit: false,
  source: "lead",
};

vi.mock("../../../src/dashboard/sse.js", () => ({
  emitSSE: vi.fn(),
}));

vi.mock("../../../src/events/store.js", () => ({
  ingestEvent: vi.fn(),
}));

vi.mock("../../../src/messaging/store.js", () => ({
  createMessage: vi.fn((params: Record<string, unknown>) => ({
    id: "msg-1",
    fromAgent: "user",
    toAgent: params.toAgent,
    projectId: params.projectId,
    channelId: null,
    type: "direct",
    priority: params.priority ?? "normal",
    content: params.content,
    status: "queued",
    parentMessageId: null,
    createdAt: 123,
    deliveredAt: null,
    readAt: null,
    protocolStatus: null,
    responseDeadline: null,
    metadata: params.metadata ?? null,
  })),
  markDelivered: vi.fn(),
}));

vi.mock("../../../src/app/queries/dashboard-assistant.js", () => ({
  getDashboardAssistantSettings: vi.fn(() => assistantSettings),
  parseAssistantDirective: vi.fn((content: string) => ({ content })),
  resolveAssistantFallbackTarget: vi.fn(() => assistantTarget),
  renderAssistantStoredMessage: vi.fn((target: { agentId: string }) => `stored:${target.agentId}`),
  renderAssistantLiveDeliveryMessage: vi.fn((requestedAgentId: string, deliveredAgentId: string) => `live:${requestedAgentId}:${deliveredAgentId}`),
  renderAssistantUnavailableMessage: vi.fn(() => "assistant unavailable"),
}));

const { emitSSE } = await import("../../../src/dashboard/sse.js");
const { ingestEvent } = await import("../../../src/events/store.js");
const { createMessage } = await import("../../../src/messaging/store.js");
const { markDelivered } = await import("../../../src/messaging/store.js");
const {
  runDeliverOperatorMessageCommand,
  runSendDirectMessageCommand,
} = await import("../../../src/app/commands/operator-messages.js");

describe("operator message commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assistantSettings = { enabled: true };
    assistantTarget = {
      agentId: "lead-root",
      title: "Root Lead",
      explicit: false,
      source: "lead",
    };
  });

  it("persists a direct user message and emits side effects", () => {
    const result = runSendDirectMessageCommand("test-project", {
      toAgent: "worker-1",
      content: "check task t1",
      priority: "urgent",
      proposalId: "p-1",
      taskId: "task-1",
      entityId: "entity-9",
      issueId: "issue-4",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 201,
      message: expect.objectContaining({
        toAgent: "worker-1",
        content: "check task t1",
      }),
    }));
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      toAgent: "worker-1",
      content: "check task t1",
      priority: "urgent",
      metadata: {
        proposalId: "p-1",
        taskId: "task-1",
        entityId: "entity-9",
        issueId: "issue-4",
      },
    }));
    expect(emitSSE).toHaveBeenCalledWith("test-project", "message:new", {
      toAgent: "worker-1",
      messageId: "msg-1",
      fromAgent: "user",
    });
    expect(ingestEvent).toHaveBeenCalledWith("test-project", "user_message", "internal", expect.objectContaining({
      messageId: "msg-1",
      toAgent: "worker-1",
      content: "check task t1",
    }), "user-msg:msg-1");
  });

  it("returns validation errors for missing direct-message fields", () => {
    expect(runSendDirectMessageCommand("test-project", {
      content: "hello",
    })).toEqual({ ok: false, status: 400, error: "to is required" });
    expect(runSendDirectMessageCommand("test-project", {
      toAgent: "worker-1",
      content: "   ",
    })).toEqual({ ok: false, status: 400, error: "content is required" });
  });

  it("delivers operator messages live when injection succeeds", async () => {
    const injectAgentMessage = vi.fn(async () => ({}));

    const result = await runDeliverOperatorMessageCommand(
      "test-project",
      "worker-1",
      { content: "hello", proposalId: "prop-live" },
      injectAgentMessage,
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      delivery: "live",
      acknowledgement: "live:worker-1:worker-1",
      message: expect.objectContaining({
        id: "msg-1",
        toAgent: "worker-1",
        content: "hello",
        status: "delivered",
      }),
    });
    expect(injectAgentMessage).toHaveBeenCalledWith({
      sessionKey: "agent:worker-1:main",
      message: "hello",
    });
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      toAgent: "worker-1",
      content: "hello",
      metadata: { proposalId: "prop-live" },
    }));
    expect(markDelivered).toHaveBeenCalledWith("msg-1", expect.anything());
  });

  it("falls back to stored assistant delivery when no live session is wired", async () => {
    const result = await runDeliverOperatorMessageCommand(
      "test-project",
      "clawforce-assistant",
      { content: "please review" },
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 200,
      delivery: "stored",
      acknowledgement: "stored:lead-root",
      message: expect.objectContaining({
        toAgent: "lead-root",
        content: "please review",
      }),
    }));
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      toAgent: "lead-root",
      content: "please review",
    }));
  });

  it("falls back to stored direct delivery after live injection failure", async () => {
    const injectAgentMessage = vi.fn(async () => {
      throw new Error("session offline");
    });

    const result = await runDeliverOperatorMessageCommand(
      "test-project",
      "worker-1",
      { content: "check task t1", taskId: "task-1", entityId: "entity-9" },
      injectAgentMessage,
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 200,
      delivery: "stored",
      acknowledgement: 'Live delivery failed, but your message was stored for "worker-1". They will see it in their next briefing.',
      message: expect.objectContaining({
        toAgent: "worker-1",
      }),
    }));
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      toAgent: "worker-1",
      content: "check task t1",
      metadata: {
        taskId: "task-1",
        entityId: "entity-9",
      },
    }));
  });

  it("returns assistant-unavailable when the assistant is disabled and no explicit target was requested", async () => {
    assistantSettings = { enabled: false };
    assistantTarget = null;

    const result = await runDeliverOperatorMessageCommand(
      "test-project",
      "clawforce-assistant",
      { content: "help me" },
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      delivery: "unavailable",
      acknowledgement: "assistant unavailable",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });
});
