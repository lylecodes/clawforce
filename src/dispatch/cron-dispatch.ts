/**
 * Clawforce — Cron-based dispatch
 *
 * Creates one-shot cron jobs via OpenClaw's CronJob API to dispatch
 * workers with full hook lifecycle (context injection, compliance
 * tracking, enforcement). Replaces the old CLI-spawn path.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { safeLog } from "../diagnostics.js";
import { getCronService, toCronJobCreate, type ManagerCronJob } from "../manager-cron.js";
import { formatDispatchCronJobName } from "./cron-job-name.js";
import { getProjectStorageDir } from "../db.js";

const execFile = promisify(execFileCb);

export type CronDispatchResult = {
  ok: boolean;
  cronJobName?: string;
  error?: string;
  handledRemotely?: boolean;
  deferred?: boolean;
};

/**
 * Attempt to bootstrap the cron service by calling the clawforce.bootstrap
 * gateway method via WebSocket RPC. The gateway method handler has access
 * to context.cron and will call setCronService().
 *
 * This is needed because worker sessions run in isolated processes where
 * setCronService() has never been called — only the main gateway process
 * has context.cron. The gateway RPC handler captures it and makes it
 * available in-process.
 *
 * Returns true if cron service is now available after the bootstrap call.
 */
async function tryBootstrapCron(): Promise<boolean> {
  // Already available — no bootstrap needed
  if (getCronService() !== null) return true;

  try {
    await execFile("openclaw", ["gateway", "call", "clawforce.bootstrap", "--json", "--params", "{}"], { timeout: 10_000 });
    // Brief wait for the gateway handler to execute setCronService()
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    safeLog("cron-dispatch.tryBootstrapCron", err);
  }

  return getCronService() !== null;
}

function parseGatewayJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`Gateway response did not contain JSON: ${stdout.trim() || "<empty>"}`);
  }
  return JSON.parse(stdout.slice(start));
}

async function dispatchViaGateway(params: {
  projectId: string;
  queueItemId: string;
  cronJobName: string;
}): Promise<CronDispatchResult> {
  try {
    const storageDir = getProjectStorageDir(params.projectId) ?? undefined;
    const gatewayParams = JSON.stringify({
      projectId: params.projectId,
      queueItemId: params.queueItemId,
      storageDir,
    });
    const output = await execFile(
      "openclaw",
      ["gateway", "call", "clawforce.dispatch_queue_item", "--json", "--params", gatewayParams],
      { timeout: 10_000 },
    );
    const stdout = typeof output === "string" ? output : output.stdout;
    const parsed = parseGatewayJson(stdout);
    const ok = parsed.ok === true;
    return {
      ok,
      cronJobName: typeof parsed.jobName === "string" ? parsed.jobName : params.cronJobName,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      handledRemotely: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("cron-dispatch.dispatchViaGateway", err);
    return { ok: false, error: msg };
  }
}

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
  let cronService = getCronService();

  // If cron service isn't available, try progressive recovery:
  // 1. Brief wait (may be in-flight bootstrap)
  // 2. Active bootstrap via gateway RPC (captures context.cron)
  if (!cronService) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    cronService = getCronService();
  }
  if (!cronService) {
    const bootstrapped = await tryBootstrapCron();
    if (bootstrapped) {
      cronService = getCronService();
    }
  }
  if (!cronService) {
    return dispatchViaGateway({
      projectId: options.projectId,
      queueItemId: options.queueItemId,
      cronJobName,
    });
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
