/**
 * @deprecated Cron-based dispatch has been replaced by inject-based dispatch.
 * Use dispatchViaInject from ./inject-dispatch.js instead.
 *
 * This file is kept as a stub to avoid breaking any external references.
 */

export type CronDispatchResult = {
  ok: boolean;
  cronJobName?: string;
  error?: string;
};

/**
 * @deprecated Use dispatchViaInject from ./inject-dispatch.js instead.
 */
export async function dispatchViaCron(_options: {
  queueItemId: string;
  taskId: string;
  projectId: string;
  prompt: string;
  agentId: string;
  model?: string;
  timeoutSeconds?: number;
}): Promise<CronDispatchResult> {
  return { ok: false, error: "dispatchViaCron is deprecated — use dispatchViaInject instead" };
}
