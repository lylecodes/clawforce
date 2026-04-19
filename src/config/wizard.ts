/**
 * Clawforce — Init Wizard
 *
 * Programmatic API for scaffolding config directories and creating domains.
 * CLI wrapper provides interactive prompts; agents call these functions directly.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { GlobalConfig, DomainConfig, GlobalAgentDef } from "./schema.js";
import { loadGlobalConfig, loadAllDomains } from "./loader.js";
import {
  removeGlobalAgent as removeGlobalAgentViaWriter,
  updateDomainConfig as updateDomainConfigViaWriter,
  updateGlobalAgent as updateGlobalAgentViaWriter,
  upsertGlobalAgent as upsertGlobalAgentViaWriter,
} from "./writer.js";

export type InitDomainOpts = {
  name: string;
  paths?: string[];
  managerAgentId?: string;
  agents: string[];
  /** Map of agent name → preset name for agents that should be auto-added to global config */
  agentPresets?: Record<string, string>;
  /** Operational profile level for this domain. */
  operational_profile?: "low" | "medium" | "high" | "ultra";
  /** Team template name (e.g. "startup", "custom"). */
  template?: string;
};

/**
 * Scaffold the base Clawforce config directory structure.
 * Creates config.yaml (with empty agents if missing), domains/, and data/ directories.
 * Idempotent — won't overwrite existing config.yaml.
 */
export function scaffoldConfigDir(baseDir: string): void {
  fs.mkdirSync(path.join(baseDir, "domains"), { recursive: true });
  fs.mkdirSync(path.join(baseDir, "data"), { recursive: true });

  const configPath = path.join(baseDir, "config.yaml");
  if (!fs.existsSync(configPath)) {
    const defaultConfig: GlobalConfig = { agents: {} };
    fs.writeFileSync(configPath, YAML.stringify(defaultConfig), "utf-8");
  }
}

/**
 * Create a new domain config file.
 * Also adds any new agents (from agentPresets) to the global config.
 * Throws if domain already exists.
 */
export function initDomain(baseDir: string, opts: InitDomainOpts): void {
  const domainPath = path.join(baseDir, "domains", `${opts.name}.yaml`);
  if (fs.existsSync(domainPath)) {
    throw new Error(`Domain "${opts.name}" already exists at ${domainPath}`);
  }

  // Add new agents to global config if agentPresets provided
  if (opts.agentPresets && Object.keys(opts.agentPresets).length > 0) {
    const globalConfig = loadGlobalConfig(baseDir);
    let changed = false;

    for (const [agentId, preset] of Object.entries(opts.agentPresets)) {
      if (!globalConfig.agents[agentId]) {
        const result = upsertGlobalAgentViaWriter(baseDir, agentId, { extends: preset }, "wizard:init_domain");
        if (!result.ok) {
          throw new Error(result.error ?? `Failed to add agent "${agentId}" to global config`);
        }
        changed = true;
      }
    }
    void changed;
  }

  // Build domain config
  const domainConfig: Record<string, unknown> = {
    domain: opts.name,
    agents: opts.agents,
  };
  if (opts.managerAgentId) {
    domainConfig.manager = {
      enabled: true,
      agentId: opts.managerAgentId,
    };
  }
  if (opts.paths && opts.paths.length > 0) domainConfig.paths = opts.paths;
  if (opts.operational_profile) domainConfig.operational_profile = opts.operational_profile;

  // Write domain file
  fs.writeFileSync(domainPath, YAML.stringify(domainConfig), "utf-8");
}

// --- Extended wizard operations (used by config-tool) ---

export type UpdateDomainOpts = {
  /** Fields to merge into the domain config. domain name cannot be changed. */
  updates: Record<string, unknown>;
};

/**
 * Update an existing domain config file. Field-level merge — does not
 * replace the entire file, only updates specified fields.
 * Throws if domain does not exist.
 */
export function updateDomain(baseDir: string, domainName: string, opts: UpdateDomainOpts): void {
  const result = updateDomainConfigViaWriter(baseDir, domainName, opts.updates, "wizard:update_domain");
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to update domain "${domainName}"`);
  }
}

/**
 * Delete a domain config file from disk.
 * Throws if domain does not exist.
 */
export function deleteDomain(baseDir: string, domainName: string): void {
  const domainPath = path.join(baseDir, "domains", `${domainName}.yaml`);
  if (!fs.existsSync(domainPath)) {
    throw new Error(`Domain "${domainName}" does not exist at ${domainPath}`);
  }
  fs.unlinkSync(domainPath);
}

/**
 * Add an agent to the global config (config.yaml).
 * Idempotent — will not overwrite if agent already exists (unless force=true).
 */
export function addAgentToGlobal(
  baseDir: string,
  agentId: string,
  agentDef: GlobalAgentDef,
  force = false,
): boolean {
  const globalConfig = loadGlobalConfig(baseDir);
  if (globalConfig.agents[agentId] && !force) {
    return false; // already exists
  }
  const result = upsertGlobalAgentViaWriter(baseDir, agentId, agentDef, "wizard:add_agent");
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to add agent "${agentId}"`);
  }
  return true;
}

/**
 * Remove an agent from the global config and optionally from all domains.
 * Returns true if the agent was found and removed.
 */
export function removeAgentFromGlobal(
  baseDir: string,
  agentId: string,
  removeFromDomains = false,
): boolean {
  const globalConfig = loadGlobalConfig(baseDir);
  if (!globalConfig.agents[agentId]) {
    return false;
  }
  const result = removeGlobalAgentViaWriter(baseDir, agentId, removeFromDomains, "wizard:remove_agent");
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to remove agent "${agentId}"`);
  }
  return true;
}

/**
 * Update specific fields on an existing agent in global config.
 * Uses field-level merge. Throws if agent does not exist.
 */
export function updateAgentInGlobal(
  baseDir: string,
  agentId: string,
  updates: Record<string, unknown>,
): void {
  const globalConfig = loadGlobalConfig(baseDir);
  if (!globalConfig.agents[agentId]) {
    throw new Error(`Agent "${agentId}" not found in global config`);
  }
  const result = updateGlobalAgentViaWriter(baseDir, agentId, updates, "wizard:update_agent");
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to update agent "${agentId}"`);
  }
}
