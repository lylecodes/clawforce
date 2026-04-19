/**
 * Clawforce — Manager configuration and session detection
 *
 * Maintains a registry of manager projects and provides fast
 * agentId→project lookup for bootstrap hook injection.
 */

import { getDefaultRuntimeState } from "./runtime/default-runtime.js";

export type ManagerSettings = {
  enabled: boolean;
  agentId: string;
  cronSchedule?: string;
  directives: string[];
  contextBudgetChars?: number;
  /** Resolved project working directory — used to load PROJECT.md charter file. */
  projectDir?: string;
  dispatchDefaults?: {
    profile?: string;
    model?: string;
    timeoutMs?: number;
  };
};

type ManagerEntry = {
  projectId: string;
  settings: ManagerSettings;
};

type ManagerConfigRuntimeState = {
  registry: Map<string, ManagerEntry>;
};

const runtime = getDefaultRuntimeState();

function getManagerRegistry(): ManagerConfigRuntimeState["registry"] {
  return (runtime.managerConfig as ManagerConfigRuntimeState).registry;
}

/**
 * Register a project's manager settings.
 * Called during workforce activation when manager config is present.
 */
export function registerManagerProject(projectId: string, settings: ManagerSettings): void {
  if (!settings.enabled) return;
  getManagerRegistry().set(settings.agentId, { projectId, settings });
}

/**
 * Look up manager config by agent ID.
 */
export function getManagerForAgent(
  agentId: string,
): { projectId: string; settings: ManagerSettings } | null {
  return getManagerRegistry().get(agentId) ?? null;
}

/**
 * Check if a given agent ID is a registered manager.
 */
export function isManagerSession(agentId?: string): boolean {
  if (!agentId) return false;
  return getManagerRegistry().has(agentId);
}

/**
 * Unregister a manager (e.g. on project teardown).
 */
export function unregisterManagerProject(agentId: string): void {
  getManagerRegistry().delete(agentId);
}

/**
 * Unregister all manager entries owned by a project.
 */
export function unregisterManagerProjectByProject(projectId: string): void {
  const registry = getManagerRegistry();
  for (const [agentId, entry] of registry.entries()) {
    if (entry.projectId === projectId) {
      registry.delete(agentId);
    }
  }
}

/**
 * Clear all registrations (for testing).
 */
export function resetManagerConfigForTest(): void {
  getManagerRegistry().clear();
}
