/**
 * Clawforce — Domain-based initialization
 *
 * Loads global config and all domain configs, registers agents globally,
 * and bridges to the existing WorkforceConfig system.
 */

import path from "node:path";
import { loadGlobalConfig, loadAllDomains, validateDomainAgents } from "./loader.js";
import { registerGlobalAgents, assignAgentsToDomain } from "./registry.js";
import { registerDomain } from "../lifecycle.js";
import { registerWorkforceConfig } from "../project.js";
import { resolveConfig, BUILTIN_AGENT_PRESETS } from "../presets.js";
import { safeLog } from "../diagnostics.js";
import type { AgentConfig, WorkforceConfig } from "../types.js";
import type { GlobalConfig, DomainConfig, GlobalAgentDef } from "./schema.js";
import { inferPreset, markInferred } from "./inference.js";

export type InitResult = {
  domains: string[];
  errors: string[];
  warnings: string[];
};

/**
 * Initialize all domains from the config directory.
 *
 * 1. Loads global config (agent roster + defaults)
 * 2. Loads all domain configs
 * 3. For each domain: registers agents, builds WorkforceConfig, bridges to existing system
 */
export function initializeAllDomains(baseDir: string): InitResult {
  const result: InitResult = { domains: [], errors: [], warnings: [] };

  // Load global config
  let globalConfig: GlobalConfig;
  try {
    globalConfig = loadGlobalConfig(baseDir);
  } catch (err) {
    result.errors.push(
      `Failed to load global config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // Register global agents
  registerGlobalAgents(globalConfig.agents);

  // Load all domains
  const domainConfigs = loadAllDomains(baseDir);
  if (domainConfigs.length === 0) {
    result.warnings.push("No domain configs found");
    return result;
  }

  for (const domainConfig of domainConfigs) {
    try {
      // Validate agents exist in global config
      const agentWarnings = validateDomainAgents(globalConfig, domainConfig);
      result.warnings.push(...agentWarnings);

      // Assign agents to domain in new registry
      assignAgentsToDomain(domainConfig.domain, domainConfig.agents);

      // Build WorkforceConfig for bridge to existing system
      const wfConfig = buildWorkforceConfig(globalConfig, domainConfig);

      // Determine project dir from first path (if any)
      const projectDir = domainConfig.paths?.[0]
        ? resolveHomePath(domainConfig.paths[0])
        : undefined;

      // Bridge: register in existing system
      registerWorkforceConfig(domainConfig.domain, wfConfig, projectDir);

      // Register in lifecycle
      registerDomain(domainConfig.domain);

      result.domains.push(domainConfig.domain);
    } catch (err) {
      const msg = `Failed to initialize domain "${domainConfig.domain}": ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      safeLog("config.init", msg);
    }
  }

  return result;
}

/**
 * Build a WorkforceConfig from global agent definitions + domain config.
 * This bridges the new config format to the existing system.
 */
function buildWorkforceConfig(
  global: GlobalConfig,
  domain: DomainConfig,
): WorkforceConfig {
  const agents: Record<string, AgentConfig> = {};

  // Build domain-scoped agent map for inference
  const domainAgentDefs: Record<string, GlobalAgentDef> = {};
  for (const agentId of domain.agents) {
    const def = global.agents[agentId];
    if (def) domainAgentDefs[agentId] = def;
  }

  // Infer preset for agents without explicit extends (domain-scoped)
  for (const agentId of domain.agents) {
    const globalDef = global.agents[agentId];
    if (globalDef && !globalDef.extends) {
      // Clone to avoid mutating shared global config across domains
      global.agents[agentId] = { ...globalDef, extends: inferPreset(agentId, domainAgentDefs) };
      markInferred(agentId);
    }
  }

  for (const agentId of domain.agents) {
    const globalDef = global.agents[agentId];
    if (!globalDef) continue; // warned about in validateDomainAgents

    // Resolve preset inheritance using BUILTIN_AGENT_PRESETS
    const resolved = resolveConfig({ ...globalDef }, BUILTIN_AGENT_PRESETS);

    // Preserve the extends field in the resolved config (resolveConfig strips it)
    if (globalDef.extends) {
      resolved.extends = globalDef.extends;
    }

    // Apply global defaults
    if (global.defaults?.model && !resolved.model) {
      resolved.model = global.defaults.model;
    }
    if (global.defaults?.performance_policy && !resolved.performance_policy) {
      resolved.performance_policy =
        global.defaults.performance_policy as AgentConfig["performance_policy"];
    }

    agents[agentId] = resolved as AgentConfig;
  }

  const wfConfig: WorkforceConfig = {
    name: domain.domain,
    agents,
  };

  // Pass through domain-level config sections
  if (domain.policies)
    wfConfig.policies = domain.policies as WorkforceConfig["policies"];
  if (domain.budget)
    wfConfig.budgets = domain.budget as WorkforceConfig["budgets"];
  if (domain.safety)
    wfConfig.safety = domain.safety as WorkforceConfig["safety"];
  if (domain.channels)
    wfConfig.channels = domain.channels as WorkforceConfig["channels"];
  if (domain.event_handlers)
    wfConfig.event_handlers =
      domain.event_handlers as WorkforceConfig["event_handlers"];
  if (domain.knowledge)
    wfConfig.knowledge = domain.knowledge as WorkforceConfig["knowledge"];

  return wfConfig;
}

function resolveHomePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return path.join(home, p.slice(1));
  }
  return path.resolve(p);
}
