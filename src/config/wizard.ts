/**
 * Clawforce — Init Wizard
 *
 * Programmatic API for scaffolding config directories and creating domains.
 * CLI wrapper provides interactive prompts; agents call these functions directly.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { GlobalConfig, DomainConfig } from "./schema.js";
import { loadGlobalConfig } from "./loader.js";

export type InitDomainOpts = {
  name: string;
  paths?: string[];
  orchestrator?: string;
  agents: string[];
  /** Map of agent name → preset name for agents that should be auto-added to global config */
  agentPresets?: Record<string, string>;
  /** Operational profile level for this domain. */
  operational_profile?: "low" | "medium" | "high" | "ultra";
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
        globalConfig.agents[agentId] = { extends: preset };
        changed = true;
      }
    }

    if (changed) {
      const configPath = path.join(baseDir, "config.yaml");
      fs.writeFileSync(configPath, YAML.stringify(globalConfig), "utf-8");
    }
  }

  // Build domain config
  const domainConfig: Record<string, unknown> = {
    domain: opts.name,
    agents: opts.agents,
  };
  if (opts.orchestrator) domainConfig.orchestrator = opts.orchestrator;
  if (opts.paths && opts.paths.length > 0) domainConfig.paths = opts.paths;
  if (opts.operational_profile) domainConfig.operational_profile = opts.operational_profile;

  // Write domain file
  fs.writeFileSync(domainPath, YAML.stringify(domainConfig), "utf-8");
}
