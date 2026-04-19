import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/enforcement/tracker.js", () => ({
  SESSION_HEARTBEAT_INTERVAL_MS: 10_000,
  heartbeatSession: vi.fn(),
  startTracking: vi.fn(),
  endSession: vi.fn(() => null),
  recordSessionProgress: vi.fn(),
  setDispatchContext: vi.fn(),
  setSessionProcessId: vi.fn(),
}));

vi.mock("../../src/enforcement/check.js", () => ({
  checkCompliance: vi.fn(() => ({ compliant: true })),
}));

vi.mock("../../src/telemetry/session-archive.js", () => ({
  archiveSession: vi.fn(),
}));

import {
  buildCliArgs,
  buildDispatchPrompt,
  dispatchViaCodex,
  killCodexSession,
  _setSpawnForTest,
} from "../../adapters/codex/dispatch.js";
import { heartbeatSession, startTracking, endSession, recordSessionProgress, setDispatchContext, setSessionProcessId } from "../../src/enforcement/tracker.js";
import { archiveSession } from "../../src/telemetry/session-archive.js";

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };
const spawnCalls: SpawnCall[] = [];

function createMockSpawn(config: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error | null;
  closeDelayMs?: number;
}) {
  return (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, opts });

    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: null;
    };
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.stdin = null;

    if (config.error) {
      process.nextTick(() => proc.emit("error", config.error));
    } else {
      const closeDelayMs = config.closeDelayMs ?? 0;
      process.nextTick(() => {
        proc.stdout.push(Buffer.from(config.stdout ?? ""));
        proc.stdout.push(null);
        proc.stderr.push(Buffer.from(config.stderr ?? ""));
        proc.stderr.push(null);
        setTimeout(() => proc.emit("close", config.exitCode ?? 0), closeDelayMs);
      });
    }

    return proc as any;
  };
}

describe("buildDispatchPrompt", () => {
  it("returns the original prompt when no system context is provided", () => {
    expect(buildDispatchPrompt("do work")).toBe("do work");
  });

  it("wraps system context and task when both are provided", () => {
    expect(buildDispatchPrompt("do work", "system rules")).toContain("<system_context>");
    expect(buildDispatchPrompt("do work", "system rules")).toContain("<task>");
  });
});

describe("buildCliArgs", () => {
  const defaultConfig = {
    binary: "codex",
    model: "gpt-5.4",
    sandbox: "workspace-write" as const,
    fullAuto: true,
    skipGitRepoCheck: true,
    dangerouslyBypassApprovalsAndSandbox: false,
    approvalPolicy: undefined,
    addDirs: [],
    workdir: undefined,
    configOverrides: [],
  };

  it("builds exec args with output capture", () => {
    const args = buildCliArgs("hello world", defaultConfig, "/tmp/out.txt");
    expect(args[0]).toBe("exec");
    expect(args).toContain("hello world");
    expect(args).toContain("--output-last-message");
    expect(args).toContain("/tmp/out.txt");
    expect(args).toContain("--ephemeral");
  });

  it("includes per-invocation config overrides", () => {
    const args = buildCliArgs("hello world", {
      ...defaultConfig,
      configOverrides: [
        'mcp_servers.clawforce.command="/usr/bin/node"',
        'mcp_servers.clawforce.args=["/tmp/server.js"]',
      ],
    }, "/tmp/out.txt");
    expect(args).toContain("-c");
    expect(args).toContain('mcp_servers.clawforce.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.clawforce.args=["/tmp/server.js"]');
  });

  it("uses full-auto by default", () => {
    const args = buildCliArgs("test", defaultConfig, "/tmp/out.txt");
    expect(args).toContain("--full-auto");
  });

  it("uses dangerous bypass when configured", () => {
    const args = buildCliArgs("test", {
      ...defaultConfig,
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: true,
    }, "/tmp/out.txt");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("uses explicit approval policy and sandbox when configured", () => {
    const args = buildCliArgs("test", {
      ...defaultConfig,
      fullAuto: false,
      approvalPolicy: "never" as const,
      sandbox: "read-only" as const,
    }, "/tmp/out.txt");
    expect(args).toContain("-a");
    expect(args).toContain("never");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--full-auto");
  });

  it("adds extra workspace roots when configured", () => {
    const args = buildCliArgs("test", {
      ...defaultConfig,
      addDirs: ["/tmp/shared", "/tmp/second"],
    }, "/tmp/out.txt");
    expect(args).toContain("--add-dir");
    expect(args.filter((value) => value === "--add-dir")).toHaveLength(2);
    expect(args).toContain("/tmp/shared");
    expect(args).toContain("/tmp/second");
  });
});

describe("dispatchViaCodex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnCalls.length = 0;
    _setSpawnForTest(createMockSpawn({ stdout: "stdout fallback", exitCode: 0 }));
  });

  afterEach(() => {
    _setSpawnForTest(null);
    vi.useRealTimers();
  });

  it("spawns codex exec with the configured model", async () => {
    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      config: { model: "gpt-5.4-mini", fullAuto: true },
    });

    expect(result.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe("codex");
    expect(spawnCalls[0]!.args).toContain("exec");
    expect(spawnCalls[0]!.args).toContain("--model");
    expect(spawnCalls[0]!.args).toContain("gpt-5.4-mini");
  });

  it("normalizes provider-scoped OpenAI Codex model ids before spawning", async () => {
    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      config: { model: "openai-codex/gpt-5.4", fullAuto: true },
    });

    expect(result.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain("--model");
    expect(spawnCalls[0]!.args).toContain("gpt-5.4");
    expect(spawnCalls[0]!.args).not.toContain("openai-codex/gpt-5.4");
  });

  it("surfaces stderr on failure", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: "Not logged in",
      exitCode: 1,
    }));

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not logged in");
  });

  it("synthesizes a review summary when codex succeeds without a final message", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toContain("returned no final summary");
    expect(result.summarySynthetic).toBe(true);
    expect(result.observedWork).toBe(false);
  });

  it("falls back to an operator summary when only a successful stderr launch transcript exists", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: "Reading additional input from stdin...\nOpenAI Codex v0.118.0 (research preview)\n--------",
      exitCode: 0,
    }));

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toContain("returned no final summary");
    expect(result.summarySynthetic).toBe(true);
  });

  it("falls back to an operator summary when the output file is only a launch transcript", async () => {
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;

      process.nextTick(() => {
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
        if (outputPath) {
          fs.writeFileSync(outputPath, [
            "Reading additional input from stdin...",
            "OpenAI Codex v0.118.0 (research preview)",
            "--------",
            "<task-metadata title=\"Transcript-only\">",
          ].join("\n"));
        }
        proc.stdout.push(Buffer.from(""));
        proc.stdout.push(null);
        proc.stderr.push(Buffer.from(""));
        proc.stderr.push(null);
        proc.emit("close", 0);
      });

      return proc as any;
    });

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toContain("returned no final summary");
    expect(result.summarySynthetic).toBe(true);
  });

  it("extracts a substantive stderr transcript instead of synthesizing a fake summary", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: [
        "Reading additional input from stdin...",
        "OpenAI Codex v0.118.0 (research preview)",
        "--------",
        "exec",
        "/bin/zsh -lc 'pwd'",
        " succeeded in 0ms:",
        "/tmp/demo",
        "",
        "## Findings",
        "- Existing routing is already correct.",
        "",
        "## Action Taken",
        "- Left evidence for the reviewer.",
        "",
        "## Reviewer Check",
        "- Confirm no duplicate task is needed.",
        "",
        "tokens used",
        "12,345",
      ].join("\n"),
      exitCode: 0,
    }));

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.summarySynthetic).toBe(false);
    expect(result.result).toContain("## Action Taken");
    expect(recordSessionProgress).toHaveBeenCalled();
  });

  it("does not treat a substantive stderr transcript as real output when MCP-backed telemetry is expected", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: [
        "Reading additional input from stdin...",
        "OpenAI Codex v0.118.0 (research preview)",
        "--------",
        "exec",
        "/bin/zsh -lc 'pwd'",
        " succeeded in 0ms:",
        "/tmp/demo",
        "",
        "## Findings",
        "- Existing routing is already correct.",
        "",
        "## Action Taken",
        "- Left evidence for the reviewer.",
        "",
        "## Reviewer Check",
        "- Confirm no duplicate task is needed.",
      ].join("\n"),
      exitCode: 0,
    }));

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
    });

    expect(result.ok).toBe(true);
    expect(result.summarySynthetic).toBe(true);
    expect(result.observedWork).toBe(false);
    expect(result.result).toContain("returned no final summary");
    expect(recordSessionProgress).not.toHaveBeenCalled();
  });

  it("does not treat stderr transcript chatter as progress for MCP-backed sessions", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: [
        "exec",
        "/bin/zsh -lc 'pwd'",
        " succeeded in 0ms:",
        "/tmp/demo",
      ].join("\n"),
      exitCode: 0,
    }));

    await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
    });

    expect(recordSessionProgress).not.toHaveBeenCalled();
  });

  it("kills an active codex session through the session key bridge", async () => {
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
        kill: (signal?: NodeJS.Signals) => boolean;
        killed?: boolean;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;
      proc.killed = false;
      proc.kill = (signal?: NodeJS.Signals) => {
        proc.killed = true;
        process.nextTick(() => proc.emit("close", null, signal ?? "SIGTERM"));
        return true;
      };

      process.nextTick(() => {
        proc.stdout.push(Buffer.from(""));
        proc.stdout.push(null);
        proc.stderr.push(Buffer.from(""));
        proc.stderr.push(null);
      });

      return proc as any;
    });

    const promise = dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      sessionKey: "dispatch:test-kill",
    });

    await Promise.resolve();
    const killed = await killCodexSession("dispatch:test-kill", "test kill");
    const result = await promise;

    expect(killed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("test kill");
  });

  it("archives tracked direct-executor sessions", async () => {
    vi.mocked(endSession).mockReturnValue({
      sessionKey: "dispatch:q-1",
      agentId: "worker",
      projectId: "demo",
      requirements: [],
      satisfied: new Map(),
      metrics: {
        startedAt: 1000,
        toolCalls: [{ toolName: "clawforce_task", action: "transition", timestamp: 1001, durationMs: 10, success: true }],
        errorCount: 0,
        toolCallBuffer: [],
      },
      jobName: "reactive-remediation",
    } as any);

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      taskId: "task-1",
      queueItemId: "q-1",
      agentConfig: { extends: "employee" } as any,
    });

    expect(result.ok).toBe(true);
    expect(archiveSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: result.sessionKey,
      agentId: "worker",
      projectId: "demo",
      taskId: "task-1",
      queueItemId: "q-1",
      provider: "codex",
      outcome: "compliant",
    }));
  });

  it("persists dispatch context for tracked direct-executor sessions", async () => {
    await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      taskId: "task-ctx",
      queueItemId: "queue-ctx",
      agentConfig: { extends: "employee" } as any,
    });

    expect(setDispatchContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        taskId: "task-ctx",
        queueItemId: "queue-ctx",
      }),
    );
  });

  it("persists the child process id for cross-process recovery", async () => {
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
        pid?: number;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;
      proc.pid = 4242;

      process.nextTick(() => {
        proc.stdout.push(Buffer.from(""));
        proc.stdout.push(null);
        proc.stderr.push(Buffer.from(""));
        proc.stderr.push(null);
        proc.emit("close", 0, null);
      });

      return proc as any;
    });

    await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      agentConfig: { extends: "employee" } as any,
    });

    expect(setSessionProcessId).toHaveBeenCalledWith(expect.any(String), 4242);
  });

  it("tracks controller-launched direct sessions even without an explicit agent config", async () => {
    await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      taskId: "task-no-config",
      queueItemId: "queue-no-config",
    });

    expect(startTracking).toHaveBeenCalledWith(
      expect.any(String),
      "worker",
      "demo",
      expect.objectContaining({
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
      }),
      undefined,
      { expectsToolTelemetry: true },
    );
    expect(setDispatchContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        taskId: "task-no-config",
        queueItemId: "queue-no-config",
      }),
    );
  });

  it("marks archive outcome as untracked when no direct-executor tool telemetry is visible", async () => {
    vi.mocked(endSession).mockReturnValue({
      sessionKey: "dispatch:q-2",
      agentId: "worker",
      projectId: "demo",
      requirements: [],
      satisfied: new Map(),
      metrics: {
        startedAt: 1000,
        toolCalls: [],
        errorCount: 0,
        toolCallBuffer: [],
      },
      jobName: "reactive-remediation",
    } as any);

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      taskId: "task-2",
      queueItemId: "q-2",
      agentConfig: { extends: "employee" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.summarySynthetic).toBe(false);
    expect(result.observedWork).toBe(false);
    expect(archiveSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: result.sessionKey,
      outcome: "untracked",
      provider: "codex",
    }));
  });

  it("records MCP bridge diagnostics in archived compliance detail", async () => {
    vi.mocked(endSession).mockReturnValue({
      sessionKey: "dispatch:q-3",
      agentId: "worker",
      projectId: "demo",
      requirements: [],
      satisfied: new Map(),
      metrics: {
        startedAt: 1000,
        toolCalls: [],
        errorCount: 0,
        toolCallBuffer: [],
      },
      jobName: "reactive-remediation",
    } as any);

    await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
      config: {
        model: "gpt-5.4",
        configOverrides: ['mcp_servers.clawforce.command="/usr/bin/node"'],
      } as any,
    });

    const archived = vi.mocked(archiveSession).mock.calls.at(-1)?.[0] as { complianceDetail?: string } | undefined;
    const detail = archived?.complianceDetail ? JSON.parse(archived.complianceDetail) as Record<string, unknown> : null;
    expect(detail?.mcpBridgeDisabled).toBe(true);
    expect(detail?.configOverrideCount).toBe(1);
    expect(detail?.timeoutMs).toBe(300000);
    expect(detail?.binary).toBe("codex");
  });

  it("heartbeats tracked direct-executor sessions while codex is still running", async () => {
    vi.useFakeTimers();
    _setSpawnForTest(createMockSpawn({
      stdout: "done",
      exitCode: 0,
      closeDelayMs: 25_000,
    }));

    const dispatchPromise = dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      agentConfig: { extends: "employee" } as any,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeatSession).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
  });

  it("treats a substantive final output file as logical completion even if the subprocess needs termination", async () => {
    vi.useFakeTimers();
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
        kill: (signal?: NodeJS.Signals) => boolean;
        killed?: boolean;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;
      proc.killed = false;
      proc.kill = (signal?: NodeJS.Signals) => {
        proc.killed = true;
        process.nextTick(() => proc.emit("close", null, signal ?? "SIGTERM"));
        return true;
      };

      process.nextTick(() => {
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
        if (outputPath) {
          fs.writeFileSync(outputPath, [
            "**Completed**",
            "",
            "Implemented the workflow mutation and left reviewer notes.",
          ].join("\n"));
        }
        proc.stdout.push(Buffer.from(""));
        proc.stderr.push(Buffer.from("Reading additional input from stdin...\nOpenAI Codex v0.118.0 (research preview)\n--------"));
      });

      return proc as any;
    });

    const dispatchPromise = dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    await vi.advanceTimersByTimeAsync(2_100);
    const result = await dispatchPromise;

    expect(result.ok).toBe(true);
    expect(result.logicalCompletion).toBe(true);
    expect(result.terminatedReason).toBe("Clawforce output capture completed");
    expect(result.result).toContain("Implemented the workflow mutation");
  });

  it("treats a completed stderr transcript as logical completion even without an output file", async () => {
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
        kill: (signal?: NodeJS.Signals) => boolean;
        killed?: boolean;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;
      proc.killed = false;
      proc.kill = (signal?: NodeJS.Signals) => {
        proc.killed = true;
        process.nextTick(() => proc.emit("close", null, signal ?? "SIGTERM"));
        return true;
      };

      process.nextTick(() => {
        proc.stderr.push(Buffer.from([
          "Reading additional input from stdin...",
          "OpenAI Codex v0.118.0 (research preview)",
          "--------",
          "exec",
          "/bin/zsh -lc 'pwd'",
          " succeeded in 0ms:",
          "/tmp/demo",
          "",
          "## Findings",
          "- Existing routing is already correct.",
          "",
          "## Action Taken",
          "- Left evidence for the reviewer.",
          "",
          "## Reviewer Check",
          "- Confirm no duplicate task is needed.",
          "",
          "tokens used",
          "12,345",
        ].join("\n")));
      });

      return proc as any;
    });

    const result = await dispatchViaCodex({
      agentId: "worker",
      projectId: "demo",
      prompt: "do the work",
      mcpBridgeDisabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.logicalCompletion).toBe(true);
    expect(result.terminatedReason).toBe("Clawforce transcript completion detected");
    expect(result.result).toContain("## Reviewer Check");
  });

  it("does not treat echoed launch prompts as completed stderr transcripts", async () => {
    _setSpawnForTest((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });

      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: null;
        kill: (signal?: NodeJS.Signals) => boolean;
        killed?: boolean;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = null;
      proc.killed = false;
      proc.kill = (_signal?: NodeJS.Signals) => {
        proc.killed = true;
        return true;
      };

      process.nextTick(() => {
        proc.stderr.push(Buffer.from([
          "Reading additional input from stdin...",
          "OpenAI Codex v0.118.0 (research preview)",
          "--------",
          "<system_context>",
          "## Action Taken",
          "- Previous unrelated work summary copied into prompt context.",
          "",
          "## Reviewer Check",
          "- This should not count as real execution output.",
          "</system_context>",
          "",
          "<task>",
          "Execute task: Open onboarding for Fresno",
          "</task>",
        ].join("\n")));
        proc.stderr.push(null);
        proc.stdout.push(Buffer.from(""));
        proc.stdout.push(null);
        process.nextTick(() => proc.emit("close", 0, null));
      });

      return proc as any;
    });

    const result = await dispatchViaCodex({
      agentId: "data-director",
      projectId: "demo",
      prompt: "Execute task: Open onboarding for Fresno",
      systemContext: "## Action Taken\n- Previous unrelated work summary copied into prompt context.\n\n## Reviewer Check\n- This should not count as real execution output.",
    });

    expect(result.ok).toBe(true);
    expect(result.logicalCompletion).not.toBe(true);
    expect(result.terminatedReason).toBeUndefined();
    expect(result.summarySynthetic).toBe(true);
    expect(result.result).toContain("returned no final summary");
  });
});
