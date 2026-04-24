/**
 * Clawforce — Agent sync to OpenClaw
 *
 * One-way projection of clawforce agent configs (`config.yaml` plus domain membership)
 * into OpenClaw's
 * config (agents.list[]) so they appear in `oc agents list`, channel routing,
 * and the OpenClaw dashboard.
 *
 * Clawforce config remains source of truth. User customizations in OpenClaw config
 * are preserved via a "user-wins" merge strategy.
 *
 * Agent IDs are namespaced with the domain (projectId) to prevent collisions
 * between domains: e.g. "demo-company:backend", "clawforce-dev:cf-lead".
 * Internal ClawForce references use the short (bare) ID; namespacing only
 * applies at the OpenClaw sync/dispatch boundary.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getAgentAllowedTools,
  getAgentBootstrapExcludeFiles,
  getAgentWorkspacePaths,
} from "./agent-runtime-config.js";
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
export type OpenClawToolPolicy = {
  profile?: string;
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  [key: string]: unknown;
};

export type OpenClawAgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  tools?: OpenClawToolPolicy;
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
  plugins?: {
    entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
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

function resolveManagedOpenClawAgentId(
  agentId: string,
  config: ClawforceAgentConfig,
  domain?: string,
): string {
  if (config.runtimeRef && config.runtimeRef.trim().length > 0) {
    return config.runtimeRef.trim();
  }
  return domain ? toNamespacedAgentId(domain, agentId) : agentId;
}

type SyncParams = {
  agents: SyncAgentInput[];
  loadConfig: () => OpenClawConfigSubset;
  writeConfigFile: (cfg: OpenClawConfigSubset) => Promise<void>;
  logger?: { info(msg: string): void; warn(msg: string): void };
};

const CLAWFORCE_PLUGIN_ID = "clawforce";
const MANAGED_AGENT_IDS_KEY = "managedAgentIds";
const CLAWFORCE_TO_OPENCLAW_TOOL_IDS: Record<string, readonly string[]> = {
  bash: ["exec", "process"],
  read: ["read"],
  edit: ["edit", "apply_patch"],
  write: ["write", "apply_patch"],
  websearch: ["web_search", "web_fetch"],
};

function getManagedAgentIds(config: OpenClawConfigSubset): Set<string> {
  const raw =
    config.plugins?.entries?.[CLAWFORCE_PLUGIN_ID]?.config?.[MANAGED_AGENT_IDS_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
}

function setManagedAgentIds(config: OpenClawConfigSubset, ids: Iterable<string>): void {
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  const existing = config.plugins.entries[CLAWFORCE_PLUGIN_ID] ?? {};
  config.plugins.entries[CLAWFORCE_PLUGIN_ID] = {
    ...existing,
    config: {
      ...(existing.config ?? {}),
      [MANAGED_AGENT_IDS_KEY]: [...ids].sort(),
    },
  };
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function normalizeToolKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function buildOpenClawToolPolicy(
  allowedTools: string[] | undefined,
): OpenClawToolPolicy | undefined {
  if (!allowedTools || allowedTools.length === 0) return undefined;
  const allow: string[] = [];
  const seen = new Set<string>();

  for (const rawToolName of allowedTools) {
    const trimmed = rawToolName.trim();
    if (!trimmed) continue;
    const mappedToolIds = CLAWFORCE_TO_OPENCLAW_TOOL_IDS[normalizeToolKey(trimmed)] ?? [trimmed];
    for (const toolId of mappedToolIds) {
      if (seen.has(toolId)) continue;
      seen.add(toolId);
      allow.push(toolId);
    }
  }

  return allow.length > 0 ? { allow } : undefined;
}

/**
 * Map a clawforce agent config to an OpenClaw agent entry.
 *
 * Only maps fields that have a clear OpenClaw equivalent.
 * Clawforce-internal fields (persona, department, expectations, etc.) are not mapped.
 *
 * When `domain` is provided the agent ID is namespaced as `{domain}:{agentId}`
 * to prevent collisions with personal agents or agents from other domains.
 */
export function buildOpenClawAgentEntry(
  agentId: string,
  config: ClawforceAgentConfig,
  projectDir?: string,
  domain?: string,
): OpenClawAgentEntry {
  const effectiveId = resolveManagedOpenClawAgentId(agentId, config, domain);
  const entry: OpenClawAgentEntry = { id: effectiveId };

  if (config.title) {
    entry.name = config.title;
    entry.identity = { name: config.title };
  }

  const workspaceRoots = resolveWorkspaceRoots(getAgentWorkspacePaths(config), projectDir);
  if (workspaceRoots.length > 0) {
    entry.workspace = workspaceRoots[0];
  }

  const allowedTools = getAgentAllowedTools(config);
  const toolPolicy = buildOpenClawToolPolicy(allowedTools);
  if (toolPolicy) {
    entry.tools = toolPolicy;
  }

  if (config.extends === "manager" || config.coordination?.enabled) {
    entry.subagents = { allowAgents: ["*"] };
  }

  return entry;
}

/**
 * Merge an incoming ClawForce projection into an existing OpenClaw entry.
 * ClawForce remains authoritative for security-sensitive runtime fields.
 */
export function mergeAgentEntry(
  existing: OpenClawAgentEntry,
  incoming: OpenClawAgentEntry,
): OpenClawAgentEntry {
  const merged = { ...existing };

  // Fields where ClawForce config wins over existing OpenClaw config
  const CLAWFORCE_WINS = new Set(["model", "workspace", "tools"]);

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

function resolveWorkspaceRoots(
  workspacePaths: string[] | undefined,
  projectDir?: string,
): string[] {
  const rawRoots = workspacePaths && workspacePaths.length > 0
    ? workspacePaths
    : (projectDir ? [projectDir] : []);
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of rawRoots) {
    const normalized = resolveWorkspacePath(rawPath, projectDir);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(normalized);
  }

  return resolved;
}

function resolveWorkspacePath(rawPath: string, projectDir?: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? null;
  if (trimmed === "~" && homeDir) {
    return homeDir;
  }
  if (trimmed.startsWith("~/") && homeDir) {
    return path.join(homeDir, trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (projectDir) {
    return path.resolve(projectDir, trimmed);
  }
  return path.resolve(trimmed);
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

  let config: OpenClawConfigSubset;
  try {
    // OpenClaw's hosted runtime persists writes by diffing the candidate config
    // against its current runtime snapshot. Mutating the loaded snapshot in place
    // makes that diff empty, so clone before applying sync changes.
    config = structuredClone(loadConfig());
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

  const previousManagedIds = getManagedAgentIds(config);
  const nextManagedIds = new Set<string>();
  let changed = false;
  const desiredIds = new Set<string>();
  for (const { agentId, config: agentConfig, projectDir, domain } of agents) {
    void agentConfig;
    void projectDir;
    desiredIds.add(resolveManagedOpenClawAgentId(agentId, agentConfig, domain));
  }

  const staleIndices: number[] = [];
  for (let i = 0; i < config.agents.list.length; i++) {
    const entry = config.agents.list[i]!;
    const ownedByClawforce = previousManagedIds.has(entry.id);
    if (!ownedByClawforce) continue;
    if (desiredIds.has(entry.id)) continue;
    staleIndices.push(i);
  }

  for (const index of staleIndices.sort((a, b) => b - a)) {
    config.agents.list.splice(index, 1);
    changed = true;
  }

  if (staleIndices.length > 0) {
    existingById.clear();
    for (let i = 0; i < config.agents.list.length; i++) {
      existingById.set(config.agents.list[i]!.id, i);
    }
  }

  for (const { agentId, config: agentConfig, projectDir, domain } of agents) {
    try {
      const incoming = buildOpenClawAgentEntry(agentId, agentConfig, projectDir, domain);
      const namespacedId = incoming.id;

      const existingIdx = existingById.get(namespacedId);
      if (existingIdx !== undefined) {
        const existing = config.agents!.list![existingIdx]!;
        const existingManaged = previousManagedIds.has(namespacedId);
        if (domain && !existingManaged) {
          const msg = `Namespace collision: "${namespacedId}" already exists in OpenClaw config and is not managed by Clawforce`;
          result.collisions.push(msg);
          logger?.warn(`Clawforce agent sync: ${msg}`);
          result.skipped++;
          continue;
        }

        const merged = mergeAgentEntry(existing, incoming);

        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          config.agents!.list![existingIdx] = merged;
          changed = true;
          result.synced++;
        } else {
          result.skipped++;
        }
        nextManagedIds.add(namespacedId);
      } else {
        config.agents!.list!.push(incoming);
        existingById.set(namespacedId, config.agents!.list!.length - 1);
        changed = true;
        result.synced++;
        nextManagedIds.add(namespacedId);
      }
    } catch (err) {
      const msg = `Agent "${agentId}": ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      logger?.warn(`Clawforce agent sync error: ${msg}`);
    }
  }

  if (!sameIdSet(previousManagedIds, nextManagedIds)) {
    setManagedAgentIds(config, nextManagedIds);
    changed = true;
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
    const bootstrapExcludeFiles = getAgentBootstrapExcludeFiles(config);
    if (!bootstrapExcludeFiles || bootstrapExcludeFiles.length === 0) continue;
    if (!projectDir) continue;

    const agentResult = cleanupBootstrapFiles(projectDir, bootstrapExcludeFiles);
    result.deleted.push(...agentResult.deleted.map(f => `${agentId}:${f}`));
    result.skipped.push(...agentResult.skipped.map(f => `${agentId}:${f}`));
    result.errors.push(...agentResult.errors.map(e => `${agentId}:${e}`));
  }

  return result;
}
