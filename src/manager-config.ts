/**
 * Clawforce — Manager configuration and session detection
 *
 * Maintains a registry of manager projects and provides fast
 * agentId→project lookup for bootstrap hook injection.
 */

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

/** @deprecated Use ManagerSettings instead. */
export type OrchestratorSettings = ManagerSettings;

type ManagerEntry = {
  projectId: string;
  settings: ManagerSettings;
};

/** agentId → entry */
const registry = new Map<string, ManagerEntry>();

/**
 * Register a project's manager settings.
 * Called during project init when manager config is present in project.yaml.
 */
export function registerManagerProject(projectId: string, settings: ManagerSettings): void {
  if (!settings.enabled) return;
  registry.set(settings.agentId, { projectId, settings });
}

/** @deprecated Use registerManagerProject instead. */
export const registerOrchestratorProject = registerManagerProject;

/**
 * Look up manager config by agent ID.
 */
export function getManagerForAgent(
  agentId: string,
): { projectId: string; settings: ManagerSettings } | null {
  return registry.get(agentId) ?? null;
}

/** @deprecated Use getManagerForAgent instead. */
export const getOrchestratorForAgent = getManagerForAgent;

/**
 * Check if a given agent ID is a registered manager.
 */
export function isManagerSession(agentId?: string): boolean {
  if (!agentId) return false;
  return registry.has(agentId);
}

/** @deprecated Use isManagerSession instead. */
export const isOrchestratorSession = isManagerSession;

/**
 * Unregister a manager (e.g. on project teardown).
 */
export function unregisterManagerProject(agentId: string): void {
  registry.delete(agentId);
}

/** @deprecated Use unregisterManagerProject instead. */
export const unregisterOrchestratorProject = unregisterManagerProject;

/**
 * Clear all registrations (for testing).
 */
export function resetManagerConfigForTest(): void {
  registry.clear();
}

/** @deprecated Use resetManagerConfigForTest instead. */
export const resetOrchestratorConfigForTest = resetManagerConfigForTest;
