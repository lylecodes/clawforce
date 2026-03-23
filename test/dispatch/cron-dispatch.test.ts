import { describe, expect, it, vi } from "vitest";

const mockExecFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
  cb(null);
});
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args as [string, string[], unknown, (err: Error | null) => void]),
}));

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");

describe("dispatchViaInject", () => {
  it("calls openclaw agent with correct args", async () => {
    const result = await dispatchViaInject({
      queueItemId: "qi-123",
      taskId: "task-456",
      projectId: "proj-1",
      prompt: "Execute the task",
      agentId: "worker",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBe("agent:worker:dispatch:qi-123");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFile.mock.calls[0]!;
    expect(cmd).toBe("openclaw");
    expect(args).toContain("--agent");
    expect(args).toContain("worker");
    expect(args).toContain("--session-id");
    expect(args).toContain("agent:worker:dispatch:qi-123");
    const msgIdx = args.indexOf("--message");
    expect(args[msgIdx + 1]).toContain("[clawforce:dispatch=qi-123:task-456]");
    expect(args[msgIdx + 1]).toContain("Execute the task");
  });

  it("returns error when execFile fails", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error("spawn ENOENT"));
    });

    const result = await dispatchViaInject({
      queueItemId: "qi-2",
      taskId: "task-2",
      projectId: "proj-1",
      prompt: "Do work",
      agentId: "worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn ENOENT");
  });
});
