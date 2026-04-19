/**
 * Clawforce — Claude Code dispatch
 *
 * Spawns `claude -p` processes for agent dispatches and collects results.
 * Integrates with ClawForce's compliance tracking and cost recording.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { resolveClaudeCodeConfig, type ClaudeCodeConfig } from "./types.js";
import { startTracking, endSession } from "../../src/enforcement/tracker.js";
import { checkCompliance } from "../../src/enforcement/check.js";
import { recordCost } from "../../src/cost.js";

// --- Types ---

export type DispatchOptions = {
  /** Agent ID performing this dispatch. */
  agentId: string;
  /** Project ID this dispatch belongs to. */
  projectId: string;
  /** The prompt to send to Claude Code. */
  prompt: string;
  /** System-level context to append (injected via --append-system-prompt). */
  systemContext?: string;
  /** Claude Code adapter config overrides. */
  config?: Partial<ClaudeCodeConfig>;
  /** Timeout in milliseconds (default: 300_000 = 5 minutes). */
  timeoutMs?: number;
  /** Optional session key (generated if not provided). */
  sessionKey?: string;
  /** Agent config for compliance tracking (optional). */
  agentConfig?: import("../../src/types.js").AgentConfig;
  /** Extra environment variables needed by the execution substrate. */
  extraEnv?: Record<string, string>;
};

export type DispatchResult = {
  /** Whether the dispatch completed successfully. */
  ok: boolean;
  /** The session key used for this dispatch. */
  sessionKey: string;
  /** Claude Code's text output (from parsed JSON or raw stdout). */
  result?: string;
  /** Parsed cost data from Claude Code's JSON output. */
  costUsd?: number;
  /** Total input tokens used. */
  inputTokens?: number;
  /** Total output tokens used. */
  outputTokens?: number;
  /** Model used for the dispatch. */
  model?: string;
  /** Duration of the dispatch in milliseconds. */
  durationMs: number;
  /** Error message if dispatch failed. */
  error?: string;
  /** Whether the session was compliance-compliant. */
  compliant?: boolean;
  /** Exit code from the claude process. */
  exitCode?: number | null;
  /** Raw JSON output from Claude Code (when --output-format json is used). */
  rawJson?: Record<string, unknown>;
};

/**
 * Claude Code JSON output shape (subset of fields we care about).
 * The actual output has more fields, but we only parse what we need.
 */
type ClaudeCodeJsonOutput = {
  result?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  model?: string;
  duration_ms?: number;
  is_error?: boolean;
  error?: string;
  // Newer Claude CLI format
  total_cost?: number;
  num_turns?: number;
  session_id?: string;
};

/** Spawn function type for dependency injection in tests. */
type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

type BudgetFlag = "--max-budget-usd" | "--max-turns-cost";

type DispatchAttempt = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

const DEFAULT_BUDGET_FLAG: BudgetFlag = "--max-budget-usd";

/**
 * Module-level spawn function. Defaults to node:child_process spawn.
 * Can be overridden via _setSpawnForTest() for unit testing.
 */
let _spawn: SpawnFn = spawn as unknown as SpawnFn;

/** @internal Test-only: override the spawn function. */
export function _setSpawnForTest(fn: SpawnFn | null): void {
  _spawn = fn ?? (spawn as unknown as SpawnFn);
}

/**
 * Dispatch a prompt to Claude Code via the CLI.
 *
 * Spawns `claude -p "prompt"` with appropriate flags, collects output,
 * parses cost data, and integrates with ClawForce's compliance system.
 */
export async function dispatchViaClaude(options: DispatchOptions): Promise<DispatchResult> {
  const cfg = resolveClaudeCodeConfig(options.config);
  const sessionKey = options.sessionKey ?? `cc-${crypto.randomUUID()}`;
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;

  // Start compliance tracking if agent config is provided
  if (options.agentConfig) {
    startTracking(sessionKey, options.agentId, options.projectId, options.agentConfig);
  }

  try {
    // Build environment variables
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CLAWFORCE_AGENT_ID: options.agentId,
      CLAWFORCE_SESSION_KEY: sessionKey,
      CLAWFORCE_PROJECT_ID: options.projectId,
      ...(options.extraEnv ?? {}),
    };

    let budgetFlag: BudgetFlag = DEFAULT_BUDGET_FLAG;
    let attempt = await runDispatchAttempt(
      cfg.binary,
      options.prompt,
      cfg,
      options.systemContext,
      budgetFlag,
      {
        env,
        cwd: cfg.workdir,
        timeoutMs,
      },
    );

    if (shouldRetryWithAlternateBudgetFlag(cfg, budgetFlag, attempt)) {
      budgetFlag = alternateBudgetFlag(budgetFlag);
      attempt = await runDispatchAttempt(
        cfg.binary,
        options.prompt,
        cfg,
        options.systemContext,
        budgetFlag,
        {
          env,
          cwd: cfg.workdir,
          timeoutMs,
        },
      );
    }

    const durationMs = Date.now() - startTime;
    const { stdout, stderr, exitCode } = attempt;

    // Parse JSON output
    const parsed = parseClaudeOutput(stdout);

    // Record costs if we got usage data
    if (parsed && (parsed.usage || parsed.cost_usd || parsed.total_cost_usd || parsed.total_cost)) {
      try {
        recordCost({
          projectId: options.projectId,
          agentId: options.agentId,
          sessionKey,
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          cacheReadTokens: parsed.usage?.cache_read_tokens ?? 0,
          cacheWriteTokens: parsed.usage?.cache_write_tokens ?? 0,
          model: parsed.model ?? cfg.model,
          provider: "anthropic",
          source: "claude-code-dispatch",
        });
      } catch {
        // Cost recording failure is non-fatal
      }
    }

    // End compliance tracking and check
    let compliant: boolean | undefined;
    if (options.agentConfig) {
      const session = endSession(sessionKey);
      if (session) {
        const result = checkCompliance(session);
        compliant = result.compliant;
      }
    }

    // Determine success
    const isError = parsed?.is_error === true || (exitCode !== null && exitCode !== 0);

    return {
      ok: !isError,
      sessionKey,
      result: parsed?.result ?? (parsed ? undefined : (stdout.trim() || undefined)),
      costUsd: parsed?.total_cost_usd ?? parsed?.cost_usd ?? parsed?.total_cost,
      inputTokens: parsed?.usage?.input_tokens,
      outputTokens: parsed?.usage?.output_tokens,
      model: parsed?.model ?? cfg.model,
      durationMs,
      compliant,
      exitCode,
      rawJson: parsed ?? undefined,
      error: isError
        ? (parsed?.error ?? (parsed?.is_error ? parsed.result : undefined) ?? (stderr.trim() || `claude exited with code ${exitCode}`))
        : undefined,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    // End compliance tracking on error
    if (options.agentConfig) {
      endSession(sessionKey);
    }

    const errorMessage = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      sessionKey,
      durationMs,
      error: errorMessage,
      exitCode: null,
    };
  }
}

// --- Internal helpers ---

/**
 * Build CLI arguments for the claude command.
 */
export function buildCliArgs(
  prompt: string,
  config: ReturnType<typeof resolveClaudeCodeConfig>,
  systemContext?: string,
  options?: { budgetFlag?: BudgetFlag },
): string[] {
  const args: string[] = [
    "-p", prompt,
    "--output-format", "json",
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.permissionMode) {
    args.push("--permission-mode", config.permissionMode);
  }

  if (config.maxBudgetPerDispatch !== undefined) {
    args.push(options?.budgetFlag ?? DEFAULT_BUDGET_FLAG, String(config.maxBudgetPerDispatch));
  }

  if (systemContext) {
    args.push("--append-system-prompt", systemContext);
  }

  if (config.mcpConfigPath) {
    args.push("--mcp-config", config.mcpConfigPath);
  }

  return args;
}

function alternateBudgetFlag(flag: BudgetFlag): BudgetFlag {
  return flag === "--max-budget-usd" ? "--max-turns-cost" : "--max-budget-usd";
}

function shouldRetryWithAlternateBudgetFlag(
  config: ReturnType<typeof resolveClaudeCodeConfig>,
  budgetFlag: BudgetFlag,
  attempt: DispatchAttempt,
): boolean {
  if (config.maxBudgetPerDispatch === undefined) {
    return false;
  }
  if (attempt.exitCode === 0) {
    return false;
  }
  return attempt.stderr.includes(`unknown option '${budgetFlag}'`)
    || attempt.stderr.includes(`unknown option "${budgetFlag}"`);
}

function runDispatchAttempt(
  binary: string,
  prompt: string,
  config: ReturnType<typeof resolveClaudeCodeConfig>,
  systemContext: string | undefined,
  budgetFlag: BudgetFlag,
  options: {
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs: number;
  },
): Promise<DispatchAttempt> {
  const args = buildCliArgs(prompt, config, systemContext, { budgetFlag });
  return spawnClaude(binary, args, options);
}

/**
 * Spawn a claude CLI process and collect output.
 */
function spawnClaude(
  binary: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = _spawn(binary, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Claude CLI binary not found: "${binary}". Is Claude Code installed?`));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Parse Claude Code's JSON output.
 * Returns null if the output is not valid JSON.
 */
export function parseClaudeOutput(stdout: string): ClaudeCodeJsonOutput | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ClaudeCodeJsonOutput;
    }
    return null;
  } catch {
    // stdout might contain non-JSON output (e.g., raw text mode)
    return null;
  }
}
