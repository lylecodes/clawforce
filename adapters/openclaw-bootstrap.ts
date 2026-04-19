import {
  syncAgentsToOpenClaw,
  type OpenClawConfigSubset,
  type SyncAgentInput,
} from "../src/agent-sync.js";
import {
  initializeAllDomains,
  syncManagedDomainRoots,
  type InitResult,
} from "../src/config/init.js";
import path from "node:path";
import { clearOpenClawConfigCache, setOpenClawConfig } from "../src/config/openclaw-reader.js";
import { startConfigWatcher, stopConfigWatcher } from "../src/config/watcher.js";
import { emitDiagnosticEvent } from "../src/diagnostics.js";
import { recoverProject } from "../src/dispatch/restart-recovery.js";
import { disableAgent } from "../src/enforcement/disabled-store.js";
import { initClawforce, shutdownClawforce } from "../src/lifecycle.js";
import { resolveClawforceHomes } from "../src/paths.js";
import { getAgentConfig, getRegisteredAgentIds } from "../src/project.js";
import { probeDatabaseDriverCompatibility } from "../src/sqlite-driver.js";
import type { OpenClawConfigSnapshot } from "../src/runtime/ports.js";

type LoggerLike = {
  info(message: string): void;
  warn(message: string): void;
};

type RuntimeConfigPort = {
  loadConfig(): OpenClawConfigSubset;
  writeConfigFile(config: OpenClawConfigSubset): Promise<void> | void;
};

export type ManagedRuntimeControllerConfig = {
  projectsDir: string;
  managedConfigDir: string;
  managedRoots?: string[];
  discoverWorkspaceRoots?: boolean;
  sweepIntervalMs: number;
  defaultMaxRetries: number;
  syncAgents: boolean;
};

type ManagedRuntimeControllerArgs = {
  config: ManagedRuntimeControllerConfig;
  logger: LoggerLike;
  runtimeConfig: RuntimeConfigPort;
};

export type ManagedRuntimeController = {
  handleDisable(agentId: string): Promise<void>;
  bootstrap(reason: string): Promise<void>;
  reload(reason: string): Promise<InitResult>;
  listManagedRoots(): string[];
  bindManagedRoot(pathHint: string, reason: string): Promise<{ root: string; roots: string[] }>;
  unbindManagedRoot(pathHint: string, reason: string): Promise<{ removed: boolean; root: string; roots: string[] }>;
  stop(): Promise<void>;
};

function logDomainResult(logger: LoggerLike, prefix: string, result: InitResult): void {
  logger.info(
    `${prefix}: ${result.domains.length} domain(s), ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
  );
  if (result.domains.length > 0) {
    logger.info(`${prefix}: ${result.domains.join(", ")}`);
  }
  for (const warning of result.warnings) {
    logger.info(`${prefix} warning: ${warning}`);
  }
  for (const error of result.errors) {
    logger.warn(`${prefix} error: ${error}`);
  }
}

function collectRegisteredAgents(): SyncAgentInput[] {
  const agents: SyncAgentInput[] = [];
  for (const id of getRegisteredAgentIds()) {
    const entry = getAgentConfig(id);
    if (!entry) continue;
    agents.push({
      agentId: id,
      config: entry.config,
      projectDir: entry.projectDir,
      domain: entry.projectId,
    });
  }
  return agents;
}

function mergeInitResults(results: InitResult[]): InitResult {
  const merged: InitResult = { domains: [], errors: [], warnings: [], claimedProjectDirs: [] };
  const domains = new Set<string>();
  const warnings = new Set<string>();
  const errors = new Set<string>();
  const claimedDirs = new Set<string>();
  for (const result of results) {
    for (const domain of result.domains) domains.add(domain);
    for (const warning of result.warnings) warnings.add(warning);
    for (const error of result.errors) errors.add(error);
    for (const dir of result.claimedProjectDirs) claimedDirs.add(dir);
  }
  merged.domains = [...domains].sort();
  merged.warnings = [...warnings].sort();
  merged.errors = [...errors].sort();
  merged.claimedProjectDirs = [...claimedDirs].sort();
  return merged;
}

function getConfiguredManagedRoots(
  config: ManagedRuntimeControllerConfig,
  snapshot: OpenClawConfigSubset,
): string[] {
  const managedRoots = new Set<string>();
  if (config.managedConfigDir) {
    managedRoots.add(path.resolve(config.managedConfigDir));
  } else if (config.projectsDir) {
    managedRoots.add(path.resolve(config.projectsDir));
  }
  for (const root of config.managedRoots ?? []) {
    const [resolved] = resolveClawforceHomes([root]);
    managedRoots.add(path.resolve(resolved ?? root));
  }
  const workspaceHints = new Set<string>();
  if (config.discoverWorkspaceRoots !== false) {
    const agentEntries = snapshot.agents?.list;
    if (Array.isArray(agentEntries)) {
      for (const entry of agentEntries) {
        const workspace = typeof entry?.workspace === "string" ? entry.workspace : undefined;
        if (workspace) {
          workspaceHints.add(workspace);
        }
      }
    }
  }
  for (const root of resolveClawforceHomes(workspaceHints)) {
    managedRoots.add(root);
  }
  return [...managedRoots].sort();
}

function setManagedRootsOnConfig(
  snapshot: OpenClawConfigSubset,
  managedRoots: string[],
): OpenClawConfigSubset {
  const nextConfig = structuredClone(snapshot) as OpenClawConfigSubset & {
    plugins?: {
      entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
    };
  };
  if (!nextConfig.plugins) nextConfig.plugins = {};
  if (!nextConfig.plugins.entries) nextConfig.plugins.entries = {};
  const existingEntry = nextConfig.plugins.entries.clawforce ?? {};
  nextConfig.plugins.entries.clawforce = {
    ...existingEntry,
    config: {
      ...(existingEntry.config ?? {}),
      managedRoots,
    },
  };
  return nextConfig;
}

export function createManagedRuntimeController(
  args: ManagedRuntimeControllerArgs,
): ManagedRuntimeController {
  const { config, logger, runtimeConfig } = args;
  let runtimeBootstrapped = false;
  let bootstrapPromise: Promise<void> | null = null;
  const watchedRoots = new Set<string>();

  function clearManagedConfigWatchers(): void {
    for (const root of [...watchedRoots]) {
      stopConfigWatcher(root);
    }
    watchedRoots.clear();
  }

  function loadRuntimeSnapshot(): OpenClawConfigSubset {
    return runtimeConfig.loadConfig() as OpenClawConfigSubset;
  }

  function refreshOpenClawConfigCache(): void {
    try {
      setOpenClawConfig(loadRuntimeSnapshot() as OpenClawConfigSnapshot);
    } catch (err) {
      logger.warn(
        `Clawforce: failed to refresh OpenClaw config cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function listManagedRoots(): string[] {
    return getConfiguredManagedRoots(config, loadRuntimeSnapshot());
  }

  async function syncRegisteredAgents(reason: string): Promise<void> {
    if (!config.syncAgents) {
      refreshOpenClawConfigCache();
      return;
    }

    const result = await syncAgentsToOpenClaw({
      agents: collectRegisteredAgents(),
      loadConfig: () => runtimeConfig.loadConfig(),
      writeConfigFile: (nextConfig) => Promise.resolve(runtimeConfig.writeConfigFile(nextConfig)),
      logger,
    });

    refreshOpenClawConfigCache();

    if (result.collisions.length > 0) {
      for (const collision of result.collisions) {
        logger.warn(`Clawforce agent sync collision (${reason}): ${collision}`);
      }
    }

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        logger.warn(`Clawforce agent sync error (${reason}): ${error}`);
      }
    }

    logger.info(
      `Clawforce: agent sync (${reason}) — ${result.synced} updated, ${result.skipped} unchanged`,
    );
  }

  async function reloadManagedDomains(reason: string): Promise<InitResult> {
    const managedRoots = listManagedRoots();
    logger.info(`Clawforce ${reason}: managing ${managedRoots.length} root(s)`);
    for (const root of managedRoots) {
      logger.info(`Clawforce ${reason} root: ${root}`);
    }

    const compatibility = probeDatabaseDriverCompatibility();
    if (!compatibility.ok) {
      syncManagedDomainRoots([]);
      clearManagedConfigWatchers();
      const result: InitResult = {
        domains: [],
        warnings: [],
        errors: [
          `Hosted runtime compatibility error (${compatibility.code}): ${compatibility.guidance}`,
        ],
        claimedProjectDirs: [],
      };
      logger.warn(`Clawforce ${reason} compatibility error: ${compatibility.message}`);
      logger.warn(`Clawforce ${reason} guidance: ${compatibility.guidance}`);
      logDomainResult(logger, `Clawforce ${reason}`, result);
      return result;
    }

    syncManagedDomainRoots(managedRoots);
    const results = managedRoots.map((root) => initializeAllDomains(root));
    const result = mergeInitResults(results);
    logDomainResult(logger, `Clawforce ${reason}`, result);
    await syncRegisteredAgents(reason);
    reconcileManagedConfigWatchers();
    return result;
  }

  function reconcileManagedConfigWatchers(): void {
    const roots = listManagedRoots();
    for (const root of [...watchedRoots]) {
      if (roots.includes(root)) continue;
      stopConfigWatcher(root);
      watchedRoots.delete(root);
      logger.info(`Clawforce: config watcher removed for ${root}`);
    }
    for (const root of roots) {
      if (watchedRoots.has(root)) continue;
      startConfigWatcher(root, (change) => {
        const changedFiles = change.files?.length ? change.files.join(", ") : change.file;
        logger.info(`Clawforce: config change detected (${changedFiles}) in ${root} — reloading...`);
        void reloadManagedDomains(`config reload (${changedFiles})`).catch((err) => {
          logger.warn(`Clawforce: config reload failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      watchedRoots.add(root);
      logger.info(`Clawforce: config watcher started for ${root}`);
    }
  }

  async function ensureBootstrapped(reason: string): Promise<void> {
    if (runtimeBootstrapped) return;
    if (bootstrapPromise) {
      await bootstrapPromise;
      return;
    }

    bootstrapPromise = (async () => {
      initClawforce({
        enabled: true,
        projectsDir: config.projectsDir,
        sweepIntervalMs: config.sweepIntervalMs,
        defaultMaxRetries: config.defaultMaxRetries,
        verificationRequired: true,
        autoInitialize: false,
      });

      const domainResult = await reloadManagedDomains(reason);

      for (const domainId of domainResult.domains) {
        try {
          const recovery = recoverProject(domainId);
          const total = recovery.staleTasks + recovery.failedDispatches + recovery.releasedLeases;
          if (total > 0) {
            logger.info(
              `Clawforce restart recovery [${domainId}]: ${recovery.staleTasks} stale tasks released, ` +
                `${recovery.failedDispatches} dispatch items failed, ${recovery.releasedLeases} expired leases released`,
            );
          }
        } catch (err) {
          logger.warn(
            `Clawforce restart recovery failed for ${domainId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      runtimeBootstrapped = true;
    })();

    try {
      await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  return {
    async handleDisable(agentId: string): Promise<void> {
      const entry = getAgentConfig(agentId);
      if (entry) {
        disableAgent(entry.projectId, agentId, "Underperforming or unresponsive");
      }
      emitDiagnosticEvent({ type: "agent_disabled", agentId });
    },

    async bootstrap(reason: string): Promise<void> {
      await ensureBootstrapped(reason);
    },

    async reload(reason: string): Promise<InitResult> {
      await ensureBootstrapped(`reload bootstrap (${reason})`);
      return reloadManagedDomains(reason);
    },

    listManagedRoots(): string[] {
      return listManagedRoots();
    },

    async bindManagedRoot(pathHint: string, reason: string): Promise<{ root: string; roots: string[] }> {
      const [root] = resolveClawforceHomes([pathHint]);
      if (!root) {
        throw new Error(`Could not resolve a ClawForce home from "${pathHint}"`);
      }
      const currentSnapshot = loadRuntimeSnapshot();
      const nextRoots = new Set(listManagedRoots());
      nextRoots.add(root);
      await runtimeConfig.writeConfigFile(setManagedRootsOnConfig(currentSnapshot, [...nextRoots].sort()));
      refreshOpenClawConfigCache();
      await this.reload(reason);
      return { root, roots: listManagedRoots() };
    },

    async unbindManagedRoot(pathHint: string, reason: string): Promise<{ removed: boolean; root: string; roots: string[] }> {
      const [root] = resolveClawforceHomes([pathHint]);
      if (!root) {
        throw new Error(`Could not resolve a ClawForce home from "${pathHint}"`);
      }
      const currentSnapshot = loadRuntimeSnapshot();
      const nextRoots = new Set(listManagedRoots());
      const removed = nextRoots.delete(root);
      await runtimeConfig.writeConfigFile(setManagedRootsOnConfig(currentSnapshot, [...nextRoots].sort()));
      refreshOpenClawConfigCache();
      await this.reload(reason);
      return { removed, root, roots: listManagedRoots() };
    },

    async stop(): Promise<void> {
      clearManagedConfigWatchers();
      syncManagedDomainRoots([]);
      clearOpenClawConfigCache();
      runtimeBootstrapped = false;
      bootstrapPromise = null;
      await shutdownClawforce();
      logger.info("Clawforce shut down (config watcher stopped)");
    },
  };
}
