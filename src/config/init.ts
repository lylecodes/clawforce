/**
 * Clawforce — Domain-based initialization
 *
 * Loads global config and all domain configs, registers agents globally,
 * and bridges to the existing WorkforceConfig system.
 */

import path from "node:path";
import { loadGlobalConfig, loadAllDomains, validateDomainAgents } from "./loader.js";
import { normalizeAgentConfig as resolveAliases } from "./aliases.js";
import { registerGlobalAgents, assignAgentsToDomain } from "./registry.js";
import { registerDomain } from "../lifecycle.js";
import { registerWorkforceConfig } from "../project.js";
import { resolveConfig, BUILTIN_AGENT_PRESETS } from "../presets.js";
import { safeLog } from "../diagnostics.js";
import type { AgentConfig, ContextSource, Expectation, PerformancePolicy, WorkforceConfig } from "../types.js";
import type { GlobalConfig, DomainConfig, GlobalAgentDef } from "./schema.js";
import { inferPreset, markInferred } from "./inference.js";
import { normalizeDomainProfile } from "../profiles/operational.js";
import { createGoal, listGoals } from "../goals/ops.js";
import { getDb } from "../db.js";
import type { GoalConfigEntry } from "../types.js";

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

  for (let domainConfig of domainConfigs) {
    try {
      // Expand operational profile (pure config transform — no cron registration)
      domainConfig = normalizeDomainProfile(domainConfig, globalConfig);

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

      // Seed goals from domain config (idempotent)
      if (wfConfig.goals) {
        seedGoals(domainConfig.domain, wfConfig.goals);
      }

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

  // Extract manager_overrides from profile expansion (if any)
  const managerOverrides = (domain as Record<string, unknown>).manager_overrides as
    Record<string, Record<string, unknown>> | undefined;

  for (const agentId of domain.agents) {
    const globalDef = global.agents[agentId];
    if (!globalDef) continue; // warned about in validateDomainAgents

    // Resolve config aliases (group→department, subgroup→team, role→extends)
    const normalizedDef = resolveAliases({ ...globalDef } as Record<string, unknown>);

    // Resolve preset inheritance using BUILTIN_AGENT_PRESETS
    const resolved = resolveConfig(normalizedDef, BUILTIN_AGENT_PRESETS);

    // Preserve the extends field in the resolved config (resolveConfig strips it).
    // Use normalizedDef so that `role` alias is captured as well.
    const effectiveExtends = normalizedDef.extends ?? globalDef.extends;
    if (effectiveExtends) {
      resolved.extends = effectiveExtends as string;
    }

    // Apply global defaults
    if (global.defaults?.performance_policy && !resolved.performance_policy) {
      resolved.performance_policy =
        global.defaults.performance_policy as AgentConfig["performance_policy"];
    }

    // Apply operational profile overrides (jobs, scheduling, memory)
    const overrides = managerOverrides?.[agentId];
    if (overrides) {
      if (overrides.jobs) {
        resolved.jobs = { ...(resolved.jobs as Record<string, unknown> ?? {}), ...overrides.jobs };
      }
      if (overrides.scheduling) {
        resolved.scheduling = { ...(resolved.scheduling as Record<string, unknown> ?? {}), ...overrides.scheduling };
      }
      if (overrides.memory) {
        resolved.memory = { ...(resolved.memory as Record<string, unknown> ?? {}), ...overrides.memory };
      }
    }

    // Apply domain defaults (briefing prepended, expectations appended, performance_policy fallback)
    const withDomainDefaults = mergeDomainDefaults(resolved as AgentConfig, domain.defaults);
    agents[agentId] = withDomainDefaults;
  }

  const projectDir = domain.paths?.[0]
    ? resolveHomePath(domain.paths[0])
    : undefined;

  const wfConfig: WorkforceConfig = {
    name: domain.domain,
    agents,
    dir: projectDir ?? ".",
    id: domain.domain,
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
  if (domain.goals)
    wfConfig.goals = domain.goals as WorkforceConfig["goals"];
  if (domain.monitoring)
    wfConfig.monitoring = domain.monitoring as WorkforceConfig["monitoring"];
  if (domain.verification)
    wfConfig.verification = domain.verification as WorkforceConfig["verification"];

  // Build manager config from orchestrator or first manager agent with coordination
  if (domain.orchestrator || domain.manager) {
    const mgrRaw = domain.manager as Record<string, unknown> | undefined;
    wfConfig.manager = {
      enabled: true,
      agentId: domain.orchestrator ?? Object.keys(agents).find(id => agents[id]?.extends === "manager") ?? "manager",
      cronSchedule: (mgrRaw?.cronSchedule as string) ?? undefined,
      ...(mgrRaw ?? {}),
    } as WorkforceConfig["manager"];
  } else {
    // Auto-detect: find the first manager agent with coordination enabled
    for (const [agentId, config] of Object.entries(agents)) {
      if (config.coordination?.enabled && config.coordination?.schedule) {
        wfConfig.manager = {
          enabled: true,
          agentId,
          cronSchedule: config.coordination.schedule,
        } as WorkforceConfig["manager"];
        break;
      }
    }
  }

  return wfConfig;
}

/**
 * Idempotently seed goals from domain config into the DB.
 * Skips goals that already exist (matched by title).
 */
function seedGoals(projectId: string, goals: Record<string, GoalConfigEntry>): void {
  try {
    const existing = listGoals(projectId, { status: "active" });
    const existingTitles = new Set(existing.map((g: { title: string }) => g.title));

    for (const [goalId, goalDef] of Object.entries(goals)) {
      const title = goalId.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      if (existingTitles.has(title)) {
        // Update existing goal's department/allocation if changed in config
        const match = existing.find((g: { title: string }) => g.title === title) as { id: string } | undefined;
        if (match && (goalDef.department || goalDef.allocation)) {
          try {
            const db = getDb(projectId);
            db.prepare("UPDATE goals SET department = COALESCE(?, department), allocation = COALESCE(?, allocation) WHERE id = ?")
              .run(goalDef.department ?? null, goalDef.allocation ?? null, match.id);
          } catch { /* ignore update failures */ }
        }
        continue;
      }

      createGoal({
        projectId,
        title,
        description: goalDef.description,
        department: goalDef.department,
        allocation: goalDef.allocation,
        createdBy: "system:config",
      });
    }
  } catch (err) {
    safeLog("config.init.seedGoals", err);
  }
}

/**
 * Merge domain-level defaults into an agent config.
 *
 * Merge order: domain defaults -> preset (manager/employee) -> agent-specific overrides.
 * - Domain default briefing sources are PREPENDED to the agent's briefing (deduped).
 * - Domain default expectations are APPENDED to the agent's expectations.
 * - Domain default performance_policy is used if the agent doesn't specify one explicitly
 *   (i.e. it only has the inherited preset default).
 */
export function mergeDomainDefaults(
  agentConfig: AgentConfig,
  domainDefaults: DomainConfig["defaults"],
): AgentConfig {
  if (!domainDefaults) return agentConfig;

  const result = { ...agentConfig };

  // Prepend domain default briefing sources (deduped)
  if (domainDefaults.briefing && Array.isArray(domainDefaults.briefing) && domainDefaults.briefing.length > 0) {
    const defaultSources = domainDefaults.briefing as ContextSource[];
    const existingSourceKeys = new Set(result.briefing.map(s => s.source));

    // Only prepend sources not already present
    const newSources = defaultSources.filter(s => !existingSourceKeys.has(s.source));
    result.briefing = [...newSources, ...result.briefing];
  }

  // Append domain default expectations
  if (domainDefaults.expectations && Array.isArray(domainDefaults.expectations) && domainDefaults.expectations.length > 0) {
    const defaultExpectations = domainDefaults.expectations as Expectation[];
    result.expectations = [...result.expectations, ...defaultExpectations];
  }

  // Use domain default performance_policy if provided
  if (domainDefaults.performance_policy && typeof domainDefaults.performance_policy === "object") {
    result.performance_policy = domainDefaults.performance_policy as unknown as PerformancePolicy;
  }

  return result;
}

function resolveHomePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return path.join(home, p.slice(1));
  }
  return path.resolve(p);
}
