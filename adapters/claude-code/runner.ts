/**
 * ClawForce — Claude Code Runner
 *
 * Standalone dispatch loop that polls the ClawForce dispatch queue
 * and spawns Claude Code sessions for claimed work items.
 *
 * This replaces the OpenClaw cron-based dispatch for environments
 * where Claude Code is the agent runtime (no OpenClaw gateway).
 *
 * Usage:
 *   CLAWFORCE_PROJECT_ID=myproject node dist/adapters/claude-code/runner.js
 *
 * Environment:
 *   CLAWFORCE_PROJECT_ID    — Project to poll (required)
 *   CLAWFORCE_PROJECTS_DIR  — Config directory (default: ~/.clawforce)
 *   CLAWFORCE_POLL_INTERVAL — Poll interval in ms (default: 30000)
 *   CLAWFORCE_MAX_CONCURRENT — Max concurrent dispatches (default: 2)
 *   CLAUDE_PROFILE          — Claude CLI profile to use
 *   CLAUDE_MODEL            — Default model override
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initClawforce } from "../../src/lifecycle.js";
import { initializeAllDomains } from "../../src/config/init.js";
import { getAgentConfig, resolveProjectDir } from "../../src/project.js";
import { claimNext, completeItem, failItem, reclaimExpiredLeases } from "../../src/dispatch/queue.js";
import { getTask } from "../../src/tasks/ops.js";
import { acquireTaskLease, releaseTaskLease } from "../../src/tasks/ops.js";
import { buildTaskPrompt } from "../../src/dispatch/spawn.js";
import { buildRetryContext } from "../../src/dispatch/dispatcher.js";
import { shouldDispatch } from "../../src/dispatch/dispatcher.js";
import { getDb } from "../../src/db.js";
import { writeAuditEntry } from "../../src/audit.js";
import { recordMetric } from "../../src/metrics.js";
import { assembleContext } from "../../src/context/assembler.js";
import type { DispatchQueueItem } from "../../src/types.js";

// --- Configuration ---
const projectId = process.env.CLAWFORCE_PROJECT_ID;
const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const pollIntervalMs = parseInt(process.env.CLAWFORCE_POLL_INTERVAL || "30000", 10);
const maxConcurrent = parseInt(process.env.CLAWFORCE_MAX_CONCURRENT || "2", 10);
const claudeBinary = process.env.CLAUDE_BINARY || `${process.env.HOME}/.local/bin/claude`;
// Use isolated config dir for dispatched agents — keeps hooks separate from user's personal CC config
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || `${projectsDir}/claude-config`;
const claudeModel = process.env.CLAUDE_MODEL;

if (!projectId) {
  process.stderr.write("[clawforce-runner] CLAWFORCE_PROJECT_ID is required\n");
  process.exit(1);
}

// --- State ---
let activeDispatches = 0;
let shutdownRequested = false;
const activeProcesses = new Set<ChildProcess>();

// --- MCP server script path ---
const mcpServerPath = path.resolve(import.meta.dirname, "../mcp-server.js");

// --- Temp dir for per-dispatch MCP configs ---
const tmpDir = path.join(projectsDir, "tmp");

// --- Initialization ---
function init(): void {
  initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3, verificationRequired: true });
  initializeAllDomains(projectsDir);
  log(`Runner started for project "${projectId}" (poll: ${pollIntervalMs}ms, max: ${maxConcurrent})`);
}

function log(msg: string): void {
  process.stderr.write(`[clawforce-runner] ${msg}\n`);
}

/**
 * Generate a per-dispatch MCP config file.
 * Each dispatch gets its own config so env vars are isolated.
 */
function generateMcpConfig(dispatchId: string, agentId: string): string {
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, `mcp-config-${dispatchId}.json`);

  const config = {
    mcpServers: {
      clawforce: {
        command: "node",
        args: [mcpServerPath],
        env: {
          CLAWFORCE_PROJECT_ID: projectId!,
          CLAWFORCE_AGENT_ID: agentId,
          CLAWFORCE_SESSION_KEY: `dispatch:${dispatchId}`,
          CLAWFORCE_PROJECTS_DIR: projectsDir,
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Clean up a per-dispatch MCP config file.
 */
function cleanupMcpConfig(dispatchId: string): void {
  try {
    fs.unlinkSync(path.join(tmpDir, `mcp-config-${dispatchId}.json`));
  } catch {
    // Ignore cleanup errors
  }
}

// --- Dispatch via Claude CLI (rentright pattern) ---
async function dispatchViaClaude(
  item: DispatchQueueItem,
  prompt: string,
  agentId: string,
  options?: {
    model?: string;
    projectDir?: string;
    timeoutMs?: number;
    agentEntry?: { config: import("../../src/types.js").AgentConfig; projectDir?: string };
  },
): Promise<{ ok: boolean; error?: string; output?: string }> {
  // Generate per-dispatch MCP config
  const mcpConfigPath = generateMcpConfig(item.id, agentId);

  const args: string[] = [
    "--print",
    "--output-format", "text",
    "--mcp-config", mcpConfigPath,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--max-turns", "25",
  ];

  // Model override
  const model = options?.model || claudeModel;
  if (model) {
    args.push("--model", model);
  }

  // Assemble ClawForce governance context for the agent
  const agentEntry = options?.agentEntry;
  const contextParts: string[] = [];

  if (agentEntry) {
    const systemContext = assembleContext(agentId, agentEntry.config, {
      projectId: item.projectId,
      projectDir: agentEntry.projectDir,
      sessionKey: `dispatch:${item.id}`,
      taskId: item.taskId,
      queueItemId: item.id,
    });
    if (systemContext) {
      contextParts.push(systemContext);
    }
  }

  // Lifecycle instructions go in the prompt, not system prompt (agents follow prompt instructions more reliably)

  if (contextParts.length > 0) {
    args.push("--append-system-prompt", contextParts.join("\n\n"));
  }

  // Prompt
  args.push(prompt);

  // Clean environment — prevent inheriting parent session state
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  env.CLAUDE_CODE_DONT_INHERIT_ENV = "1";
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.CLAWFORCE_PROJECT_ID = item.projectId;
  env.CLAWFORCE_AGENT_ID = agentId;
  env.CLAWFORCE_SESSION_KEY = `dispatch:${item.id}`;
  env.CLAWFORCE_PROJECTS_DIR = projectsDir;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";

    try {
      const proc = spawn(claudeBinary, args, {
        cwd: options?.projectDir || undefined,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      activeProcesses.add(proc);

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Timeout
      const timeoutMs = options?.timeoutMs || 10 * 60 * 1000;
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        activeProcesses.delete(proc);
        cleanupMcpConfig(item.id);

        const durationMs = Date.now() - startTime;

        if (code !== 0 && code !== null) {
          const errorMsg = stderr.slice(-500) || `Exit code ${code}`;
          log(`Dispatch failed for task ${item.taskId} (exit ${code}, ${durationMs}ms): ${errorMsg}`);
          resolve({ ok: false, error: errorMsg });
        } else {
          log(`Dispatch completed for task ${item.taskId} in ${durationMs}ms`);
          resolve({ ok: true, output: stdout });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        activeProcesses.delete(proc);
        cleanupMcpConfig(item.id);
        resolve({ ok: false, error: `Spawn error: ${err.message}` });
      });
    } catch (err) {
      cleanupMcpConfig(item.id);
      resolve({
        ok: false,
        error: `Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

// --- Main dispatch loop ---
async function tick(): Promise<number> {
  if (shutdownRequested) return 0;

  const db = getDb(projectId!);
  let dispatched = 0;

  // Reclaim expired leases
  try {
    reclaimExpiredLeases(projectId!, db);
  } catch (err) {
    log(`Lease reclaim error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Process items while we have capacity
  while (activeDispatches < maxConcurrent && !shutdownRequested) {
    const item = claimNext(projectId!, undefined, undefined, db);
    if (!item) break; // No more queued items

    const task = getTask(projectId!, item.taskId, db);
    if (!task) {
      failItem(item.id, `Task not found: ${item.taskId}`, db, projectId!);
      continue;
    }

    // Only dispatch tasks in valid states
    if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
      failItem(item.id, `Task in non-dispatchable state: ${task.state}`, db, projectId!);
      continue;
    }

    // Resolve agent ID
    const payload = item.payload ?? {};
    const agentId = task.assignedTo ?? (payload.profile ? `claude-code:${payload.profile as string}` : "claude-code:worker");

    // Pre-dispatch gate check (budget, rate limits)
    const gateCheck = shouldDispatch(projectId!, agentId, undefined, { taskId: item.taskId });
    if (!gateCheck.ok) {
      failItem(item.id, gateCheck.reason, db, projectId!);
      log(`Gate blocked dispatch for task ${item.taskId}: ${gateCheck.reason}`);
      continue;
    }

    // Acquire task lease
    const holder = `runner:${item.id}`;
    const LEASE_MS = 2 * 60 * 60 * 1000; // 2 hours
    const leaseOk = acquireTaskLease(projectId!, item.taskId, holder, LEASE_MS, db);
    if (!leaseOk) {
      failItem(item.id, "Could not acquire task lease", db, projectId!);
      continue;
    }

    // Build prompt
    const userPrompt = (payload.prompt as string) ?? `Execute task: ${task.title}`;
    const prompt = buildTaskPrompt(task, userPrompt);
    const retryContext = buildRetryContext(projectId!, item.taskId, db);
    const fullPrompt = retryContext ? `${prompt}\n\n${retryContext}` : prompt;

    // Resolve agent config for project dir
    const agentEntry = getAgentConfig(agentId);
    const projectDir = agentEntry?.projectDir || (payload.projectDir as string) || undefined;
    const model = (payload.model as string) || undefined;
    const timeoutMs = (payload.timeoutMs as number) || undefined;

    // Dispatch asynchronously
    activeDispatches++;
    dispatched++;

    dispatchViaClaude(item, fullPrompt, agentId, {
      model,
      projectDir,
      timeoutMs,
      agentEntry: agentEntry ? { config: agentEntry.config, projectDir: agentEntry.projectDir } : undefined,
    }).then((result) => {
      activeDispatches--;

      if (result.ok) {
        // Check if task state advanced (mark complete) or stayed stuck (mark failed)
        try {
          const taskAfter = getTask(projectId!, item.taskId, db);
          if (taskAfter && taskAfter.state !== "ASSIGNED" && taskAfter.state !== "IN_PROGRESS") {
            completeItem(item.id, db, projectId!);
            log(`Queue item ${item.id} completed (task ${item.taskId} -> ${taskAfter.state})`);
          } else {
            failItem(item.id, `Task remained in ${taskAfter?.state ?? "unknown"} after dispatch`, db, projectId!);
            log(`Queue item ${item.id} failed — task state unchanged`);
          }
        } catch (err) {
          failItem(item.id, `Completion check error: ${err instanceof Error ? err.message : String(err)}`, db, projectId!);
        }
      } else {
        failItem(item.id, result.error ?? "Unknown dispatch error", db, projectId!);
      }

      // Release task lease
      try {
        releaseTaskLease(projectId!, item.taskId, holder, db);
      } catch (err) {
        log(`Lease release error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Record metric
      try {
        recordMetric({
          projectId: projectId!,
          type: "dispatch",
          subject: item.taskId,
          key: result.ok ? "dispatch_success" : "dispatch_failure",
          value: 1,
          tags: { queueItemId: item.id, runner: "claude-code" },
        }, db);
      } catch {
        // Non-critical
      }

      // Audit entry
      try {
        writeAuditEntry({
          projectId: projectId!,
          actor: "runner:claude-code",
          action: result.ok ? "dispatch_success" : "dispatch_failure",
          targetType: "task",
          targetId: item.taskId,
          detail: JSON.stringify({ queueItemId: item.id, error: result.error }),
        }, db);
      } catch {
        // Non-critical
      }
    }).catch((err) => {
      activeDispatches--;
      log(`Unhandled dispatch error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return dispatched;
}

// --- Poll loop ---
async function run(): Promise<void> {
  init();

  const poll = async (): Promise<void> => {
    if (shutdownRequested) return;

    try {
      const dispatched = await tick();
      if (dispatched > 0) {
        log(`Dispatched ${dispatched} item(s)`);
      }
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!shutdownRequested) {
      setTimeout(poll, pollIntervalMs);
    }
  };

  await poll();
}

// --- Graceful shutdown ---
function shutdown(): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  log("Shutting down...");

  // Kill active child processes
  for (const proc of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  // Give processes time to clean up, then exit
  setTimeout(() => {
    if (activeDispatches > 0) {
      log(`Force exit with ${activeDispatches} active dispatch(es)`);
    }
    process.exit(0);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the runner
run().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
