import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

vi.mock("../../src/dispatch/queue.js", () => ({
  enqueue: vi.fn(() => ({ id: "queue-replay-1" })),
  releaseActiveItem: vi.fn(() => ({ ok: false, reason: "no active queue item" })),
  retryFailedItem: vi.fn(() => ({ ok: false, reason: "no failed queue item" })),
}));

vi.mock("../../src/project.js", () => ({
  getAgentConfig: vi.fn(() => ({
    config: {
      model: "gpt-5.4",
    },
  })),
}));

vi.mock("../../src/runtime/controller-leases.js", () => ({
  getCurrentControllerGeneration: vi.fn(() => "gen-current"),
  requestControllerGeneration: vi.fn(),
}));

vi.mock("../../src/scheduling/recurring-jobs.js", () => ({
  replayRecurringJobTask: vi.fn(() => ({
    ok: true,
    task: {
      id: "replay-task-1",
      assignedTo: "agent-dev",
      metadata: {
        recurringJob: {
          agentId: "agent-dev",
          jobName: "cleanup",
        },
      },
    },
  })),
}));

vi.mock("../../src/jobs.js", () => ({
  resolveEffectiveConfig: vi.fn((config: unknown) => config),
}));

vi.mock("../../src/tasks/ops.js", () => ({
  getTask: vi.fn((_projectId: string, taskId: string) => ({
    id: taskId,
    assignedTo: "agent-dev",
    metadata: {
      recurringJob: {
        agentId: "agent-dev",
        jobName: "cleanup",
      },
    },
  })),
}));

const {
  runRecoverRecurringRunCommand,
  runRequestControllerHandoffCommand,
} = await import("../../src/app/commands/setup-controls.js");
const { writeAuditEntry } = await import("../../src/audit.js");
const { enqueue, releaseActiveItem, retryFailedItem } = await import("../../src/dispatch/queue.js");
const { requestControllerGeneration } = await import("../../src/runtime/controller-leases.js");
const { replayRecurringJobTask } = await import("../../src/scheduling/recurring-jobs.js");

describe("setup controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (enqueue as any).mockReturnValue({ id: "queue-replay-1" });
    (releaseActiveItem as any).mockReturnValue({ ok: false, reason: "no active queue item" });
    (retryFailedItem as any).mockReturnValue({ ok: false, reason: "no failed queue item" });
    (replayRecurringJobTask as any).mockReturnValue({
      ok: true,
      task: {
        id: "replay-task-1",
        assignedTo: "agent-dev",
        metadata: {
          recurringJob: {
            agentId: "agent-dev",
            jobName: "cleanup",
          },
        },
      },
    });
  });

  it("requests controller handoff through the current generation", () => {
    const result = runRequestControllerHandoffCommand("proj1", { actor: "user:setup" });

    expect(result.status).toBe(200);
    expect(requestControllerGeneration).toHaveBeenCalledWith("proj1", expect.objectContaining({
      generation: "gen-current",
      requestedBy: "user:setup",
    }));
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: "setup.controller_handoff.requested",
      targetId: "proj1",
    }));
  });

  it("releases a stalled recurring dispatch when an active queue item exists", () => {
    (releaseActiveItem as any).mockReturnValue({
      ok: true,
      previousItem: { taskId: "task-1" },
      queueItem: { id: "queue-1" },
    });

    const result = runRecoverRecurringRunCommand("proj1", "task-1", { actor: "user:setup" });

    expect(result.status).toBe(200);
    expect(releaseActiveItem).toHaveBeenCalledWith("proj1", expect.objectContaining({
      taskId: "task-1",
      actor: "user:setup",
    }));
    expect(retryFailedItem).not.toHaveBeenCalled();
    expect(replayRecurringJobTask).not.toHaveBeenCalled();
    expect(requestControllerGeneration).toHaveBeenCalledWith("proj1", expect.objectContaining({
      reason: "dashboard_setup_recovery:task-1",
    }));
  });

  it("replays and enqueues a recurring task when no lease or failed item can be recovered", () => {
    const result = runRecoverRecurringRunCommand("proj1", "task-1", { actor: "user:setup" });

    expect(result.status).toBe(200);
    expect(replayRecurringJobTask).toHaveBeenCalledWith("proj1", "task-1", "user:setup");
    expect(enqueue).toHaveBeenCalledWith(
      "proj1",
      "replay-task-1",
      expect.objectContaining({
        jobName: "cleanup",
        model: "gpt-5.4",
      }),
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    expect(requestControllerGeneration).toHaveBeenCalledWith("proj1", expect.objectContaining({
      metadata: expect.objectContaining({
        recoveryMode: "replayed",
        recoveredTaskId: "replay-task-1",
      }),
    }));
  });
});
