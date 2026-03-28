import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// Mock dispatch injector for meeting dispatch
const mockInjector = vi.fn(async () => ({ runId: "mock-run" }));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  getDispatchInjector: vi.fn(() => mockInjector),
  setDispatchInjector: vi.fn(),
}));

// Mock channel notification
vi.mock("../../src/channels/notify.js", () => ({
  notifyChannelMessage: vi.fn(async () => {}),
  setChannelNotifier: vi.fn(),
  formatChannelMessage: vi.fn(() => ""),
  formatMeetingTranscript: vi.fn(() => ""),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createClawforceChannelTool } = await import("../../src/tools/channel-tool.js");
const { createChannel, getChannel, getChannelByName } = await import("../../src/channels/store.js");

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

describe("tools/channel-tool", () => {
  let db: DatabaseSync;
  const PROJECT = "chan-tool-test";
  let tool: ReturnType<typeof createClawforceChannelTool>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    mockInjector.mockClear();
    tool = createClawforceChannelTool({
      agentSessionKey: "mgr-session",
      projectId: PROJECT,
    });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  it("creates a channel", async () => {
    // Pre-create DB so the tool can use it
    const result = await tool.execute("call-1", {
      action: "create",
      project_id: PROJECT,
      channel_name: "engineering",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect((parsed.channel as any).name).toBe("engineering");
    expect((parsed.channel as any).type).toBe("topic");
  });

  it("creates a channel with Telegram config", async () => {
    const result = await tool.execute("call-2", {
      action: "create",
      project_id: PROJECT,
      channel_name: "tg-channel",
      telegram_group_id: "-100123",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect((parsed.channel as any).metadata?.telegramGroupId).toBe("-100123");
  });

  it("joins a channel", async () => {
    // First create a channel
    const ch = createChannel({
      projectId: PROJECT,
      name: "join-test",
      createdBy: "other-agent",
    }, db);

    const joinTool = createClawforceChannelTool({
      agentSessionKey: "worker1",
      projectId: PROJECT,
    });

    const result = await joinTool.execute("call-3", {
      action: "join",
      project_id: PROJECT,
      channel_id: ch.id,
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect((parsed.channel as any).members).toContain("worker1");
  });

  it("leaves a channel", async () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "leave-test",
      members: ["worker1"],
      createdBy: "mgr",
    }, db);

    const leaveTool = createClawforceChannelTool({
      agentSessionKey: "worker1",
      projectId: PROJECT,
    });

    const result = await leaveTool.execute("call-4", {
      action: "leave",
      project_id: PROJECT,
      channel_id: ch.id,
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect((parsed.channel as any).members).not.toContain("worker1");
  });

  it("sends a message to a channel", async () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "send-test",
      createdBy: "mgr",
    }, db);

    const result = await tool.execute("call-5", {
      action: "send",
      project_id: PROJECT,
      channel_id: ch.id,
      content: "Hello from test!",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBeDefined();
  });

  it("lists channels for the agent", async () => {
    createChannel({
      projectId: PROJECT,
      name: "ch-1",
      members: ["mgr-session"],
      createdBy: "mgr-session",
    }, db);
    createChannel({
      projectId: PROJECT,
      name: "ch-2",
      members: ["mgr-session"],
      createdBy: "mgr-session",
    }, db);

    const result = await tool.execute("call-6", {
      action: "list",
      project_id: PROJECT,
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect((parsed.channels as any[]).length).toBe(2);
  });

  it("shows channel history", async () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "history-test",
      createdBy: "mgr",
    }, db);

    const { sendChannelMessage } = await import("../../src/channels/messages.js");
    sendChannelMessage({
      fromAgent: "worker1",
      channelId: ch.id,
      projectId: PROJECT,
      content: "Test message",
    }, db);

    const result = await tool.execute("call-7", {
      action: "history",
      project_id: PROJECT,
      channel_id: ch.id,
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect(parsed.transcript).toContain("Test message");
  });

  it("returns error for unknown channel", async () => {
    const result = await tool.execute("call-8", {
      action: "history",
      project_id: PROJECT,
      channel_id: "nonexistent",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("not found");
  });

  it("resolves channel by name", async () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "named-channel",
      createdBy: "mgr",
    }, db);

    const result = await tool.execute("call-9", {
      action: "history",
      project_id: PROJECT,
      channel_name: "named-channel",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect(parsed.channelName).toBe("named-channel");
  });

  it("starts a meeting", async () => {
    const result = await tool.execute("call-10", {
      action: "start_meeting",
      project_id: PROJECT,
      channel_name: "standup",
      participants: ["worker1", "worker2"],
      prompt: "Give status",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(true);
    expect(parsed.channelName).toBe("standup");
    expect(parsed.dispatched).toBe(true);
    expect(mockInjector).toHaveBeenCalled();
  });

  it("returns error for start_meeting without participants", async () => {
    const result = await tool.execute("call-11", {
      action: "start_meeting",
      project_id: PROJECT,
      channel_name: "empty",
    });

    const parsed = parseResult(result as any);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("participants");
  });
});
