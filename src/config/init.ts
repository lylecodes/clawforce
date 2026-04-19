/**
 * Clawforce — Domain-based initialization
 *
 * Loads global config and all domain configs, registers agents globally,
 * and bridges to the existing WorkforceConfig system.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadGlobalConfig, loadAllDomains, validateDomainAgents } from "./loader.js";
import { normalizeAgentConfig as resolveAliases } from "./aliases.js";
import { removeDomain, setAgentsForDomain, syncGlobalAgents } from "./registry.js";
import { activateWorkforceProject, unregisterWorkforceProject } from "../project.js";
import { resolveConfig, deepMerge, BUILTIN_AGENT_PRESETS, mergeConfigLayer } from "../presets.js";
import { safeLog } from "../diagnostics.js";
import type { AgentConfig, ContextSource, Expectation, PerformancePolicy, WorkforceConfig } from "../types.js";
import type { GlobalConfig, DomainConfig, GlobalAgentDef, MixinDef } from "./schema.js";
import { validateDomainConfig } from "./schema.js";
import { inferPreset, markInferred } from "./inference.js";
import { resolveConditionals } from "./conditionals.js";
import { validateAllConfigs } from "./validate.js";
import { normalizeDomainProfile } from "../profiles/operational.js";
import { normalizeEntityKindsConfig } from "../entities/config.js";
import { normalizeExecutionConfig } from "../execution/config.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";
import { getDb } from "../db.js";
import { markControllerLeaseConfigApplied } from "../runtime/controller-leases.js";
import { detectDomainConfigChange } from "../telemetry/config-tracker.js";

export type InitResult = {
  domains: string[];
  errors: string[];
  warnings: string[];
  claimedProjectDirs: string[];
};

export type DomainRuntimeReloadSource = "initialize" | "reload";

export type DomainRuntimeReloadStatus = {
  domainId: string;
  status: "loaded" | "warning" | "error" | "disabled" | "missing";
  runtimeLoaded: boolean;
  configApplied: boolean;
  source: DomainRuntimeReloadSource;
  ownerBaseDir?: string;
  lastAttemptedAt: number;
  lastAppliedAt: number | null;
  errors: string[];
  warnings: string[];
};

type DomainFileLoadResult = {
  exists: boolean;
  config?: DomainConfig;
  error?: string;
};

const runtime = getDefaultRuntimeState();

function getConfigInitState() {
  return runtime.configInit;
}

function getReloadStatusStore() {
  return runtime.configInit.reloadStatusByDomain as Map<string, DomainRuntimeReloadStatus>;
}

function normalizeBaseDir(baseDir: string): string {
  return path.resolve(baseDir);
}

function recordDomainRuntimeReloadStatus(
  domainId: string,
  params: {
    status: DomainRuntimeReloadStatus["status"];
    source: DomainRuntimeReloadSource;
    ownerBaseDir?: string;
    configApplied: boolean;
    runtimeLoaded: boolean;
    errors?: string[];
    warnings?: string[];
  },
): DomainRuntimeReloadStatus {
  const previous = getReloadStatusStore().get(domainId);
  const now = Date.now();
  const appliedAt = params.configApplied
    ? now
    : previous?.lastAppliedAt ?? null;
  const next: DomainRuntimeReloadStatus = {
    domainId,
    status: params.status,
    runtimeLoaded: params.runtimeLoaded,
    configApplied: params.configApplied,
    source: params.source,
    ownerBaseDir: params.ownerBaseDir ?? previous?.ownerBaseDir,
    lastAttemptedAt: now,
    lastAppliedAt: appliedAt,
    errors: params.errors ?? [],
    warnings: params.warnings ?? [],
  };
  getReloadStatusStore().set(domainId, next);
  return next;
}

export function getDomainRuntimeReloadStatus(domainId: string): DomainRuntimeReloadStatus | null {
  return getReloadStatusStore().get(domainId) ?? null;
}

/**
 * Initialize all domains from the config directory.
 *
 * 1. Loads global config (agent roster + defaults)
 * 2. Loads all domain configs
 * 3. For each domain: registers agents, builds WorkforceConfig, bridges to existing system
 */
export function initializeAllDomains(baseDir: string): InitResult {
  const resolvedBaseDir = normalizeBaseDir(baseDir);
  const state = getConfigInitState();
  const result: InitResult = { domains: [], errors: [], warnings: [], claimedProjectDirs: [] };
  const previousManagedDomains = new Set(state.managedDomainsByBaseDir.get(resolvedBaseDir) ?? []);
  const nextManagedDomains = new Set<string>();
  const explicitlyDisabledDomains = new Set<string>();
  const domainFileIds = getDomainFileIds(resolvedBaseDir);

  // Run config validation first — non-blocking, all issues are warnings
  try {
    const report = validateAllConfigs(resolvedBaseDir);
    for (const issue of report.issues) {
      const prefix = issue.severity === "error" ? "ERROR" : issue.severity === "warn" ? "WARN" : "INFO";
      const msg = `[${prefix}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`;
      result.warnings.push(msg);
    }
  } catch (err) {
    // Validation failure is non-blocking — domains still load
    result.warnings.push(`Config validation skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load global config
  let globalConfig: GlobalConfig;
  try {
    globalConfig = loadGlobalConfig(resolvedBaseDir);
  } catch (err) {
    result.errors.push(
      `Failed to load global config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // Synchronize the global roster to the latest config snapshot.
  syncGlobalAgents(globalConfig.agents);

  // Load all domains
  const domainConfigs = loadAllDomains(resolvedBaseDir);
  if (domainConfigs.length === 0) {
    result.warnings.push("No domain configs found");
  }

  for (let domainConfig of domainConfigs) {
    // Skip disabled domains
    if (domainConfig.enabled === false) {
      explicitlyDisabledDomains.add(domainConfig.domain);
      result.warnings.push(`Domain "${domainConfig.domain}" is disabled — skipping`);
      recordDomainRuntimeReloadStatus(domainConfig.domain, {
        status: "disabled",
        source: "initialize",
        ownerBaseDir: resolvedBaseDir,
        configApplied: true,
        runtimeLoaded: runtime.activeProjectIds.has(domainConfig.domain),
        warnings: [`Domain "${domainConfig.domain}" is disabled — skipping`],
      });
      continue;
    }
    const existingOwner = state.domainOwnerBaseDirs.get(domainConfig.domain);
    if (existingOwner && existingOwner !== resolvedBaseDir) {
      const error =
        `Domain "${domainConfig.domain}" is already managed from ${existingOwner}; refusing duplicate load from ${resolvedBaseDir}`;
      result.errors.push(error);
      recordDomainRuntimeReloadStatus(domainConfig.domain, {
        status: "error",
        source: "initialize",
        ownerBaseDir: resolvedBaseDir,
        configApplied: false,
        runtimeLoaded: runtime.activeProjectIds.has(domainConfig.domain),
        errors: [error],
      });
      continue;
    }
    try {
      const warningStart = result.warnings.length;
      domainConfig = initializeRuntimeForDomain(resolvedBaseDir, globalConfig, domainConfig, result);
      recordAppliedDomainConfigVersion(globalConfig, domainConfig, "initialize");
      state.domainOwnerBaseDirs.set(domainConfig.domain, resolvedBaseDir);
      nextManagedDomains.add(domainConfig.domain);
      const domainWarnings = result.warnings.slice(warningStart);
      recordDomainRuntimeReloadStatus(domainConfig.domain, {
        status: domainWarnings.length > 0 ? "warning" : "loaded",
        source: "initialize",
        ownerBaseDir: resolvedBaseDir,
        configApplied: true,
        runtimeLoaded: runtime.activeProjectIds.has(domainConfig.domain),
        warnings: domainWarnings,
      });
    } catch (err) {
      const msg = `Failed to initialize domain "${domainConfig.domain}": ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      safeLog("config.init", msg);
      recordDomainRuntimeReloadStatus(domainConfig.domain, {
        status: "error",
        source: "initialize",
        ownerBaseDir: resolvedBaseDir,
        configApplied: false,
        runtimeLoaded: runtime.activeProjectIds.has(domainConfig.domain),
        errors: [msg],
      });
    }
  }

  for (const staleDomainId of previousManagedDomains) {
    if (nextManagedDomains.has(staleDomainId)) continue;
    const shouldDeactivate = explicitlyDisabledDomains.has(staleDomainId) || !domainFileIds.has(staleDomainId);
    if (!shouldDeactivate) continue;
    const nextStatus: DomainRuntimeReloadStatus["status"] = explicitlyDisabledDomains.has(staleDomainId)
      ? "disabled"
      : "missing";
    deactivateManagedDomain(staleDomainId);
    recordDomainRuntimeReloadStatus(staleDomainId, {
      status: nextStatus,
      source: "initialize",
      ownerBaseDir: resolvedBaseDir,
      configApplied: true,
      runtimeLoaded: runtime.activeProjectIds.has(staleDomainId),
      warnings: [
        nextStatus === "disabled"
          ? `Domain "${staleDomainId}" is disabled — skipping`
          : `Domain "${staleDomainId}" config file not found — domain unloaded`,
      ],
    });
  }

  if (nextManagedDomains.size > 0) {
    state.managedDomainsByBaseDir.set(resolvedBaseDir, nextManagedDomains);
  } else {
    state.managedDomainsByBaseDir.delete(resolvedBaseDir);
  }

  return result;
}

export function reloadDomain(baseDir: string, domainId: string): InitResult {
  return reloadDomains(baseDir, [domainId]);
}

export function reloadDomains(baseDir: string, domainIds: Iterable<string>): InitResult {
  const resolvedBaseDir = normalizeBaseDir(baseDir);
  const state = getConfigInitState();
  const result: InitResult = { domains: [], errors: [], warnings: [], claimedProjectDirs: [] };

  let globalConfig: GlobalConfig;
  try {
    globalConfig = loadGlobalConfig(resolvedBaseDir);
  } catch (err) {
    result.errors.push(`Failed to load global config: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  syncGlobalAgents(globalConfig.agents);

  const requestedDomainIds = [...new Set([...domainIds])];
  for (const domainId of requestedDomainIds) {
    const existingOwner = state.domainOwnerBaseDirs.get(domainId);
    if (existingOwner && existingOwner !== resolvedBaseDir) {
      const error =
        `Domain "${domainId}" is already managed from ${existingOwner}; refusing reload from ${resolvedBaseDir}`;
      result.errors.push(error);
      recordDomainRuntimeReloadStatus(domainId, {
        status: "error",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: false,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        errors: [error],
      });
      continue;
    }

    const loaded = loadDomainConfigById(resolvedBaseDir, domainId);
    if (loaded.error) {
      result.errors.push(loaded.error);
      recordDomainRuntimeReloadStatus(domainId, {
        status: "error",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: false,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        errors: [loaded.error],
      });
      continue;
    }

    if (!loaded.exists || !loaded.config) {
      if (existingOwner === resolvedBaseDir) {
        deactivateManagedDomain(domainId);
      }
      const warning = `Domain "${domainId}" config file not found — skipping reload`;
      result.warnings.push(warning);
      recordDomainRuntimeReloadStatus(domainId, {
        status: "missing",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: true,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        warnings: [warning],
      });
      continue;
    }

    if (loaded.config.enabled === false) {
      if (existingOwner === resolvedBaseDir) {
        deactivateManagedDomain(domainId);
      }
      const warning = `Domain "${domainId}" is disabled — skipping`;
      result.warnings.push(warning);
      recordDomainRuntimeReloadStatus(domainId, {
        status: "disabled",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: true,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        warnings: [warning],
      });
      continue;
    }

    try {
      const warningStart = result.warnings.length;
      const normalizedDomain = initializeRuntimeForDomain(resolvedBaseDir, globalConfig, loaded.config, result);
      recordAppliedDomainConfigVersion(globalConfig, normalizedDomain, "reload");
      state.domainOwnerBaseDirs.set(domainId, resolvedBaseDir);
      let ownedDomains = state.managedDomainsByBaseDir.get(resolvedBaseDir);
      if (!ownedDomains) {
        ownedDomains = new Set<string>();
        state.managedDomainsByBaseDir.set(resolvedBaseDir, ownedDomains);
      }
      ownedDomains.add(domainId);
      const domainWarnings = result.warnings.slice(warningStart);
      recordDomainRuntimeReloadStatus(domainId, {
        status: domainWarnings.length > 0 ? "warning" : "loaded",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: true,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        warnings: domainWarnings,
      });
    } catch (err) {
      const message = `Failed to reload domain "${domainId}": ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(message);
      safeLog("config.init.reload", message);
      recordDomainRuntimeReloadStatus(domainId, {
        status: "error",
        source: "reload",
        ownerBaseDir: resolvedBaseDir,
        configApplied: false,
        runtimeLoaded: runtime.activeProjectIds.has(domainId),
        errors: [message],
      });
    }
  }

  return result;
}

function getDomainFileIds(baseDir: string): Set<string> {
  const domainsDir = path.join(baseDir, "domains");
  if (!fs.existsSync(domainsDir)) {
    return new Set<string>();
  }

  return new Set(
    fs.readdirSync(domainsDir)
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => path.basename(file, ".yaml")),
  );
}

function deactivateManagedDomain(domainId: string): void {
  const state = getConfigInitState();
  removeDomain(domainId);
  unregisterWorkforceProject(domainId);
  const owner = state.domainOwnerBaseDirs.get(domainId);
  if (owner) {
    const ownedDomains = state.managedDomainsByBaseDir.get(owner);
    ownedDomains?.delete(domainId);
    if (ownedDomains && ownedDomains.size === 0) {
      state.managedDomainsByBaseDir.delete(owner);
    }
  }
  state.domainOwnerBaseDirs.delete(domainId);
}

export function syncManagedDomainRoots(baseDirs: Iterable<string>): void {
  const state = getConfigInitState();
  const activeRoots = new Set([...baseDirs].map(normalizeBaseDir));
  for (const knownRoot of [...state.managedDomainsByBaseDir.keys()]) {
    if (activeRoots.has(knownRoot)) continue;
    const domainIds = [...(state.managedDomainsByBaseDir.get(knownRoot) ?? [])];
    for (const domainId of domainIds) {
      deactivateManagedDomain(domainId);
    }
    state.managedDomainsByBaseDir.delete(knownRoot);
  }

  for (const [domainId, status] of [...getReloadStatusStore().entries()]) {
    if (!status.ownerBaseDir) continue;
    if (activeRoots.has(status.ownerBaseDir)) continue;
    getReloadStatusStore().delete(domainId);
  }
}

function loadDomainConfigById(baseDir: string, domainId: string): DomainFileLoadResult {
  const filePath = path.join(baseDir, "domains", `${domainId}.yaml`);
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(raw);
    const validation = validateDomainConfig(parsed);
    if (!validation.valid) {
      const details = validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ");
      return {
        exists: true,
        error: `Invalid domain config at ${filePath}: ${details}`,
      };
    }

    return {
      exists: true,
      config: parsed as DomainConfig,
    };
  } catch (err) {
    return {
      exists: true,
      error: `Failed to load domain "${domainId}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function initializeRuntimeForDomain(
  baseDir: string,
  globalConfig: GlobalConfig,
  domainConfig: DomainConfig,
  result: InitResult,
): DomainConfig {
  // Expand operational profile (pure config transform — no cron registration)
  const normalizedDomain = normalizeDomainProfile(domainConfig, globalConfig);

  // Validate agents exist in global config
  const agentWarnings = validateDomainAgents(globalConfig, normalizedDomain);
  result.warnings.push(...agentWarnings);

  // Assign agents to domain in new registry
  setAgentsForDomain(normalizedDomain.domain, normalizedDomain.agents);

  // Build WorkforceConfig for bridge to existing system
  const wfConfig = buildWorkforceConfig(globalConfig, normalizedDomain);

  // Determine project dir from first path (if any)
  const projectDir = normalizedDomain.paths?.[0]
    ? resolveHomePath(normalizedDomain.paths[0])
    : undefined;

  for (const claimedDir of resolveDomainPaths(normalizedDomain)) {
    if (!result.claimedProjectDirs.includes(claimedDir)) {
      result.claimedProjectDirs.push(claimedDir);
    }
  }

  // Bridge: activate the domain using the shared workforce runtime path so
  // policies, DB/bootstrap, and goals stay aligned.
  activateWorkforceProject(normalizedDomain.domain, wfConfig, {
    projectDir,
    storageDir: baseDir,
    scaffoldAgentDocs: true,
    goalSeedMode: "titleized",
    goalCreatedBy: "system:config",
    syncExistingGoalMetadata: true,
  });

  result.domains.push(normalizedDomain.domain);
  return normalizedDomain;
}

function recordAppliedDomainConfigVersion(
  globalConfig: GlobalConfig,
  domainConfig: DomainConfig,
  source: DomainRuntimeReloadSource,
): void {
  try {
    const db = getDb(domainConfig.domain);
    const fingerprint = detectDomainConfigChange(
      domainConfig.domain,
      globalConfig,
      domainConfig,
      `config.${source}`,
      db,
    );
    markControllerLeaseConfigApplied(
      domainConfig.domain,
      fingerprint.versionId,
      fingerprint.contentHash,
      {},
      db,
    );
  } catch (err) {
    safeLog("config.init.version-tracking", err);
  }
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
  const rawDomain = domain as Record<string, unknown>;

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

    // Resolve config aliases (group→department, subgroup→team)
    const aliasResolved = resolveAliases({ ...globalDef } as Record<string, unknown>);

    // Resolve conditional `when` blocks using agent's own fields as context
    const conditionalContext: Record<string, unknown> = {
      department: aliasResolved.department,
      team: aliasResolved.team,
      extends: aliasResolved.extends,
      title: aliasResolved.title,
    };
    const normalizedDef = resolveConditionals(aliasResolved, conditionalContext);

    // Resolve preset inheritance using BUILTIN_AGENT_PRESETS
    let resolved = resolveConfig(normalizedDef, BUILTIN_AGENT_PRESETS);

    // Preserve the extends field in the resolved config (resolveConfig strips it).
    const effectiveExtends = normalizedDef.extends ?? globalDef.extends;
    if (effectiveExtends) {
      resolved.extends = effectiveExtends as string;
    }

    // Apply mixins after preset resolution, before agent overrides.
    // Mixins merge left-to-right, then agent's own fields re-applied on top.
    resolved = applyMixins(resolved, globalDef, global.mixins);

    // Apply role defaults from domain config (based on extends).
    // Merge order: preset -> role defaults -> team template -> agent override.
    if (domain.role_defaults && effectiveExtends) {
      const roleDefaults = domain.role_defaults[effectiveExtends as string];
      if (roleDefaults) {
        // Role defaults are applied as a layer on top of the preset-resolved config,
        // but UNDER any agent-specific overrides. We merge role defaults first,
        // then re-apply agent-specific fields on top.
        const agentOverrides: Record<string, unknown> = {};
        for (const key of Object.keys(normalizedDef)) {
          if (key !== "extends") {
            agentOverrides[key] = normalizedDef[key];
          }
        }
        const withRoleDefaults = mergeConfigLayer(resolved, roleDefaults as Record<string, unknown>);
        // Re-apply agent overrides on top of role defaults
        Object.assign(resolved, mergeConfigLayer(withRoleDefaults, agentOverrides));
      }
    }

    // Apply team template (based on team field).
    // Merge order: preset -> role defaults -> team template -> agent override.
    const agentTeam = (resolved.team ?? normalizedDef.team) as string | undefined;
    if (agentTeam) {
      // Domain team_templates override global team_templates
      const teamTemplate =
        (domain.team_templates as Record<string, Record<string, unknown>> | undefined)?.[agentTeam] ??
        (global.team_templates as Record<string, Record<string, unknown>> | undefined)?.[agentTeam];
      if (teamTemplate) {
        const agentOverrides: Record<string, unknown> = {};
        for (const key of Object.keys(normalizedDef)) {
          if (key !== "extends") {
            agentOverrides[key] = normalizedDef[key];
          }
        }
        const withTeamTemplate = mergeConfigLayer(resolved, teamTemplate);
        // Re-apply agent overrides on top of team template
        Object.assign(resolved, mergeConfigLayer(withTeamTemplate, agentOverrides));
      }
    }

    // Normalize job triggers (filter invalid entries from raw YAML)
    normalizeJobTriggers(resolved);

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
    // Pass whether the user explicitly set expectations in their config — if so, domain defaults
    // should not override their choice (e.g., `expectations: []` means "I want none").
    const userExplicitlySetExpectations = "expectations" in globalDef;
    const withDomainDefaults = mergeDomainDefaults(resolved as AgentConfig, domain.defaults, userExplicitlySetExpectations);
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
    adapter: global.adapter,
    codex: global.codex,
    claudeCode: global.claude_code,
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
  if (rawDomain.dispatch || (global.adapter && global.adapter !== "openclaw")) {
    const dispatchConfig: NonNullable<WorkforceConfig["dispatch"]> = {
      ...(rawDomain.dispatch as Record<string, unknown> | undefined ?? {}),
    };
    if (!dispatchConfig.executor && global.adapter && global.adapter !== "openclaw") {
      dispatchConfig.executor = global.adapter;
    }
    wfConfig.dispatch = dispatchConfig;
  }
  if (rawDomain.lifecycle)
    wfConfig.lifecycle = rawDomain.lifecycle as WorkforceConfig["lifecycle"];
  if (domain.knowledge)
    wfConfig.knowledge = domain.knowledge as WorkforceConfig["knowledge"];
  if (domain.goals)
    wfConfig.goals = domain.goals as WorkforceConfig["goals"];
  if (domain.monitoring)
    wfConfig.monitoring = domain.monitoring as WorkforceConfig["monitoring"];
  if (domain.skills)
    wfConfig.skills = domain.skills as WorkforceConfig["skills"];
  if (domain.triggers)
    wfConfig.triggers = domain.triggers as WorkforceConfig["triggers"];
  if (domain.verification)
    wfConfig.verification = domain.verification as WorkforceConfig["verification"];
  if (rawDomain.sweep)
    wfConfig.sweep = rawDomain.sweep as WorkforceConfig["sweep"];
  if (rawDomain.trust)
    wfConfig.trust = rawDomain.trust as WorkforceConfig["trust"];
  if (rawDomain.context)
    wfConfig.context = rawDomain.context as WorkforceConfig["context"];
  if (rawDomain.memory)
    wfConfig.memory = rawDomain.memory as WorkforceConfig["memory"];
  if (domain.entities)
    wfConfig.entities = normalizeEntityKindsConfig(domain.entities);
  if (rawDomain.execution !== undefined)
    wfConfig.execution = normalizeExecutionConfig(rawDomain.execution);

  // Build manager config from explicit domain config or infer it from agent coordination.
  if (domain.manager) {
    const mgrRaw = domain.manager as Record<string, unknown> | undefined;
    wfConfig.manager = {
      enabled: true,
      agentId:
        (typeof mgrRaw?.agentId === "string" && mgrRaw.agentId.trim())
          ? mgrRaw.agentId.trim()
          : Object.keys(agents).find(id => agents[id]?.extends === "manager") ?? "manager",
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
 * Merge domain-level defaults into an agent config.
 *
 * Merge order: domain defaults -> preset (manager/employee) -> agent-specific overrides.
 * - Domain default briefing sources are PREPENDED to the agent's briefing (deduped).
 * - Domain default expectations are APPENDED to the agent's expectations.
 * - Domain default performance_policy is used if the agent doesn't specify one explicitly
 *   (i.e. it only has the inherited preset default).
 */

/**
 * Resolve a single mixin by name, recursively resolving any nested `mixins` it includes.
 * Detects circular references by tracking the current resolution path.
 */
function resolveMixin(
  name: string,
  allMixins: Record<string, MixinDef>,
  path: string[] = [],
): Record<string, unknown> {
  if (path.includes(name)) {
    safeLog("mixin-cycle", `Circular mixin reference detected: ${[...path, name].join(" → ")}`);
    return {}; // graceful degradation — skip the cycle
  }

  const mixin = allMixins[name];
  if (!mixin) return {}; // validation catches missing refs separately

  const currentPath = [...path, name];

  // Start with an empty base, then layer in nested mixins first
  let resolved: Record<string, unknown> = {};

  if (mixin.mixins && Array.isArray(mixin.mixins)) {
    for (const nested of mixin.mixins) {
      const nestedResolved = resolveMixin(nested, allMixins, currentPath);
      resolved = { ...resolved, ...nestedResolved };
    }
  }

  // Apply this mixin's own fields on top (its fields win over nested mixins)
  const { mixins: _, ...ownFields } = mixin;
  resolved = { ...resolved, ...ownFields };

  return resolved;
}

/**
 * Apply named mixins to a resolved agent config.
 *
 * Merge order: resolved preset base -> mixin1 -> mixin2 -> ... -> agent overrides.
 * Agent's own explicit fields always win over mixin values.
 * Circular mixin references are detected and gracefully skipped.
 */
export function applyMixins(
  resolved: Record<string, unknown>,
  agentDef: GlobalAgentDef,
  mixinDefs?: Record<string, MixinDef> | Record<string, Partial<GlobalAgentDef>>,
): Record<string, unknown> {
  const mixinNames = agentDef.mixins;
  if (!mixinNames || mixinNames.length === 0 || !mixinDefs) return resolved;

  // Collect agent's own explicit keys (excluding extends/mixins) so we can re-apply them
  const { extends: _e, mixins: _m, ...agentOwnFields } = agentDef;

  // Apply each mixin left-to-right on top of the resolved preset
  let result = resolved;
  for (const name of mixinNames) {
    const mixinResolved = resolveMixin(name, mixinDefs as Record<string, MixinDef>);
    result = deepMerge(result, mixinResolved);
  }

  // Re-apply agent's own fields so they always override mixin values
  result = deepMerge(result, agentOwnFields as Record<string, unknown>);

  return result;
}

/**
 * Normalize trigger arrays on all jobs in a resolved agent config.
 * Filters out invalid trigger entries (non-objects, missing/empty `on` field).
 */
function normalizeJobTriggers(resolved: Record<string, unknown>): void {
  const jobs = resolved.jobs as Record<string, Record<string, unknown>> | undefined;
  if (!jobs || typeof jobs !== "object") return;

  for (const jobDef of Object.values(jobs)) {
    if (!jobDef || typeof jobDef !== "object") continue;
    const rawTriggers = jobDef.triggers;
    if (!Array.isArray(rawTriggers)) continue;

    const normalized: Array<{ on: string; conditions?: Record<string, unknown> }> = [];
    for (const item of rawTriggers) {
      if (typeof item !== "object" || item === null) continue;
      const t = item as Record<string, unknown>;
      if (typeof t.on !== "string" || !t.on.trim()) continue;
      const trigger: { on: string; conditions?: Record<string, unknown> } = { on: t.on.trim() };
      if (typeof t.conditions === "object" && t.conditions !== null && !Array.isArray(t.conditions)) {
        trigger.conditions = t.conditions as Record<string, unknown>;
      }
      normalized.push(trigger);
    }
    jobDef.triggers = normalized;
  }
}

export function mergeDomainDefaults(
  agentConfig: AgentConfig,
  domainDefaults: DomainConfig["defaults"],
  userExplicitlySetExpectations = false,
): AgentConfig {
  if (!domainDefaults) return agentConfig;

  const result = { ...agentConfig };

  // Prepend domain default briefing sources (deduped) — managers only.
  // Workers/verifiers get focused context (soul + assigned_task + standards).
  // Domain defaults (direction, policies, architecture) are manager-level context.
  const isManager = agentConfig.extends === "manager" || agentConfig.coordination?.enabled;
  if (isManager && domainDefaults.briefing && Array.isArray(domainDefaults.briefing) && domainDefaults.briefing.length > 0) {
    const defaultSources = domainDefaults.briefing as ContextSource[];
    const existingSourceKeys = new Set(result.briefing.map(s => s.source));

    // Only prepend sources not already present
    const newSources = defaultSources.filter(s => !existingSourceKeys.has(s.source));
    result.briefing = [...newSources, ...result.briefing];
  }

  // Append domain default expectations — BUT respect explicit user overrides.
  // If user set `expectations: []` in their agent config, they explicitly want none.
  // Don't re-add defaults they intentionally removed.
  if (!userExplicitlySetExpectations &&
      domainDefaults.expectations && Array.isArray(domainDefaults.expectations) && domainDefaults.expectations.length > 0) {
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

function resolveDomainPaths(domain: DomainConfig): string[] {
  if (!domain.paths || domain.paths.length === 0) return [];
  return domain.paths.map(resolveHomePath);
}
