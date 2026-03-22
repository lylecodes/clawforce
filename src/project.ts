/**
 * Clawforce — Project configuration
 *
 * Reads project.yaml files, initializes per-project databases and directories.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { setBudget } from "./budget.js";
import { getDb, getProjectsDir } from "./db.js";
import { emitDiagnosticEvent, safeLog } from "./diagnostics.js";
import { registerProject } from "./lifecycle.js";
import type { ManagerSettings } from "./manager-config.js";
import { registerManagerProject } from "./manager-config.js";
import { registerManagerCron } from "./manager-cron.js";
import { resolveEscalationChain } from "./org.js";
import { applyProfile } from "./profiles.js";
import { BUILTIN_AGENT_PRESETS } from "./presets.js";
import { normalizeAgentConfig as resolveAliases } from "./config/aliases.js";
import { registerCustomSkills } from "./skills/registry.js";
import type {
  AgentConfig,
  AlertRuleDefinition,
  AnomalyConfig,
  ApprovalPolicy,
  AssignmentConfig,
  AssignmentStrategy,
  BudgetConfig,
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
  WorkforceConfig,
} from "./types.js";
import { EVENT_ACTION_TYPES, TRIGGER_SOURCES } from "./types.js";

export type ProjectConfig = {
  id: string;
  name: string;
  dir: string;
  agents: {
    project: string;
    workers: WorkerConfig[];
  };
  verification: {
    required: boolean;
  };
  defaults: {
    maxRetries: number;
    priority: "P0" | "P1" | "P2" | "P3";
  };
  manager?: ManagerSettings;
  /** @deprecated Use manager instead. */
  orchestrator?: ManagerSettings;
};

export type WorkerConfig = {
  type: "claude-code" | "openclaw-agent";
  profile?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Load a project config from a YAML file.
 * @deprecated Use domain-based config via initializeAllDomains instead.
 * Retained for backward compatibility with setup-tool activate and tests.
 */
export function loadProject(configPath: string): ProjectConfig {
  const content = fs.readFileSync(configPath, "utf-8");
  return parseProjectYaml(content);
}

/**
 * Load the workforce config (agent configs + approval policy) from a project.yaml.
 * Returns null if the file has no `agents` section with workforce configs.
 * @deprecated Use domain-based config via initializeAllDomains instead.
 * Retained for backward compatibility with setup-tool activate and tests.
 */
export function loadWorkforceConfig(configPath: string): WorkforceConfig | null {
  const content = fs.readFileSync(configPath, "utf-8");
  const raw = YAML.parse(content) as Record<string, unknown> | null;
  if (!raw) return null;

  const rawAgents = raw.agents as Record<string, unknown> | undefined;
  if (!rawAgents) return null;

  // Check if agents section has workforce-style configs (extends/role + expectations)
  // vs the legacy format (project + workers)
  const hasWorkforceAgents = Object.values(rawAgents).some(
    (v) => typeof v === "object" && v !== null &&
      ("extends" in (v as Record<string, unknown>) || "role" in (v as Record<string, unknown>)),
  );
  if (!hasWorkforceAgents) return null;

  // Pre-parse skill_packs so they can be applied during agent normalization
  const skillPacks = raw.skill_packs && typeof raw.skill_packs === "object"
    ? normalizeSkillPacksConfig(raw.skill_packs as Record<string, unknown>)
    : undefined;

  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, rawAgent] of Object.entries(rawAgents)) {
    if (typeof rawAgent !== "object" || rawAgent === null) continue;
    const a = rawAgent as Record<string, unknown>;
    if (!a.role && !a.extends) continue;

    agents[agentId] = normalizeAgentConfig(a, skillPacks);
  }

  if (Object.keys(agents).length === 0) return null;

  const approval = normalizeApprovalPolicy(raw.approval);

  const result: WorkforceConfig = {
    name: String(raw.name ?? "unnamed"),
    approval: approval ?? undefined,
    agents,
  };

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

  return result;
}

/** @deprecated Use domain-based config via initializeAllDomains. Alias for loadWorkforceConfig. */
export const loadEnforcementConfig = loadWorkforceConfig;

/**
 * Initialize a project: create DB, register for sweeps.
 */
export function initProject(config: ProjectConfig): void {
  // Ensure project directory exists
  const projectDir = path.join(getProjectsDir(), config.id);
  fs.mkdirSync(projectDir, { recursive: true });

  // Initialize the database (runs migrations)
  getDb(config.id);

  // Register for sweep service
  registerProject(config.id);

  // Register manager if configured (accept both "manager" and legacy "orchestrator" key)
  const mgrConfig = config.manager ?? config.orchestrator;
  if (mgrConfig?.enabled) {
    // Set projectDir so the charter file (PROJECT.md) can be loaded at bootstrap
    mgrConfig.projectDir = resolveProjectDir(config.dir);
    registerManagerProject(config.id, mgrConfig);

    // Auto-register cron job if schedule is specified
    if (mgrConfig.cronSchedule) {
      void registerManagerCron(
        config.id,
        mgrConfig.agentId,
        mgrConfig.cronSchedule,
      );
    }
  }
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

/**
 * Parse project.yaml using the yaml library.
 */
function parseProjectYaml(content: string): ProjectConfig {
  const raw = YAML.parse(content) as Record<string, unknown>;
  return normalizeProjectConfig(raw);
}

function normalizeProjectConfig(raw: Record<string, unknown>): ProjectConfig {
  const agents = raw.agents as Record<string, unknown> | undefined;
  const verification = raw.verification as Record<string, unknown> | undefined;
  const defaults = raw.defaults as Record<string, unknown> | undefined;
  const workers = (agents?.workers as Record<string, unknown>[]) ?? [];
  const orch = (raw.manager ?? raw.orchestrator) as Record<string, unknown> | undefined;

  const config: ProjectConfig = {
    id: String(raw.id ?? "default"),
    name: String(raw.name ?? raw.id ?? "Default Project"),
    dir: String(raw.dir ?? "."),
    agents: {
      project: String(agents?.project ?? "default"),
      workers: workers.map((w) => ({
        type: (String(w.type ?? "claude-code")) as "claude-code" | "openclaw-agent",
        profile: w.profile ? String(w.profile) : undefined,
        model: w.model ? String(w.model) : undefined,
        timeoutMs: typeof w.timeoutMs === "number" ? w.timeoutMs : undefined,
      })),
    },
    verification: {
      required: verification?.required !== false,
    },
    defaults: {
      maxRetries: typeof defaults?.maxRetries === "number" ? defaults.maxRetries : 3,
      priority: (String(defaults?.priority ?? "P2")) as "P0" | "P1" | "P2" | "P3",
    },
  };

  if (orch) {
    const dispatchDefaults = orch.dispatchDefaults as Record<string, unknown> | undefined;
    config.manager = {
      enabled: orch.enabled !== false,
      agentId: String(orch.agentId ?? config.agents.project),
      cronSchedule: orch.cronSchedule ? String(orch.cronSchedule) : undefined,
      directives: Array.isArray(orch.directives)
        ? (orch.directives as unknown[]).map(String)
        : [],
      contextBudgetChars:
        typeof orch.contextBudgetChars === "number" ? orch.contextBudgetChars : undefined,
      dispatchDefaults: dispatchDefaults
        ? {
            profile: dispatchDefaults.profile ? String(dispatchDefaults.profile) : undefined,
            model: dispatchDefaults.model ? String(dispatchDefaults.model) : undefined,
            timeoutMs:
              typeof dispatchDefaults.timeoutMs === "number"
                ? dispatchDefaults.timeoutMs
                : undefined,
          }
        : undefined,
    };
  }

  return config;
}

// --- Workforce config normalizers ---

const VALID_SOURCES: ContextSource["source"][] = [
  "instructions", "custom", "project_md", "task_board",
  "assigned_task", "knowledge", "file", "skill", "memory",
  "memory_instructions", "memory_review_context",
  "escalations", "workflows", "activity", "sweep_status",
  "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
  "team_status", "team_performance", "soul", "tools_reference",
  "channel_messages", "pending_messages", "goal_hierarchy", "planning_delta",
  "velocity", "preferences", "trust_scores", "resources", "initiative_status",
  "cost_forecast", "available_capacity", "knowledge_candidates",
  "budget_guidance", "onboarding_welcome", "weekly_digest", "intervention_suggestions",
"custom_stream", "observed_events",
  "direction", "policies", "standards", "architecture",
  "task_creation_standards", "execution_standards", "review_standards", "rejection_standards",
];

function normalizeAgentConfig(rawInput: Record<string, unknown>, skillPacks?: Record<string, SkillPack>): AgentConfig {
  // Resolve config aliases (group→department, subgroup→team, role→extends)
  // before any other processing so canonical names are always available.
  const raw = resolveAliases(rawInput);

  // Handle extends field — error if old role: field used
  if (raw.role !== undefined) {
    const oldRole = raw.role as string;
    emitDiagnosticEvent({
      type: "config_error",
      message: `"role: ${oldRole}" is deprecated. Use "extends: ${oldRole}" instead.`,
    });
  }

  // Use `extends` if set, fall back to `role` for backward compat, default to "employee"
  const rawExtends = typeof raw.extends === "string" && raw.extends.trim()
    ? raw.extends.trim()
    : undefined;
  const rawRole = typeof raw.role === "string" && raw.role.trim()
    ? raw.role.trim()
    : undefined;
  // Map legacy role aliases (applies to both extends and role for backward compat)
  // e.g. role: worker → extends: worker (via alias) → employee (via legacy map)
  const ROLE_ALIAS: Record<string, string> = { orchestrator: "manager", worker: "employee" };
  const mappedExtends = rawExtends ? (ROLE_ALIAS[rawExtends] ?? rawExtends) : undefined;
  const mappedRole = rawRole ? (ROLE_ALIAS[rawRole] ?? rawRole) : undefined;
  const extendsFrom = mappedExtends ?? mappedRole ?? "employee";

  // Accept both old and new field names for migration
  const briefing = normalizeContextSources(raw.briefing ?? raw.context_in);
  const excludeBriefing = normalizeExcludeContext(raw.exclude_briefing ?? raw.exclude_context);
  const expectations = normalizeExpectations(raw.expectations ?? raw.required_outputs);
  const performancePolicy = normalizePerformancePolicy(raw.performance_policy ?? raw.on_failure);

  // Determine whether the user explicitly provided these fields
  const hasExplicitExpectations = Array.isArray(raw.expectations ?? raw.required_outputs);
  const hasExplicitPolicy = typeof (raw.performance_policy ?? raw.on_failure) === "object" && (raw.performance_policy ?? raw.on_failure) !== null;

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

  const observe = Array.isArray(raw.observe)
    ? (raw.observe.filter((s: unknown) => typeof s === "string") as string[])
    : undefined;

  const skillCap = typeof raw.skill_cap === "number" ? raw.skill_cap : undefined;

  const contextBudgetChars = typeof (raw.context_budget_chars ?? raw.contextBudgetChars) === "number"
    ? (raw.context_budget_chars ?? raw.contextBudgetChars) as number
    : undefined;
  const maxTurnsPerSession = typeof (raw.max_turns_per_session ?? raw.maxTurnsPerSession) === "number"
    ? (raw.max_turns_per_session ?? raw.maxTurnsPerSession) as number
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
    model: agentModel,
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
      if (!VALID_SOURCES.includes(item.source as ContextSource["source"])) {
        emitDiagnosticEvent({
          type: "config_warning",
          message: `Unknown context source "${item.source as string}" — falling back to "custom". Valid sources: ${VALID_SOURCES.join(", ")}`,
        });
      }
      const source = VALID_SOURCES.includes(item.source as ContextSource["source"])
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
    if (j.briefing !== undefined || j.context_in !== undefined) {
      job.briefing = normalizeContextSources(j.briefing ?? j.context_in);
    }
    if (j.exclude_briefing !== undefined || j.exclude_context !== undefined) {
      job.exclude_briefing = normalizeExcludeContext(j.exclude_briefing ?? j.exclude_context);
    }
    if (j.expectations !== undefined || j.required_outputs !== undefined) {
      job.expectations = normalizeExpectations(j.expectations ?? j.required_outputs);
    }
    if (j.performance_policy !== undefined || j.on_failure !== undefined) {
      job.performance_policy = normalizePerformancePolicy(j.performance_policy ?? j.on_failure);
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

    result[jobName] = job;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

function normalizeDispatchConfig(raw: Record<string, unknown>): DispatchConfig {
  const result: DispatchConfig = {};
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
      }
    }

    if (actions.length > 0) {
      result[eventType] = actions;
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

  return result;
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

// --- Agent config registry ---
// Maps agentId → { projectId, config } for runtime lookups by hooks

type AgentConfigEntry = {
  projectId: string;
  config: AgentConfig;
  /** Absolute path to the project directory on disk. */
  projectDir?: string;
};

const agentConfigRegistry = new Map<string, AgentConfigEntry>();

/** Approval policies keyed by projectId. */
const approvalPolicies = new Map<string, ApprovalPolicy>();

/** Extended project config keyed by projectId. */
type ExtendedProjectConfig = {
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
};
const projectExtendedConfig = new Map<string, ExtendedProjectConfig>();

/** Get extended project config. */
export function getExtendedProjectConfig(projectId: string): ExtendedProjectConfig | null {
  return projectExtendedConfig.get(projectId) ?? null;
}

/**
 * Register all agents from a workforce config.
 * Called during project initialization.
 */
export function registerWorkforceConfig(
  projectId: string,
  wfConfig: WorkforceConfig,
  projectDir?: string,
): void {
  for (const [agentId, config] of Object.entries(wfConfig.agents)) {
    agentConfigRegistry.set(agentId, { projectId, config, projectDir });
  }
  if (wfConfig.approval) {
    approvalPolicies.set(projectId, wfConfig.approval);
  }

  // Register manager cron if configured
  const mgrConfig = wfConfig.manager ?? wfConfig.orchestrator;
  if (mgrConfig?.enabled) {
    if (projectDir) {
      mgrConfig.projectDir = projectDir;
    }
    registerManagerProject(projectId, {
      ...mgrConfig,
      directives: (mgrConfig as Record<string, unknown>).directives as string[] ?? [],
    });
    if (mgrConfig.cronSchedule) {
      void registerManagerCron(
        projectId,
        mgrConfig.agentId,
        mgrConfig.cronSchedule,
      );
    }
  }

  // Register custom skill topics
  if (wfConfig.skills && projectDir) {
    try {
      registerCustomSkills(projectId, wfConfig.skills, projectDir);
    } catch (err) {
      safeLog("project.customSkills", err);
    }
  }

  // Register budgets
  if (wfConfig.budgets) {
    try {
      if (wfConfig.budgets.project) {
        setBudget({ projectId, config: wfConfig.budgets.project });
      }
      if (wfConfig.budgets.agents) {
        for (const [agentId, budgetConfig] of Object.entries(wfConfig.budgets.agents)) {
          setBudget({ projectId, agentId, config: budgetConfig });
        }
      }
    } catch (err) {
      safeLog("project.budgetSetup", err);
    }
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

  // Store extra config sections for runtime use
  if (wfConfig.policies || wfConfig.monitoring || wfConfig.riskTiers || wfConfig.dispatch || wfConfig.assignment || wfConfig.toolGates || wfConfig.bulkThresholds || wfConfig.event_handlers || wfConfig.triggers || wfConfig.review || wfConfig.channels || wfConfig.safety || wfConfig.lifecycle || wfConfig.managerBehavior || wfConfig.telemetry || wfConfig.contextOwnership) {
    projectExtendedConfig.set(projectId, {
      policies: wfConfig.policies,
      monitoring: wfConfig.monitoring,
      riskTiers: wfConfig.riskTiers,
      dispatch: wfConfig.dispatch,
      assignment: wfConfig.assignment,
      toolGates: wfConfig.toolGates,
      bulkThresholds: wfConfig.bulkThresholds,
      eventHandlers: wfConfig.event_handlers,
      triggers: wfConfig.triggers,
      review: wfConfig.review,
      channels: wfConfig.channels,
      safety: wfConfig.safety,
      lifecycle: wfConfig.lifecycle,
      managerBehavior: wfConfig.managerBehavior,
      telemetry: wfConfig.telemetry,
      contextOwnership: wfConfig.contextOwnership,
    });
  }
}

/** @deprecated Use registerWorkforceConfig instead. */
export const registerEnforcementConfig = registerWorkforceConfig;

/** Look up agent config by agent ID. */
export function getAgentConfig(agentId: string): AgentConfigEntry | null {
  return agentConfigRegistry.get(agentId) ?? null;
}

/** Get approval policy for a project. */
export function getApprovalPolicy(projectId: string): ApprovalPolicy | null {
  return approvalPolicies.get(projectId) ?? null;
}

/** Get all registered agent IDs. */
export function getRegisteredAgentIds(): string[] {
  return [...agentConfigRegistry.keys()];
}

/** Clear all registrations (for testing). */
export function resetEnforcementConfigForTest(): void {
  agentConfigRegistry.clear();
  approvalPolicies.clear();
  projectExtendedConfig.clear();
}

/**
 * Register a single agent into the config registry at runtime.
 * Used by adaptation flows (e.g. agent hiring) to spin up new agents.
 */
export function registerAgentInProject(
  projectId: string,
  agentId: string,
  config: AgentConfig,
  projectDir?: string,
): void {
  agentConfigRegistry.set(agentId, { projectId, config, projectDir });
}
