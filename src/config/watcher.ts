/**
 * Clawforce — Config Hot-Reload
 *
 * Watches config files for changes, diffs the last good snapshot against the
 * next one, and emits targeted reload events. Invalid edits are ignored until
 * the file becomes valid again so runtime state stays on the last good config.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { FSWatcher } from "node:fs";
import { safeLog } from "../diagnostics.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";
import { loadAllDomains, loadGlobalConfig } from "./loader.js";
import { validateDomainConfig, validateGlobalConfig } from "./schema.js";
import type { GlobalConfig, DomainConfig } from "./schema.js";

// --- Diff Types ---

export type GlobalConfigDiff = {
  changed: boolean;
  agentChanges: string[];
  defaultsChanged: boolean;
  otherChanged: boolean;
};

export type DomainConfigDiff = {
  changed: boolean;
  agentsAdded: string[];
  agentsRemoved: string[];
  budgetChanged: boolean;
  policiesChanged: boolean;
  rulesChanged: boolean;
  managerChanged: boolean;
  defaultsChanged: boolean;
  jobsChanged: boolean;
  otherChanged: boolean;
  domainAdded?: boolean;
  domainRemoved?: boolean;
};

export type ConfigSnapshot = {
  global: GlobalConfig;
  domains: Map<string, DomainConfig>;
};

type PendingChange = {
  file: string;
  type: "global" | "domain";
  domainId?: string;
};

// --- Diff Helpers ---

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stripGlobalKnownFields(config: GlobalConfig): Record<string, unknown> {
  const { agents: _agents, defaults: _defaults, ...rest } = config as GlobalConfig & Record<string, unknown>;
  return rest;
}

function stripDomainKnownFields(config: DomainConfig): Record<string, unknown> {
  const {
    domain: _domain,
    agents: _agents,
    budget: _budget,
    policies: _policies,
    rules: _rules,
    manager: _manager,
    defaults: _defaults,
    jobs: _jobs,
    ...rest
  } = config as DomainConfig & Record<string, unknown>;
  return rest;
}

function emptyGlobalConfig(): GlobalConfig {
  return { agents: {} };
}

function emptyDomainConfig(domainId: string): DomainConfig {
  return { domain: domainId, agents: [] };
}

/**
 * Compare two global configs and return what changed.
 */
export function diffConfigs(oldConfig: GlobalConfig, newConfig: GlobalConfig): GlobalConfigDiff {
  const agentChanges: string[] = [];

  // Check for changed/added agents
  for (const [id, newDef] of Object.entries(newConfig.agents)) {
    const oldDef = oldConfig.agents[id];
    if (!oldDef || JSON.stringify(oldDef) !== JSON.stringify(newDef)) {
      agentChanges.push(id);
    }
  }

  // Check for removed agents
  for (const id of Object.keys(oldConfig.agents)) {
    if (!newConfig.agents[id]) {
      agentChanges.push(id);
    }
  }

  const defaultsChanged = JSON.stringify(oldConfig.defaults) !== JSON.stringify(newConfig.defaults);
  const otherChanged = stableStringify(stripGlobalKnownFields(oldConfig)) !== stableStringify(stripGlobalKnownFields(newConfig));

  return {
    changed: agentChanges.length > 0 || defaultsChanged || otherChanged,
    agentChanges,
    defaultsChanged,
    otherChanged,
  };
}

/**
 * Compare two domain configs and return what changed.
 */
export function diffDomainConfigs(
  oldDomain: DomainConfig,
  newDomain: DomainConfig,
): DomainConfigDiff {
  const oldAgents = new Set(oldDomain.agents);
  const newAgents = new Set(newDomain.agents);

  const agentsAdded = [...newAgents].filter(a => !oldAgents.has(a));
  const agentsRemoved = [...oldAgents].filter(a => !newAgents.has(a));

  const budgetChanged = stableStringify(oldDomain.budget) !== stableStringify(newDomain.budget);
  const policiesChanged = stableStringify(oldDomain.policies) !== stableStringify(newDomain.policies);
  const rulesChanged = stableStringify(oldDomain.rules) !== stableStringify(newDomain.rules);
  const managerChanged = stableStringify(oldDomain.manager) !== stableStringify(newDomain.manager);
  const defaultsChanged = stableStringify(oldDomain.defaults) !== stableStringify(newDomain.defaults);
  const jobsChanged = stableStringify(oldDomain.jobs) !== stableStringify(newDomain.jobs);
  const otherChanged = stableStringify(stripDomainKnownFields(oldDomain)) !== stableStringify(stripDomainKnownFields(newDomain));

  return {
    changed:
      agentsAdded.length > 0 ||
      agentsRemoved.length > 0 ||
      budgetChanged ||
      policiesChanged ||
      rulesChanged ||
      managerChanged ||
      defaultsChanged ||
      jobsChanged ||
      otherChanged,
    agentsAdded,
    agentsRemoved,
    budgetChanged,
    policiesChanged,
    rulesChanged,
    managerChanged,
    defaultsChanged,
    jobsChanged,
    otherChanged,
  };
}

export function loadConfigSnapshot(baseDir: string): ConfigSnapshot {
  return {
    global: loadGlobalConfig(baseDir),
    domains: new Map(loadAllDomains(baseDir).map((domain) => [domain.domain, domain])),
  };
}

export function buildReloadEvent(
  previous: ConfigSnapshot,
  next: ConfigSnapshot,
  change: PendingChange,
): {
  file: string;
  type: "global" | "domain";
  diff: GlobalConfigDiff | DomainConfigDiff;
  domainId?: string;
} {
  if (change.type === "global") {
    return {
      file: change.file,
      type: "global",
      diff: diffConfigs(previous.global, next.global),
    };
  }

  const domainId = change.domainId ?? path.basename(change.file, ".yaml");
  const oldDomain = previous.domains.get(domainId) ?? emptyDomainConfig(domainId);
  const nextDomain = next.domains.get(domainId) ?? emptyDomainConfig(domainId);
  const diff = diffDomainConfigs(oldDomain, nextDomain);

  if (!previous.domains.has(domainId) && next.domains.has(domainId)) {
    diff.domainAdded = true;
  }

  if (previous.domains.has(domainId) && !next.domains.has(domainId)) {
    diff.domainRemoved = true;
  }

  return {
    file: change.file,
    type: "domain",
    diff,
    domainId,
  };
}

function resolvePendingChange(filename: string): PendingChange | null {
  if (filename === "config.yaml") {
    return { file: filename, type: "global" };
  }

  if (filename.endsWith(".yaml")) {
    return {
      file: filename,
      type: "domain",
      domainId: path.basename(filename, ".yaml"),
    };
  }

  return null;
}

function readYamlObject(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf-8");
  return YAML.parse(raw);
}

function validatePendingChange(baseDir: string, change: PendingChange): string | null {
  const filePath = change.type === "global"
    ? path.join(baseDir, "config.yaml")
    : path.join(baseDir, "domains", change.file);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const parsed = readYamlObject(filePath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${change.file} parsed to a non-object value`;
  }

  const validation = change.type === "global"
    ? validateGlobalConfig(parsed)
    : validateDomainConfig(parsed);

  if (!validation.valid) {
    return validation.errors
      .map((error) => `${error.field}: ${error.message}`)
      .join("; ");
  }

  return null;
}

function normalizeFilename(filename: string | Buffer | null): string | null {
  if (filename == null) return null;
  return typeof filename === "string" ? filename : filename.toString("utf-8");
}

export type ReloadCallback = (event: {
  file: string;
  type: "global" | "domain";
  diff: GlobalConfigDiff | DomainConfigDiff;
  domainId?: string;
  files?: string[];
}) => void;

const runtime = getDefaultRuntimeState();

/**
 * Start watching config directory for changes.
 * Debounces 500ms, validates the changed file, and emits diffs against the
 * previous good snapshot.
 */
export function startConfigWatcher(baseDir: string, onReload: ReloadCallback): void {
  const resolvedBaseDir = path.resolve(baseDir);
  stopConfigWatcher(resolvedBaseDir);
  const watcherState = runtime.configWatcher;

  try {
    watcherState.snapshotsByBaseDir.set(resolvedBaseDir, loadConfigSnapshot(resolvedBaseDir));
  } catch (err) {
    safeLog("config.watcher.snapshot", err);
    watcherState.snapshotsByBaseDir.set(
      resolvedBaseDir,
      { global: emptyGlobalConfig(), domains: new Map() } satisfies ConfigSnapshot,
    );
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChange: PendingChange | null = null;
  const pendingFiles = new Set<string>();

  const ensureDomainsWatcher = () => {
    const domainsDir = path.join(resolvedBaseDir, "domains");
    if (!fs.existsSync(domainsDir)) return;
    if (watcherState.watchers.some((watcher) => (watcher as unknown as { __clawforcePath?: string; __clawforceBaseDir?: string }).__clawforcePath === domainsDir)) {
      return;
    }
    try {
      const watcher = fs.watch(domainsDir, (_, filename) => {
        const normalized = normalizeFilename(filename);
        if (!normalized) return;
        queueChange(resolvePendingChange(normalized));
      });
      (watcher as unknown as { __clawforcePath?: string }).__clawforcePath = domainsDir;
      (watcher as unknown as { __clawforceBaseDir?: string }).__clawforceBaseDir = resolvedBaseDir;
      watcher.unref();
      watcherState.watchers.push(watcher);
    } catch (err) {
      safeLog("config.watcher.domains", err);
    }
  };

  const processPendingChange = () => {
    const change = pendingChange;
    const currentSnapshot = watcherState.snapshotsByBaseDir.get(resolvedBaseDir) as ConfigSnapshot | null;
    if (!change || !currentSnapshot) return;

    ensureDomainsWatcher();

    try {
      const validationError = validatePendingChange(resolvedBaseDir, change);
      if (validationError) {
        safeLog("config.watcher", `Skipping reload: ${change.file} is invalid — ${validationError}`);
        return;
      }

      const nextSnapshot = loadConfigSnapshot(resolvedBaseDir);
      const event = buildReloadEvent(currentSnapshot, nextSnapshot, change);
      watcherState.snapshotsByBaseDir.set(resolvedBaseDir, nextSnapshot);

      if (!event.diff.changed) {
        return;
      }

      onReload({
        ...event,
        files: [...pendingFiles].sort(),
      });
    } catch (err) {
      safeLog("config.watcher", err);
    } finally {
      pendingChange = null;
      pendingFiles.clear();
    }
  };

  const queueChange = (change: PendingChange | null) => {
    if (!change) return;
    pendingChange = change;
    pendingFiles.add(change.file);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processPendingChange();
    }, 500);
  };

  try {
    const baseWatcher = fs.watch(resolvedBaseDir, (_, filename) => {
      const normalized = normalizeFilename(filename);
      if (!normalized) return;
      if (normalized === "domains") {
        ensureDomainsWatcher();
        return;
      }
      queueChange(resolvePendingChange(normalized));
    });
    (baseWatcher as unknown as { __clawforcePath?: string }).__clawforcePath = resolvedBaseDir;
    (baseWatcher as unknown as { __clawforceBaseDir?: string }).__clawforceBaseDir = resolvedBaseDir;
    baseWatcher.unref();
    watcherState.watchers.push(baseWatcher);

    ensureDomainsWatcher();
  } catch (err) {
    safeLog("config.watcher.start", err);
  }
}

/**
 * Stop all config file watchers.
 */
export function stopConfigWatcher(baseDir?: string): void {
  const watcherState = runtime.configWatcher;
  const resolvedBaseDir = baseDir ? path.resolve(baseDir) : null;
  const retained: FSWatcher[] = [];
  for (const w of watcherState.watchers) {
    const watcherBaseDir = (w as unknown as { __clawforceBaseDir?: string }).__clawforceBaseDir;
    if (resolvedBaseDir && watcherBaseDir !== resolvedBaseDir) {
      retained.push(w);
      continue;
    }
    try { w.close(); } catch { /* ignore */ }
  }
  watcherState.watchers = retained;
  if (resolvedBaseDir) {
    watcherState.snapshotsByBaseDir.delete(resolvedBaseDir);
  } else {
    watcherState.snapshotsByBaseDir.clear();
  }
}
