import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const mockInjector = vi.fn();

const { setDispatchInjector, dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");

describe("dispatchViaInject", () => {
  beforeEach(() => {
    mockInjector.mockReset();
    mockInjector.mockResolvedValue({ runId: "run-123" });
    setDispatchInjector(mockInjector);
  });

  afterEach(() => {
    setDispatchInjector(null as never);
  });

  it("injects a message with dispatch tag in prompt", async () => {
    const result = await dispatchViaInject({
      queueItemId: "qi-123",
      taskId: "task-456",
      projectId: "proj-1",
      prompt: "Execute the task",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBe("agent:agent:worker:dispatch:qi-123");

    expect(mockInjector).toHaveBeenCalledTimes(1);
    const call = mockInjector.mock.calls[0]![0];
    expect(call.sessionKey).toBe("agent:agent:worker:dispatch:qi-123");
    expect(call.message).toContain("[clawforce:dispatch=qi-123:task-456]");
    expect(call.message).toContain("Execute the task");
  });

  it("returns error when injector is not set", async () => {
    setDispatchInjector(null as never);

    const result = await dispatchViaInject({
      queueItemId: "qi-1",
      taskId: "task-1",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Dispatch injector not set");
    expect(mockInjector).not.toHaveBeenCalled();
  });

  it("returns error when injector throws", async () => {
    mockInjector.mockRejectedValue(new Error("Network timeout"));

    const result = await dispatchViaInject({
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
