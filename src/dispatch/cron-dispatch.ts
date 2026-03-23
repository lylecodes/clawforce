/**
 * Clawforce — Cron-based dispatch (direct file write)
 *
 * Creates one-shot cron jobs by writing directly to OpenClaw's cron jobs file.
 * This bypasses the cron service API (which requires gateway request context)
 * and instead writes to the JSON file that the cron scheduler reads.
 *
 * After writing, triggers a cron wake to process the new job immediately.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeLog } from "../diagnostics.js";

// Re-export getCronService/setCronService for backward compat
export { getCronService, setCronService } from "../manager-cron.js";

export type CronDispatchResult = {
  ok: boolean;
  cronJobName?: string;
  error?: string;
};

/**
 * Resolve the cron jobs file path.
 * Default: ~/.openclaw/cron/jobs.json
 */
function getCronJobsPath(): string {
  return path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
}

/**
 * Dispatch a task by writing a one-shot cron job directly to the jobs file.
 * The cron job embeds a `[clawforce:dispatch=...]` tag so the
 * `before_prompt_build` hook can link the session to the dispatch queue item.
 */
export async function dispatchViaCron(options: {
  queueItemId: string;
  taskId: string;
  projectId: string;
  prompt: string;
  agentId: string;
  model?: string;
  timeoutSeconds?: number;
}): Promise<CronDispatchResult> {
  const cronJobName = `dispatch:${options.queueItemId}`;
  const jobId = crypto.randomUUID();
  const now = Date.now();

  const taggedPrompt = [
    `[clawforce:dispatch=${options.queueItemId}:${options.taskId}]`,
    "",
    options.prompt,
  ].join("\n");

  const job = {
    id: jobId,
    name: cronJobName,
    agentId: options.agentId,
    enabled: true,
    schedule: {
      kind: "at" as const,
      at: new Date().toISOString(),
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn" as const,
      message: taggedPrompt,
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    },
    deleteAfterRun: true,
    createdAtMs: now,
    updatedAtMs: now,
    state: {},
    // No delivery — dispatch sessions don't need Telegram notification
  };

  const jobsPath = getCronJobsPath();

  try {
    // Read existing jobs file
    let data: { version: number; jobs: unknown[] };
    try {
      const raw = fs.readFileSync(jobsPath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      // File doesn't exist or is corrupt — create fresh
      data = { version: 1, jobs: [] };
    }

    // Append our dispatch job
    data.jobs.push(job);

    // Write back atomically (write to temp, rename)
    const tmpPath = jobsPath + ".tmp." + crypto.randomUUID().slice(0, 8);
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, jobsPath);

    return { ok: true, cronJobName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("cron-dispatch.dispatchViaCron", err);
    return { ok: false, error: msg };
  }
}
