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

import { execFile, type ChildProcess } from "node:child_process";
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
import type { DispatchQueueItem } from "../../src/types.js";

// --- Configuration ---
const projectId = process.env.CLAWFORCE_PROJECT_ID;
const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const pollIntervalMs = parseInt(process.env.CLAWFORCE_POLL_INTERVAL || "30000", 10);
const maxConcurrent = parseInt(process.env.CLAWFORCE_MAX_CONCURRENT || "2", 10);
const claudeBinary = process.env.CLAUDE_BINARY || "claude";
const claudeModel = process.env.CLAUDE_MODEL;

if (!projectId) {
  process.stderr.write("[clawforce-runner] CLAWFORCE_PROJECT_ID is required\n");
  process.exit(1);
}

// --- State ---
let activeDispatches = 0;
let shutdownRequested = false;
const activeProcesses = new Set<ChildProcess>();

// --- MCP config path (resolved at startup) ---
const mcpConfigPath = path.resolve(import.meta.dirname, "clawforce-mcp.json");

// --- Initialization ---
function init(): void {
  initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3, verificationRequired: true });
  initializeAllDomains(projectsDir);
  log(`Runner started for project "${projectId}" (poll: ${pollIntervalMs}ms, max: ${maxConcurrent})`);
}

function log(msg: string): void {
  process.stderr.write(`[clawforce-runner] ${msg}\n`);
}

// --- Dispatch via Claude CLI ---
async function dispatchViaClaude(
  item: DispatchQueueItem,
  prompt: string,
  agentId: string,
  options?: {
    model?: string;
    projectDir?: string;
    timeoutMs?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args: string[] = [
      "--print",       // Non-interactive, print output
      "--output-format", "text",
    ];

    // Model override
    const model = options?.model || claudeModel;
    if (model) {
      args.push("--model", model);
    }

    // Profile override
    // No --profile flag — use CLAUDE_BINARY env var to select the right binary

    // MCP server config
    args.push("--mcp-config", mcpConfigPath);

    // Prompt goes last
    args.push("--prompt", prompt);

    // Environment variables for the spawned session
    const env = {
      ...process.env,
      CLAWFORCE_PROJECT_ID: item.projectId,
      CLAWFORCE_AGENT_ID: agentId,
      CLAWFORCE_SESSION_KEY: `dispatch:${item.id}`,
      CLAWFORCE_PROJECTS_DIR: projectsDir,
    };

    const startTime = Date.now();

    try {
      const childProcess = execFile(claudeBinary, args, {
        env,
        cwd: options?.projectDir || undefined,
        timeout: options?.timeoutMs || 10 * 60 * 1000, // 10 minute default
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      }, (error, stdout, stderr) => {
        activeProcesses.delete(childProcess);
        const durationMs = Date.now() - startTime;

        if (error) {
          const errorMsg = error.killed
            ? `Timed out after ${durationMs}ms`
            : error.message;
          log(`Dispatch failed for task ${item.taskId}: ${errorMsg}`);
          resolve({ ok: false, error: errorMsg });
        } else {
          log(`Dispatch completed for task ${item.taskId} in ${durationMs}ms`);
          resolve({ ok: true });
        }
      });

      activeProcesses.add(childProcess);
    } catch (err) {
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
