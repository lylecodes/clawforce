import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

// Mock cron service
const mockInjector = vi.fn(async () => ({ runId: "mock-run" }));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  getDispatchInjector: vi.fn(() => mockInjector),
  setDispatchInjector: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createChannel, getChannel } = await import("../../src/channels/store.js");
const { sendChannelMessage } = await import("../../src/channels/messages.js");
const { startMeeting, advanceMeetingTurn, concludeMeeting, getMeetingStatus } = await import("../../src/channels/meeting.js");

describe("channels/meeting", () => {
  let db: DatabaseSync;
  const PROJECT = "meeting-test";

  beforeEach(() => {
    db = getMemoryDb();
    mockInjector.mockClear();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("starts a meeting and creates a channel", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "daily-standup",
      participants: ["worker1", "worker2", "worker3"],
      prompt: "Give your status update",
      initiator: "mgr",
    }, db);

    expect(result.channel).toBeDefined();
    expect(result.channel.name).toBe("daily-standup");
    expect(result.channel.type).toBe("meeting");
    expect(result.channel.status).toBe("active");
    expect(result.dispatched).toBe(true);
    expect(mockInjector).toHaveBeenCalledTimes(1);
  });

  it("sets meeting config in channel metadata", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "standup",
      participants: ["worker1", "worker2"],
      prompt: "Status?",
      initiator: "mgr",
    }, db);

    const ch = getChannel(PROJECT, result.channel.id, db);
    const config = ch!.metadata?.meetingConfig as { participants: string[]; currentTurn: number; prompt: string };
    expect(config.participants).toEqual(["worker1", "worker2"]);
    expect(config.currentTurn).toBe(0);
    expect(config.prompt).toBe("Status?");
  });

  it("throws when no participants provided", () => {
    expect(() => {
      startMeeting({
        projectId: PROJECT,
        channelName: "empty-meeting",
        participants: [],
        initiator: "mgr",
      }, db);
    }).toThrow("at least one participant");
  });

  it("reuses existing channel by name", () => {
    createChannel({
      projectId: PROJECT,
      name: "recurring",
      type: "meeting",
      createdBy: "mgr",
    }, db);

    const result = startMeeting({
      projectId: PROJECT,
      channelName: "recurring",
      participants: ["worker1"],
      initiator: "mgr",
    }, db);

    expect(result.channel.name).toBe("recurring");
  });

  it("throws when starting meeting on concluded channel", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "done-ch",
      type: "meeting",
      createdBy: "mgr",
    }, db);

    concludeMeeting(PROJECT, ch.id, "mgr", db);

    expect(() => {
      startMeeting({
        projectId: PROJECT,
        channelId: ch.id,
        participants: ["worker1"],
        initiator: "mgr",
      }, db);
    }).toThrow("concluded");
  });

  it("advances meeting turn", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "advance-test",
      participants: ["worker1", "worker2", "worker3"],
      initiator: "mgr",
    }, db);

    mockInjector.mockClear();

    const turn1 = advanceMeetingTurn(PROJECT, result.channel.id, db);
    expect(turn1.nextAgent).toBe("worker2");
    expect(turn1.turnIndex).toBe(1);
    expect(turn1.done).toBe(false);
    expect(mockInjector).toHaveBeenCalledTimes(1);

    mockInjector.mockClear();

    const turn2 = advanceMeetingTurn(PROJECT, result.channel.id, db);
    expect(turn2.nextAgent).toBe("worker3");
    expect(turn2.turnIndex).toBe(2);
    expect(turn2.done).toBe(false);

    const turn3 = advanceMeetingTurn(PROJECT, result.channel.id, db);
    expect(turn3.done).toBe(true);
    expect(turn3.nextAgent).toBeNull();
  });

  it("concludes a meeting", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "conclude-test",
      participants: ["worker1"],
      initiator: "mgr",
    }, db);

    const concluded = concludeMeeting(PROJECT, result.channel.id, "mgr", db);
    expect(concluded.status).toBe("concluded");
    expect(concluded.concludedAt).toBeDefined();
  });

  it("returns meeting status with transcript", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "status-test",
      participants: ["worker1", "worker2"],
      prompt: "Daily status",
      initiator: "mgr",
    }, db);

    // Add a message
    sendChannelMessage({
      fromAgent: "worker1",
      channelId: result.channel.id,
      projectId: PROJECT,
      content: "All tasks done.",
    }, db);

    const status = getMeetingStatus(PROJECT, result.channel.id, db);
    expect(status).toBeDefined();
    expect(status!.currentTurn).toBe(0);
    expect(status!.participants).toEqual(["worker1", "worker2"]);
    expect(status!.transcript).toContain("worker1");
    expect(status!.transcript).toContain("All tasks done.");
    expect(status!.done).toBe(false);
  });

  it("returns null for non-existent channel", () => {
    expect(getMeetingStatus(PROJECT, "nonexistent", db)).toBeNull();
  });

  it("reports done=true for concluded channel", () => {
    const result = startMeeting({
      projectId: PROJECT,
      channelName: "done-status-test",
      participants: ["worker1"],
      initiator: "mgr",
    }, db);

    concludeMeeting(PROJECT, result.channel.id, "mgr", db);
    const status = getMeetingStatus(PROJECT, result.channel.id, db);
    expect(status!.done).toBe(true);
  });
});
