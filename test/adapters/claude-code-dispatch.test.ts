import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks for ClawForce internals ---

vi.mock("../../src/enforcement/tracker.js", () => ({
  startTracking: vi.fn(),
  endSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  recordToolCall: vi.fn(),
}));

vi.mock("../../src/enforcement/check.js", () => ({
  checkCompliance: vi.fn(() => ({ compliant: true })),
}));

vi.mock("../../src/cost.js", () => ({
  recordCost: vi.fn(),
  recordCostFromLlmOutput: vi.fn(),
}));

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
  })),
  setProjectsDir: vi.fn(),
}));

import {
  buildCliArgs,
  dispatchViaClaude,
  parseClaudeOutput,
  _setSpawnForTest,
} from "../../adapters/claude-code/dispatch.js";
import { startTracking, endSession } from "../../src/enforcement/tracker.js";
import { recordCost } from "../../src/cost.js";

// --- Mock spawn helper ---

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };
const spawnCalls: SpawnCall[] = [];

function createMockSpawn(config: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error | null;
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
      const err = config.error;
      process.nextTick(() => proc.emit("error", err));
    } else {
      const stdout = config.stdout ?? "";
      const stderr = config.stderr ?? "";
      const exitCode = config.exitCode ?? 0;
      // Push data in nextTick, then emit close in setImmediate
      // so the Readable stream has time to flush data events
      process.nextTick(() => {
        proc.stdout.push(Buffer.from(stdout));
        proc.stdout.push(null);
        proc.stderr.push(Buffer.from(stderr));
        proc.stderr.push(null);
        setImmediate(() => {
          proc.emit("close", exitCode);
        });
      });
    }

    return proc as any;
  };
}

// --- Tests ---

describe("buildCliArgs", () => {
  const defaultConfig = {
    binary: "claude",
    model: "claude-opus-4-6",
    permissionMode: "auto",
    maxBudgetPerDispatch: 1.0,
    workdir: undefined,
    mcpConfigPath: undefined,
  };

  it("builds basic args with prompt", () => {
    const args = buildCliArgs("hello world", defaultConfig);
    expect(args).toContain("-p");
    expect(args).toContain("hello world");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
  });

  it("includes model flag", () => {
    const args = buildCliArgs("test", defaultConfig);
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
  });

  it("includes permission mode", () => {
    const args = buildCliArgs("test", defaultConfig);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
  });

  it("includes max budget", () => {
    const args = buildCliArgs("test", defaultConfig);
    expect(args).toContain("--max-turns-cost");
    expect(args).toContain("1");
  });

  it("includes system context via --append-system-prompt", () => {
    const args = buildCliArgs("test", defaultConfig, "You are a helpful agent");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("You are a helpful agent");
  });

  it("includes mcp config path", () => {
    const args = buildCliArgs("test", { ...defaultConfig, mcpConfigPath: "/path/to/mcp.json" });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/path/to/mcp.json");
  });

  it("omits mcp config when not set", () => {
    const args = buildCliArgs("test", defaultConfig);
    expect(args).not.toContain("--mcp-config");
  });
});

describe("parseClaudeOutput", () => {
  it("parses valid JSON output", () => {
    const output = JSON.stringify({
      result: "Task completed",
      cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "claude-opus-4-6",
    });
    const parsed = parseClaudeOutput(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.result).toBe("Task completed");
    expect(parsed!.cost_usd).toBe(0.05);
    expect(parsed!.usage?.input_tokens).toBe(1000);
    expect(parsed!.usage?.output_tokens).toBe(500);
    expect(parsed!.model).toBe("claude-opus-4-6");
  });

  it("returns null for empty string", () => {
    expect(parseClaudeOutput("")).toBeNull();
    expect(parseClaudeOutput("  ")).toBeNull();
  });

  it("returns null for non-JSON output", () => {
    expect(parseClaudeOutput("just some text")).toBeNull();
    expect(parseClaudeOutput("Error: something went wrong")).toBeNull();
  });

  it("returns null for JSON primitives", () => {
    expect(parseClaudeOutput("42")).toBeNull();
    expect(parseClaudeOutput('"hello"')).toBeNull();
  });

  it("handles total_cost_usd field", () => {
    const output = JSON.stringify({ total_cost_usd: 0.12, result: "done" });
    const parsed = parseClaudeOutput(output);
    expect(parsed!.total_cost_usd).toBe(0.12);
  });

  it("handles is_error flag", () => {
    const output = JSON.stringify({ is_error: true, error: "Something failed" });
    const parsed = parseClaudeOutput(output);
    expect(parsed!.is_error).toBe(true);
    expect(parsed!.error).toBe("Something failed");
  });
});

describe("dispatchViaClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnCalls.length = 0;
    // Default: empty JSON object, success
    _setSpawnForTest(createMockSpawn({ stdout: "{}", exitCode: 0 }));
  });

  afterEach(() => {
    _setSpawnForTest(null); // restore real spawn
  });

  it("returns successful result for valid JSON output", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: JSON.stringify({
        result: "Done",
        cost_usd: 0.03,
        usage: { input_tokens: 500, output_tokens: 200 },
        model: "claude-opus-4-6",
      }),
    }));

    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "Build a widget",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBe("Done");
    expect(result.costUsd).toBe(0.03);
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(200);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.sessionKey).toMatch(/^cc-/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sets environment variables for the spawned process", async () => {
    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env.CLAWFORCE_AGENT_ID).toBe("agent-1");
    expect(env.CLAWFORCE_SESSION_KEY).toMatch(/^cc-/);
    expect(env.CLAWFORCE_PROJECT_ID).toBe("proj-1");
  });

  it("uses custom session key when provided", async () => {
    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
      sessionKey: "custom-session-123",
    });

    expect(result.sessionKey).toBe("custom-session-123");
  });

  it("handles non-zero exit code", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: "",
      stderr: "Error: rate limited",
      exitCode: 1,
    }));

    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("Error: rate limited");
  });

  it("handles is_error in JSON output", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: JSON.stringify({ is_error: true, error: "Tool call failed" }),
    }));

    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Tool call failed");
  });

  it("records cost when usage data is present", async () => {
    _setSpawnForTest(createMockSpawn({
      stdout: JSON.stringify({
        result: "ok",
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    }));

    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        agentId: "agent-1",
        inputTokens: 1000,
        outputTokens: 500,
        source: "claude-code-dispatch",
      }),
    );
  });

  it("starts and ends compliance tracking when agentConfig provided", async () => {
    const mockConfig = {
      expectations: [],
      performance_policy: { action: "alert" as const },
    };

    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
      agentConfig: mockConfig as any,
    });

    expect(startTracking).toHaveBeenCalledWith(
      expect.stringMatching(/^cc-/),
      "agent-1",
      "proj-1",
      mockConfig,
    );
    expect(endSession).toHaveBeenCalled();
  });

  it("does not track compliance when no agentConfig provided", async () => {
    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(startTracking).not.toHaveBeenCalled();
  });

  it("handles ENOENT error for missing binary", async () => {
    const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    _setSpawnForTest(createMockSpawn({ error: err }));

    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Claude CLI binary not found");
  });

  it("falls back to raw stdout when JSON parsing fails", async () => {
    _setSpawnForTest(createMockSpawn({ stdout: "plain text output" }));

    const result = await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
    });

    // Non-JSON output — result comes from raw stdout
    expect(result.result).toBe("plain text output");
  });

  it("passes workdir to spawn options", async () => {
    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
      config: { workdir: "/tmp/work" },
    });

    expect(spawnCalls[0]!.opts.cwd).toBe("/tmp/work");
  });

  it("uses custom binary path from config", async () => {
    await dispatchViaClaude({
      agentId: "agent-1",
      projectId: "proj-1",
      prompt: "test",
      config: { binary: "/usr/local/bin/claude" },
    });

    expect(spawnCalls[0]!.cmd).toBe("/usr/local/bin/claude");
  });
});
