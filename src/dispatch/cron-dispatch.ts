/**
 * Clawforce — Cron-based dispatch
 *
 * Creates one-shot runtime cron jobs to dispatch workers with full hook
 * lifecycle (context injection, compliance tracking, enforcement).
 *
 * OpenClaw remains an optional integration, but this module no longer shells
 * through `openclaw gateway` as a structural bootstrap path. If a runtime
 * wants OpenClaw-backed cron behavior, it must wire a cron service explicitly.
 */

import { safeLog } from "../diagnostics.js";
import { getCronService, toCronJobCreate, type ManagerCronJob } from "../manager-cron.js";
import { formatDispatchCronJobName } from "./cron-job-name.js";

export type CronDispatchResult = {
  ok: boolean;
  cronJobName?: string;
  error?: string;
  handledRemotely?: boolean;
  deferred?: boolean;
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
  const cronJobName = formatDispatchCronJobName(options.projectId, options.queueItemId);
  const cronService = getCronService();
  if (!cronService) {
    return {
      ok: false,
      cronJobName,
      error: "Cron service unavailable for OpenClaw dispatch. Wire a runtime cron service or use the codex/claude-code executor.",
    };
  }

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
