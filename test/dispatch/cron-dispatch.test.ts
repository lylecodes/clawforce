import { describe, expect, it, vi } from "vitest";

// Mock child_process.spawn to avoid actually spawning processes
const mockChildProcess = { unref: vi.fn() };
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChildProcess),
}));

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { spawn } = await import("node:child_process");
const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");

describe("dispatchViaInject", () => {
  it("spawns openclaw agent with correct args and session-id", async () => {
    const result = await dispatchViaInject({
      queueItemId: "qi-123",
      taskId: "task-456",
      projectId: "proj-1",
      prompt: "Execute the task",
      agentId: "worker",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBe("agent:worker:dispatch:qi-123");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(cmd).toBe("openclaw");
    expect(args).toContain("--agent");
    expect(args).toContain("worker");
    expect(args).toContain("--session-id");
    expect(args).toContain("agent:worker:dispatch:qi-123");
    expect(args).toContain("--message");
    // The message arg should contain the dispatch tag
    const msgIdx = args.indexOf("--message");
    const msg = args[msgIdx + 1];
    expect(msg).toContain("[clawforce:dispatch=qi-123:task-456]");
    expect(msg).toContain("Execute the task");
    // Fire and forget
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(mockChildProcess.unref).toHaveBeenCalled();
  });

  it("returns error when spawn throws", async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
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
