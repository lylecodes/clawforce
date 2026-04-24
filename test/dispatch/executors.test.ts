import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async (request: Record<string, unknown>) => ({
    ok: true,
    sessionKey: `openclaw:${request.queueItemId as string}`,
  })),
}));

vi.mock("../../adapters/codex/executor.js", () => ({
  dispatchViaCodexExecutor: vi.fn(async (request: Record<string, unknown>) => ({
    ok: true,
    executor: "codex",
    sessionKey: `codex:${request.queueItemId as string}`,
    completedInline: true,
  })),
}));

vi.mock("../../adapters/claude-code/executor.js", () => ({
  dispatchViaClaudeExecutor: vi.fn(async (request: Record<string, unknown>) => ({
    ok: true,
    executor: "claude-code",
    sessionKey: `claude:${request.queueItemId as string}`,
    completedInline: true,
  })),
}));

const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const {
  executeDispatch,
  resolveDispatchExecutorName,
} = await import("../../src/dispatch/executors.js");
const {
  registerDispatchExecutorPort,
  resetDispatchExecutorPortsForTest,
} = await import("../../src/runtime/integrations.js");
const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");
const { dispatchViaCodexExecutor } = await import("../../adapters/codex/executor.js");
const { dispatchViaClaudeExecutor } = await import("../../adapters/claude-code/executor.js");

describe("dispatch executors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnforcementConfigForTest();
    resetDispatchExecutorPortsForTest();
  });

  it("defaults to the Codex executor", () => {
    registerWorkforceConfig("default-executor", {
      name: "default-executor",
      agents: {
        worker: { extends: "employee" },
      },
    });

    expect(resolveDispatchExecutorName("default-executor")).toBe("codex");
  });

  it("uses the configured adapter as the executor fallback", () => {
    registerWorkforceConfig("adapter-fallback", {
      name: "adapter-fallback",
      adapter: "codex",
      codex: { model: "gpt-5.4-mini" },
      agents: {
        worker: { extends: "employee" },
      },
    });

    expect(resolveDispatchExecutorName("adapter-fallback")).toBe("codex");
  });

  it("prefers explicit dispatch.executor over adapter fallback", () => {
    registerWorkforceConfig("explicit-executor", {
      name: "explicit-executor",
      adapter: "codex",
      agents: {
        worker: { extends: "employee" },
      },
      dispatch: {
        executor: "openclaw",
      },
    });

    expect(resolveDispatchExecutorName("explicit-executor")).toBe("openclaw");
  });

  it("keeps strict tool-filtered agents on the configured direct executor by default", () => {
    registerWorkforceConfig("strict-routing", {
      name: "strict-routing",
      adapter: "codex",
      agents: {
        worker: { extends: "employee", runtime: { allowedTools: ["Read"] } },
      },
    });

    expect(resolveDispatchExecutorName("strict-routing", "worker")).toBe("codex");
  });

  it("keeps an explicit codex executor even when the agent requests strict tool filtering", () => {
    registerWorkforceConfig("strict-pinned", {
      name: "strict-pinned",
      adapter: "codex",
      dispatch: {
        executor: "codex",
      },
      agents: {
        worker: { extends: "employee", runtime: { allowedTools: ["Read"] } },
      },
    });

    expect(resolveDispatchExecutorName("strict-pinned", "worker")).toBe("codex");
  });

  it("routes OpenClaw dispatches through the executor boundary with namespacing and runtime fields", async () => {
    registerWorkforceConfig("openclaw-project", {
      name: "openclaw-project",
      adapter: "openclaw",
      agents: {
        worker: { extends: "employee" },
      },
    });

    const result = await executeDispatch({
      queueItemId: "q-1",
      taskId: "t-1",
      projectId: "openclaw-project",
      prompt: "do the work",
      agentId: "worker",
      model: "gpt-5.4",
      timeoutSeconds: 42,
    });

    expect(result.ok).toBe(true);
    expect(dispatchViaInject).toHaveBeenCalledWith(expect.objectContaining({
      queueItemId: "q-1",
      taskId: "t-1",
      projectId: "openclaw-project",
      prompt: "do the work",
      agentId: "openclaw-project:worker",
      model: "gpt-5.4",
      timeoutSeconds: 42,
    }));
  });

  it("routes direct local dispatches through the Codex executor", async () => {
    registerWorkforceConfig("codex-project", {
      name: "codex-project",
      adapter: "codex",
      agents: {
        worker: { extends: "manager" },
      },
    });

    const result = await executeDispatch({
      queueItemId: "q-2",
      taskId: "t-2",
      projectId: "codex-project",
      prompt: "do the local work",
      agentId: "worker",
    });

    expect(result.executor).toBe("codex");
    expect(dispatchViaCodexExecutor).toHaveBeenCalledWith(expect.objectContaining({
      queueItemId: "q-2",
      taskId: "t-2",
      projectId: "codex-project",
      agentId: "worker",
    }));
  });

  it("routes strict employee dispatches through Codex by default", async () => {
    registerWorkforceConfig("strict-project", {
      name: "strict-project",
      adapter: "codex",
      agents: {
        worker: { extends: "employee", runtime: { allowedTools: ["Read"] } },
      },
    });

    const result = await executeDispatch({
      queueItemId: "q-strict",
      taskId: "t-strict",
      projectId: "strict-project",
      prompt: "strict work",
      agentId: "worker",
    });

    expect(result.executor).toBe("codex");
    expect(dispatchViaCodexExecutor).toHaveBeenCalledWith(expect.objectContaining({
      queueItemId: "q-strict",
      taskId: "t-strict",
      projectId: "strict-project",
      agentId: "worker",
    }));
  });

  it("keeps the legacy Claude executor available for compatibility", async () => {
    registerWorkforceConfig("legacy-claude-project", {
      name: "legacy-claude-project",
      adapter: "claude-code",
      agents: {
        worker: { extends: "employee" },
      },
    });

    const result = await executeDispatch({
      queueItemId: "q-legacy",
      taskId: "t-legacy",
      projectId: "legacy-claude-project",
      prompt: "legacy direct work",
      agentId: "worker",
    });

    expect(result.executor).toBe("claude-code");
    expect(dispatchViaClaudeExecutor).toHaveBeenCalled();
  });

  it("allows runtime override of a built-in executor", async () => {
    const override = vi.fn(async () => ({
      ok: true,
      executor: "openclaw",
      sessionKey: "override-session",
    }));
    registerDispatchExecutorPort({
      id: "openclaw",
      dispatch: override,
    });
    registerWorkforceConfig("override-project", {
      name: "override-project",
      dispatch: {
        executor: "openclaw",
      },
      agents: {
        worker: { extends: "employee" },
      },
    });

    await executeDispatch({
      queueItemId: "q-3",
      taskId: "t-3",
      projectId: "override-project",
      prompt: "override me",
      agentId: "worker",
    });

    expect(override).toHaveBeenCalledWith(expect.objectContaining({
      queueItemId: "q-3",
      taskId: "t-3",
      projectId: "override-project",
    }));
    expect(dispatchViaInject).not.toHaveBeenCalled();
  });
});
