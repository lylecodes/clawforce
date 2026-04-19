import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/assembler.js", () => ({
  assembleContext: vi.fn(() => "assembled context"),
}));

vi.mock("../../src/paths.js", () => ({
  getClawforceHome: vi.fn(() => "/clawforce-home"),
}));

vi.mock("../../src/project.js", () => ({
  getAgentConfig: vi.fn(() => null),
  getExtendedProjectConfig: vi.fn(() => ({ projectDir: "/repo", codex: { model: "gpt-5.4-mini" } })),
}));

vi.mock("../../src/runtime/integrations.js", () => ({
  getAgentKillPort: vi.fn(() => null),
  setAgentKillPort: vi.fn(),
}));

vi.mock("../../adapters/codex/dispatch.js", () => ({
  dispatchViaCodex: vi.fn(async () => ({
    ok: true,
    sessionKey: "codex:session-1",
    result: "done",
    summarySynthetic: false,
    observedWork: [],
  })),
  killCodexSession: vi.fn(async () => false),
}));

const { dispatchViaCodexExecutor } = await import("../../adapters/codex/executor.js");
const { dispatchViaCodex } = await import("../../adapters/codex/dispatch.js");

describe("dispatchViaCodexExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses nested runtime scope to enforce read-only sandbox and writable roots", async () => {
    await dispatchViaCodexExecutor({
      queueItemId: "q-1",
      taskId: "t-1",
      projectId: "proj-1",
      prompt: "do work",
      agentId: "worker-1",
      projectDir: "/repo",
      agentConfig: {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [],
        performance_policy: { action: "alert" },
        runtime: {
          allowedTools: ["Read"],
          workspacePaths: ["packages/core", "/tmp/shared"],
        },
      },
    });

    expect(dispatchViaCodex).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        workdir: "/repo/packages/core",
        sandbox: "read-only",
        addDirs: [],
      }),
    }));
  });

  it("uses nested runtime scope to allow writes in companion roots when write tools are present", async () => {
    await dispatchViaCodexExecutor({
      queueItemId: "q-2",
      taskId: "t-2",
      projectId: "proj-1",
      prompt: "do work",
      agentId: "worker-2",
      projectDir: "/repo",
      agentConfig: {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [],
        performance_policy: { action: "alert" },
        runtime: {
          allowedTools: ["Read", "Write"],
          workspacePaths: ["packages/api", "/tmp/shared"],
        },
      },
    });

    expect(dispatchViaCodex).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        workdir: "/repo/packages/api",
        sandbox: undefined,
        addDirs: ["/tmp/shared"],
      }),
    }));
  });
});
