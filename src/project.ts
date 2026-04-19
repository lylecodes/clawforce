/**
 * Clawforce — Project configuration
 *
 * Loads workforce configuration, initializes per-project databases and directories,
 * and manages runtime registration for active domains.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "./sqlite-driver.js";
import YAML from "yaml";
import { setBudget } from "./budget.js";
import { clearProjectStorageDir, getDb, setProjectStorageDir } from "./db.js";
import { emitDiagnosticEvent, safeLog } from "./diagnostics.js";
import { registerProject, unregisterProject } from "./lifecycle.js";
import { registerManagerProject, unregisterManagerProjectByProject } from "./manager-config.js";
import { resolveEscalationChain } from "./org.js";
import { applyProfile, generateDefaultScopePolicies } from "./profiles.js";
import { clearProjectPolicies, registerPolicies } from "./policy/registry.js";
import { BUILTIN_AGENT_PRESETS } from "./presets.js";
import { normalizeAgentConfig as resolveAliases } from "./config/aliases.js";
import { isKnownContextSource } from "./context/catalog.js";
import { ensureAgentDocs } from "./context/sources/auto-generate.js";
import { recoverOrphanedSessions } from "./enforcement/tracker.js";
import { normalizeEntityKindsConfig } from "./entities/config.js";
import { normalizeExecutionConfig } from "./execution/config.js";
import { createGoal, listGoals } from "./goals/ops.js";
import { registerCustomSkills, unregisterCustomSkills } from "./skills/registry.js";
import {
  getAgentRuntimeConfig,
  mergeAgentRuntimeConfig,
  normalizeBootstrapConfig,
  normalizeConfiguredAgentRuntime,
} from "./agent-runtime-config.js";
import { toNamespacedAgentId } from "./agent-sync.js";
import { getDefaultRuntimeState } from "./runtime/default-runtime.js";
import { REVIEW_REASON_CODES } from "./types.js";
import type {
  AgentConfig,
  AlertRuleDefinition,
  AnomalyConfig,
  ApprovalPolicy,
  AssignmentConfig,
  AssignmentStrategy,
  BudgetConfig,
  BudgetPacingConfig,
  ChannelConfig,
  ChannelType,
  CompactionConfig,
  ContextOwnershipConfig,
  ContextSource,
  DispatchConfig,
  Expectation,
  EventActionType,
  EventActionConfig,
  EventHandlerConfig,
  GoalConfigEntry,
  LifecycleConfig,
  ManagerBehaviorConfig,
  MemoryGovernanceConfig,
  ReviewConfig,
  SchedulingConfig,
  JobDefinition,
  PerformancePolicy,
  PolicyDefinition,
  RiskTierConfig,
  SkillPack,
  SloDefinition,
  TaskPriority,
  TelemetryConfig,
  ToolGatesConfig,
  TriggerAfterProcess,
  TriggerAuth,
  TriggerAuthType,
  TriggerCondition,
  TriggerConditionOperator,
  TriggerDefinition,
  TriggerSeverity,
  TriggerSource,
  VerificationConfig,
  VerificationGate,
  GitIsolationConfig,
  ObserveEntry,
  WorkforceConfig,
  SweepConfig,
  TrustConfig,
  ContextConfig,
  MemoryConfig,
} from "./types.js";
import { EVENT_ACTION_TYPES, TRIGGER_SOURCES } from "./types.js";

/**
 * Load a workforce config document from disk.
 */
export function loadWorkforceConfig(configPath: string): WorkforceConfig {
  const content = fs.readFileSync(configPath, "utf-8");
  return parseWorkforceConfigContent(content);
}

/**
 * Parse a workforce config document from raw YAML content.
 */
export function parseWorkforceConfigContent(content: string): WorkforceConfig {
  const raw = YAML.parse(content) as Record<string, unknown> | null;
  if (!raw) {
    throw new Error("Config is empty or not an object.");
  }

  const rawAgents = raw.agents as Record<string, unknown> | undefined;
  if (!rawAgents || typeof rawAgents !== "object") {
    throw new Error("Config must define an agents object.");
  }

  // Pre-parse skill_packs so they can be applied during agent normalization
  const skillPacks = raw.skill_packs && typeof raw.skill_packs === "object"
    ? normalizeSkillPacksConfig(raw.skill_packs as Record<string, unknown>)
    : undefined;

  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, rawAgent] of Object.entries(rawAgents)) {
    if (typeof rawAgent !== "object" || rawAgent === null) continue;
    const a = rawAgent as Record<string, unknown>;
    if (!a.extends) {
      throw new Error(`Agent "${agentId}" is missing required field "extends".`);
    }

    agents[agentId] = normalizeAgentConfig(a, skillPacks);
  }

  if (Object.keys(agents).length === 0) {
    throw new Error("Config must define at least one agent.");
  }

  const approval = normalizeApprovalPolicy(raw.approval);

  const result: WorkforceConfig = {
    name: String(raw.name ?? "unnamed"),
    approval: approval ?? undefined,
    agents,
  };

  if (typeof raw.adapter === "string" && ["openclaw", "codex", "claude-code"].includes(raw.adapter)) {
    result.adapter = raw.adapter as WorkforceConfig["adapter"];
  } else {
    result.adapter = "codex";
  }
  if (raw.codex && typeof raw.codex === "object") {
    result.codex = raw.codex as Record<string, unknown>;
  }
  if ((raw.claude_code ?? raw.claudeCode) && typeof (raw.claude_code ?? raw.claudeCode) === "object") {
    result.claudeCode = (raw.claude_code ?? raw.claudeCode) as Record<string, unknown>;
  }

  // Parse budgets config
  if (raw.budgets && typeof raw.budgets === "object") {
    result.budgets = normalizeBudgetsConfig(raw.budgets as Record<string, unknown>);
  }

  // Parse policies config
  if (Array.isArray(raw.policies)) {
    result.policies = normalizePoliciesConfig(raw.policies as Record<string, unknown>[]);
  }

  // Parse monitoring config
  if (raw.monitoring && typeof raw.monitoring === "object") {
    result.monitoring = normalizeMonitoringConfig(raw.monitoring as Record<string, unknown>);
  }

  // Parse risk_tiers config
  if (raw.risk_tiers && typeof raw.risk_tiers === "object") {
    result.riskTiers = normalizeRiskTiersConfig(raw.risk_tiers as Record<string, unknown>);
  }

  // Parse skills (custom skill topics)
  if (raw.skills && typeof raw.skills === "object") {
    result.skills = normalizeSkillsConfig(raw.skills as Record<string, unknown>);
  }

  // Parse skill_packs
  if (raw.skill_packs && typeof raw.skill_packs === "object") {
    result.skill_packs = normalizeSkillPacksConfig(raw.skill_packs as Record<string, unknown>);
  }

  // Parse dispatch config
  if (raw.dispatch && typeof raw.dispatch === "object") {
    result.dispatch = normalizeDispatchConfig(raw.dispatch as Record<string, unknown>);
  }

  // Parse assignment config
  if (raw.assignment && typeof raw.assignment === "object") {
    result.assignment = normalizeAssignmentConfig(raw.assignment as Record<string, unknown>);
  }

  // Parse event_handlers config
  if (raw.event_handlers && typeof raw.event_handlers === "object") {
    result.event_handlers = normalizeEventHandlersConfig(raw.event_handlers as Record<string, unknown>);
  }

  // Parse triggers config
  if (raw.triggers && typeof raw.triggers === "object") {
    result.triggers = normalizeTriggerConfig(raw.triggers as Record<string, unknown>);
  }

  // Parse review config
  if (raw.review && typeof raw.review === "object") {
    result.review = normalizeReviewConfig(raw.review as Record<string, unknown>);
  }

  // Parse channels config
  if (raw.channels && Array.isArray(raw.channels)) {
    result.channels = normalizeChannelsConfig(raw.channels);
  }

  // Parse goals config
  if (raw.goals && typeof raw.goals === "object") {
    const goals: Record<string, GoalConfigEntry> = {};
    let totalAllocation = 0;

    for (const [id, def] of Object.entries(raw.goals as Record<string, Record<string, unknown>>)) {
      const entry: GoalConfigEntry = {
        description: typeof def.description === "string" ? def.description : undefined,
        allocation: typeof def.allocation === "number" ? def.allocation : undefined,
        department: typeof def.department === "string" ? def.department : undefined,
        team: typeof def.team === "string" ? def.team : undefined,
        acceptance_criteria: typeof def.acceptance_criteria === "string" ? def.acceptance_criteria : undefined,
        owner_agent_id: typeof def.owner_agent_id === "string" ? def.owner_agent_id : undefined,
      };
      if (entry.allocation != null) {
        totalAllocation += entry.allocation;
      }
      goals[id] = entry;
    }

    if (totalAllocation > 100) {
      throw new Error(`Goal allocations exceed 100%: total is ${totalAllocation}%`);
    }

    result.goals = goals;
  }

  // Parse entity kind config
  if (raw.entities && typeof raw.entities === "object") {
    result.entities = normalizeEntityKindsConfig(raw.entities);
  }

  // Parse execution config
  if (raw.execution !== undefined) {
    result.execution = normalizeExecutionConfig(raw.execution);
  }

  // Parse knowledge config
  if (raw.knowledge && typeof raw.knowledge === "object") {
    const k = raw.knowledge as Record<string, unknown>;
    const pt = k.promotion_threshold && typeof k.promotion_threshold === "object"
      ? k.promotion_threshold as Record<string, unknown>
      : undefined;
    result.knowledge = {
      promotionThreshold: pt ? {
        minRetrievals: typeof pt.min_retrievals === "number" ? pt.min_retrievals : undefined,
        minSessions: typeof pt.min_sessions === "number" ? pt.min_sessions : undefined,
      } : undefined,
    };
  }

  // Parse lifecycle config
  if (raw.lifecycle && typeof raw.lifecycle === "object") {
    result.lifecycle = normalizeLifecycleConfig(raw.lifecycle as Record<string, unknown>);
  }

  // Parse manager_behavior config
  if ((raw.manager_behavior ?? raw.managerBehavior) && typeof (raw.manager_behavior ?? raw.managerBehavior) === "object") {
    result.managerBehavior = normalizeManagerBehaviorConfig((raw.manager_behavior ?? raw.managerBehavior) as Record<string, unknown>);
  }

  // Parse telemetry config
  if (raw.telemetry && typeof raw.telemetry === "object") {
    result.telemetry = normalizeTelemetryConfig(raw.telemetry as Record<string, unknown>);
  }

  // Parse context_ownership config
  if ((raw.context_ownership ?? raw.contextOwnership) && typeof (raw.context_ownership ?? raw.contextOwnership) === "object") {
    result.contextOwnership = normalizeContextOwnershipConfig((raw.context_ownership ?? raw.contextOwnership) as Record<string, unknown>);
  }

  // Parse verification config
  if (raw.verification && typeof raw.verification === "object") {
    result.verification = normalizeVerificationConfig(raw.verification);
  }

  // Parse bootstrap_defaults config (CO-1: project-level bootstrap budget)
  const rawBootstrapDefaults = raw.bootstrap_defaults ?? raw.bootstrapDefaults;
  if (rawBootstrapDefaults && typeof rawBootstrapDefaults === "object") {
    result.bootstrapDefaults = normalizeBootstrapConfig(rawBootstrapDefaults);
  }

  // Parse sweep config
  if (raw.sweep && typeof raw.sweep === "object") {
    result.sweep = normalizeSweepConfig(raw.sweep as Record<string, unknown>);
  }

  // Parse trust config
  if (raw.trust && typeof raw.trust === "object") {
    result.trust = normalizeTrustConfig(raw.trust as Record<string, unknown>);
  }

  // Parse context config
  if (raw.context && typeof raw.context === "object") {
    result.context = normalizeContextConfig(raw.context as Record<string, unknown>);
  }

  // Parse memory config
  if (raw.memory && typeof raw.memory === "object") {
    result.memory = normalizeMemorySystemConfig(raw.memory as Record<string, unknown>);
  }

  return result;
}

/**
 * Resolve the project directory path, expanding ~ if needed.
 */
export function resolveProjectDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", dir.slice(1));
  }
  return path.resolve(dir);
}


// --- Workforce config normalizers ---

function normalizeAgentConfig(rawInput: Record<string, unknown>, skillPacks?: Record<string, SkillPack>): AgentConfig {
  // Resolve config aliases (group→department, subgroup→team) before any
  // other processing so canonical names are always available.
  const raw = resolveAliases(rawInput);

  // `extends` is the only supported preset selector.
  const rawExtends = typeof raw.extends === "string" && raw.extends.trim()
    ? raw.extends.trim()
    : undefined;
  if (rawExtends === "scheduled") {
    throw new Error('Preset "scheduled" has been removed. Use "employee" instead.');
  }
  const extendsFrom = rawExtends ?? "employee";

  const briefing = normalizeContextSources(raw.briefing);
  const excludeBriefing = normalizeExcludeContext(raw.exclude_briefing);
  const expectations = normalizeExpectations(raw.expectations);
  const performancePolicy = normalizePerformancePolicy(raw.performance_policy);

  // Determine whether the user explicitly provided these fields
  const hasExplicitExpectations = Array.isArray(raw.expectations);
  const hasExplicitPolicy = typeof raw.performance_policy === "object" && raw.performance_policy !== null;

  // Apply role profile defaults, merging with agent-level overrides
  const merged = applyProfile(extendsFrom, {
    briefing,
    exclude_briefing: excludeBriefing,
    expectations: hasExplicitExpectations ? expectations : null,
    performance_policy: hasExplicitPolicy ? performancePolicy : null,
  });

  // Apply skill_pack if referenced
  const skillPackName = typeof raw.skill_pack === "string" && raw.skill_pack.trim() ? raw.skill_pack.trim() : undefined;
  if (skillPackName && skillPacks?.[skillPackName]) {
    const pack = skillPacks[skillPackName]!;
    // Append pack briefing (deduped by source)
    if (pack.briefing && pack.briefing.length > 0) {
      const existingSources = new Set(merged.briefing.map((s) => s.source));
      for (const src of pack.briefing) {
        if (!existingSources.has(src.source)) {
          merged.briefing.push(src);
          existingSources.add(src.source);
        }
      }
    }
    // Merge expectations (append if not explicitly set)
    if (pack.expectations && pack.expectations.length > 0 && !hasExplicitExpectations) {
      merged.expectations = [...merged.expectations, ...pack.expectations];
    }
    // Override performance_policy if not explicitly set
    if (pack.performance_policy && !hasExplicitPolicy) {
      merged.performance_policy = pack.performance_policy;
    }
  }

  // Always inject instructions source if not already present
  if (!merged.briefing.some((s) => s.source === "instructions")) {
    merged.briefing.unshift({ source: "instructions" });
  }

  const memory = normalizeMemoryConfig(raw.memory);

  // Normalize compaction config
  const hasExplicitCompaction = raw.compaction !== undefined;
  const compaction = hasExplicitCompaction
    ? normalizeCompactionConfig(raw.compaction)
    : (BUILTIN_AGENT_PRESETS[extendsFrom]?.compaction as boolean | undefined) ?? false;

  // When compaction is disabled, strip the compaction expectation that may
  // have been inherited from the profile (unless user explicitly set expectations)
  const effectiveCompaction = typeof compaction === "boolean"
    ? compaction
    : (typeof compaction === "object" && compaction !== null ? (compaction as CompactionConfig).enabled : false);

  if (!effectiveCompaction && !hasExplicitExpectations) {
    const filtered = merged.expectations.filter(
      (r) => r.tool !== "clawforce_compact",
    );
    merged.expectations = filtered;
  }

  // When memory.expectations is explicitly false, strip the memory_search
  // expectation that may have been inherited from the manager profile
  // (unless user explicitly set expectations)
  if (memory?.expectations === false && !hasExplicitExpectations) {
    merged.expectations = merged.expectations.filter(
      (r) => r.tool !== "memory_search",
    );
  }

  const reportsTo = typeof raw.reports_to === "string" && raw.reports_to.trim()
    ? raw.reports_to.trim()
    : undefined;

  // Parse new employee profile fields
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;
  const persona = typeof raw.persona === "string" && raw.persona.trim() ? raw.persona.trim() : undefined;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === "string") : undefined;
  const channel = typeof raw.channel === "string" && raw.channel.trim() ? raw.channel.trim() : undefined;
  const department = typeof raw.department === "string" && raw.department.trim() ? raw.department.trim() : undefined;
  const team = typeof raw.team === "string" && raw.team.trim() ? raw.team.trim() : undefined;
  const permissions = normalizePermissions(raw.permissions);

  const jobs = normalizeJobs(raw.jobs);

  const observe: ObserveEntry[] | undefined = Array.isArray(raw.observe)
    ? (raw.observe.filter((entry: unknown) => {
        if (typeof entry === "string") return true;
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).pattern === "string") return true;
        return false;
      }).map((entry: unknown) => {
        if (typeof entry === "string") return entry;
        const obj = entry as Record<string, unknown>;
        const result: { pattern: string; scope?: { team?: string; agent?: string } } = {
          pattern: obj.pattern as string,
        };
        if (obj.scope && typeof obj.scope === "object") {
          const scope = obj.scope as Record<string, unknown>;
          const scopeResult: { team?: string; agent?: string } = {};
          if (typeof scope.team === "string") scopeResult.team = scope.team;
          if (typeof scope.agent === "string") scopeResult.agent = scope.agent;
          if (scopeResult.team || scopeResult.agent) {
            result.scope = scopeResult;
          }
        }
        return result;
      }) as ObserveEntry[])
    : undefined;

  const skillCap = typeof raw.skill_cap === "number" ? raw.skill_cap : undefined;

  const contextBudgetChars = typeof (raw.context_budget_chars ?? raw.contextBudgetChars) === "number"
    ? (raw.context_budget_chars ?? raw.contextBudgetChars) as number
    : undefined;
  const maxTurnsPerSession = typeof (raw.max_turns_per_session ?? raw.maxTurnsPerSession) === "number"
    ? (raw.max_turns_per_session ?? raw.maxTurnsPerSession) as number
    : undefined;
  const runtimeRef = typeof (raw.runtime_ref ?? raw.runtimeRef) === "string"
    && String(raw.runtime_ref ?? raw.runtimeRef).trim()
    ? String(raw.runtime_ref ?? raw.runtimeRef).trim()
    : undefined;
  const agentModel = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;

  let scheduling: SchedulingConfig | undefined;
  if (raw.scheduling && typeof raw.scheduling === "object") {
    const s = raw.scheduling as Record<string, unknown>;
    scheduling = {
      adaptiveWake: typeof s.adaptive_wake === "boolean" ? s.adaptive_wake : undefined,
      planning: typeof s.planning === "boolean" ? s.planning : undefined,
      wakeBounds: Array.isArray(s.wake_bounds) ? s.wake_bounds as [string, string] : undefined,
    };
  }

  const presetDefaults = BUILTIN_AGENT_PRESETS[extendsFrom];
  const effectiveRuntime = mergeAgentRuntimeConfig(
    getAgentRuntimeConfig(presetDefaults as AgentConfig | undefined),
    normalizeConfiguredAgentRuntime(raw),
  );

  return {
    extends: extendsFrom,
    title,
    persona,
    tools: tools?.length ? tools : undefined,
    permissions,
    channel,
    department,
    team,
    briefing: merged.briefing,
    exclude_briefing: excludeBriefing.length > 0 ? excludeBriefing : undefined,
    expectations: merged.expectations,
    performance_policy: merged.performance_policy,
    reports_to: reportsTo,
    skill_pack: skillPackName,
    compaction: compaction === false ? undefined : compaction,
    jobs,
    observe: observe && observe.length > 0 ? observe : undefined,
    scheduling,
    skillCap,
    memory,
    contextBudgetChars,
    maxTurnsPerSession,
    runtimeRef,
    runtime: effectiveRuntime,
    model: agentModel,
    bootstrapConfig: effectiveRuntime?.bootstrapConfig,
    bootstrapExcludeFiles: effectiveRuntime?.bootstrapExcludeFiles,
    allowedTools: effectiveRuntime?.allowedTools,
    workspacePaths: effectiveRuntime?.workspacePaths,
  };
}

function normalizePermissions(raw: unknown): AgentConfig["permissions"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const result: NonNullable<AgentConfig["permissions"]> = {};
  if (typeof r.can_hire === "boolean") result.can_hire = r.can_hire;
  if (typeof r.can_fire === "boolean") result.can_fire = r.can_fire;
  if (typeof r.budget_limit_cents === "number" && r.budget_limit_cents > 0) {
    result.budget_limit_cents = r.budget_limit_cents;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeContextSources(raw: unknown): ContextSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item): ContextSource => {
      if (!isKnownContextSource(item.source as string)) {
        emitDiagnosticEvent({
          type: "config_warning",
          message: `Unknown context source "${item.source as string}" — falling back to "custom".`,
        });
      }
      const source = isKnownContextSource(item.source as string)
        ? (item.source as ContextSource["source"])
        : "custom";

      const result: ContextSource = { source };
      if (typeof item.content === "string") result.content = item.content;
      if (typeof item.path === "string") result.path = item.path;
      if (item.params !== undefined && typeof item.params === "object") {
        result.params = item.params as Record<string, unknown>;
      }
      if (typeof item.streamName === "string") result.streamName = item.streamName;
      if (typeof item.filter === "object" && item.filter !== null) {
        const f = item.filter as Record<string, unknown>;
        result.filter = {
          category: Array.isArray(f.category) ? f.category.map(String) : undefined,
          tags: Array.isArray(f.tags) ? f.tags.map(String) : undefined,
        };
      }
      return result;
    });
}

function normalizeExcludeContext(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeExpectations(raw: unknown): Expectation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item): Expectation => ({
      tool: String(item.tool ?? ""),
      action: Array.isArray(item.action)
        ? item.action.map(String)
        : String(item.action ?? ""),
      min_calls: typeof item.min_calls === "number" ? item.min_calls : 1,
    }))
    .filter((r) => r.tool !== "");
}

function normalizePerformancePolicy(raw: unknown): PerformancePolicy {
  if (typeof raw !== "object" || raw === null) {
    return { action: "alert" };
  }
  const r = raw as Record<string, unknown>;
  // Support old "disable_and_alert" as alias for "terminate_and_alert"
  let action = r.action as string;
  if (action === "disable_and_alert") action = "terminate_and_alert";
  action = (["retry", "alert", "terminate_and_alert"].includes(action)
    ? action
    : "alert") as PerformancePolicy["action"];

  let thenRaw = r.then as string | undefined;
  if (thenRaw === "disable_and_alert") thenRaw = "terminate_and_alert";
  const thenAction = (["alert", "terminate_and_alert"].includes(thenRaw as string) ? thenRaw : undefined) as
    | "alert"
    | "terminate_and_alert"
    | undefined;

  return {
    action: action as PerformancePolicy["action"],
    max_retries: typeof r.max_retries === "number" ? r.max_retries : undefined,
    then: thenAction,
  };
}

function normalizeCompactionConfig(raw: unknown): boolean | CompactionConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
    const files = Array.isArray(r.files)
      ? r.files.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f.length > 0)
      : undefined;
    return { enabled, files: files?.length ? files : undefined };
  }
  return undefined;
}

function normalizeMemoryConfig(raw: unknown): MemoryGovernanceConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const result: MemoryGovernanceConfig = {};

  if (r.instructions !== undefined) {
    if (typeof r.instructions === "boolean") {
      result.instructions = r.instructions;
    } else if (typeof r.instructions === "string" && r.instructions.trim()) {
      result.instructions = r.instructions.trim();
    }
  }

  if (typeof r.expectations === "boolean") {
    result.expectations = r.expectations;
  }

  if (typeof r.review === "object" && r.review !== null) {
    const rv = r.review as Record<string, unknown>;
    const review: NonNullable<MemoryGovernanceConfig["review"]> = {};
    if (typeof rv.enabled === "boolean") review.enabled = rv.enabled;
    if (typeof rv.cron === "string" && rv.cron.trim()) review.cron = rv.cron.trim();
    if (typeof rv.model === "string" && rv.model.trim()) review.model = rv.model.trim();
    if (typeof rv.aggressiveness === "string" && ["low", "medium", "high"].includes(rv.aggressiveness)) {
      review.aggressiveness = rv.aggressiveness as "low" | "medium" | "high";
    }
    if (typeof rv.scope === "string" && ["self", "reports", "all"].includes(rv.scope)) {
      review.scope = rv.scope as "self" | "reports" | "all";
    }
    if (Object.keys(review).length > 0) result.review = review;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeJobs(raw: unknown): Record<string, JobDefinition> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const result: Record<string, JobDefinition> = {};
  for (const [jobName, rawJob] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rawJob !== "object" || rawJob === null) continue;
    const j = rawJob as Record<string, unknown>;
    const job: JobDefinition = {};

    if (typeof j.cron === "string" && j.cron.trim()) {
      job.cron = j.cron.trim();
    }
    if (j.briefing !== undefined) {
      job.briefing = normalizeContextSources(j.briefing);
    }
    if (j.exclude_briefing !== undefined) {
      job.exclude_briefing = normalizeExcludeContext(j.exclude_briefing);
    }
    if (j.expectations !== undefined) {
      job.expectations = normalizeExpectations(j.expectations);
    }
    if (j.performance_policy !== undefined) {
      job.performance_policy = normalizePerformancePolicy(j.performance_policy);
    }
    if (j.compaction !== undefined) {
      const c = normalizeCompactionConfig(j.compaction);
      if (c !== undefined) job.compaction = c;
    }
    if (typeof j.nudge === "string" && j.nudge.trim()) {
      job.nudge = j.nudge.trim();
    }
    if (typeof j.cronTimezone === "string" && j.cronTimezone.trim()) {
      job.cronTimezone = j.cronTimezone.trim();
    }
    if (typeof j.sessionTarget === "string" && (j.sessionTarget === "main" || j.sessionTarget === "isolated")) {
      job.sessionTarget = j.sessionTarget;
    }
    if (typeof j.wakeMode === "string" && (j.wakeMode === "now" || j.wakeMode === "next-heartbeat")) {
      job.wakeMode = j.wakeMode;
    }
    if (typeof j.delivery === "object" && j.delivery !== null) {
      const d = j.delivery as Record<string, unknown>;
      const mode = typeof d.mode === "string" && ["none", "announce", "webhook"].includes(d.mode)
        ? (d.mode as "none" | "announce" | "webhook") : "none";
      job.delivery = {
        mode,
        ...(typeof d.to === "string" && { to: d.to }),
        ...(typeof d.channel === "string" && { channel: d.channel }),
        ...(typeof d.accountId === "string" && { accountId: d.accountId }),
        ...(typeof d.bestEffort === "boolean" && { bestEffort: d.bestEffort }),
      };
    }
    if (j.failureAlert !== undefined) {
      if (j.failureAlert === false) {
        job.failureAlert = false;
      } else if (typeof j.failureAlert === "object" && j.failureAlert !== null) {
        const fa = j.failureAlert as Record<string, unknown>;
        job.failureAlert = {
          ...(typeof fa.after === "number" && { after: fa.after }),
          ...(typeof fa.channel === "string" && { channel: fa.channel }),
          ...(typeof fa.to === "string" && { to: fa.to }),
          ...(typeof fa.cooldownMs === "number" && { cooldownMs: fa.cooldownMs }),
          ...(typeof fa.mode === "string" && ["announce", "webhook"].includes(fa.mode) && { mode: fa.mode as "announce" | "webhook" }),
          ...(typeof fa.accountId === "string" && { accountId: fa.accountId }),
        };
      }
    }
    if (typeof j.model === "string" && j.model.trim()) {
      job.model = j.model.trim();
    }
    if (typeof j.timeoutSeconds === "number" && j.timeoutSeconds > 0) {
      job.timeoutSeconds = j.timeoutSeconds;
    }
    if (typeof j.lightContext === "boolean") {
      job.lightContext = j.lightContext;
    }
    if (typeof j.deleteAfterRun === "boolean") {
      job.deleteAfterRun = j.deleteAfterRun;
    }
    if (typeof (j.max_turns ?? j.maxTurns) === "number" && ((j.max_turns ?? j.maxTurns) as number) > 0) {
      job.maxTurns = (j.max_turns ?? j.maxTurns) as number;
    }
    if (typeof j.frequency === "string" && j.frequency.trim()) {
      job.frequency = j.frequency.trim();
    }
    if (Array.isArray(j.triggers)) {
      job.triggers = normalizeTriggers(j.triggers);
    }

    result[jobName] = job;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTriggers(
  raw: unknown[],
): Array<{ on: string; conditions?: Record<string, unknown> }> {
  const triggers: Array<{ on: string; conditions?: Record<string, unknown> }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.on !== "string" || !t.on.trim()) continue;
    const trigger: { on: string; conditions?: Record<string, unknown> } = { on: t.on.trim() };
    if (typeof t.conditions === "object" && t.conditions !== null && !Array.isArray(t.conditions)) {
      trigger.conditions = t.conditions as Record<string, unknown>;
    }
    triggers.push(trigger);
  }
  return triggers;
}

function normalizeBudgetsConfig(raw: Record<string, unknown>): WorkforceConfig["budgets"] {
  const result: NonNullable<WorkforceConfig["budgets"]> = {};
  if (raw.project && typeof raw.project === "object") {
    const p = raw.project as Record<string, unknown>;
    result.project = {
      dailyLimitCents: typeof p.daily_limit === "number" ? Math.round(p.daily_limit * 100) : undefined,
      sessionLimitCents: typeof p.session_limit === "number" ? Math.round(p.session_limit * 100) : undefined,
      taskLimitCents: typeof p.task_limit === "number" ? Math.round(p.task_limit * 100) : undefined,
    };
  }
  if (raw.agents && typeof raw.agents === "object") {
    result.agents = {};
    for (const [agentId, agentBudget] of Object.entries(raw.agents as Record<string, unknown>)) {
      if (typeof agentBudget !== "object" || agentBudget === null) continue;
      const b = agentBudget as Record<string, unknown>;
      result.agents[agentId] = {
        dailyLimitCents: typeof b.daily_limit === "number" ? Math.round(b.daily_limit * 100) : undefined,
        sessionLimitCents: typeof b.session_limit === "number" ? Math.round(b.session_limit * 100) : undefined,
        taskLimitCents: typeof b.task_limit === "number" ? Math.round(b.task_limit * 100) : undefined,
      };
    }
  }
  return result;
}

function normalizePoliciesConfig(raw: Record<string, unknown>[]): NonNullable<WorkforceConfig["policies"]> {
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? ""),
      type: String(item.type ?? ""),
      target: typeof item.target === "string" ? item.target : undefined,
      config: (typeof item.config === "object" && item.config !== null ? item.config : {}) as Record<string, unknown>,
    }))
    .filter((p) => p.name && p.type);
}

function normalizeMonitoringConfig(raw: Record<string, unknown>): NonNullable<WorkforceConfig["monitoring"]> {
  const result: NonNullable<WorkforceConfig["monitoring"]> = {};

  if (raw.slos && typeof raw.slos === "object") {
    result.slos = raw.slos as Record<string, Record<string, unknown>>;
  }
  if (raw.anomaly_detection && typeof raw.anomaly_detection === "object") {
    result.anomalyDetection = raw.anomaly_detection as Record<string, Record<string, unknown>>;
  }
  if (raw.alert_rules && typeof raw.alert_rules === "object") {
    result.alertRules = raw.alert_rules as Record<string, Record<string, unknown>>;
  }

  return result;
}

function normalizeRiskTiersConfig(raw: Record<string, unknown>): RiskTierConfig {
  const policies: RiskTierConfig["policies"] = {
    low: { gate: "none" },
    medium: { gate: "delay", delayMs: 30000 },
    high: { gate: "approval" },
    critical: { gate: "human_approval" },
  };

  if (raw.policies && typeof raw.policies === "object") {
    for (const [tier, config] of Object.entries(raw.policies as Record<string, unknown>)) {
      if (typeof config === "object" && config !== null) {
        const c = config as Record<string, unknown>;
        policies[tier as keyof typeof policies] = {
          gate: String(c.gate ?? "none") as RiskTierConfig["policies"]["low"]["gate"],
          delayMs: typeof c.delay_ms === "number" ? c.delay_ms : undefined,
        };
      }
    }
  }

  const patterns: RiskTierConfig["patterns"] = [];
  if (Array.isArray(raw.patterns)) {
    for (const p of raw.patterns as Record<string, unknown>[]) {
      if (typeof p === "object" && p !== null && p.match && p.tier) {
        patterns.push({
          match: p.match as Record<string, unknown>,
          tier: String(p.tier) as RiskTierConfig["patterns"][0]["tier"],
        });
      }
    }
  }

  return {
    enabled: raw.enabled !== false,
    defaultTier: (typeof raw.default_tier === "string" ? raw.default_tier : "low") as RiskTierConfig["defaultTier"],
    policies,
    patterns,
  };
}

function normalizeSkillsConfig(raw: Record<string, unknown>): WorkforceConfig["skills"] {
  const result: NonNullable<WorkforceConfig["skills"]> = {};
  for (const [id, skillRaw] of Object.entries(raw)) {
    if (typeof skillRaw !== "object" || skillRaw === null) continue;
    const s = skillRaw as Record<string, unknown>;
    if (typeof s.title !== "string" || typeof s.path !== "string") continue;
    result[id] = {
      title: s.title,
      description: typeof s.description === "string" ? s.description : s.title,
      path: s.path,
      presets: Array.isArray(s.presets ?? s.roles)
        ? ((s.presets ?? s.roles) as unknown[]).filter((r): r is string => typeof r === "string")
        : undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeSkillPacksConfig(raw: Record<string, unknown>): Record<string, SkillPack> | undefined {
  const result: Record<string, SkillPack> = {};
  for (const [id, packRaw] of Object.entries(raw)) {
    if (typeof packRaw !== "object" || packRaw === null) continue;
    const p = packRaw as Record<string, unknown>;
    const pack: SkillPack = {};
    if (p.briefing !== undefined) {
      pack.briefing = normalizeContextSources(p.briefing);
    }
    if (p.expectations !== undefined) {
      pack.expectations = normalizeExpectations(p.expectations);
    }
    if (p.performance_policy !== undefined) {
      pack.performance_policy = normalizePerformancePolicy(p.performance_policy);
    }
    result[id] = pack;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeApprovalPolicy(raw: unknown): ApprovalPolicy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.policy !== "string") return null;
  return { policy: r.policy };
}

const VALID_ASSIGNMENT_STRATEGIES: AssignmentStrategy[] = ["workload_balanced", "round_robin", "skill_matched"];

const VALID_DISPATCH_MODES = ["event-driven", "cron", "manual"] as const;
const VALID_DISPATCH_EXECUTORS = ["openclaw", "codex", "claude-code"] as const;

function normalizeDispatchConfig(raw: Record<string, unknown>): DispatchConfig {
  const result: DispatchConfig = {};

  // Dispatch mode
  if (typeof raw.mode === "string" && (VALID_DISPATCH_MODES as readonly string[]).includes(raw.mode)) {
    result.mode = raw.mode as DispatchConfig["mode"];
  }
  if (typeof raw.executor === "string" && (VALID_DISPATCH_EXECUTORS as readonly string[]).includes(raw.executor)) {
    result.executor = raw.executor as DispatchConfig["executor"];
  }

  if (typeof raw.max_concurrent_dispatches === "number" && raw.max_concurrent_dispatches > 0) {
    result.maxConcurrentDispatches = raw.max_concurrent_dispatches;
  }
  if (typeof raw.max_dispatches_per_hour === "number" && raw.max_dispatches_per_hour > 0) {
    result.maxDispatchesPerHour = raw.max_dispatches_per_hour;
  }
  if (raw.agent_limits && typeof raw.agent_limits === "object") {
    result.agentLimits = {};
    for (const [agentId, limits] of Object.entries(raw.agent_limits as Record<string, unknown>)) {
      if (typeof limits !== "object" || limits === null) continue;
      const l = limits as Record<string, unknown>;
      const entry: NonNullable<DispatchConfig["agentLimits"]>[string] = {};
      if (typeof l.max_concurrent === "number" && l.max_concurrent > 0) entry.maxConcurrent = l.max_concurrent;
      if (typeof l.max_per_hour === "number" && l.max_per_hour > 0) entry.maxPerHour = l.max_per_hour;
      if (Object.keys(entry).length > 0) result.agentLimits[agentId] = entry;
    }
    if (Object.keys(result.agentLimits).length === 0) delete result.agentLimits;
  }

  // Budget pacing config
  if (raw.budget_pacing && typeof raw.budget_pacing === "object") {
    const bp = raw.budget_pacing as Record<string, unknown>;
    result.budget_pacing = {
      enabled: typeof bp.enabled === "boolean" ? bp.enabled : true,
      reactive_reserve_pct: typeof bp.reactive_reserve_pct === "number" ? bp.reactive_reserve_pct : 20,
      low_budget_threshold: typeof bp.low_budget_threshold === "number" ? bp.low_budget_threshold : 10,
      critical_threshold: typeof bp.critical_threshold === "number" ? bp.critical_threshold : 5,
    };
  }

  // Per-team dispatch overrides
  if (raw.teams && typeof raw.teams === "object") {
    const teamsRaw = raw.teams as Record<string, unknown>;
    const teams: NonNullable<DispatchConfig["teams"]> = {};
    for (const [teamName, teamCfg] of Object.entries(teamsRaw)) {
      if (!teamCfg || typeof teamCfg !== "object") continue;
      const tc = teamCfg as Record<string, unknown>;
      const teamEntry: { budget_pacing?: BudgetPacingConfig } = {};
      if (tc.budget_pacing && typeof tc.budget_pacing === "object") {
        const bp = tc.budget_pacing as Record<string, unknown>;
        teamEntry.budget_pacing = {
          enabled: typeof bp.enabled === "boolean" ? bp.enabled : true,
          reactive_reserve_pct: typeof bp.reactive_reserve_pct === "number" ? bp.reactive_reserve_pct : undefined,
          low_budget_threshold: typeof bp.low_budget_threshold === "number" ? bp.low_budget_threshold : undefined,
          critical_threshold: typeof bp.critical_threshold === "number" ? bp.critical_threshold : undefined,
        };
      }
      if (Object.keys(teamEntry).length > 0) teams[teamName] = teamEntry;
    }
    if (Object.keys(teams).length > 0) result.teams = teams;
  }

  // Lead schedule config
  if (raw.lead_schedule && typeof raw.lead_schedule === "object") {
    const ls = raw.lead_schedule as Record<string, unknown>;
    result.lead_schedule = {
      planning_sessions_per_day: typeof ls.planning_sessions_per_day === "number" ? ls.planning_sessions_per_day : 3,
      planning_model: typeof ls.planning_model === "string" ? ls.planning_model : undefined,
      review_model: typeof ls.review_model === "string" ? ls.review_model : undefined,
      wake_on: Array.isArray(ls.wake_on) ? (ls.wake_on as unknown[]).filter((s): s is string => typeof s === "string") : undefined,
    };
  }

  // Worker dispatch config
  if (raw.worker && typeof raw.worker === "object") {
    const w = raw.worker as Record<string, unknown>;
    result.worker = {
      session_loop: typeof w.session_loop === "boolean" ? w.session_loop : true,
      max_tasks_per_session: typeof w.max_tasks_per_session === "number" ? w.max_tasks_per_session : 5,
      idle_timeout_ms: typeof w.idle_timeout_ms === "number" ? w.idle_timeout_ms : 300000,
      wake_on: Array.isArray(w.wake_on) ? (w.wake_on as unknown[]).filter((s): s is string => typeof s === "string") : undefined,
    };
  }

  // Verifier dispatch config
  if (raw.verifier && typeof raw.verifier === "object") {
    const v = raw.verifier as Record<string, unknown>;
    result.verifier = {
      wake_on: Array.isArray(v.wake_on) ? (v.wake_on as unknown[]).filter((s): s is string => typeof s === "string") : undefined,
    };
  }

  // Global max concurrency
  if (typeof (raw.global_max_concurrency ?? raw.globalMaxConcurrency) === "number") {
    result.globalMaxConcurrency = (raw.global_max_concurrency ?? raw.globalMaxConcurrency) as number;
  }

  // Task lease duration
  if (typeof (raw.task_lease_ms ?? raw.taskLeaseMs) === "number") {
    result.taskLeaseMs = (raw.task_lease_ms ?? raw.taskLeaseMs) as number;
  }

  // Queue lease duration
  if (typeof (raw.queue_lease_ms ?? raw.queueLeaseMs) === "number") {
    result.queueLeaseMs = (raw.queue_lease_ms ?? raw.queueLeaseMs) as number;
  }

  // Max dispatch attempts
  if (typeof (raw.max_dispatch_attempts ?? raw.maxDispatchAttempts) === "number") {
    result.maxDispatchAttempts = (raw.max_dispatch_attempts ?? raw.maxDispatchAttempts) as number;
  }

  // Role aliases
  if ((raw.role_aliases ?? raw.roleAliases) && typeof (raw.role_aliases ?? raw.roleAliases) === "object") {
    const aliases = (raw.role_aliases ?? raw.roleAliases) as Record<string, unknown>;
    result.roleAliases = {};
    for (const [alias, target] of Object.entries(aliases)) {
      if (typeof target === "string") result.roleAliases[alias] = target;
    }
    if (Object.keys(result.roleAliases).length === 0) delete result.roleAliases;
  }

  return result;
}

function normalizeAssignmentConfig(raw: Record<string, unknown>): AssignmentConfig {
  const enabled = raw.enabled === true;
  const rawStrategy = typeof raw.strategy === "string" ? raw.strategy : "workload_balanced";
  const strategy = VALID_ASSIGNMENT_STRATEGIES.includes(rawStrategy as AssignmentStrategy)
    ? (rawStrategy as AssignmentStrategy)
    : "workload_balanced";
  const autoDispatch = typeof raw.auto_dispatch_on_assign === "boolean"
    ? raw.auto_dispatch_on_assign
    : undefined;
  return { enabled, strategy, autoDispatchOnAssign: autoDispatch };
}

function normalizeEventHandlersConfig(
  raw: Record<string, unknown>,
): Record<string, EventHandlerConfig> | undefined {
  const result: Record<string, EventHandlerConfig> = {};

  for (const [eventType, rawActions] of Object.entries(raw)) {
    if (!Array.isArray(rawActions)) continue;

    const actions: EventActionConfig[] = [];
    for (const rawAction of rawActions) {
      if (typeof rawAction !== "object" || rawAction === null) continue;
      const a = rawAction as Record<string, unknown>;
      const actionType = String(a.action ?? "");
      if (!EVENT_ACTION_TYPES.includes(actionType as EventActionType)) continue;

      switch (actionType) {
        case "create_task":
          actions.push({
            action: "create_task",
            template: String(a.template ?? ""),
            description: typeof a.description === "string" ? a.description : undefined,
            priority: typeof a.priority === "string" ? a.priority as TaskPriority : undefined,
            assign_to: typeof a.assign_to === "string" ? a.assign_to : undefined,
            department: typeof a.department === "string" ? a.department : undefined,
            team: typeof a.team === "string" ? a.team : undefined,
          });
          break;
        case "notify":
          actions.push({
            action: "notify",
            message: String(a.message ?? ""),
            to: typeof a.to === "string" ? a.to : undefined,
            priority: typeof a.priority === "string" ? a.priority as "low" | "normal" | "high" | "urgent" : undefined,
          });
          break;
        case "escalate":
          actions.push({
            action: "escalate",
            to: String(a.to ?? "manager"),
            message: typeof a.message === "string" ? a.message : undefined,
          });
          break;
        case "enqueue_work":
          actions.push({
            action: "enqueue_work",
            task_id: typeof a.task_id === "string" ? a.task_id : undefined,
            priority: typeof a.priority === "number" ? a.priority : undefined,
          });
          break;
        case "emit_event":
          actions.push({
            action: "emit_event",
            event_type: String(a.event_type ?? "custom"),
            event_payload: typeof a.event_payload === "object" && a.event_payload !== null
              ? Object.fromEntries(Object.entries(a.event_payload as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
              : undefined,
            dedup_key: typeof a.dedup_key === "string" ? a.dedup_key : undefined,
          });
          break;
        case "dispatch_agent":
          actions.push({
            action: "dispatch_agent",
            agent_role: typeof a.agent_role === "string" ? a.agent_role : "worker",
            model: typeof a.model === "string" ? a.model : undefined,
            session_type: typeof a.session_type === "string" ? a.session_type as "reactive" | "active" | "planning" : undefined,
            payload: typeof a.payload === "object" && a.payload !== null ? a.payload as Record<string, unknown> : undefined,
          });
          break;
      }
    }

    if (actions.length > 0) {
      // Support both array format (YAML) and object format (with override_builtin)
      const overrideBuiltin = typeof rawActions === "object" && !Array.isArray(rawActions)
        ? Boolean((rawActions as Record<string, unknown>).override_builtin)
        : false;
      result[eventType] = { actions, override_builtin: overrideBuiltin };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

const VALID_TRIGGER_ACTIONS: TriggerAfterProcess[] = ["create_task", "emit_event", "enqueue", "none"];
const VALID_TRIGGER_AUTH_TYPES: TriggerAuthType[] = ["none", "bearer", "hmac", "api_key"];
const VALID_TRIGGER_SEVERITIES: TriggerSeverity[] = ["low", "medium", "high", "critical"];
const VALID_TRIGGER_OPERATORS: TriggerConditionOperator[] = [
  "==", "!=", ">", "<", ">=", "<=", "contains", "matches", "exists", "not_exists",
];

export function normalizeTriggerConfig(
  raw: Record<string, unknown>,
): Record<string, TriggerDefinition> | undefined {
  const result: Record<string, TriggerDefinition> = {};

  for (const [name, rawDef] of Object.entries(raw)) {
    if (typeof rawDef !== "object" || rawDef === null) continue;
    const d = rawDef as Record<string, unknown>;

    const def: TriggerDefinition = {};

    if (typeof d.description === "string" && d.description.trim()) {
      def.description = d.description.trim();
    }
    if (typeof d.enabled === "boolean") {
      def.enabled = d.enabled;
    }
    if (Array.isArray(d.sources)) {
      const sources = (d.sources as unknown[])
        .filter((s): s is string => typeof s === "string")
        .filter((s) => TRIGGER_SOURCES.includes(s as TriggerSource)) as TriggerSource[];
      if (sources.length > 0) def.sources = sources;
    }
    if (typeof d.auth === "object" && d.auth !== null) {
      const a = d.auth as Record<string, unknown>;
      const authType = typeof a.type === "string" && VALID_TRIGGER_AUTH_TYPES.includes(a.type as TriggerAuthType)
        ? (a.type as TriggerAuthType)
        : "none";
      const auth: TriggerAuth = { type: authType };
      if (typeof a.secret === "string") auth.secret = a.secret;
      if (typeof a.header_name === "string") auth.headerName = a.header_name;
      def.auth = auth;
    }
    if (Array.isArray(d.conditions)) {
      const conditions: TriggerCondition[] = [];
      for (const rawCond of d.conditions) {
        if (typeof rawCond !== "object" || rawCond === null) continue;
        const c = rawCond as Record<string, unknown>;
        if (typeof c.field !== "string" || !c.field.trim()) continue;
        const operator = typeof c.operator === "string" && VALID_TRIGGER_OPERATORS.includes(c.operator as TriggerConditionOperator)
          ? (c.operator as TriggerConditionOperator)
          : "==";
        const cond: TriggerCondition = { field: c.field.trim(), operator };
        if (c.value !== undefined) cond.value = c.value;
        conditions.push(cond);
      }
      if (conditions.length > 0) def.conditions = conditions;
    }
    if (typeof d.action === "string" && VALID_TRIGGER_ACTIONS.includes(d.action as TriggerAfterProcess)) {
      def.action = d.action as TriggerAfterProcess;
    }
    if (typeof d.task_template === "string" && d.task_template.trim()) {
      def.task_template = d.task_template.trim();
    }
    if (typeof d.task_description === "string" && d.task_description.trim()) {
      def.task_description = d.task_description.trim();
    }
    const VALID_TASK_PRIORITIES: string[] = ["P0", "P1", "P2", "P3"];
    if (typeof d.task_priority === "string" && VALID_TASK_PRIORITIES.includes(d.task_priority)) {
      def.task_priority = d.task_priority as TaskPriority;
    }
    if (typeof d.assign_to === "string" && d.assign_to.trim()) {
      def.assign_to = d.assign_to.trim();
    }
    if (typeof d.cooldown_ms === "number" && d.cooldown_ms > 0) {
      def.cooldownMs = d.cooldown_ms;
    }
    // Also accept camelCase for cooldownMs
    if (def.cooldownMs === undefined && typeof d.cooldownMs === "number" && (d.cooldownMs as number) > 0) {
      def.cooldownMs = d.cooldownMs as number;
    }
    if (typeof d.severity === "string" && VALID_TRIGGER_SEVERITIES.includes(d.severity as TriggerSeverity)) {
      def.severity = d.severity as TriggerSeverity;
    }
    if (Array.isArray(d.tags)) {
      const tags = (d.tags as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tags.length > 0) def.tags = tags;
    }

    result[name] = def;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeLifecycleConfig(raw: Record<string, unknown>): LifecycleConfig {
  const result: LifecycleConfig = {};
  if (typeof raw.auto_transition_on_dispatch === "boolean" || typeof raw.autoTransitionOnDispatch === "boolean") {
    result.autoTransitionOnDispatch = (raw.auto_transition_on_dispatch ?? raw.autoTransitionOnDispatch) as boolean;
  }
  if (typeof raw.auto_transition_on_complete === "boolean" || typeof raw.autoTransitionOnComplete === "boolean") {
    result.autoTransitionOnComplete = (raw.auto_transition_on_complete ?? raw.autoTransitionOnComplete) as boolean;
  }
  if (typeof raw.auto_capture_evidence === "boolean" || typeof raw.autoCaptureEvidence === "boolean") {
    result.autoCaptureEvidence = (raw.auto_capture_evidence ?? raw.autoCaptureEvidence) as boolean;
  }
  if (Array.isArray(raw.significant_tools ?? raw.significantTools)) {
    const tools = ((raw.significant_tools ?? raw.significantTools) as unknown[])
      .filter((t): t is string => typeof t === "string");
    if (tools.length > 0) result.significantTools = tools;
  }
  if (typeof (raw.evidence_truncation_limit ?? raw.evidenceTruncationLimit) === "number") {
    result.evidenceTruncationLimit = (raw.evidence_truncation_limit ?? raw.evidenceTruncationLimit) as number;
  }
  if (typeof raw.immediate_review_dispatch === "boolean" || typeof raw.immediateReviewDispatch === "boolean") {
    result.immediateReviewDispatch = (raw.immediate_review_dispatch ?? raw.immediateReviewDispatch) as boolean;
  }
  const complianceAction = raw.worker_non_compliance_action ?? raw.workerNonComplianceAction;
  if (typeof complianceAction === "string") {
    const valid = ["BLOCKED", "REVIEW", "FAILED", "alert_only"] as const;
    if ((valid as readonly string[]).includes(complianceAction)) {
      result.workerNonComplianceAction = complianceAction as LifecycleConfig["workerNonComplianceAction"];
    }
  }
  return result;
}

function normalizeManagerBehaviorConfig(raw: Record<string, unknown>): ManagerBehaviorConfig {
  const result: ManagerBehaviorConfig = {};
  if (typeof (raw.max_tasks_per_planning_session ?? raw.maxTasksPerPlanningSession) === "number") {
    result.maxTasksPerPlanningSession = (raw.max_tasks_per_planning_session ?? raw.maxTasksPerPlanningSession) as number;
  }
  if (typeof (raw.planning_horizon_days ?? raw.planningHorizonDays) === "number") {
    result.planningHorizonDays = (raw.planning_horizon_days ?? raw.planningHorizonDays) as number;
  }
  if (typeof (raw.escalation_trust_threshold ?? raw.escalationTrustThreshold) === "number") {
    result.escalationTrustThreshold = (raw.escalation_trust_threshold ?? raw.escalationTrustThreshold) as number;
  }
  return result;
}

function normalizeTelemetryConfig(raw: Record<string, unknown>): TelemetryConfig {
  const result: TelemetryConfig = {};
  if (typeof (raw.archive_transcripts ?? raw.archiveTranscripts) === "boolean") {
    result.archiveTranscripts = (raw.archive_transcripts ?? raw.archiveTranscripts) as boolean;
  }
  if (typeof (raw.capture_tool_io ?? raw.captureToolIO) === "boolean") {
    result.captureToolIO = (raw.capture_tool_io ?? raw.captureToolIO) as boolean;
  }
  if (typeof (raw.tool_io_truncation_limit ?? raw.toolIOTruncationLimit) === "number") {
    result.toolIOTruncationLimit = (raw.tool_io_truncation_limit ?? raw.toolIOTruncationLimit) as number;
  }
  if (typeof (raw.retention_days ?? raw.retentionDays) === "number") {
    result.retentionDays = (raw.retention_days ?? raw.retentionDays) as number;
  }
  if (typeof (raw.track_config_changes ?? raw.trackConfigChanges) === "boolean") {
    result.trackConfigChanges = (raw.track_config_changes ?? raw.trackConfigChanges) as boolean;
  }
  return result;
}

const VALID_OWNERSHIP_VALUES = ["any", "manager", "human"] as const;

function normalizeContextOwnershipConfig(raw: Record<string, unknown>): ContextOwnershipConfig {
  const result: ContextOwnershipConfig = {};
  for (const key of ["architecture", "standards", "direction", "policies"] as const) {
    const val = raw[key];
    if (typeof val === "string" && (VALID_OWNERSHIP_VALUES as readonly string[]).includes(val)) {
      result[key] = val as "any" | "manager" | "human";
    }
  }
  return result;
}

function normalizeReviewConfig(raw: Record<string, unknown>): ReviewConfig {
  const result: ReviewConfig = {};

  if (typeof raw.verifier_agent === "string" && raw.verifier_agent.trim()) {
    result.verifierAgent = raw.verifier_agent.trim();
  }
  if (typeof raw.auto_escalate_after_hours === "number" && raw.auto_escalate_after_hours > 0) {
    result.autoEscalateAfterHours = raw.auto_escalate_after_hours;
  }
  if (typeof raw.self_review_allowed === "boolean") {
    result.selfReviewAllowed = raw.self_review_allowed;
  }
  const VALID_PRIORITIES: string[] = ["P0", "P1", "P2", "P3"];
  if (typeof raw.self_review_max_priority === "string" &&
      VALID_PRIORITIES.includes(raw.self_review_max_priority)) {
    result.selfReviewMaxPriority = raw.self_review_max_priority as TaskPriority;
  }

  if (raw.workflow_steward && typeof raw.workflow_steward === "object") {
    const steward = raw.workflow_steward as Record<string, unknown>;
    const normalized: NonNullable<ReviewConfig["workflowSteward"]> = {};

    if (typeof steward.agent_id === "string" && steward.agent_id.trim()) {
      normalized.agentId = steward.agent_id.trim();
    }
    if (typeof steward.auto_proposal_threshold === "number" && steward.auto_proposal_threshold > 0) {
      normalized.autoProposalThreshold = steward.auto_proposal_threshold;
    }
    if (Array.isArray(steward.auto_proposal_reason_codes)) {
      const allowed = new Set<string>(REVIEW_REASON_CODES);
      const reasonCodes = steward.auto_proposal_reason_codes
        .filter((code): code is import("./types.js").ReviewReasonCode => typeof code === "string" && allowed.has(code));
      if (reasonCodes.length > 0) {
        normalized.autoProposalReasonCodes = reasonCodes;
      }
    }
    if (typeof steward.proposal_cooldown_hours === "number" && steward.proposal_cooldown_hours > 0) {
      normalized.proposalCooldownHours = steward.proposal_cooldown_hours;
    }

    if (Object.keys(normalized).length > 0) {
      result.workflowSteward = normalized;
    }
  }

  return result;
}

function normalizeVerificationConfig(raw: unknown): VerificationConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const config: VerificationConfig = {};
  if (typeof r.enabled === "boolean") config.enabled = r.enabled;
  if (Array.isArray(r.gates)) {
    config.gates = r.gates
      .filter((g: unknown): g is Record<string, unknown> => typeof g === "object" && g !== null)
      .map((g) => {
        const gate: VerificationGate = {
          name: String(g.name ?? ""),
          command: String(g.command ?? ""),
        };
        if (typeof g.timeout_seconds === "number") gate.timeout_seconds = g.timeout_seconds;
        if (typeof g.required === "boolean") gate.required = g.required;
        if (typeof g.file_pattern === "string") gate.file_pattern = g.file_pattern;
        return gate;
      });
  }
  if (typeof r.total_timeout_seconds === "number") config.total_timeout_seconds = r.total_timeout_seconds;
  if (typeof r.parallel === "boolean") config.parallel = r.parallel;
  if (typeof (r.default_gate_timeout_seconds ?? r.defaultGateTimeoutSeconds) === "number") {
    config.defaultGateTimeoutSeconds = (r.default_gate_timeout_seconds ?? r.defaultGateTimeoutSeconds) as number;
  }
  if (r.git && typeof r.git === "object") {
    const git = r.git as Record<string, unknown>;
    config.git = {} as GitIsolationConfig;
    if (typeof git.enabled === "boolean") config.git.enabled = git.enabled;
    if (typeof git.branch_pattern === "string") config.git.branch_pattern = git.branch_pattern;
    if (typeof git.base_branch === "string") config.git.base_branch = git.base_branch;
    if (typeof git.auto_merge === "boolean") config.git.auto_merge = git.auto_merge;
    if (typeof git.delete_after_merge === "boolean") config.git.delete_after_merge = git.delete_after_merge;
    if (typeof git.mode === "string" && (git.mode === "branch" || git.mode === "worktree")) {
      config.git.mode = git.mode;
    }
  }
  return config;
}

const VALID_CHANNEL_TYPES: ChannelType[] = ["topic", "meeting"];

function normalizeChannelsConfig(raw: unknown[]): ChannelConfig[] {
  const result: ChannelConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const ch = item as Record<string, unknown>;

    if (typeof ch.name !== "string" || !ch.name.trim()) continue;

    const config: ChannelConfig = { name: ch.name.trim() };

    if (typeof ch.type === "string" && VALID_CHANNEL_TYPES.includes(ch.type as ChannelType)) {
      config.type = ch.type as ChannelType;
    }
    if (Array.isArray(ch.members)) {
      config.members = ch.members.filter((m: unknown) => typeof m === "string") as string[];
    }
    if (Array.isArray(ch.departments)) {
      config.departments = ch.departments.filter((d: unknown) => typeof d === "string") as string[];
    }
    if (Array.isArray(ch.teams)) {
      config.teams = ch.teams.filter((t: unknown) => typeof t === "string") as string[];
    }
    const rawPresets = ch.presets ?? ch.roles;
    if (Array.isArray(rawPresets)) {
      config.presets = (rawPresets as unknown[]).filter((r: unknown) => typeof r === "string") as string[];
    }
    if (typeof ch.telegram_group_id === "string" && ch.telegram_group_id.trim()) {
      config.telegramGroupId = ch.telegram_group_id.trim();
    }
    if (typeof ch.telegram_thread_id === "number") {
      config.telegramThreadId = ch.telegram_thread_id;
    }

    result.push(config);
  }

  return result.length > 0 ? result : [];
}

function normalizeSweepConfig(raw: Record<string, unknown>): SweepConfig {
  const result: SweepConfig = {};
  if (typeof (raw.stale_threshold_ms ?? raw.staleThresholdMs) === "number") {
    result.staleThresholdMs = (raw.stale_threshold_ms ?? raw.staleThresholdMs) as number;
  }
  if (typeof (raw.proposal_ttl_ms ?? raw.proposalTtlMs) === "number") {
    result.proposalTtlMs = (raw.proposal_ttl_ms ?? raw.proposalTtlMs) as number;
  }
  if (typeof (raw.stale_dispatch_timeout_ms ?? raw.staleDispatchTimeoutMs) === "number") {
    result.staleDispatchTimeoutMs = (raw.stale_dispatch_timeout_ms ?? raw.staleDispatchTimeoutMs) as number;
  }
  return result;
}

function normalizeTrustConfig(raw: Record<string, unknown>): TrustConfig {
  const result: TrustConfig = {};
  const thresholds = raw.tier_thresholds ?? raw.tierThresholds;
  if (thresholds && typeof thresholds === "object") {
    const t = thresholds as Record<string, unknown>;
    if (typeof t.high === "number") result.tierThresholdHigh = t.high;
    if (typeof t.medium === "number") result.tierThresholdMedium = t.medium;
  }
  if (Array.isArray(raw.protected_categories ?? raw.protectedCategories)) {
    result.protectedCategories = ((raw.protected_categories ?? raw.protectedCategories) as unknown[])
      .filter((c): c is string => typeof c === "string");
  }
  if (typeof (raw.min_decisions_for_suggestion ?? raw.minDecisionsForSuggestion) === "number") {
    result.minDecisionsForSuggestion = (raw.min_decisions_for_suggestion ?? raw.minDecisionsForSuggestion) as number;
  }
  if (typeof (raw.min_approval_rate ?? raw.minApprovalRate) === "number") {
    result.minApprovalRate = (raw.min_approval_rate ?? raw.minApprovalRate) as number;
  }
  return result;
}

function normalizeContextConfig(raw: Record<string, unknown>): ContextConfig {
  const result: ContextConfig = {};
  if (typeof (raw.default_budget_chars ?? raw.defaultBudgetChars) === "number") {
    result.defaultBudgetChars = (raw.default_budget_chars ?? raw.defaultBudgetChars) as number;
  }
  return result;
}

function normalizeMemorySystemConfig(raw: Record<string, unknown>): MemoryConfig {
  const result: MemoryConfig = {};
  if (typeof (raw.review_transcript_max_chars ?? raw.reviewTranscriptMaxChars) === "number") {
    result.reviewTranscriptMaxChars = (raw.review_transcript_max_chars ?? raw.reviewTranscriptMaxChars) as number;
  }
  return result;
}

// --- Agent config registry ---
// Stores runtime agent config under namespaced keys and keeps a legacy bare-ID
// alias only while that bare ID is unique across all loaded domains.

type AgentConfigEntry = {
  agentId: string;
  projectId: string;
  config: AgentConfig;
  /** Absolute path to the project directory on disk. */
  projectDir?: string;
};

/** Extended project config keyed by projectId. */
export type ExtendedProjectConfig = {
  projectDir?: string;
  storageDir?: string;
  adapter?: WorkforceConfig["adapter"];
  codex?: WorkforceConfig["codex"];
  claudeCode?: WorkforceConfig["claudeCode"];
  policies?: WorkforceConfig["policies"];
  monitoring?: WorkforceConfig["monitoring"];
  riskTiers?: RiskTierConfig;
  dispatch?: DispatchConfig;
  assignment?: AssignmentConfig;
  toolGates?: ToolGatesConfig;
  bulkThresholds?: WorkforceConfig["bulkThresholds"];
  eventHandlers?: Record<string, EventHandlerConfig>;
  triggers?: Record<string, TriggerDefinition>;
  review?: ReviewConfig;
  channels?: ChannelConfig[];
  safety?: WorkforceConfig["safety"];
  lifecycle?: LifecycleConfig;
  managerBehavior?: ManagerBehaviorConfig;
  telemetry?: TelemetryConfig;
  contextOwnership?: ContextOwnershipConfig;
  verification?: VerificationConfig;
  sweep?: WorkforceConfig["sweep"];
  trust?: WorkforceConfig["trust"];
  context?: WorkforceConfig["context"];
  memory?: WorkforceConfig["memory"];
  entities?: WorkforceConfig["entities"];
  execution?: WorkforceConfig["execution"];
};

type ProjectConfigRuntimeState = {
  agentConfigRegistry: Map<string, AgentConfigEntry>;
  bareAgentAliases: Map<string, string>;
  bareAgentQualifiedIds: Map<string, Set<string>>;
  runtimeAgentAliases: Map<string, string>;
  runtimeAgentQualifiedIds: Map<string, Set<string>>;
  projectAgentIds: Map<string, Set<string>>;
  approvalPolicies: Map<string, ApprovalPolicy>;
  projectExtendedConfig: Map<string, ExtendedProjectConfig>;
};

const runtime = getDefaultRuntimeState();

function getProjectConfigState(): ProjectConfigRuntimeState {
  return runtime.projectConfig as ProjectConfigRuntimeState;
}

/** Get extended project config. */
export function getExtendedProjectConfig(projectId: string): ExtendedProjectConfig | null {
  return getProjectConfigState().projectExtendedConfig.get(projectId) ?? null;
}

export function getProjectDir(projectId: string): string | null {
  return getProjectConfigState().projectExtendedConfig.get(projectId)?.projectDir ?? null;
}

/**
 * Register all agents from a workforce config.
 * Called during project initialization.
 */
export function registerWorkforceConfig(
  projectId: string,
  wfConfig: WorkforceConfig,
  projectDir?: string,
  storageDir?: string,
): void {
  const state = getProjectConfigState();
  clearProjectAgentRegistrations(projectId);
  state.approvalPolicies.delete(projectId);
  unregisterManagerProjectByProject(projectId);
  unregisterCustomSkills(projectId);
  if (storageDir) {
    setProjectStorageDir(projectId, storageDir);
  } else {
    clearProjectStorageDir(projectId);
  }

  for (const [agentId, config] of Object.entries(wfConfig.agents)) {
    registerAgentEntry(projectId, agentId, { agentId, projectId, config, projectDir });
  }
  if (wfConfig.approval) {
    state.approvalPolicies.set(projectId, wfConfig.approval);
  }

  // Register manager cron if configured
  const mgrConfig = wfConfig.manager;
  if (mgrConfig?.enabled) {
    if (projectDir) {
      mgrConfig.projectDir = projectDir;
    }
    registerManagerProject(projectId, {
      ...mgrConfig,
      directives: (mgrConfig as Record<string, unknown>).directives as string[] ?? [],
    });
  }

  // Register custom skill topics
  if (projectDir) {
    try {
      registerCustomSkills(projectId, wfConfig.skills ?? {}, projectDir);
    } catch (err) {
      safeLog("project.customSkills", err);
    }
  }

  try {
    syncProjectBudgets(projectId, wfConfig.budgets);
  } catch (err) {
    safeLog("project.budgetSetup", err);
  }

  // Runtime escalation chain validation — catches cycles that span
  // multiple registerWorkforceConfig calls for the same project
  for (const agentId of Object.keys(wfConfig.agents)) {
    const { hasCycle } = resolveEscalationChain(projectId, agentId);
    if (hasCycle) {
      emitDiagnosticEvent({
        type: "escalation_cycle_detected",
        projectId,
        agentId,
        message: `Escalation cycle detected starting from agent "${agentId}" in project "${projectId}".`,
      });
    }
  }

  // Inject default event handlers for event-driven mode
  // User config overrides defaults per event type (full replacement, not merge)
  //
  // NOTE: task_assigned is intentionally NOT included here. The built-in
  // handleTaskAssigned() in router.ts already enqueues for dispatch (with dedup).
  // Having a dispatch_agent user handler here too would cause double-dispatch.
  // The canonical dispatch path is:
  //   createTask → handleTaskCreated → emits task_assigned → handleTaskAssigned → enqueue
  let effectiveEventHandlers = wfConfig.event_handlers;
  if (wfConfig.dispatch?.mode === "event-driven") {
    const defaults: Record<string, EventHandlerConfig> = {
      task_review_ready: { actions: [{ action: "dispatch_agent", agent_role: "lead", session_type: "reactive" }] },
      task_failed: { actions: [{ action: "dispatch_agent", agent_role: "lead", session_type: "reactive" }] },
      budget_changed: { actions: [{ action: "dispatch_agent", agent_role: "lead", session_type: "planning" }] },
    };
    effectiveEventHandlers = { ...defaults, ...effectiveEventHandlers };
  }

  // Store extra config sections for runtime use
  if (projectDir || storageDir || wfConfig.adapter || wfConfig.codex || wfConfig.claudeCode || wfConfig.policies || wfConfig.monitoring || wfConfig.riskTiers || wfConfig.dispatch || wfConfig.assignment || wfConfig.toolGates || wfConfig.bulkThresholds || effectiveEventHandlers || wfConfig.triggers || wfConfig.review || wfConfig.channels || wfConfig.safety || wfConfig.lifecycle || wfConfig.managerBehavior || wfConfig.telemetry || wfConfig.contextOwnership || wfConfig.verification || wfConfig.sweep || wfConfig.trust || wfConfig.context || wfConfig.memory || wfConfig.entities || wfConfig.execution) {
  state.projectExtendedConfig.set(projectId, {
    projectDir,
    storageDir,
    adapter: wfConfig.adapter,
    codex: wfConfig.codex,
    claudeCode: wfConfig.claudeCode,
    policies: wfConfig.policies,
      monitoring: wfConfig.monitoring,
      riskTiers: wfConfig.riskTiers,
      dispatch: wfConfig.dispatch,
      assignment: wfConfig.assignment,
      toolGates: wfConfig.toolGates,
      bulkThresholds: wfConfig.bulkThresholds,
      eventHandlers: effectiveEventHandlers,
      triggers: wfConfig.triggers,
      review: wfConfig.review,
      channels: wfConfig.channels,
      safety: wfConfig.safety,
      lifecycle: wfConfig.lifecycle,
      managerBehavior: wfConfig.managerBehavior,
      telemetry: wfConfig.telemetry,
      contextOwnership: wfConfig.contextOwnership,
      verification: wfConfig.verification,
      sweep: wfConfig.sweep,
      trust: wfConfig.trust,
      context: wfConfig.context,
      memory: wfConfig.memory,
      entities: wfConfig.entities,
      execution: wfConfig.execution,
    });
  } else {
    state.projectExtendedConfig.delete(projectId);
  }
}

export type GoalSeedMode = "literal" | "titleized";

export type ActivateWorkforceProjectOptions = {
  projectDir?: string;
  storageDir?: string;
  scaffoldAgentDocs?: boolean;
  recoverOrphanedSessions?: boolean;
  goalSeedMode?: GoalSeedMode;
  goalCreatedBy?: string;
  syncExistingGoalMetadata?: boolean;
};

export type ActivateWorkforceProjectResult = {
  registeredAgents: Array<{ id: string; extends: string | undefined }>;
  orphanedSessionsRecovered: number;
};

/**
 * Activate a workforce project into the live runtime.
 *
 * This is the shared runtime path used by setup activation and domain
 * initialization. It keeps workforce registration,
 * policy loading, DB/bootstrap, and goal seeding on one code path.
 */
export function activateWorkforceProject(
  projectId: string,
  wfConfig: WorkforceConfig,
  options: ActivateWorkforceProjectOptions = {},
): ActivateWorkforceProjectResult {
  const {
    projectDir,
    storageDir,
    scaffoldAgentDocs = false,
    recoverOrphanedSessions: shouldRecoverOrphans = false,
    goalSeedMode = "literal",
    goalCreatedBy = "system:config",
    syncExistingGoalMetadata = false,
  } = options;

  registerWorkforceConfig(projectId, wfConfig, projectDir, storageDir);

  try {
    // Ensure the runtime DB exists and the project participates in sweeps.
    getDb(projectId);
    registerProject(projectId);

    registerProjectPolicies(projectId, wfConfig);

    const registeredAgents = Object.entries(wfConfig.agents).map(([agentId, config]) => {
      if (scaffoldAgentDocs && projectDir) {
        try {
          ensureAgentDocs(projectDir, agentId, config);
        } catch (err) {
          safeLog("project.activate.ensureAgentDocs", err);
        }
      }
      return { id: agentId, extends: config.extends };
    });

    if (wfConfig.goals) {
      seedConfiguredGoals(projectId, wfConfig.goals, {
        mode: goalSeedMode,
        createdBy: goalCreatedBy,
        syncExistingGoalMetadata,
      });
    }

    const orphanedSessionsRecovered = shouldRecoverOrphans
      ? recoverOrphanedSessions(projectId).length
      : 0;

    return { registeredAgents, orphanedSessionsRecovered };
  } catch (error) {
    unregisterWorkforceProject(projectId);
    throw error;
  }
}

export function unregisterWorkforceProject(projectId: string): void {
  const state = getProjectConfigState();
  clearProjectAgentRegistrations(projectId);
  state.approvalPolicies.delete(projectId);
  state.projectExtendedConfig.delete(projectId);
  clearProjectStorageDir(projectId);
  unregisterManagerProjectByProject(projectId);
  unregisterCustomSkills(projectId);
  clearProjectPolicies(projectId);
  unregisterProject(projectId);
}

/**
 * Look up agent config by agent ID.
 *
 * Accepts both bare IDs ("cf-lead") and namespaced IDs ("clawforce-dev:cf-lead").
 * Bare IDs only resolve when they are unambiguous across loaded domains.
 * Project-local lookups always try the local bare ID first, which preserves
 * agent IDs that already contain ":" (for example "agent:verifier").
 * Pass projectId when the caller already knows domain context.
 */
export function getAgentConfig(agentId: string, projectId?: string): AgentConfigEntry | null {
  const state = getProjectConfigState();
  if (projectId) {
    const scopedEntry = state.agentConfigRegistry.get(toNamespacedAgentId(projectId, agentId));
    if (scopedEntry) return scopedEntry;

    const exactEntry = state.agentConfigRegistry.get(agentId);
    if (exactEntry?.projectId === projectId) return exactEntry;

    const runtimeQualifiedId = state.runtimeAgentAliases.get(agentId);
    if (!runtimeQualifiedId) return null;
    const runtimeEntry = state.agentConfigRegistry.get(runtimeQualifiedId);
    return runtimeEntry?.projectId === projectId ? runtimeEntry : null;
  }

  const qualifiedId = state.bareAgentAliases.get(agentId);
  if (qualifiedId) {
    return state.agentConfigRegistry.get(qualifiedId) ?? null;
  }

  const runtimeQualifiedId = state.runtimeAgentAliases.get(agentId);
  if (runtimeQualifiedId) {
    return state.agentConfigRegistry.get(runtimeQualifiedId) ?? null;
  }

  return state.agentConfigRegistry.get(agentId) ?? null;
}

/**
 * Resolve the OpenClaw-facing agent identifier for a registered ClawForce agent.
 * Existing runtimes can supply `runtimeRef` to keep their native agent IDs.
 */
export function resolveOpenClawAgentId(agentId: string, projectId?: string): string {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry) return agentId;
  if (entry.config.runtimeRef) return entry.config.runtimeRef;
  return toNamespacedAgentId(entry.projectId, entry.agentId);
}

function registerProjectPolicies(projectId: string, wfConfig: WorkforceConfig): void {
  const allPolicies: Array<{ name: string; type: string; target?: string; config: Record<string, unknown> }> = [];

  if (wfConfig.policies && wfConfig.policies.length > 0) {
    allPolicies.push(...wfConfig.policies);
  }

  try {
    const agentEntries = Object.fromEntries(
      Object.entries(wfConfig.agents).map(([id, cfg]) => [id, { extends: cfg.extends }]),
    );
    const scopePolicies = generateDefaultScopePolicies(agentEntries, wfConfig.policies);
    allPolicies.push(...scopePolicies);
  } catch (err) {
    safeLog("project.activate.scopePolicies", err);
  }

  try {
    registerPolicies(projectId, allPolicies);
  } catch (err) {
    safeLog("project.activate.registerPolicies", err);
  }
}

function seedConfiguredGoals(
  projectId: string,
  goals: Record<string, GoalConfigEntry>,
  options: {
    mode: GoalSeedMode;
    createdBy: string;
    syncExistingGoalMetadata: boolean;
  },
): void {
  try {
    const existing = listGoals(projectId, { status: "active" });
    const existingByTitle = new Map(existing.map((goal) => [goal.title, goal]));

    for (const [goalKey, goalDef] of Object.entries(goals)) {
      const title = options.mode === "titleized" ? titleizeGoalKey(goalKey) : goalKey;
      const match = existingByTitle.get(title);
      if (match) {
        if (options.syncExistingGoalMetadata && (goalDef.department != null || goalDef.allocation != null)) {
          try {
            const db = getDb(projectId);
            db.prepare(
              "UPDATE goals SET department = COALESCE(?, department), allocation = COALESCE(?, allocation) WHERE id = ?",
            ).run(goalDef.department ?? null, goalDef.allocation ?? null, match.id);
          } catch {
            // Metadata sync is best-effort only.
          }
        }
        continue;
      }

      createGoal({
        projectId,
        title,
        description: goalDef.description,
        acceptanceCriteria: goalDef.acceptance_criteria,
        ownerAgentId: goalDef.owner_agent_id,
        department: goalDef.department,
        team: goalDef.team,
        allocation: goalDef.allocation,
        createdBy: options.createdBy,
      });
    }
  } catch (err) {
    safeLog("project.activate.seedGoals", err);
  }
}

function syncProjectBudgets(
  projectId: string,
  budgets?: WorkforceConfig["budgets"],
): void {
  const db = getDb(projectId);

  syncBudgetRows(projectId, budgets, db);

  if (!budgets) return;

  if (budgets.project) {
    setBudget({ projectId, config: budgets.project }, db);
  }

  if (budgets.agents) {
    for (const [agentId, budgetConfig] of Object.entries(budgets.agents)) {
      setBudget({ projectId, agentId, config: budgetConfig }, db);
    }
  }
}

function syncBudgetRows(
  projectId: string,
  budgets: WorkforceConfig["budgets"] | undefined,
  db: DatabaseSync,
): void {
  if (!budgets?.project) {
    db.prepare("DELETE FROM budgets WHERE project_id = ? AND agent_id IS NULL").run(projectId);
  }

  const desiredAgentBudgetIds = Object.keys(budgets?.agents ?? {});
  if (desiredAgentBudgetIds.length === 0) {
    db.prepare("DELETE FROM budgets WHERE project_id = ? AND agent_id IS NOT NULL").run(projectId);
    return;
  }

  const placeholders = desiredAgentBudgetIds.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM budgets
     WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id NOT IN (${placeholders})`,
  ).run(projectId, ...desiredAgentBudgetIds);
}

function titleizeGoalKey(goalKey: string): string {
  return goalKey
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Get approval policy for a project. */
export function getApprovalPolicy(projectId: string): ApprovalPolicy | null {
  return getProjectConfigState().approvalPolicies.get(projectId) ?? null;
}

/**
 * Get registered agent IDs.
 *
 * With projectId, returns bare IDs for that domain.
 * Without projectId, returns bare IDs when unique and namespaced IDs for
 * colliding agent names so no registrations are silently omitted.
 */
export function getRegisteredAgentIds(projectId?: string): string[] {
  const state = getProjectConfigState();
  if (projectId) {
    return [...(state.projectAgentIds.get(projectId) ?? [])];
  }

  const ids: string[] = [];
  for (const [agentId, qualifiedIds] of state.bareAgentQualifiedIds) {
    if (qualifiedIds.size === 1) {
      ids.push(agentId);
      continue;
    }
    ids.push(...[...qualifiedIds].sort());
  }
  return ids;
}

/** Clear all registrations (for testing). */
export function resetEnforcementConfigForTest(): void {
  const state = getProjectConfigState();
  state.agentConfigRegistry.clear();
  state.bareAgentAliases.clear();
  state.bareAgentQualifiedIds.clear();
  state.runtimeAgentAliases.clear();
  state.runtimeAgentQualifiedIds.clear();
  state.projectAgentIds.clear();
  state.approvalPolicies.clear();
  state.projectExtendedConfig.clear();
}

/**
 * Register a single agent into the config registry at runtime.
 * Used by adaptation flows (e.g. agent hiring) to spin up new agents.
 *
 * Registers both a bare ID entry and a namespace alias so the agent is
 * reachable from both internal ClawForce code and OpenClaw hooks.
 */
export function registerAgentInProject(
  projectId: string,
  agentId: string,
  config: AgentConfig,
  projectDir?: string,
): void {
  registerAgentEntry(projectId, agentId, { agentId, projectId, config, projectDir });
}

function registerAgentEntry(projectId: string, agentId: string, entry: AgentConfigEntry): void {
  const state = getProjectConfigState();
  const qualifiedId = toNamespacedAgentId(projectId, agentId);
  state.agentConfigRegistry.set(qualifiedId, entry);

  let projectIds = state.projectAgentIds.get(projectId);
  if (!projectIds) {
    projectIds = new Set<string>();
    state.projectAgentIds.set(projectId, projectIds);
  }
  projectIds.add(agentId);

  let qualifiedIds = state.bareAgentQualifiedIds.get(agentId);
  if (!qualifiedIds) {
    qualifiedIds = new Set<string>();
    state.bareAgentQualifiedIds.set(agentId, qualifiedIds);
  }
  qualifiedIds.add(qualifiedId);
  refreshBareAlias(agentId);

  const runtimeRef = entry.config.runtimeRef?.trim();
  if (runtimeRef && runtimeRef !== agentId) {
    let runtimeQualifiedIds = state.runtimeAgentQualifiedIds.get(runtimeRef);
    if (!runtimeQualifiedIds) {
      runtimeQualifiedIds = new Set<string>();
      state.runtimeAgentQualifiedIds.set(runtimeRef, runtimeQualifiedIds);
    }
    runtimeQualifiedIds.add(qualifiedId);
    refreshRuntimeAlias(runtimeRef);
  }
}

function clearProjectAgentRegistrations(projectId: string): void {
  const state = getProjectConfigState();
  const bareIds = state.projectAgentIds.get(projectId);
  if (!bareIds) return;

  for (const agentId of bareIds) {
    const qualifiedId = toNamespacedAgentId(projectId, agentId);
    const entry = state.agentConfigRegistry.get(qualifiedId);
    state.agentConfigRegistry.delete(qualifiedId);

    const qualifiedIds = state.bareAgentQualifiedIds.get(agentId);
    if (qualifiedIds) {
      qualifiedIds.delete(qualifiedId);
      if (qualifiedIds.size === 0) {
        state.bareAgentQualifiedIds.delete(agentId);
      }
      refreshBareAlias(agentId);
    }

    const runtimeRef = entry?.config.runtimeRef?.trim();
    if (runtimeRef && runtimeRef !== agentId) {
      const runtimeQualifiedIds = state.runtimeAgentQualifiedIds.get(runtimeRef);
      if (runtimeQualifiedIds) {
        runtimeQualifiedIds.delete(qualifiedId);
        if (runtimeQualifiedIds.size === 0) {
          state.runtimeAgentQualifiedIds.delete(runtimeRef);
          state.runtimeAgentAliases.delete(runtimeRef);
        } else {
          refreshRuntimeAlias(runtimeRef);
        }
      }
    }
  }

  state.projectAgentIds.delete(projectId);
}

function refreshBareAlias(agentId: string): void {
  const state = getProjectConfigState();
  const qualifiedIds = state.bareAgentQualifiedIds.get(agentId);
  if (!qualifiedIds || qualifiedIds.size === 0) {
    state.bareAgentAliases.delete(agentId);
    return;
  }

  if (qualifiedIds.size === 1) {
    state.bareAgentAliases.set(agentId, [...qualifiedIds][0]!);
    return;
  }

  state.bareAgentAliases.delete(agentId);
}

function refreshRuntimeAlias(runtimeRef: string): void {
  const state = getProjectConfigState();
  const qualifiedIds = state.runtimeAgentQualifiedIds.get(runtimeRef);
  if (!qualifiedIds || qualifiedIds.size === 0) {
    state.runtimeAgentAliases.delete(runtimeRef);
    return;
  }

  if (qualifiedIds.size === 1) {
    state.runtimeAgentAliases.set(runtimeRef, [...qualifiedIds][0]!);
    return;
  }

  state.runtimeAgentAliases.delete(runtimeRef);
}
