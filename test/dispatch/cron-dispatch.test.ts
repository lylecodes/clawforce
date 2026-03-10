import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const mockAdd = vi.fn();
const mockCronService = {
  list: vi.fn(async () => []),
  add: mockAdd,
  update: vi.fn(),
  remove: vi.fn(),
};

const { setCronService } = await import("../../src/manager-cron.js");
const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");

describe("dispatchViaCron", () => {
  beforeEach(() => {
    mockAdd.mockReset();
    mockAdd.mockResolvedValue(undefined);
    setCronService(mockCronService);
  });

  afterEach(() => {
    setCronService(null);
  });

  it("creates a one-shot cron job with dispatch tag in payload", async () => {
    const result = await dispatchViaCron({
      queueItemId: "qi-123",
      taskId: "task-456",
      projectId: "proj-1",
      prompt: "Execute the task",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(true);
    expect(result.cronJobName).toBe("dispatch:qi-123");

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const input = mockAdd.mock.calls[0]![0];
    expect(input.name).toBe("dispatch:qi-123");
    expect(input.agentId).toBe("agent:worker");
    expect(input.sessionTarget).toBe("isolated");
    expect(input.wakeMode).toBe("now");
    expect(input.deleteAfterRun).toBe(true);
    expect(input.schedule.kind).toBe("at");
    expect(input.payload.message).toContain("[clawforce:dispatch=qi-123:task-456]");
    expect(input.payload.message).toContain("Execute the task");
  });

  it("passes model and timeoutSeconds when provided", async () => {
    await dispatchViaCron({
      queueItemId: "qi-789",
      taskId: "task-abc",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "agent:worker",
      model: "claude-sonnet-4-20250514",
      timeoutSeconds: 600,
    });

    const input = mockAdd.mock.calls[0]![0];
    expect(input.payload.model).toBe("claude-sonnet-4-20250514");
    expect(input.payload.timeoutSeconds).toBe(600);
  });

  it("returns error when cron service is null", async () => {
    setCronService(null);

    const result = await dispatchViaCron({
      queueItemId: "qi-1",
      taskId: "task-1",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Cron service not available");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("returns error when cronService.add() throws", async () => {
    mockAdd.mockRejectedValue(new Error("Network timeout"));

    const result = await dispatchViaCron({
      queueItemId: "qi-2",
      taskId: "task-2",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network timeout");
  });
});
