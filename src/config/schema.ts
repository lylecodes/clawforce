/**
 * Clawforce — Domain config schema types and validators
 *
 * Defines the shape of global and domain-level configuration,
 * plus runtime validators that return structured error lists.
 */

import type { OperationalProfile, RuleDefinition } from "../types.js";

// --- Types ---

export type GlobalAgentDef = {
  extends?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  [key: string]: unknown;
};

export type GlobalDefaults = {
  performance_policy?: {
    action: "retry" | "alert" | "terminate_and_alert";
    max_retries?: number;
    then?: string;
  };
};

/** Supported adapter backends for ClawForce dispatch. */
export type AdapterType = "openclaw" | "claude-code";

export type GlobalConfig = {
  defaults?: GlobalDefaults;
  agents: Record<string, GlobalAgentDef>;
  /** Adapter backend to use for dispatch (default: "openclaw"). */
  adapter?: AdapterType;
  /** Claude Code adapter configuration (used when adapter is "claude-code"). */
  claude_code?: Record<string, unknown>;
  /**
   * Team-level config templates. Agents with a matching `team` field
   * inherit these defaults. Merge order: org defaults -> team template -> preset -> agent override.
   */
  team_templates?: Record<string, Partial<GlobalAgentDef>>;
};

export type DomainConfig = {
  domain: string;
  /** Set to false to prevent this domain from loading on gateway start. */
  enabled?: boolean;
  /** Path to DIRECTION.md file (relative to domain config or project root). */
  direction?: string;
  /** Template preset name (e.g. "startup"). */
  template?: string;
  orchestrator?: string;
  paths?: string[];
  agents: string[];
  policies?: unknown[];
  budget?: Record<string, unknown>;
  workflows?: string[];
  rules?: RuleDefinition[];
  manager?: Record<string, unknown>;
  context_sources?: unknown[];
  expectations?: unknown[];
  jobs?: Record<string, unknown>;
  knowledge?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  channels?: unknown[];
  event_handlers?: Record<string, unknown>;
  triggers?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  dashboard_assistant?: {
    enabled?: boolean;
    model?: string;
    agentId?: string;
  };
  operational_profile?: OperationalProfile;
  /** Domain-wide defaults inherited by ALL agents in this domain. */
  defaults?: {
    briefing?: unknown[];
    expectations?: unknown[];
    performance_policy?: Record<string, unknown>;
  };
  /**
   * Role-level defaults applied to agents based on their `extends` field.
   * Merge order: org defaults -> role defaults -> team template -> agent override.
   */
  role_defaults?: Record<string, Partial<GlobalAgentDef>>;
  /**
   * Team-level config templates (domain-scoped, overrides global team_templates).
   * Agents with a matching `team` field inherit these defaults.
   */
  team_templates?: Record<string, Partial<GlobalAgentDef>>;
  [key: string]: unknown;
};

export type ValidationResult = {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
};

// --- Validators ---

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateGlobalConfig(config: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];

  if (!isObject(config)) {
    errors.push({ field: "config", message: "config must be an object" });
    return { valid: false, errors };
  }

  if (!isObject(config.agents)) {
    errors.push({
      field: "agents",
      message: "agents must be a non-array object",
    });
  }

  // Validate adapter field
  if (config.adapter !== undefined) {
    const validAdapters: AdapterType[] = ["openclaw", "claude-code"];
    if (typeof config.adapter !== "string" || !validAdapters.includes(config.adapter as AdapterType)) {
      errors.push({
        field: "adapter",
        message: `adapter must be one of: ${validAdapters.join(", ")}`,
      });
    }
  }

  // Validate claude_code config shape (detailed validation delegated to adapter)
  if (config.claude_code !== undefined && !isObject(config.claude_code)) {
    errors.push({
      field: "claude_code",
      message: "claude_code must be an object",
    });
  }

  // Validate team_templates shape
  if (config.team_templates !== undefined) {
    if (!isObject(config.team_templates)) {
      errors.push({
        field: "team_templates",
        message: "team_templates must be a non-array object",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateDomainConfig(config: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];

  if (!isObject(config)) {
    errors.push({ field: "config", message: "config must be an object" });
    return { valid: false, errors };
  }

  if (typeof config.domain !== "string" || config.domain.length === 0) {
    errors.push({
      field: "domain",
      message: "domain must be a non-empty string",
    });
  }

  if (!Array.isArray(config.agents)) {
    errors.push({ field: "agents", message: "agents must be an array" });
  }

  return { valid: errors.length === 0, errors };
}

export function validateRuleDefinition(rule: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];

  if (!isObject(rule)) {
    errors.push({ field: "rule", message: "rule must be an object" });
    return { valid: false, errors };
  }

  if (typeof rule.name !== "string" || rule.name.length === 0) {
    errors.push({ field: "name", message: "name must be a non-empty string" });
  }

  if (!isObject(rule.trigger)) {
    errors.push({ field: "trigger", message: "trigger must be an object" });
  }

  if (!isObject(rule.action)) {
    errors.push({ field: "action", message: "action must be an object" });
  } else {
    if (typeof rule.action.agent !== "string") {
      errors.push({
        field: "action.agent",
        message: "action.agent must be a string",
      });
    }
    if (typeof rule.action.prompt_template !== "string") {
      errors.push({
        field: "action.prompt_template",
        message: "action.prompt_template must be a string",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
