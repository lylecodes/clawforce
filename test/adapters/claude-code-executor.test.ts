import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/assembler.js", () => ({
  assembleContext: vi.fn(() => "assembled context"),
}));

vi.mock("../../src/paths.js", () => ({
  getClawforceHome: vi.fn(() => "/tmp/clawforce-home"),
}));

vi.mock("../../src/project.js", () => ({
  getAgentConfig: vi.fn(() => null),
  getExtendedProjectConfig: vi.fn(() => ({ projectDir: "/repo", claudeCode: { model: "claude-sonnet-4-6" } })),
}));

vi.mock("../../adapters/claude-code/dispatch.js", () => ({
  dispatchViaClaude: vi.fn(async () => ({
    ok: true,
    sessionKey: "claude:session-1",
    result: "done",
  })),
}));

const { dispatchViaClaudeExecutor } = await import("../../adapters/claude-code/executor.js");
const { dispatchViaClaude } = await import("../../adapters/claude-code/dispatch.js");

describe("dispatchViaClaudeExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the project-level claude model when the request does not override it", async () => {
    await dispatchViaClaudeExecutor({
      queueItemId: "q-1",
      taskId: "t-1",
      projectId: "proj-1",
      prompt: "do work",
      agentId: "worker-1",
    });

    expect(dispatchViaClaude).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        model: "claude-sonnet-4-6",
      }),
    }));
  });
});
