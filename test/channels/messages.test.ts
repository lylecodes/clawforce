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
const { createChannel } = await import("../../src/channels/store.js");
const { sendChannelMessage, buildChannelTranscript } = await import("../../src/channels/messages.js");

describe("channels/messages", () => {
  let db: DatabaseSync;
  const PROJECT = "msg-ch-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("sends a message to a channel", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "general",
      createdBy: "mgr",
    }, db);

    const msg = sendChannelMessage({
      fromAgent: "worker1",
      channelId: ch.id,
      projectId: PROJECT,
      content: "Hello team!",
    }, db);

    expect(msg.id).toBeDefined();
    expect(msg.fromAgent).toBe("worker1");
    expect(msg.toAgent).toBe("channel:general");
    expect(msg.content).toBe("Hello team!");
    expect(msg.channelId).toBe(ch.id);
  });

  it("sets type to meeting for meeting channels", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "standup",
      type: "meeting",
      createdBy: "mgr",
    }, db);

    const msg = sendChannelMessage({
      fromAgent: "worker1",
      channelId: ch.id,
      projectId: PROJECT,
      content: "Status update",
    }, db);

    expect(msg.type).toBe("meeting");
  });

  it("builds a transcript from channel messages", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "eng",
      createdBy: "mgr",
    }, db);

    sendChannelMessage({ fromAgent: "alice", channelId: ch.id, projectId: PROJECT, content: "Working on feature X" }, db);
    sendChannelMessage({ fromAgent: "bob", channelId: ch.id, projectId: PROJECT, content: "Need a review" }, db);

    const transcript = buildChannelTranscript(PROJECT, ch.id, {}, db);
    expect(transcript).toContain("alice");
    expect(transcript).toContain("bob");
    expect(transcript).toContain("Working on feature X");
    expect(transcript).toContain("Need a review");
  });

  it("returns empty string when no messages", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "empty",
      createdBy: "mgr",
    }, db);

    const transcript = buildChannelTranscript(PROJECT, ch.id, {}, db);
    expect(transcript).toBe("");
  });

  it("truncates transcript at maxChars limit", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "big-chat",
      createdBy: "mgr",
    }, db);

    // Send enough messages to exceed a small maxChars
    for (let i = 0; i < 20; i++) {
      sendChannelMessage({
        fromAgent: `agent-${i}`,
        channelId: ch.id,
        projectId: PROJECT,
        content: `This is message number ${i} with some extra content to pad the length`,
      }, db);
    }

    const transcript = buildChannelTranscript(PROJECT, ch.id, { maxChars: 200 }, db);
    expect(transcript.length).toBeLessThanOrEqual(500); // some overhead for truncation notice
    expect(transcript).toContain("truncated");
  });

  it("preserves chronological order", () => {
    const ch = createChannel({
      projectId: PROJECT,
      name: "ordered",
      createdBy: "mgr",
    }, db);

    sendChannelMessage({ fromAgent: "first", channelId: ch.id, projectId: PROJECT, content: "msg-1" }, db);
    sendChannelMessage({ fromAgent: "second", channelId: ch.id, projectId: PROJECT, content: "msg-2" }, db);
    sendChannelMessage({ fromAgent: "third", channelId: ch.id, projectId: PROJECT, content: "msg-3" }, db);

    const transcript = buildChannelTranscript(PROJECT, ch.id, {}, db);
    const idx1 = transcript.indexOf("msg-1");
    const idx2 = transcript.indexOf("msg-2");
    const idx3 = transcript.indexOf("msg-3");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });
});
