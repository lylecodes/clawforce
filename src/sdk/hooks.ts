/**
 * Clawforce SDK — Hooks Namespace
 *
 * Provides INTERCEPTORS — unlike events.on() which is reactive (after-the-fact),
 * hooks can BLOCK or MODIFY behavior before it happens. This is a pure in-memory
 * registry of hook callbacks that other SDK namespaces call at key decision points.
 *
 * Hook errors are isolated: a throwing callback will not propagate — the error is
 * swallowed and execution continues with the next registered callback.
 *
 * Any single callback returning { block: true } short-circuits execution and
 * returns { blocked: true, reason } to the caller immediately.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookResult = { block?: boolean; reason?: string } | void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookCallback<T = Record<string, unknown>> = (context: T) => HookResult;

export interface DispatchContext {
  taskId: string;
  agentId?: string;
  priority?: number;
}

export interface TransitionContext {
  taskId: string;
  fromState: string;
  toState: string;
  actor: string;
}

export interface BudgetContext {
  agentId?: string;
  costCents: number;
  remaining: number;
}

export class HooksNamespace {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hooks = new Map<string, Set<HookCallback<any>>>();

  constructor(readonly domain: string) {}

  /**
   * Register a hook that fires before a task is dispatched.
   * Return { block: true } to prevent dispatch.
   */
  beforeDispatch(callback: HookCallback<DispatchContext>): void {
    this.register("beforeDispatch", callback);
  }

  /**
   * Register a hook that fires before a task state transition.
   * Return { block: true } to prevent the transition.
   */
  beforeTransition(callback: HookCallback<TransitionContext>): void {
    this.register("beforeTransition", callback);
  }

  /**
   * Register a hook that fires when a budget threshold is exceeded.
   * Return { block: true } to halt further spending.
   */
  onBudgetExceeded(callback: HookCallback<BudgetContext>): void {
    this.register("onBudgetExceeded", callback);
  }

  /**
   * Generic hook registration for custom lifecycle points.
   *
   * @param hookName - Arbitrary name identifying the lifecycle point
   * @param callback - Function invoked when the hook fires
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(hookName: string, callback: HookCallback<any>): void {
    if (!this.hooks.has(hookName)) this.hooks.set(hookName, new Set());
    this.hooks.get(hookName)!.add(callback);
  }

  /**
   * Remove a previously registered callback for a hook.
   *
   * @param hookName - The hook name the callback was registered under
   * @param callback - The exact callback reference passed to register()
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unregister(hookName: string, callback: HookCallback<any>): void {
    this.hooks.get(hookName)?.delete(callback);
  }

  /**
   * Execute all callbacks registered for a lifecycle point.
   *
   * Iterates callbacks in insertion order. The first callback to return
   * { block: true } short-circuits execution and returns { blocked: true }.
   * Callback errors are swallowed — they never propagate to the caller.
   *
   * @param hookName - Lifecycle point to fire
   * @param context  - Data passed to every callback
   * @returns { blocked: false } if all callbacks passed, or { blocked: true, reason? } if one blocked
   */
  execute<T>(hookName: string, context: T): { blocked: boolean; reason?: string } {
    const callbacks = this.hooks.get(hookName);
    if (!callbacks || callbacks.size === 0) return { blocked: false };

    for (const cb of callbacks) {
      try {
        const result = cb(context);
        if (result?.block) {
          return { blocked: true, reason: result.reason ?? "Blocked by hook" };
        }
      } catch {
        // Hook errors are intentionally swallowed to protect execute() callers.
      }
    }
    return { blocked: false };
  }

  /**
   * List all registered hook names.
   */
  list(): string[] {
    return [...this.hooks.keys()];
  }

  /**
   * Clear all registered hooks. Useful for test teardown.
   */
  clear(): void {
    this.hooks.clear();
  }
}
