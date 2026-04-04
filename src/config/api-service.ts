/**
 * Clawforce -- Config API Service
 *
 * Encapsulates all config read/write operations behind a clean service layer.
 * The dashboard and other API consumers call these functions instead of doing
 * raw file I/O. This module owns all knowledge of ~/.clawforce paths.
 *
 * Delegates to config/writer.ts and config/loader.ts for actual YAML I/O.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import type { DomainConfig, GlobalConfig, GlobalAgentDef } from "./schema.js";
import { validateDomainConfig } from "./schema.js";
import {
  readDomainConfig as readDomainConfigFile,
  updateDomainConfig as updateDomainConfigFile,
  writeDomainConfig as writeDomainConfigFile,
  readGlobalConfig as readGlobalConfigFile,
  updateGlobalConfig as updateGlobalConfigFile,
} from "./writer.js";
import { loadGlobalConfig } from "./loader.js";
import { scaffoldConfigDir } from "./wizard.js";
import { initializeAllDomains } from "./init.js";
import { safeLog } from "../diagnostics.js";

// --- Internal ---

/** Resolve the ClawForce base directory (~/.clawforce), respecting CLAWFORCE_HOME override. */
function getBaseDir(): string {
  return process.env.CLAWFORCE_HOME ?? path.join(os.homedir(), ".clawforce");
}

// --- Read operations ---

/**
 * Read a domain's config (parsed, validated).
 * Returns the DomainConfig or null if the domain does not exist.
 */
export function readDomainConfig(projectId: string): DomainConfig | null {
  return readDomainConfigFile(getBaseDir(), projectId);
}

/**
 * Read the global config. Returns a default empty config if the file does not exist.
 */
export function readGlobalConfig(): GlobalConfig {
  return loadGlobalConfig(getBaseDir());
}

/**
 * Get the context directory path for a domain (for context file operations).
 * This is where DIRECTION.md, POLICIES.md, etc. live.
 */
export function getDomainContextDir(projectId: string): string {
  return path.join(getBaseDir(), "domains", projectId, "context");
}

// --- Write operations ---

/**
 * Update a section of domain config. Validates, persists, and emits audit event.
 *
 * @param projectId - The domain/project ID
 * @param section - The top-level config key to update (e.g. "agents", "budget", "safety")
 * @param data - The new value for the section
 * @param actor - Who initiated the change (default: "dashboard")
 * @returns Result with ok/error
 */
export function updateDomainConfig(
  projectId: string,
  section: string,
  data: unknown,
  actor = "dashboard",
): { ok: boolean; error?: string; warnings?: string[]; reloadErrors?: string[] } {
  const baseDir = getBaseDir();
  const result = updateDomainConfigFile(baseDir, projectId, { [section]: data }, actor);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Reload domain config into runtime
  try {
    const reloadResult = initializeAllDomains(baseDir);
    if (reloadResult.errors.length > 0 || reloadResult.warnings.length > 0) {
      return {
        ok: true,
        ...(reloadResult.warnings.length > 0 ? { warnings: reloadResult.warnings } : {}),
        ...(reloadResult.errors.length > 0 ? { reloadErrors: reloadResult.errors } : {}),
      };
    }
  } catch (err) {
    // Non-fatal: file is saved even if runtime reload fails
    safeLog("config.api-service", `Runtime reload after config update failed: ${err}`);
    return { ok: true, warnings: [`Runtime reload failed: ${err instanceof Error ? err.message : String(err)}`] };
  }

  return { ok: true };
}

/**
 * Update global agent config (merge into existing agent entry).
 */
export function updateGlobalAgentConfig(
  agentId: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  const baseDir = getBaseDir();
  const globalConfig = readGlobalConfigFile(baseDir);

  if (!globalConfig.agents[agentId]) {
    return { ok: false, error: `Agent "${agentId}" not found in global config` };
  }

  // Merge updates into the agent's config
  const agentUpdates: Record<string, unknown> = {};
  agentUpdates[agentId] = { ...globalConfig.agents[agentId], ...updates };
  const result = updateGlobalConfigFile(baseDir, { agents: agentUpdates }, actor);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true };
}

/**
 * Create a new domain with initial config.
 * Scaffolds the config directory if needed, writes the domain YAML,
 * and loads it into the runtime.
 */
export function createDomain(
  domainId: string,
  config: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const baseDir = getBaseDir();

  try {
    // Ensure base directory structure exists
    scaffoldConfigDir(baseDir);

    // Build and validate domain config
    const domainConfig: Record<string, unknown> = {
      domain: domainId,
      agents: [],
      ...config,
    };
    domainConfig.domain = domainId; // Ensure domain name matches

    const validation = validateDomainConfig(domainConfig);
    if (!validation.valid) {
      const details = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ");
      return { ok: false, error: `Validation failed: ${details}` };
    }

    // Write domain file
    const domainsDir = path.join(baseDir, "domains");
    fs.mkdirSync(domainsDir, { recursive: true });

    const result = writeDomainConfigFile(baseDir, domainId, domainConfig as unknown as DomainConfig);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Load into runtime
    try {
      initializeAllDomains(baseDir);
    } catch (err) {
      safeLog("config.api-service", `Runtime init after domain creation failed: ${err}`);
      // Non-fatal: file is written
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write agents to the global config (merge into existing agents map).
 * Used by demo creation and bulk agent setup.
 */
export function upsertGlobalAgents(
  agents: Record<string, GlobalAgentDef>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  const baseDir = getBaseDir();

  try {
    const globalConfig = readGlobalConfigFile(baseDir);
    const existingAgents = globalConfig.agents ?? {};
    Object.assign(existingAgents, agents);

    const result = updateGlobalConfigFile(baseDir, { agents: existingAgents }, actor);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write a raw domain YAML config (full replacement, not merge).
 * Used for demo creation where the entire domain config is constructed.
 */
export function writeDomainConfig(
  domainId: string,
  config: DomainConfig,
): { ok: boolean; error?: string } {
  const baseDir = getBaseDir();

  try {
    scaffoldConfigDir(baseDir);
    const result = writeDomainConfigFile(baseDir, domainId, config);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reload all domains into the runtime after config changes.
 * Returns the init result with loaded domain IDs.
 */
export function reloadAllDomains(): { domains: string[]; errors: string[] } {
  const baseDir = getBaseDir();
  try {
    const result = initializeAllDomains(baseDir);
    return { domains: result.domains, errors: result.errors };
  } catch (err) {
    return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}
