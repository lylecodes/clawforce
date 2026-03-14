/**
 * Clawforce — Agent sync to OpenClaw
 *
 * One-way projection of clawforce agent configs (project.yaml) into OpenClaw's
 * config (agents.list[]) so they appear in `oc agents list`, channel routing,
 * and the OpenClaw dashboard.
 *
 * project.yaml remains source of truth. User customizations in OpenClaw config
 * are preserved via a "user-wins" merge strategy.
 */

import type { AgentConfig as ClawforceAgentConfig } from "./types.js";

/** Minimal shape of an OpenClaw agent entry (config.agents.list[]). */
export type OpenClawAgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  identity?: { name?: string; theme?: string; emoji?: string; avatar?: string };
  subagents?: { allowAgents?: string[]; model?: string | { primary?: string; fallbacks?: string[] } };
  [key: string]: unknown;
};

/** Minimal config shape for reading/writing. */
export type OpenClawConfigSubset = {
  agents?: {
    defaults?: Record<string, unknown>;
    list?: OpenClawAgentEntry[];
  };
  [key: string]: unknown;
};

export type SyncAgentInput = {
  agentId: string;
  config: ClawforceAgentConfig;
  projectDir?: string;
};

export type SyncResult = {
  synced: number;
  skipped: number;
  errors: string[];
};

type SyncParams = {
  agents: SyncAgentInput[];
  loadConfig: () => OpenClawConfigSubset;
  writeConfigFile: (cfg: OpenClawConfigSubset) => Promise<void>;
  logger?: { info(msg: string): void; warn(msg: string): void };
};

/**
 * Map a clawforce agent config to an OpenClaw agent entry.
 *
 * Only maps fields that have a clear OpenClaw equivalent.
 * Clawforce-internal fields (persona, department, expectations, etc.) are not mapped.
 */
export function buildOpenClawAgentEntry(
  agentId: string,
  config: ClawforceAgentConfig,
  projectDir?: string,
): OpenClawAgentEntry {
  const entry: OpenClawAgentEntry = { id: agentId };

  if (config.title) {
    entry.name = config.title;
    entry.identity = { name: config.title };
  }

  if (projectDir) {
    entry.workspace = projectDir;
  }

  if (config.extends === "manager" || config.coordination?.enabled) {
    entry.subagents = { allowAgents: ["*"] };
  }

  return entry;
}

/**
 * User-wins merge: existing fields are always preserved.
 * Only fills in fields that are `undefined` in the existing entry.
 */
export function mergeAgentEntry(
  existing: OpenClawAgentEntry,
  incoming: OpenClawAgentEntry,
): OpenClawAgentEntry {
  const merged = { ...existing };

  for (const key of Object.keys(incoming) as (keyof OpenClawAgentEntry)[]) {
    if (key === "id") continue; // id is always from existing
    if (merged[key] === undefined) {
      merged[key] = incoming[key];
    }
  }

  return merged;
}

/**
 * Sync clawforce agents into OpenClaw's config.agents.list[].
 *
 * - Reads current config via loadConfig()
 * - For each agent: builds entry, merges with existing (if any)
 * - Writes config only if something changed (batched single write)
 * - Per-agent errors are isolated; one failure doesn't block others
 */
export async function syncAgentsToOpenClaw(params: SyncParams): Promise<SyncResult> {
  const { agents, loadConfig, writeConfigFile, logger } = params;
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

  if (agents.length === 0) return result;

  let config: OpenClawConfigSubset;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = `Failed to load OpenClaw config: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    logger?.warn(`Clawforce agent sync: ${msg}`);
    return result;
  }

  // Ensure agents.list exists
  if (!config.agents) config.agents = {};
  if (!config.agents.list) config.agents.list = [];

  const existingById = new Map<string, number>();
  for (let i = 0; i < config.agents.list.length; i++) {
    const entry = config.agents.list[i]!;
    existingById.set(entry.id, i);
  }

  let changed = false;

  for (const { agentId, config: agentConfig, projectDir } of agents) {
    try {
      const incoming = buildOpenClawAgentEntry(agentId, agentConfig, projectDir);
      const existingIdx = existingById.get(agentId);

      if (existingIdx !== undefined) {
        // Merge with existing entry
        const existing = config.agents!.list![existingIdx]!;
        const merged = mergeAgentEntry(existing, incoming);

        // Check if merge actually changed anything
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          config.agents!.list![existingIdx] = merged;
          changed = true;
          result.synced++;
        } else {
          result.skipped++;
        }
      } else {
        // New agent — append
        config.agents!.list!.push(incoming);
        existingById.set(agentId, config.agents!.list!.length - 1);
        changed = true;
        result.synced++;
      }
    } catch (err) {
      const msg = `Agent "${agentId}": ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      logger?.warn(`Clawforce agent sync error: ${msg}`);
    }
  }

  if (changed) {
    try {
      await writeConfigFile(config);
      logger?.info(`Clawforce agent sync: synced ${result.synced} agent(s) to OpenClaw config`);
    } catch (err) {
      const msg = `Failed to write OpenClaw config: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      logger?.warn(`Clawforce agent sync: ${msg}`);
    }
  }

  return result;
}
