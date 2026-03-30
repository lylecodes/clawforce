/**
 * Clawforce — Lifecycle management
 *
 * initClawforce() / shutdownClawforce() — start sweep timer, close DBs.
 * Called from gateway server.impl.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ClawforceConfig } from "./types.js";
import { closeAllDbs, setProjectsDir } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { sweep } from "./sweep/actions.js";
import { initializeAllDomains } from "./config/init.js";
import { loadProject, loadWorkforceConfig, initProject, registerWorkforceConfig } from "./project.js";

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let activeProjectIds: Set<string> = new Set();
const inFlightSweeps: Set<Promise<unknown>> = new Set();

export function initClawforce(config: ClawforceConfig): void {
  if (!config.enabled) return;
  if (initialized) return;

  setProjectsDir(config.projectsDir);

  autoActivateProjects(config.projectsDir);

  if (config.sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      for (const projectId of activeProjectIds) {
        try {
          const p = sweep({ projectId }).catch((err) => {
            safeLog(`lifecycle.sweep.${projectId}`, err);
          });
          inFlightSweeps.add(p);
          p.finally(() => inFlightSweeps.delete(p));
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

function autoActivateProjects(projectsDir: string): void {
  // 1) Prefer domain-based config initialization (config.yaml + domains/*.yaml)
  try {
    initializeAllDomains(projectsDir);
  } catch (err) {
    safeLog("lifecycle.autoActivate.initializeAllDomains", err);
  }

  // 2) Backward compatibility: auto-activate legacy project.yaml projects
  try {
    if (!fs.existsSync(projectsDir)) return;
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectId = entry.name;
      const projectDir = path.join(projectsDir, projectId);
      const configPath = path.join(projectDir, "project.yaml");
      if (!fs.existsSync(configPath)) continue;

      try {
        const wfConfig = loadWorkforceConfig(configPath);
        if (wfConfig) {
          registerWorkforceConfig(projectId, wfConfig, projectDir);
          // Register in the active-project set so getActiveProjectIds() returns
          // this project without requiring a separate initProject() call.
          registerProject(projectId);
          continue;
        }

        // Legacy project format without workforce agents
        const projectConfig = loadProject(configPath);
        initProject(projectConfig);
      } catch (err) {
        safeLog(`lifecycle.autoActivate.${projectId}`, err);
      }
    }
  } catch (err) {
    safeLog("lifecycle.autoActivate.scan", err);
  }
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

// Domain aliases — pass through to existing project tracking.
// During the migration to domain-based config, both vocabularies work.
export function registerDomain(domainId: string): void {
  activeProjectIds.add(domainId);
}

export function unregisterDomain(domainId: string): void {
  activeProjectIds.delete(domainId);
}

export function getActiveDomainIds(): string[] {
  return [...activeProjectIds];
}

export function isClawforceInitialized(): boolean {
  return initialized;
}
