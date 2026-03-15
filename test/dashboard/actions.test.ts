import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock core functions
vi.mock("../../src/approval/resolve.js", () => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

vi.mock("../../src/tasks/ops.js", () => ({
  createTask: vi.fn(),
  reassignTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
  enableAgent: vi.fn(),
}));

vi.mock("../../src/channels/meeting.js", () => ({
  startMeeting: vi.fn(),
  concludeMeeting: vi.fn(),
}));

vi.mock("../../src/channels/messages.js", () => ({
  sendChannelMessage: vi.fn(),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  emitSSE: vi.fn(),
}));

const { handleAction } = await import("../../src/dashboard/actions.js");
const { approveProposal, rejectProposal } = await import("../../src/approval/resolve.js");
const { createTask, reassignTask, transitionTask } = await import("../../src/tasks/ops.js");
const { disableAgent, enableAgent } = await import("../../src/enforcement/disabled-store.js");
const { startMeeting, concludeMeeting } = await import("../../src/channels/meeting.js");
const { sendChannelMessage } = await import("../../src/channels/messages.js");
const { emitSSE } = await import("../../src/dashboard/sse.js");

describe("handleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Approvals ---

  it("approves a proposal", () => {
    (approveProposal as any).mockReturnValue({ id: "p1", status: "approved" });

    const result = handleAction("test-project", "approvals/p1/approve", {});
    expect(result.status).toBe(200);
    expect(approveProposal).toHaveBeenCalledWith("test-project", "p1", undefined);
    expect(emitSSE).toHaveBeenCalledWith("test-project", "approval:resolved", {
      proposalId: "p1",
      status: "approved",
    });
  });

  it("rejects a proposal with feedback", () => {
    (rejectProposal as any).mockReturnValue({ id: "p1", status: "rejected" });

    const result = handleAction("test-project", "approvals/p1/reject", { feedback: "nope" });
    expect(result.status).toBe(200);
    expect(rejectProposal).toHaveBeenCalledWith("test-project", "p1", "nope");
  });

  it("returns 404 for missing proposal on approve", () => {
    (approveProposal as any).mockReturnValue(null);

    const result = handleAction("test-project", "approvals/p1/approve", {});
    expect(result.status).toBe(404);
  });

  // --- Tasks ---

  it("creates a task", () => {
    (createTask as any).mockReturnValue({ id: "t1", title: "Test task" });

    const result = handleAction("test-project", "tasks/create", {
      title: "Test task",
      priority: "medium",
      assignedTo: "agent-a",
    });
    expect(result.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        title: "Test task",
        priority: "medium",
        assignedTo: "agent-a",
        createdBy: "dashboard",
      }),
    );
    expect(emitSSE).toHaveBeenCalledWith("test-project", "task:update", {
      taskId: "t1",
      action: "created",
    });
  });

  it("returns 400 for task create without title", () => {
    const result = handleAction("test-project", "tasks/create", {});
    expect(result.status).toBe(400);
  });

  it("reassigns a task", () => {
    (reassignTask as any).mockReturnValue({ ok: true, task: { id: "t1" } });

    const result = handleAction("test-project", "tasks/t1/reassign", { newAssignee: "agent-b" });
    expect(result.status).toBe(200);
    expect(reassignTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        taskId: "t1",
        newAssignee: "agent-b",
      }),
    );
  });

  it("returns 400 for reassign without newAssignee", () => {
    const result = handleAction("test-project", "tasks/t1/reassign", {});
    expect(result.status).toBe(400);
  });

  it("returns 400 for failed reassign", () => {
    (reassignTask as any).mockReturnValue({ ok: false, reason: "Task not found" });

    const result = handleAction("test-project", "tasks/t1/reassign", { newAssignee: "agent-b" });
    expect(result.status).toBe(400);
  });

  it("transitions a task", () => {
    (transitionTask as any).mockReturnValue({ ok: true, task: { id: "t1" } });

    const result = handleAction("test-project", "tasks/t1/transition", { toState: "IN_PROGRESS" });
    expect(result.status).toBe(200);
  });

  // --- Agents ---

  it("disables an agent", () => {
    const result = handleAction("test-project", "agents/a1/disable", { reason: "testing" });
    expect(result.status).toBe(200);
    expect(disableAgent).toHaveBeenCalledWith("test-project", "a1", "testing");
    expect(emitSSE).toHaveBeenCalledWith("test-project", "agent:status", {
      agentId: "a1",
      status: "disabled",
      reason: "testing",
    });
  });

  it("enables an agent", () => {
    const result = handleAction("test-project", "agents/a1/enable", {});
    expect(result.status).toBe(200);
    expect(enableAgent).toHaveBeenCalledWith("test-project", "a1");
  });

  it("returns 501 for agent message (deferred)", () => {
    const result = handleAction("test-project", "agents/a1/message", { message: "hello" });
    expect(result.status).toBe(501);
  });

  it("returns 501 for agent kill (deferred)", () => {
    const result = handleAction("test-project", "agents/a1/kill", {});
    expect(result.status).toBe(501);
  });

  // --- Meetings ---

  it("creates a meeting", () => {
    (startMeeting as any).mockReturnValue({
      channel: { id: "ch1", name: "meeting-1" },
      dispatched: true,
    });

    const result = handleAction("test-project", "meetings/create", {
      participants: ["agent-a", "agent-b"],
      prompt: "Discuss Q3 goals",
    });
    expect(result.status).toBe(201);
    expect(startMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        participants: ["agent-a", "agent-b"],
        prompt: "Discuss Q3 goals",
      }),
    );
    expect(emitSSE).toHaveBeenCalledWith("test-project", "meeting:started", {
      channelId: "ch1",
      participants: ["agent-a", "agent-b"],
    });
  });

  it("returns 400 for meeting create without participants", () => {
    const result = handleAction("test-project", "meetings/create", {});
    expect(result.status).toBe(400);
  });

  it("sends a meeting message", () => {
    (sendChannelMessage as any).mockReturnValue({ id: "m1", content: "hello" });

    const result = handleAction("test-project", "meetings/ch1/message", {
      content: "hello",
      fromAgent: "agent-a",
    });
    expect(result.status).toBe(200);
    expect(sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "ch1",
        projectId: "test-project",
        content: "hello",
        fromAgent: "agent-a",
      }),
    );
  });

  it("ends a meeting", () => {
    (concludeMeeting as any).mockReturnValue({ id: "ch1", status: "concluded" });

    const result = handleAction("test-project", "meetings/ch1/end", {});
    expect(result.status).toBe(200);
    expect(concludeMeeting).toHaveBeenCalledWith("test-project", "ch1", "dashboard");
    expect(emitSSE).toHaveBeenCalledWith("test-project", "meeting:ended", { channelId: "ch1" });
  });

  // --- Config / Budget (deferred) ---

  it("returns 501 for config save (deferred)", () => {
    const result = handleAction("test-project", "config/save", {});
    expect(result.status).toBe(501);
  });

  it("returns 501 for budget allocate (deferred)", () => {
    const result = handleAction("test-project", "budget/allocate", {});
    expect(result.status).toBe(501);
  });

  // --- Unknown ---

  it("returns 404 for unknown action", () => {
    const result = handleAction("test-project", "unknown/action", {});
    expect(result.status).toBe(404);
  });

  it("returns 404 for too-short action path", () => {
    const result = handleAction("test-project", "approvals", {});
    expect(result.status).toBe(404);
  });
});
