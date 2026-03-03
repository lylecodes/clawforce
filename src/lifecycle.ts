/**
 * Clawforce — Lifecycle management
 *
 * initClawforce() / shutdownClawforce() — start sweep timer, close DBs.
 * Called from gateway server.impl.ts.
 */

import type { ClawforceConfig } from "./types.js";
import { closeAllDbs, setProjectsDir } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { setManagerCronRegistrar } from "./manager-cron.js";
import { sweep } from "./sweep/actions.js";

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let activeProjectIds: Set<string> = new Set();
const inFlightSweeps: Set<Promise<unknown>> = new Set();

export function initClawforce(config: ClawforceConfig): void {
  if (!config.enabled) return;
  if (initialized) return;

  setProjectsDir(config.projectsDir);

  // Store cron registrar so initProject() can auto-register manager cron jobs
  setManagerCronRegistrar(config.cronRegistrar);

  if (config.sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      for (const projectId of activeProjectIds) {
        try {
          const p = sweep({ projectId }).catch((err) => {
            safeLog(`lifecycle.sweep.${projectId}`, err);
          }).finally(() => {
            inFlightSweeps.delete(p);
          });
          inFlightSweeps.add(p);
        } catch (err) {
          // Synchronous errors (e.g., DatabaseSync throws) must not
          // interrupt the loop for remaining projects.
          safeLog(`lifecycle.sweep.${projectId}`, err);
        }
      }
    }, config.sweepIntervalMs);
    sweepTimer.unref();
  }

  initialized = true;
}

export async function shutdownClawforce(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  // Wait for any in-flight sweeps to complete before closing databases
  if (inFlightSweeps.size > 0) {
    await Promise.allSettled([...inFlightSweeps]);
    inFlightSweeps.clear();
  }
  closeAllDbs();
  activeProjectIds.clear();
  initialized = false;
}

export function registerProject(projectId: string): void {
  activeProjectIds.add(projectId);
}

export function unregisterProject(projectId: string): void {
  activeProjectIds.delete(projectId);
}

export function getActiveProjectIds(): string[] {
  return [...activeProjectIds];
}

export function isClawforceInitialized(): boolean {
  return initialized;
}
