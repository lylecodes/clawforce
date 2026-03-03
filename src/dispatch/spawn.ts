/**
 * Clawforce — Claude Code dispatch (subprocess path)
 *
 * Spawns `claude` CLI as a child process, captures output as evidence.
 * Uses child_process.spawn — NOT OpenClaw's subagent system (sessions_spawn).
 *
 * This is the dispatch path for `claude-code` worker type in project config.
 * Orchestrators using `openclaw-agent` workers dispatch via sessions_spawn instead,
 * and those workers get context via the bootstrap hook in orchestrator-bootstrap.ts.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recordCost } from "../cost.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { recordDispatchMetric } from "../metrics.js";
import { attachEvidence, transitionTask } from "../tasks/ops.js";
import type { Task } from "../types.js";

export type DispatchOptions = {
  task: Task;
  projectDir: string;
  prompt: string;
  profile?: string;
  model?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  maxTurns?: number;
};

export type DispatchResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  evidenceId?: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function dispatchClaudeCode(options: DispatchOptions): Promise<DispatchResult> {
  const { task, projectDir, prompt, profile, model, timeoutMs, allowedTools, maxTurns } = options;
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  try {
    emitDiagnosticEvent({
      type: "clawforce.dispatch",
      projectId: task.projectId,
      taskId: task.id,
      action: "start",
    });
  } catch (err) {
    safeLog("dispatch.start", err);
  }

  const args: string[] = [
    "--print",
    "--output-format", "json",
  ];

  if (profile) {
    args.push("--profile", profile);
  }
  if (model) {
    args.push("--model", model);
  }
  if (allowedTools) {
    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  // Build the full prompt with task context
  const fullPrompt = buildTaskPrompt(task, prompt);
  args.push(fullPrompt);

  // Validate project directory exists and is a directory
  const resolvedDir = path.resolve(projectDir);
  try {
    const stat = fs.statSync(resolvedDir);
    if (!stat.isDirectory()) {
      return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid project directory (not a directory): ${projectDir}`, durationMs: 0 };
    }
  } catch {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Invalid project directory (does not exist): ${projectDir}`, durationMs: 0 };
  }

  return new Promise<DispatchResult>((resolve) => {
    const proc = spawn("claude", args, {
      cwd: resolvedDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      const durationMs = Date.now() - startTime;

      // Parse JSON output to extract text result and token usage
      let outputText = stdout;
      let tokenUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } = {};
      try {
        const parsed = JSON.parse(stdout);
        // Claude CLI JSON format: { result: string, usage: { input_tokens, output_tokens, ... } }
        if (typeof parsed === "object" && parsed !== null) {
          if (typeof parsed.result === "string") {
            outputText = parsed.result;
          }
          if (parsed.usage && typeof parsed.usage === "object") {
            tokenUsage = {
              inputTokens: parsed.usage.input_tokens ?? 0,
              outputTokens: parsed.usage.output_tokens ?? 0,
              cacheReadTokens: parsed.usage.cache_read_input_tokens ?? parsed.usage.cache_read_tokens ?? 0,
              cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? parsed.usage.cache_write_tokens ?? 0,
            };
          }
        }
      } catch {
        // Not valid JSON — use raw stdout as text
        outputText = stdout;
      }

      // Attach output as evidence
      let evidenceId: string | undefined;
      if (outputText.trim()) {
        try {
          const evidence = attachEvidence({
            projectId: task.projectId,
            taskId: task.id,
            type: "output",
            content: outputText,
            attachedBy: `claude-code:${profile ?? "default"}`,
            metadata: { exitCode, durationMs, model },
          });
          evidenceId = evidence.id;
        } catch (err) {
          safeLog("dispatch.evidence", err);
        }
      }

      const ok = exitCode === 0;

      // Record dispatch metric
      try {
        recordDispatchMetric(task.projectId, task.id, {
          durationMs,
          exitCode,
          profile: options.profile,
          model: options.model,
        });
      } catch (err) {
        safeLog("dispatch.metrics", err);
      }

      // Record cost if we have token data
      if (tokenUsage.inputTokens || tokenUsage.outputTokens) {
        try {
          recordCost({
            projectId: task.projectId,
            agentId: `claude-code:${profile ?? "default"}`,
            taskId: task.id,
            inputTokens: tokenUsage.inputTokens ?? 0,
            outputTokens: tokenUsage.outputTokens ?? 0,
            cacheReadTokens: tokenUsage.cacheReadTokens ?? 0,
            cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0,
            model: options.model,
            source: "dispatch",
          });
        } catch (err) {
          safeLog("dispatch.cost", err);
        }
      }

      try {
        emitDiagnosticEvent({
          type: "clawforce.dispatch",
          projectId: task.projectId,
          taskId: task.id,
          action: ok ? "complete" : "fail",
          durationMs,
          exitCode,
        });
      } catch (err) {
        safeLog("dispatch.complete", err);
      }

      resolve({ ok, exitCode, stdout: outputText, stderr, durationMs, evidenceId });
    });

    proc.on("error", (spawnErr) => {
      const durationMs = Date.now() - startTime;

      try {
        emitDiagnosticEvent({
          type: "clawforce.dispatch",
          projectId: task.projectId,
          taskId: task.id,
          action: "fail",
          durationMs,
        });
      } catch (diagnosticErr) {
        safeLog("dispatch.error", diagnosticErr);
      }

      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: stderr + `\nSpawn error: ${spawnErr.message}`,
        durationMs,
      });
    });
  });
}

/**
 * Dispatch and auto-transition: IN_PROGRESS → REVIEW on success.
 */
export async function dispatchAndTransition(options: DispatchOptions): Promise<DispatchResult> {
  const result = await dispatchClaudeCode(options);

  if (result.ok && result.evidenceId) {
    const transResult = transitionTask({
      projectId: options.task.projectId,
      taskId: options.task.id,
      toState: "REVIEW",
      actor: `claude-code:${options.profile ?? "default"}`,
      evidenceId: result.evidenceId,
      reason: "Claude Code dispatch completed successfully",
    });
    if (!transResult.ok) {
      return {
        ...result,
        ok: false,
        stderr: result.stderr + `\nPost-dispatch transition to REVIEW failed: ${transResult.reason}`,
      };
    }
  }

  return result;
}

function buildTaskPrompt(task: Task, userPrompt: string): string {
  const parts: string[] = [
    `# Task: ${task.title}`,
  ];

  if (task.description) {
    parts.push(`\n## Description\n${task.description}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`\nTags: ${task.tags.join(", ")}`);
  }

  parts.push(`\n## Instructions\n${userPrompt}`);

  return parts.join("\n");
}
