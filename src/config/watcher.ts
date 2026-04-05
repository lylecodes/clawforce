/**
 * Clawforce — Config Hot-Reload
 *
 * Watches config files for changes, diffs, and applies updates without restart.
 * Validates YAML before applying — invalid configs are skipped with a warning.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { safeLog } from "../diagnostics.js";
import type { GlobalConfig, DomainConfig } from "./schema.js";

// --- Diff Types ---

export type GlobalConfigDiff = {
  changed: boolean;
  agentChanges: string[];  // agent IDs that changed
  defaultsChanged: boolean;
};

export type DomainConfigDiff = {
  changed: boolean;
  agentsAdded: string[];
  agentsRemoved: string[];
  budgetChanged: boolean;
  policiesChanged: boolean;
  rulesChanged: boolean;
};

// --- Diff Functions ---

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

  return {
    changed: agentChanges.length > 0 || defaultsChanged,
    agentChanges,
    defaultsChanged,
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

  const budgetChanged = JSON.stringify(oldDomain.budget) !== JSON.stringify(newDomain.budget);
  const policiesChanged = JSON.stringify(oldDomain.policies) !== JSON.stringify(newDomain.policies);
  const rulesChanged = JSON.stringify(oldDomain.rules) !== JSON.stringify(newDomain.rules);

  return {
    changed: agentsAdded.length > 0 || agentsRemoved.length > 0 || budgetChanged || policiesChanged || rulesChanged,
    agentsAdded,
    agentsRemoved,
    budgetChanged,
    policiesChanged,
    rulesChanged,
  };
}

// --- Watcher ---

export type ReloadCallback = (event: {
  file: string;
  type: "global" | "domain";
  diff: GlobalConfigDiff | DomainConfigDiff;
}) => void;

let watchers: fs.FSWatcher[] = [];

/**
 * Start watching config directory for changes.
 * Debounces 500ms. Validates before applying.
 */
export function startConfigWatcher(baseDir: string, onReload: ReloadCallback): void {
  stopConfigWatcher(); // clean up any existing watchers

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleChange = (filename: string | null) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        // Validate the changed file before applying the reload.
        // If the new config has invalid YAML, skip the reload entirely
        // to avoid putting the system in a broken state.
        const changedFile = filename === "config.yaml"
          ? path.join(baseDir, filename)
          : filename
            ? path.join(baseDir, "domains", filename)
            : null;

        if (changedFile && fs.existsSync(changedFile)) {
          try {
            const raw = fs.readFileSync(changedFile, "utf-8");
            const parsed = YAML.parse(raw);
            if (!parsed || typeof parsed !== "object") {
              safeLog("config.watcher", `Skipping reload: ${filename} parsed to non-object value`);
              return;
            }
          } catch (parseErr) {
            safeLog("config.watcher", `Skipping reload: ${filename} has invalid YAML — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
            return;
          }
        }

        if (filename === "config.yaml") {
          onReload({ file: filename, type: "global", diff: { changed: true, agentChanges: [], defaultsChanged: true } });
        } else {
          onReload({ file: filename ?? "unknown", type: "domain", diff: { changed: true, agentsAdded: [], agentsRemoved: [], budgetChanged: false, policiesChanged: false, rulesChanged: false } });
        }
      } catch (err) {
        safeLog("config.watcher", err);
      }
    }, 500);
  };

  try {
    // Watch config files: config.yaml, project.yaml, and any *.yaml in config dir
    for (const configFile of ["config.yaml", "project.yaml"]) {
      const configPath = path.join(baseDir, configFile);
      if (fs.existsSync(configPath)) {
        const w = fs.watch(configPath, (_, filename) => handleChange(filename ?? configFile));
        w.unref();
        watchers.push(w);
      }
    }

    // Watch domains directory
    const domainsDir = path.join(baseDir, "domains");
    if (fs.existsSync(domainsDir)) {
      const w = fs.watch(domainsDir, (_, filename) => handleChange(filename ?? "unknown"));
      w.unref();
      watchers.push(w);
    }
  } catch (err) {
    safeLog("config.watcher.start", err);
  }
}

/**
 * Stop all config file watchers.
 */
export function stopConfigWatcher(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers = [];
}
