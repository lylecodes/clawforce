import { describe, expect, it, vi } from "vitest";

// Mock the openclaw plugin-sdk callGatewayTool
const mockCallGatewayTool = vi.fn(async () => ({ ok: true }));
vi.mock("openclaw/plugin-sdk", () => ({
  callGatewayTool: mockCallGatewayTool,
}));

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");

describe("dispatchViaInject", () => {
  it("calls chat.send with correct session key and tagged prompt", async () => {
    const result = await dispatchViaInject({
      queueItemId: "qi-123",
      taskId: "task-456",
      projectId: "proj-1",
      prompt: "Execute the task",
      agentId: "worker",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBe("agent:worker:dispatch:qi-123");

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    const [method, opts, params] = mockCallGatewayTool.mock.calls[0]!;
    expect(method).toBe("chat.send");
    expect(opts.timeoutMs).toBe(600_000);
    expect((params as { sessionKey: string }).sessionKey).toBe("agent:worker:dispatch:qi-123");
    expect((params as { message: string }).message).toContain("[clawforce:dispatch=qi-123:task-456]");
    expect((params as { message: string }).message).toContain("Execute the task");
  });

  it("returns error when callGatewayTool throws", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));

    const result = await dispatchViaInject({
      queueItemId: "qi-2",
      taskId: "task-2",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("gateway unavailable");
  });
});
