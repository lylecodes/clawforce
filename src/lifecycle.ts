/**
 * Clawforce — Lifecycle management
 *
 * initClawforce() / shutdownClawforce() — start sweep timer, close DBs.
 * Called from gateway server.impl.ts.
 */

import type { ClawforceConfig } from "./types.js";
import { closeAllDbs, setProjectsDir } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { sweep } from "./sweep/actions.js";
import { initializeAllDomains, recordControllerAppliedDomainConfig } from "./config/init.js";
import { getDefaultRuntimeState } from "./runtime/default-runtime.js";
import { acquireControllerLease, releaseControllerLease } from "./runtime/controller-leases.js";

const runtime = getDefaultRuntimeState();

export function initClawforce(config: ClawforceConfig): void {
  if (!config.enabled) return;
  if (runtime.initialized) return;

  setProjectsDir(config.projectsDir);

  if (config.autoInitialize !== false) {
    autoActivateProjects(config.projectsDir);
  }

  if (config.sweepIntervalMs > 0) {
    runtime.sweepTimer = setInterval(() => {
      for (const projectId of runtime.activeProjectIds) {
        try {
          const lease = acquireControllerLease(projectId, { purpose: "lifecycle" });
          if (lease.ok && !lease.lease.appliedConfigHash) {
            recordControllerAppliedDomainConfig(config.projectsDir, projectId, "config.lifecycle.heartbeat");
          }
        } catch (err) {
          safeLog(`lifecycle.controllerLease.${projectId}`, err);
        }
        try {
          const p = sweep({ projectId }).catch((err) => {
            safeLog(`lifecycle.sweep.${projectId}`, err);
          });
          runtime.inFlightSweeps.add(p);
          p.finally(() => runtime.inFlightSweeps.delete(p));
        } catch (err) {
          // Synchronous errors (e.g., DatabaseSync throws) must not
          // interrupt the loop for remaining projects.
          safeLog(`lifecycle.sweep.${projectId}`, err);
        }
      }
    }, config.sweepIntervalMs);
    runtime.sweepTimer.unref();

    for (const projectId of runtime.activeProjectIds) {
      try {
        const lease = acquireControllerLease(projectId, { purpose: "lifecycle" });
        if (lease.ok) {
          recordControllerAppliedDomainConfig(config.projectsDir, projectId, "config.lifecycle.startup");
        }
      } catch (err) {
        safeLog(`lifecycle.controllerLease.${projectId}`, err);
      }
    }
  }

  runtime.initialized = true;
}

function autoActivateProjects(projectsDir: string): void {
  try {
    initializeAllDomains(projectsDir);
  } catch (err) {
    safeLog("lifecycle.autoActivate.initializeAllDomains", err);
  }
}

export async function shutdownClawforce(): Promise<void> {
  if (runtime.sweepTimer) {
    clearInterval(runtime.sweepTimer);
    runtime.sweepTimer = null;
  }
  // Wait for any in-flight sweeps to complete before closing databases
  if (runtime.inFlightSweeps.size > 0) {
    await Promise.allSettled([...runtime.inFlightSweeps]);
    runtime.inFlightSweeps.clear();
  }
  closeAllDbs();
  for (const projectId of runtime.activeProjectIds) {
    try {
      releaseControllerLease(projectId);
    } catch (err) {
      safeLog(`lifecycle.releaseLease.${projectId}`, err);
    }
  }
  runtime.activeProjectIds.clear();
  runtime.configInit.reloadStatusByDomain.clear();
  runtime.initialized = false;
}

export function registerProject(projectId: string): void {
  runtime.activeProjectIds.add(projectId);
  if (runtime.sweepTimer) {
    try {
      const lease = acquireControllerLease(projectId, { purpose: "lifecycle" });
      if (lease.ok) {
        recordControllerAppliedDomainConfig(runtime.projectsDir, projectId, "config.lifecycle.register");
      }
    } catch (err) {
      safeLog(`lifecycle.registerLease.${projectId}`, err);
    }
  }
}

export function unregisterProject(projectId: string): void {
  try {
    releaseControllerLease(projectId);
  } catch (err) {
    safeLog(`lifecycle.unregisterLease.${projectId}`, err);
  }
  runtime.activeProjectIds.delete(projectId);
}

export function getActiveProjectIds(): string[] {
  return [...runtime.activeProjectIds];
}

export function isClawforceInitialized(): boolean {
  return runtime.initialized;
}
