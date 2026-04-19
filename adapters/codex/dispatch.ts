/**
 * Clawforce — Codex CLI dispatch
 *
 * Spawns `codex exec` processes for local OpenAI-backed dispatches.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_HEARTBEAT_INTERVAL_MS,
  heartbeatSession,
  startTracking,
  endSession,
  recordSessionProgress,
  setDispatchContext,
  setSessionProcessId,
} from "../../src/enforcement/tracker.js";
import { checkCompliance } from "../../src/enforcement/check.js";
import { archiveSession } from "../../src/telemetry/session-archive.js";
import type { AgentConfig } from "../../src/types.js";
import { resolveCodexConfig, type CodexConfig } from "./types.js";

export type DispatchOptions = {
  agentId: string;
  projectId: string;
  prompt: string;
  systemContext?: string;
  config?: Partial<CodexConfig>;
  timeoutMs?: number;
  sessionKey?: string;
  agentConfig?: AgentConfig;
  extraEnv?: Record<string, string>;
  taskId?: string;
  queueItemId?: string;
  jobName?: string;
  mcpBridgeDisabled?: boolean;
};

export type DispatchResult = {
  ok: boolean;
  sessionKey: string;
  result?: string;
  summarySynthetic?: boolean;
  observedWork?: boolean;
  model?: string;
  durationMs: number;
  error?: string;
  compliant?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  terminatedReason?: string;
  timeoutMs?: number;
  logicalCompletion?: boolean;
  stdout?: string;
  stderr?: string;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

type ActiveCodexProcess = {
  proc: ChildProcess;
  terminatedReason?: string;
};

let _spawn: SpawnFn = spawn as unknown as SpawnFn;
const activeCodexProcesses = new Map<string, ActiveCodexProcess>();

export function _setSpawnForTest(fn: SpawnFn | null): void {
  _spawn = fn ?? (spawn as unknown as SpawnFn);
}

export async function killCodexSession(sessionKey: string, reason: string): Promise<boolean> {
  const active = activeCodexProcesses.get(sessionKey);
  if (!active) return false;

  active.terminatedReason = reason;
  try {
    active.proc.kill("SIGTERM");
  } catch {
    return false;
  }

  setTimeout(() => {
    const stillActive = activeCodexProcesses.get(sessionKey);
    if (stillActive && !stillActive.proc.killed) {
      try {
        stillActive.proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, 5_000).unref?.();

  return true;
}

export function buildDispatchPrompt(prompt: string, systemContext?: string): string {
  if (!systemContext?.trim()) {
    return prompt;
  }
  return [
    "<system_context>",
    systemContext.trim(),
    "</system_context>",
    "",
    "<task>",
    prompt.trim(),
    "</task>",
  ].join("\n");
}

export function buildCliArgs(
  prompt: string,
  config: ReturnType<typeof resolveCodexConfig>,
  outputPath: string,
): string[] {
  const args: string[] = ["exec"];

  for (const override of config.configOverrides ?? []) {
    args.push("-c", override);
  }

  args.push(
    prompt,
    "--output-last-message",
    outputPath,
    "--ephemeral",
  );

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    if (config.approvalPolicy) {
      args.push("-a", config.approvalPolicy);
    }

    if (config.fullAuto && !config.approvalPolicy) {
      args.push("--full-auto");
    } else if (config.sandbox) {
      args.push("--sandbox", config.sandbox);
    }
  }

  if (config.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (config.workdir) {
    args.push("--cd", config.workdir);
  }

  for (const addDir of config.addDirs ?? []) {
    args.push("--add-dir", addDir);
  }

  return args;
}

export async function dispatchViaCodex(options: DispatchOptions): Promise<DispatchResult> {
  const cfg = resolveCodexConfig(options.config);
  const sessionKey = options.sessionKey ?? `codex-${crypto.randomUUID()}`;
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const trackingConfig = options.agentConfig ?? createFallbackTrackingConfig();

  startTracking(sessionKey, options.agentId, options.projectId, trackingConfig, undefined, {
    expectsToolTelemetry: options.mcpBridgeDisabled !== true,
  });
  if (options.taskId && options.queueItemId) {
    setDispatchContext(sessionKey, {
      taskId: options.taskId,
      queueItemId: options.queueItemId,
    });
  }

  const heartbeatTimer = setInterval(() => heartbeatSession(sessionKey), SESSION_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer?.unref?.();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-codex-"));
  const outputPath = path.join(tmpDir, `${sessionKey}-last-message.txt`);

  try {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CLAWFORCE_AGENT_ID: options.agentId,
      CLAWFORCE_SESSION_KEY: sessionKey,
      CLAWFORCE_PROJECT_ID: options.projectId,
      ...(options.extraEnv ?? {}),
    };

    const finalPrompt = buildDispatchPrompt(options.prompt, options.systemContext);
    const args = buildCliArgs(finalPrompt, cfg, outputPath);
    const { stdout, stderr, exitCode, signal, terminatedReason, logicalCompletion } = await spawnCodex(cfg.binary, args, {
      env,
      cwd: cfg.workdir,
      timeoutMs,
      sessionKey,
      outputPath,
      allowTranscriptCompletion: options.mcpBridgeDisabled === true,
    });

    const durationMs = Date.now() - startTime;
    const ok = logicalCompletion === true || (exitCode === 0 && !signal);
    const resultPayload = deriveResultText({
      sessionKey,
      outputPath,
      stdout,
      stderr,
      ok,
      allowTranscriptSummary: options.mcpBridgeDisabled === true,
    });
    const resultText = resultPayload.text;

    let compliant: boolean | undefined;
    let observedWork = false;
    const session = endSession(sessionKey);
    if (session) {
      const complianceObserved = session.metrics.toolCalls.length > 0;
      observedWork = complianceObserved;
      if (complianceObserved) {
        compliant = checkCompliance(session).compliant;
      }
      try {
        archiveSession({
          sessionKey,
          agentId: options.agentId,
          projectId: options.projectId,
          transcript: resultText,
          outcome: complianceObserved
            ? (compliant ? "compliant" : "non_compliant")
            : (ok ? "untracked" : "failed"),
          exitSignal: ok ? "success" : "error",
          complianceDetail: JSON.stringify({
            complianceObserved,
            compliant,
            exitCode,
            signal,
            terminatedReason,
            timeoutMs,
            logicalCompletion,
            stderr,
            stdout,
            summarySynthetic: resultPayload.synthetic,
            observedWork,
            resultSource: resultPayload.source,
            outputFilePresent: resultPayload.outputFilePresent,
            outputChars: resultPayload.outputChars,
            outputLooksLikeLaunchTranscript: resultPayload.outputLooksLikeLaunchTranscript,
            stdoutChars: resultPayload.stdoutChars,
            stdoutLooksLikeLaunchTranscript: resultPayload.stdoutLooksLikeLaunchTranscript,
            stderrChars: resultPayload.stderrChars,
            stderrLooksLikeLaunchTranscript: resultPayload.stderrLooksLikeLaunchTranscript,
            promptChars: options.prompt.length,
            systemContextChars: options.systemContext?.length ?? 0,
            finalPromptChars: finalPrompt.length,
            mcpBridgeDisabled: options.mcpBridgeDisabled === true,
            configOverrideCount: cfg.configOverrides?.length ?? 0,
            binary: cfg.binary,
            cwd: cfg.workdir ?? null,
          }),
          taskId: options.taskId,
          queueItemId: options.queueItemId,
          jobName: options.jobName ?? session.jobName,
          model: cfg.model,
          provider: "codex",
          startedAt: session.metrics.startedAt,
          endedAt: Date.now(),
          durationMs,
          toolCallCount: session.metrics.toolCalls.length,
          errorCount: session.metrics.errorCount,
        });
      } catch {
        // telemetry should never break dispatch completion
      }
    }

    return {
      ok,
      sessionKey,
      result: resultText,
      summarySynthetic: resultPayload.synthetic,
      observedWork,
      model: cfg.model,
      durationMs,
      compliant,
      exitCode,
      signal,
      terminatedReason,
      timeoutMs,
      logicalCompletion,
      stdout,
      stderr,
      error: ok ? undefined : (terminatedReason || stderr.trim() || stdout.trim() || (signal ? `codex terminated by ${signal}` : `codex exited with code ${exitCode}`)),
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    endSession(sessionKey);
    return {
      ok: false,
      sessionKey,
      durationMs,
      exitCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function createFallbackTrackingConfig(): AgentConfig {
  return {
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" },
  };
}

function readMaybeFile(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function looksLikeCodexLaunchTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("Reading additional input from stdin...\nOpenAI Codex v")
    || (
      trimmed.startsWith("OpenAI Codex v")
      && trimmed.includes("<task-metadata")
      && !trimmed.includes("**Completed**")
      && !trimmed.includes("**Done**")
    );
}

function stripLaunchPromptEcho(text: string): string {
  if (!text.includes("Reading additional input from stdin...")) {
    return text;
  }
  const taskClose = text.lastIndexOf("</task>");
  if (taskClose >= 0) {
    return text.slice(taskClose + "</task>".length).trimStart();
  }
  return text;
}

function stripTranscriptPrefix(line: string): string {
  return line.replace(/^\+\s?/, "");
}

function isTranscriptNoiseLine(line: string): boolean {
  const trimmed = stripTranscriptPrefix(line).trim();
  if (!trimmed) return true;
  return trimmed === "codex"
    || trimmed === "exec"
    || trimmed === "user"
    || trimmed === "--------"
    || trimmed.startsWith("mcp: ")
    || trimmed.startsWith("/bin/zsh -lc")
    || trimmed.startsWith("Reading additional input from stdin...")
    || trimmed.startsWith("OpenAI Codex v")
    || trimmed.startsWith("workdir:")
    || trimmed.startsWith("model:")
    || trimmed.startsWith("provider:")
    || trimmed.startsWith("approval:")
    || trimmed.startsWith("sandbox:")
    || trimmed.startsWith("reasoning effort:")
    || trimmed.startsWith("reasoning summaries:")
    || trimmed.startsWith("session id:")
    || trimmed.startsWith("succeeded in ")
    || trimmed.startsWith("failed in ");
}

function containsTranscriptProgressSignal(text: string): boolean {
  return /(?:^|\n)(exec|apply_patch|open|click|find|screenshot|mcp: )/i.test(text)
    || /\bsucceeded in \d+(?:ms|s)\b/i.test(text)
    || /\bfailed in \d+(?:ms|s)\b/i.test(text);
}

function transcriptSignalsCompletion(text: string): boolean {
  return /\btokens used\b/i.test(text)
    || (
      /(?:^|\n)\+?##\s+Action Taken\b/i.test(text)
      && /(?:^|\n)\+?##\s+Reviewer Check\b/i.test(text)
    );
}

function extractSubstantiveTranscriptSummary(text: string): string | undefined {
  const trimmed = stripLaunchPromptEcho(text).trim();
  if (!trimmed || !containsTranscriptProgressSignal(trimmed)) {
    return undefined;
  }

  const lines = trimmed.split(/\r?\n/).map(stripTranscriptPrefix);
  while (lines.length > 0 && /^\s*tokens used\b/i.test(lines.at(-1) ?? "")) {
    lines.pop();
  }
  while (lines.length > 0 && /^[\d,\s]+$/.test(lines.at(-1) ?? "")) {
    lines.pop();
  }
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }

  const tail = lines.slice(-160);
  const firstHeading = tail.findIndex((line) => /^##\s+/.test(line.trim()));
  if (firstHeading >= 0) {
    const excerpt = tail.slice(firstHeading).join("\n").trim();
    if (excerpt.length >= 80) {
      return excerpt;
    }
  }

  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (tail[index]?.trim().toLowerCase() !== "codex") continue;
    const excerpt = tail
      .slice(index + 1)
      .filter((line) => !isTranscriptNoiseLine(line))
      .join("\n")
      .trim();
    if (excerpt.length >= 40) {
      return excerpt;
    }
  }

  const excerpt = tail
    .filter((line) => !isTranscriptNoiseLine(line))
    .join("\n")
    .trim();
  return excerpt.length >= 80 ? excerpt : undefined;
}

function deriveResultText(params: {
  sessionKey: string;
  outputPath: string;
  stdout: string;
  stderr: string;
  ok: boolean;
  allowTranscriptSummary: boolean;
}): {
  text?: string;
  synthetic: boolean;
  source: "output_file" | "stdout" | "stderr" | "synthetic";
  outputFilePresent: boolean;
  outputChars: number;
  outputLooksLikeLaunchTranscript: boolean;
  stdoutChars: number;
  stdoutLooksLikeLaunchTranscript: boolean;
  stderrChars: number;
  stderrLooksLikeLaunchTranscript: boolean;
} {
  const fileText = readMaybeFile(params.outputPath);
  const stdoutText = params.stdout.trim();
  const stderrText = params.stderr.trim();
  const normalizedStderrText = stripLaunchPromptEcho(stderrText).trim();
  const outputLooksLikeLaunchTranscript = fileText ? looksLikeCodexLaunchTranscript(fileText) : false;
  const stdoutLooksLikeLaunchTranscript = stdoutText ? looksLikeCodexLaunchTranscript(stdoutText) : false;
  const stderrLooksLikeLaunchTranscript = stderrText ? looksLikeCodexLaunchTranscript(stderrText) : false;

  if (fileText && !outputLooksLikeLaunchTranscript) {
    return {
      text: fileText,
      synthetic: false,
      source: "output_file",
      outputFilePresent: true,
      outputChars: fileText.length,
      outputLooksLikeLaunchTranscript,
      stdoutChars: stdoutText.length,
      stdoutLooksLikeLaunchTranscript,
      stderrChars: stderrText.length,
      stderrLooksLikeLaunchTranscript,
    };
  }

  if (stdoutText && !stdoutLooksLikeLaunchTranscript) {
    return {
      text: stdoutText,
      synthetic: false,
      source: "stdout",
      outputFilePresent: Boolean(fileText),
      outputChars: fileText?.length ?? 0,
      outputLooksLikeLaunchTranscript,
      stdoutChars: stdoutText.length,
      stdoutLooksLikeLaunchTranscript,
      stderrChars: stderrText.length,
      stderrLooksLikeLaunchTranscript,
    };
  }

  const transcriptSummary = params.allowTranscriptSummary
    ? extractSubstantiveTranscriptSummary(stderrText)
    : undefined;
  if (transcriptSummary) {
    return {
      text: transcriptSummary,
      synthetic: false,
      source: "stderr",
      outputFilePresent: Boolean(fileText),
      outputChars: fileText?.length ?? 0,
      outputLooksLikeLaunchTranscript,
      stdoutChars: stdoutText.length,
      stdoutLooksLikeLaunchTranscript,
      stderrChars: stderrText.length,
      stderrLooksLikeLaunchTranscript,
    };
  }

  if (!params.ok && normalizedStderrText) {
    return {
      text: normalizedStderrText,
      synthetic: false,
      source: "stderr",
      outputFilePresent: Boolean(fileText),
      outputChars: fileText?.length ?? 0,
      outputLooksLikeLaunchTranscript,
      stdoutChars: stdoutText.length,
      stdoutLooksLikeLaunchTranscript,
      stderrChars: stderrText.length,
      stderrLooksLikeLaunchTranscript,
    };
  }

  if (!params.ok) {
    return {
      text: undefined,
      synthetic: false,
      source: "stderr",
      outputFilePresent: Boolean(fileText),
      outputChars: fileText?.length ?? 0,
      outputLooksLikeLaunchTranscript,
      stdoutChars: stdoutText.length,
      stdoutLooksLikeLaunchTranscript,
      stderrChars: stderrText.length,
      stderrLooksLikeLaunchTranscript,
    };
  }
  return {
    text: [
      "**Completed**",
      "",
      `Codex session ${params.sessionKey} exited successfully but returned no final summary.`,
      "Review any changed files and the archived session detail before approving this task.",
    ].join("\n"),
    synthetic: true,
    source: "synthetic",
    outputFilePresent: Boolean(fileText),
    outputChars: fileText?.length ?? 0,
    outputLooksLikeLaunchTranscript,
    stdoutChars: stdoutText.length,
    stdoutLooksLikeLaunchTranscript,
    stderrChars: stderrText.length,
    stderrLooksLikeLaunchTranscript,
  };
}

function spawnCodex(
  binary: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs: number;
    sessionKey: string;
    outputPath: string;
    allowTranscriptCompletion?: boolean;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; terminatedReason?: string; logicalCompletion?: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = _spawn(binary, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    activeCodexProcesses.set(options.sessionKey, { proc });
    setSessionProcessId(options.sessionKey, proc.pid ?? null);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrTail = "";
    let logicalCompletion = false;
    let completionRequested = false;

    const requestGracefulCompletion = (reason: string) => {
      const active = activeCodexProcesses.get(options.sessionKey);
      if (!active || completionRequested) return;
      completionRequested = true;
      logicalCompletion = true;
      active.terminatedReason = reason;
      try {
        active.proc.kill("SIGTERM");
      } catch {
        // best effort
      }
      setTimeout(() => {
        const stillActive = activeCodexProcesses.get(options.sessionKey);
        if (stillActive && !stillActive.proc.killed) {
          try {
            stillActive.proc.kill("SIGKILL");
          } catch {
            // best effort
          }
        }
      }, 5_000).unref?.();
    };

    const completionPoll = setInterval(() => {
      const fileText = readMaybeFile(options.outputPath);
      if (!fileText || looksLikeCodexLaunchTranscript(fileText)) return;
      requestGracefulCompletion("Clawforce output capture completed");
    }, 2_000);
    completionPoll.unref?.();

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const chunkText = chunk.toString("utf-8");
      if (options.allowTranscriptCompletion === true && containsTranscriptProgressSignal(chunkText)) {
        recordSessionProgress(options.sessionKey);
      }
      stderrTail = `${stderrTail}${chunkText}`.slice(-200_000);
      const completionTail = stripLaunchPromptEcho(stderrTail);
      if (
        options.allowTranscriptCompletion === true
        && !completionRequested
        && completionTail.trim()
        && transcriptSignalsCompletion(completionTail)
        && extractSubstantiveTranscriptSummary(completionTail)
      ) {
        requestGracefulCompletion("Clawforce transcript completion detected");
      }
    });

    proc.on("error", (err) => {
      clearInterval(completionPoll);
      activeCodexProcesses.delete(options.sessionKey);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Codex CLI binary not found: "${binary}". Is Codex installed?`));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code, signal) => {
      clearInterval(completionPoll);
      const active = activeCodexProcesses.get(options.sessionKey);
      activeCodexProcesses.delete(options.sessionKey);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
        signal,
        terminatedReason: active?.terminatedReason,
        logicalCompletion,
      });
    });
  });
}
