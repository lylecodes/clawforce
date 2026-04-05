/**
 * Clawforce SDK — Dispatch Namespace
 *
 * Wraps the internal dispatch queue and dispatcher with a clean public API.
 * The `domain` property maps to the internal `projectId` param.
 *
 * This is the critical namespace for game loops and agent coordination:
 * without it, tasks can be created but not triggered for execution.
 */

import {
  enqueue as internalEnqueue,
  claimNext as internalClaimNext,
  completeItem,
  failItem,
  cancelItem,
  getQueueStatus,
  reclaimExpiredLeases,
} from "../dispatch/queue.js";

import {
  getConcurrencyInfo,
  setMaxConcurrency as internalSetMaxConcurrency,
} from "../dispatch/dispatcher.js";

import type { DispatchQueueItem } from "../types.js";
import { HooksNamespace } from "./hooks.js";

export class DispatchNamespace {
  private readonly getHooks: () => HooksNamespace;

  constructor(readonly domain: string, getHooks?: () => HooksNamespace) {
    // Fall back to a no-op HooksNamespace when constructed without hooks wiring
    // (e.g. in unit tests that construct DispatchNamespace directly)
    if (getHooks) {
      this.getHooks = getHooks;
    } else {
      const fallback = new HooksNamespace(domain);
      this.getHooks = () => fallback;
    }
  }

  /**
   * Enqueue a task for agent dispatch.
   *
   * Deduplicates: returns null if a non-terminal queue item already exists
   * for this taskId, or if the task is in a non-dispatchable state.
   *
   * @param taskId   - The ID of the task to dispatch
   * @param opts.priority       - Queue priority (lower = higher priority, default 2)
   * @param opts.skipStateCheck - Skip the task-state guard (e.g. dispatching a verifier for a REVIEW task)
   */
  enqueue(
    taskId: string,
    opts?: { priority?: number; agentId?: string; skipStateCheck?: boolean },
  ): DispatchQueueItem | null {
    const hookResult = this.getHooks().execute("beforeDispatch", {
      taskId,
      agentId: opts?.agentId,
      priority: opts?.priority,
    });
    if (hookResult.blocked) {
      return null;
    }
    return internalEnqueue(
      this.domain,
      taskId,
      opts?.agentId ? { agentId: opts.agentId } : undefined,
      opts?.priority,
      undefined,
      undefined,
      opts?.skipStateCheck,
    );
  }

  /**
   * Claim the next queued item for processing (for custom dispatch loops).
   *
   * Atomically claims the highest-priority item, setting its status to
   * 'leased' with an expiry. Returns null when the queue is empty.
   *
   * @param opts.leaseDurationMs - Lease duration in ms (default 15 minutes)
   * @param opts.leasedBy        - Identifier for the claimant (default "dispatcher:<pid>")
   */
  claimNext(opts?: {
    leaseDurationMs?: number;
    leasedBy?: string;
  }): DispatchQueueItem | null {
    return internalClaimNext(
      this.domain,
      opts?.leaseDurationMs,
      opts?.leasedBy,
    );
  }

  /**
   * Mark a dispatched queue item as successfully completed.
   *
   * @param itemId - The queue item ID (not the task ID)
   */
  complete(itemId: string): void {
    completeItem(itemId, undefined, this.domain);
  }

  /**
   * Mark a dispatched queue item as failed with an error message.
   *
   * @param itemId - The queue item ID (not the task ID)
   * @param error  - Human-readable error description
   */
  fail(itemId: string, error: string): void {
    failItem(itemId, error, undefined, this.domain);
  }

  /**
   * Cancel a queue item (removes it from processing without counting as a failure).
   *
   * @param itemId - The queue item ID (not the task ID)
   */
  cancel(itemId: string): void {
    cancelItem(itemId, undefined, this.domain);
  }

  /**
   * Get a summary of the dispatch queue for this domain.
   *
   * Returns counts by status: queued, leased, completed, failed, cancelled.
   */
  status(): { queued: number; leased: number; dispatched: number; completed: number; failed: number; cancelled: number } {
    const result = getQueueStatus(this.domain);
    return {
      queued: result.queued,
      leased: result.leased,
      dispatched: result.dispatched,
      completed: result.completed,
      failed: result.failed,
      cancelled: result.cancelled,
    };
  }

  /**
   * Reclaim expired leases in the queue.
   *
   * Items whose leases have expired are reset to 'queued' (if attempts remain)
   * or 'failed' (if max attempts exhausted). Returns the number of items reclaimed.
   *
   * Call this periodically as a maintenance operation.
   */
  reclaimExpired(): number {
    return reclaimExpiredLeases(this.domain);
  }

  /**
   * Get current global dispatch concurrency info.
   *
   * Returns the number of active dispatches and the configured maximum.
   * Note: this is a global counter across all projects in the process.
   */
  concurrency(): { active: number; max: number } {
    return getConcurrencyInfo();
  }

  /**
   * Set the global maximum number of concurrent dispatches.
   *
   * Note: this sets a process-global limit that affects all projects.
   *
   * @param max - Maximum number of concurrent agent dispatches
   */
  setMaxConcurrency(max: number): void {
    internalSetMaxConcurrency(max);
  }
}
