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

const { getMemoryDb } = await import("../../src/db.js");
const {
  createChannel,
  getChannel,
  getChannelByName,
  listChannels,
  addMember,
  removeMember,
  updateChannelMetadata,
  concludeChannel,
  archiveChannel,
  getChannelMessages,
} = await import("../../src/channels/store.js");

describe("channels/store", () => {
  let db: DatabaseSync;
  const PROJECT = "chan-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a channel and retrieves it by ID", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "engineering",
      createdBy: "mgr",
    }, db);

    expect(ch.id).toBeDefined();
    expect(ch.name).toBe("engineering");
    expect(ch.type).toBe("topic");
    expect(ch.status).toBe("active");
    expect(ch.createdBy).toBe("mgr");
    expect(ch.members).toContain("mgr");

    const fetched = getChannel(PROJECT, ch.id, db);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("engineering");
  });

  it("retrieves a channel by name", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "standup",
      type: "meeting",
      createdBy: "mgr",
    }, db);

    const fetched = getChannelByName(PROJECT, "standup", db);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(ch.id);
    expect(fetched!.type).toBe("meeting");
  });

  it("returns null for non-existent channel", () => {
    expect(getChannel(PROJECT, "nonexistent", db)).toBeNull();
    expect(getChannelByName(PROJECT, "nonexistent", db)).toBeNull();
  });

  it("prevents duplicate channel names (unique constraint)", () => {
    createChannel({ projectId: PROJECT, name: "engineering", createdBy: "mgr" }, db);

    expect(() => {
      createChannel({ projectId: PROJECT, name: "engineering", createdBy: "mgr" }, db);
    }).toThrow();
  });

  it("auto-adds creator to members", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "team",
      members: ["worker1", "worker2"],
      createdBy: "mgr",
    }, db);

    expect(ch.members).toContain("mgr");
    expect(ch.members).toContain("worker1");
    expect(ch.members).toContain("worker2");
  });

  it("does not duplicate creator in members if already present", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "team",
      members: ["mgr", "worker1"],
      createdBy: "mgr",
    }, db);

    expect(ch.members.filter(m => m === "mgr")).toHaveLength(1);
  });

  it("lists channels with filters", () => {
    createChannel({ projectId: PROJECT, name: "eng", type: "topic", createdBy: "mgr" }, db);
    createChannel({ projectId: PROJECT, name: "standup", type: "meeting", createdBy: "mgr" }, db);
    createChannel({ projectId: PROJECT, name: "design", type: "topic", createdBy: "designer" }, db);

    const all = listChannels(PROJECT, {}, db);
    expect(all).toHaveLength(3);

    const meetings = listChannels(PROJECT, { type: "meeting" }, db);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]!.name).toBe("standup");

    const topics = listChannels(PROJECT, { type: "topic" }, db);
    expect(topics).toHaveLength(2);
  });

  it("filters channels by member agent", () => {
    createChannel({ projectId: PROJECT, name: "eng", members: ["worker1"], createdBy: "mgr" }, db);
    createChannel({ projectId: PROJECT, name: "design", members: ["designer"], createdBy: "mgr" }, db);

    const worker1Channels = listChannels(PROJECT, { memberAgent: "worker1" }, db);
    expect(worker1Channels).toHaveLength(1);
    expect(worker1Channels[0]!.name).toBe("eng");

    // mgr is in both (auto-added as creator)
    const mgrChannels = listChannels(PROJECT, { memberAgent: "mgr" }, db);
    expect(mgrChannels).toHaveLength(2);
  });

  it("adds and removes members", () => {
    const ch = createChannel({ projectId: PROJECT, name: "team", createdBy: "mgr" }, db);
    expect(ch.members).toEqual(["mgr"]);

    const updated = addMember(PROJECT, ch.id, "worker1", db);
    expect(updated.members).toContain("worker1");

    // Adding same member again is idempotent
    const again = addMember(PROJECT, ch.id, "worker1", db);
    expect(again.members.filter(m => m === "worker1")).toHaveLength(1);

    const removed = removeMember(PROJECT, ch.id, "worker1", db);
    expect(removed.members).not.toContain("worker1");
  });

  it("concludes and archives channels", () => {
    const ch = createChannel({ projectId: PROJECT, name: "sprint-1", createdBy: "mgr" }, db);

    const concluded = concludeChannel(PROJECT, ch.id, db);
    expect(concluded.status).toBe("concluded");
    expect(concluded.concludedAt).toBeDefined();

    const archived = archiveChannel(PROJECT, ch.id, db);
    expect(archived.status).toBe("archived");
  });

  it("filters channels by status", () => {
    const ch1 = createChannel({ projectId: PROJECT, name: "active-ch", createdBy: "mgr" }, db);
    const ch2 = createChannel({ projectId: PROJECT, name: "done-ch", createdBy: "mgr" }, db);
    concludeChannel(PROJECT, ch2.id, db);

    const active = listChannels(PROJECT, { status: "active" }, db);
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe("active-ch");

    const concluded = listChannels(PROJECT, { status: "concluded" }, db);
    expect(concluded).toHaveLength(1);
    expect(concluded[0]!.name).toBe("done-ch");
  });

  it("stores and retrieves metadata", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "tg-channel",
      createdBy: "mgr",
      metadata: { telegramGroupId: "-100123" },
    }, db);

    expect(ch.metadata?.telegramGroupId).toBe("-100123");

    const fetched = getChannel(PROJECT, ch.id, db);
    expect(fetched!.metadata?.telegramGroupId).toBe("-100123");
  });

  it("updates channel metadata", () => {
    const ch = createChannel({ projectId: PROJECT, name: "meta-test", createdBy: "mgr" }, db);

    updateChannelMetadata(PROJECT, ch.id, { custom: "value" }, db);
    const fetched = getChannel(PROJECT, ch.id, db);
    expect(fetched!.metadata?.custom).toBe("value");
  });

  it("retrieves channel messages from messages table", async () => {
    const { createMessage } = await import("../../src/messaging/store.js");
    const ch = createChannel({ projectId: PROJECT, name: "msg-test", createdBy: "mgr" }, db);

    // Insert messages with channel_id
    createMessage({
      fromAgent: "worker1",
      toAgent: `channel:${ch.name}`,
      projectId: PROJECT,
      channelId: ch.id,
      content: "Hello team",
    }, db);

    createMessage({
      fromAgent: "worker2",
      toAgent: `channel:${ch.name}`,
      projectId: PROJECT,
      channelId: ch.id,
      content: "Hi there",
    }, db);

    const messages = getChannelMessages(PROJECT, ch.id, {}, db);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("Hello team");
    expect(messages[1]!.content).toBe("Hi there");
  });
});
