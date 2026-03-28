/**
 * Clawforce — Agent sync to OpenClaw
 *
 * One-way projection of clawforce agent configs (project.yaml) into OpenClaw's
 * config (agents.list[]) so they appear in `oc agents list`, channel routing,
 * and the OpenClaw dashboard.
 *
 * project.yaml remains source of truth. User customizations in OpenClaw config
 * are preserved via a "user-wins" merge strategy.
 *
 * Agent IDs are namespaced with the domain (projectId) to prevent collisions
 * between domains: e.g. "demo-company:backend", "clawforce-dev:cf-lead".
 * Internal ClawForce references use the short (bare) ID; namespacing only
 * applies at the OpenClaw sync/dispatch boundary.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentConfig as ClawforceAgentConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Namespace utilities — domain:agentId at the OpenClaw boundary
// ---------------------------------------------------------------------------

/** Separator used between domain and agent ID in namespaced identifiers. */
const NS_SEP = ":";

/**
 * Build a namespaced agent ID for use in OpenClaw config and dispatch.
 * E.g. toNamespacedAgentId("demo-company", "backend") → "demo-company:backend"
 */
export function toNamespacedAgentId(domain: string, agentId: string): string {
  // Guard: if the agentId is already namespaced with this domain, return as-is
  if (agentId.startsWith(`${domain}${NS_SEP}`)) return agentId;
  return `${domain}${NS_SEP}${agentId}`;
}

/**
 * Parse a namespaced agent ID into { domain, agentId }.
 * Returns null if the ID is not namespaced (no separator found).
 */
export function parseNamespacedAgentId(
  namespacedId: string,
): { domain: string; agentId: string } | null {
  const idx = namespacedId.indexOf(NS_SEP);
  if (idx <= 0 || idx === namespacedId.length - 1) return null;
  return { domain: namespacedId.slice(0, idx), agentId: namespacedId.slice(idx + 1) };
}

/**
 * Check whether an agent ID is already namespaced.
 */
export function isNamespacedAgentId(id: string): boolean {
  const idx = id.indexOf(NS_SEP);
  return idx > 0 && idx < id.length - 1;
}

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
  /** Domain (projectId) this agent belongs to. Used for namespace isolation. */
  domain?: string;
};

export type SyncResult = {
  synced: number;
  skipped: number;
  errors: string[];
  /** Collision warnings: namespaced IDs that already exist from a different domain. */
  collisions: string[];
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
 *
 * When `domain` is provided the agent ID is namespaced as `{domain}:{agentId}`
 * to prevent collisions with personal agents or agents from other domains.
 * A `clawforce_domain` metadata field is added so ownership is traceable.
 */
export function buildOpenClawAgentEntry(
  agentId: string,
  config: ClawforceAgentConfig,
  projectDir?: string,
  domain?: string,
): OpenClawAgentEntry {
  // Namespace the ID when domain context is available
  const effectiveId = domain ? toNamespacedAgentId(domain, agentId) : agentId;
  const entry: OpenClawAgentEntry = { id: effectiveId };

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

  if (config.model) {
    entry.model = { primary: config.model };
  }

  // CO-1: Propagate bootstrap config to OpenClaw agent entry
  if (config.bootstrapConfig) {
    if (config.bootstrapConfig.maxChars !== undefined) {
      entry.bootstrapMaxChars = config.bootstrapConfig.maxChars;
    }
    if (config.bootstrapConfig.totalMaxChars !== undefined) {
      entry.bootstrapTotalMaxChars = config.bootstrapConfig.totalMaxChars;
    }
  }

  // CO-3: Propagate allowed tools to OpenClaw agent entry
  if (config.allowedTools && config.allowedTools.length > 0) {
    entry.allowedTools = config.allowedTools;
  }

  // Track which domain owns this agent for collision detection
  if (domain) {
    entry.clawforce_domain = domain;
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

  // Fields where ClawForce config wins over existing OpenClaw config
  const CLAWFORCE_WINS = new Set(["model", "allowedTools", "bootstrapMaxChars", "bootstrapTotalMaxChars", "clawforce_domain"]);

  for (const key of Object.keys(incoming) as (keyof OpenClawAgentEntry)[]) {
    if (key === "id") continue; // id is always from existing
    if (CLAWFORCE_WINS.has(key as string) && incoming[key] !== undefined) {
      // ClawForce is the source of truth for these fields
      merged[key] = incoming[key];
    } else if (merged[key] === undefined) {
      merged[key] = incoming[key];
    }
  }

  return merged;
}

/**
 * Sync clawforce agents into OpenClaw's config.agents.list[].
 *
 * - Reads current config via loadConfig()
 * - For each agent: builds entry with namespaced ID, merges with existing (if any)
 * - Detects collisions: warns if a namespaced ID already exists from a DIFFERENT domain
 * - Writes config only if something changed (batched single write)
 * - Per-agent errors are isolated; one failure doesn't block others
 */
export async function syncAgentsToOpenClaw(params: SyncParams): Promise<SyncResult> {
  const { agents, loadConfig, writeConfigFile, logger } = params;
  const result: SyncResult = { synced: 0, skipped: 0, errors: [], collisions: [] };

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

  for (const { agentId, config: agentConfig, projectDir, domain } of agents) {
    try {
      const incoming = buildOpenClawAgentEntry(agentId, agentConfig, projectDir, domain);
      const namespacedId = incoming.id; // already namespaced by buildOpenClawAgentEntry

      // Collision detection: check if this namespaced ID already exists from a different domain
      const existingIdx = existingById.get(namespacedId);
      if (existingIdx !== undefined) {
        const existing = config.agents!.list![existingIdx]!;
        const existingDomain = existing.clawforce_domain as string | undefined;
        if (existingDomain && domain && existingDomain !== domain) {
          const msg = `Namespace collision: "${namespacedId}" already exists from domain "${existingDomain}", incoming domain "${domain}"`;
          result.collisions.push(msg);
          logger?.warn(`Clawforce agent sync: ${msg}`);
          // Skip this agent — do not overwrite another domain's entry
          result.skipped++;
          continue;
        }

        // Merge with existing entry (same domain or no domain mismatch)
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
        existingById.set(namespacedId, config.agents!.list!.length - 1);
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

/**
 * CO-2: Clean up bootstrap files excluded by agent config.
 *
 * OpenClaw seeds workspace bootstrap files (AGENTS.md, HEARTBEAT.md, etc.)
 * on first use. ClawForce agents that don't need them can exclude them via
 * `bootstrapExcludeFiles`. This function removes those files from the workspace.
 *
 * Only deletes files whose basenames match VALID_BOOTSTRAP_NAMES to prevent
 * accidental deletion of user files.
 */
const VALID_BOOTSTRAP_NAMES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
  "MEMORIES.md",
]);

export type BootstrapCleanupResult = {
  deleted: string[];
  skipped: string[];
  errors: string[];
};

export function cleanupBootstrapFiles(
  workspaceDir: string,
  excludeFiles: string[],
): BootstrapCleanupResult {
  const result: BootstrapCleanupResult = { deleted: [], skipped: [], errors: [] };

  for (const fileName of excludeFiles) {
    // Safety: only delete recognized bootstrap filenames
    if (!VALID_BOOTSTRAP_NAMES.has(fileName)) {
      result.skipped.push(fileName);
      continue;
    }

    const filePath = path.join(workspaceDir, fileName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        result.deleted.push(fileName);
      }
    } catch (err) {
      result.errors.push(`${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Clean up bootstrap files for all agents in a batch.
 * Call after syncAgentsToOpenClaw to enforce bootstrap exclusions.
 */
export function cleanupAllBootstrapFiles(
  agents: SyncAgentInput[],
): BootstrapCleanupResult {
  const result: BootstrapCleanupResult = { deleted: [], skipped: [], errors: [] };

  for (const { agentId, config, projectDir } of agents) {
    if (!config.bootstrapExcludeFiles || config.bootstrapExcludeFiles.length === 0) continue;
    if (!projectDir) continue;

    const agentResult = cleanupBootstrapFiles(projectDir, config.bootstrapExcludeFiles);
    result.deleted.push(...agentResult.deleted.map(f => `${agentId}:${f}`));
    result.skipped.push(...agentResult.skipped.map(f => `${agentId}:${f}`));
    result.errors.push(...agentResult.errors.map(e => `${agentId}:${e}`));
  }

  return result;
}
