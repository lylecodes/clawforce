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
import { applyProfile, BUILTIN_PROFILES } from "./profiles.js";
import type {
  AgentConfig,
  AgentRole,
  AlertRuleDefinition,
  AnomalyConfig,
  ApprovalPolicy,
  BudgetConfig,
  CompactionConfig,
  ContextSource,
  Expectation,
  PerformancePolicy,
  PolicyDefinition,
  RiskTierConfig,
  SloDefinition,
  WorkforceConfig,
} from "./types.js";

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
 */
export function loadProject(configPath: string): ProjectConfig {
  const content = fs.readFileSync(configPath, "utf-8");
  return parseProjectYaml(content);
}

/**
 * Load the workforce config (agent configs + approval policy) from a project.yaml.
 * Returns null if the file has no `agents` section with workforce configs.
 */
export function loadWorkforceConfig(configPath: string): WorkforceConfig | null {
  const content = fs.readFileSync(configPath, "utf-8");
  const raw = YAML.parse(content) as Record<string, unknown> | null;
  if (!raw) return null;

  const rawAgents = raw.agents as Record<string, unknown> | undefined;
  if (!rawAgents) return null;

  // Check if agents section has workforce-style configs (role + expectations)
  // vs the legacy format (project + workers)
  const hasWorkforceAgents = Object.values(rawAgents).some(
    (v) => typeof v === "object" && v !== null && "role" in (v as Record<string, unknown>),
  );
  if (!hasWorkforceAgents) return null;

  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, rawAgent] of Object.entries(rawAgents)) {
    if (typeof rawAgent !== "object" || rawAgent === null) continue;
    const a = rawAgent as Record<string, unknown>;
    if (!a.role) continue;

    agents[agentId] = normalizeAgentConfig(a);
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

  return result;
}

/** @deprecated Use loadWorkforceConfig instead. */
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

/** Role aliases for migration: old names map to new names. */
const ROLE_ALIASES: Record<string, AgentRole> = {
  orchestrator: "manager",
  worker: "employee",
  cron: "scheduled",
};

const VALID_ROLES: AgentRole[] = ["manager", "employee", "scheduled"];
const VALID_SOURCES: ContextSource["source"][] = [
  "instructions", "custom", "project_md", "task_board",
  "assigned_task", "knowledge", "file", "skill", "memory",
  "escalations", "workflows", "activity", "sweep_status",
  "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
  "team_status", "team_performance",
];

function normalizeAgentConfig(raw: Record<string, unknown>): AgentConfig {
  // Support old role names as aliases
  let rawRole = raw.role as string;
  if (rawRole in ROLE_ALIASES) {
    rawRole = ROLE_ALIASES[rawRole]!;
  }
  const role = VALID_ROLES.includes(rawRole as AgentRole)
    ? (rawRole as AgentRole)
    : "employee";

  // Accept both old and new field names for migration
  const briefing = normalizeContextSources(raw.briefing ?? raw.context_in);
  const excludeBriefing = normalizeExcludeContext(raw.exclude_briefing ?? raw.exclude_context);
  const expectations = normalizeExpectations(raw.expectations ?? raw.required_outputs);
  const performancePolicy = normalizePerformancePolicy(raw.performance_policy ?? raw.on_failure);

  // Determine whether the user explicitly provided these fields
  const hasExplicitExpectations = Array.isArray(raw.expectations ?? raw.required_outputs);
  const hasExplicitPolicy = typeof (raw.performance_policy ?? raw.on_failure) === "object" && (raw.performance_policy ?? raw.on_failure) !== null;

  // Apply role profile defaults, merging with agent-level overrides
  const merged = applyProfile(role, {
    briefing,
    exclude_briefing: excludeBriefing,
    expectations: hasExplicitExpectations ? expectations : null,
    performance_policy: hasExplicitPolicy ? performancePolicy : null,
  });

  // Always inject instructions source if not already present
  if (!merged.briefing.some((s) => s.source === "instructions")) {
    merged.briefing.unshift({ source: "instructions" });
  }

  // Normalize compaction config
  const hasExplicitCompaction = raw.compaction !== undefined;
  const compaction = hasExplicitCompaction
    ? normalizeCompactionConfig(raw.compaction)
    : BUILTIN_PROFILES[role].compaction;

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

  const reportsTo = typeof raw.reports_to === "string" && raw.reports_to.trim()
    ? raw.reports_to.trim()
    : undefined;

  // Parse new employee profile fields
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : undefined;
  const persona = typeof raw.persona === "string" && raw.persona.trim() ? raw.persona.trim() : undefined;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === "string") : undefined;
  const channel = typeof raw.channel === "string" && raw.channel.trim() ? raw.channel.trim() : undefined;
  const department = typeof raw.department === "string" && raw.department.trim() ? raw.department.trim() : undefined;
  const team = typeof raw.team === "string" && raw.team.trim() ? raw.team.trim() : undefined;
  const permissions = normalizePermissions(raw.permissions);

  return {
    role,
    title,
    model,
    provider,
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
    compaction: compaction === false ? undefined : compaction,
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
      const source = VALID_SOURCES.includes(item.source as ContextSource["source"])
        ? (item.source as ContextSource["source"])
        : "custom";

      const result: ContextSource = { source };
      if (typeof item.content === "string") result.content = item.content;
      if (typeof item.path === "string") result.path = item.path;
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

function normalizeApprovalPolicy(raw: unknown): ApprovalPolicy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.policy !== "string") return null;
  return { policy: r.policy };
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
  if (wfConfig.policies || wfConfig.monitoring || wfConfig.riskTiers) {
    projectExtendedConfig.set(projectId, {
      policies: wfConfig.policies,
      monitoring: wfConfig.monitoring,
      riskTiers: wfConfig.riskTiers,
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
