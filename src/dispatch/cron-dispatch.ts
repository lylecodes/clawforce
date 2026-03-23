/**
 * Clawforce — Cron-based dispatch
 *
 * Creates one-shot cron jobs via OpenClaw's CronJob API to dispatch
 * workers with full hook lifecycle (context injection, compliance
 * tracking, enforcement). Replaces the old CLI-spawn path.
 */

import { safeLog } from "../diagnostics.js";
import { getCronService, toCronJobCreate, type ManagerCronJob } from "../manager-cron.js";

export type CronDispatchResult = {
  ok: boolean;
  cronJobName?: string;
  error?: string;
};

/**
 * Dispatch a task by creating a one-shot cron job that fires immediately.
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
  const cronService = getCronService();
  if (!cronService) {
    return { ok: false, error: "Cron service not available" };
  }

  const cronJobName = `dispatch:${options.queueItemId}`;

  const job: ManagerCronJob = {
    name: cronJobName,
    schedule: `at:${new Date().toISOString()}`,
    agentId: options.agentId,
    payload: [
      `[clawforce:dispatch=${options.queueItemId}:${options.taskId}]`,
      "",
      options.prompt,
    ].join("\n"),
    sessionTarget: "isolated",
    wakeMode: "now",
    deleteAfterRun: true,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
  };

  const input = toCronJobCreate(job);

  try {
    await cronService.add(input);
    return { ok: true, cronJobName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("cron-dispatch.dispatchViaCron", err);
    return { ok: false, error: msg };
  }
}
