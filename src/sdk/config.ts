/**
 * Clawforce SDK — Config Namespace
 *
 * Wraps internal config loading and registry functions with the public SDK
 * vocabulary:
 *   role  → extends      (internal GlobalAgentDef)
 *   group → department   (internal AgentConfig)
 *
 * No internal files are modified — this is a pure wrapper layer.
 */

import * as path from "node:path";
import { initializeAllDomains } from "../config/init.js";
import {
  getAgentConfig,
  getRegisteredAgentIds,
  getExtendedProjectConfig,
} from "../project.js";
import { BUILTIN_AGENT_PRESETS } from "../presets.js";
import type { AgentConfig as PublicAgentConfig } from "./types.js";

/**
 * Convert an internal AgentConfig entry to the public SDK AgentConfig shape.
 *
 * Vocabulary mapping:
 *   extends    → role
 *   department → group
 *   team       → subgroup
 */
function toPublicAgentConfig(agentId: string): PublicAgentConfig | undefined {
  const entry = getAgentConfig(agentId);
  if (!entry) return undefined;
  const { config } = entry;

  const { extends: _extends, department, team, ...rest } = config as Record<string, unknown>;

  return {
    ...rest,
    role: _extends as string | undefined,
    group: department as string | undefined,
    subgroup: team as string | undefined,
  } as PublicAgentConfig;
}

export class ConfigNamespace {
  constructor(readonly domain: string) {}

  /**
   * Load domain config from a config directory path (or a YAML file path —
   * the parent directory is used as the base dir in that case).
   *
   * Calls initializeAllDomains on the resolved base directory, which reads
   * `config.yaml` + `domains/*.yaml` and registers all agents and domains.
   */
  load(configPath: string): void {
    // If the caller passes a YAML file path, treat its parent dir as baseDir.
    const baseDir = configPath.endsWith(".yaml")
      ? path.dirname(configPath)
      : configPath;

    initializeAllDomains(baseDir);
  }

  /**
   * Return an agent's resolved config (public vocabulary) when agentId is
   * provided, or the full extended domain config when called with no argument.
   *
   * Agent config uses abstract vocabulary:
   *   role     instead of extends
   *   group    instead of department
   *   subgroup instead of team
   */
  get(agentId?: string): any {
    if (agentId !== undefined) {
      return toPublicAgentConfig(agentId);
    }
    // No agentId — return the extended domain config
    return getExtendedProjectConfig(this.domain);
  }

  /**
   * Return available agent presets.
   * Keys are preset names, values are the preset definitions.
   * Currently returns the built-in presets; user-defined presets can be
   * merged in here as that surface is added to the config system.
   */
  presets(): Record<string, any> {
    return { ...BUILTIN_AGENT_PRESETS };
  }

  /**
   * List the agent IDs registered under this domain.
   */
  agents(): string[] {
    const allIds = getRegisteredAgentIds();
    return allIds.filter((agentId) => {
      const entry = getAgentConfig(agentId);
      return entry?.projectId === this.domain;
    });
  }

  /**
   * Return the full extended project config for this domain (monitoring,
   * policies, risk tiers, channels, safety, etc.).
   */
  extended(): any {
    return getExtendedProjectConfig(this.domain);
  }
}
