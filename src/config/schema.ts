/**
 * Clawforce — Domain config schema types and validators
 *
 * Defines the shape of global and domain-level configuration,
 * plus runtime validators that return structured error lists.
 */

import type { OperationalProfile, RuleDefinition, MemoryRecallConfig, MemoryPersistConfig, MemoryProviderConfig } from "../types.js";

// --- Types ---

export type GlobalAgentDef = {
  extends?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  /** Named mixins to compose into this agent's config. Applied left-to-right after preset resolution. */
  mixins?: string[];
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

/** A named mixin: a reusable partial agent config applied via `mixins: [name]`. */
export type MixinDef = {
  /** Other mixins this mixin itself includes (allows composition). */
  mixins?: string[];
  [key: string]: unknown;
};

export type GlobalConfig = {
  defaults?: GlobalDefaults;
  agents: Record<string, GlobalAgentDef>;
  /** Reusable behavior bundles that agents can compose via `mixins: [name]`. */
  mixins?: Record<string, MixinDef>;
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
    /** Domain-wide memory defaults inherited by all agents. */
    memory?: {
      recall?: MemoryRecallConfig;
      persist?: MemoryPersistConfig;
      provider?: MemoryProviderConfig;
    };
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

  // Validate mixins field
  if (config.mixins !== undefined && !isObject(config.mixins)) {
    errors.push({
      field: "mixins",
      message: "mixins must be a non-array object",
    });
  }

  // Validate memory config on agents
  if (isObject(config.agents)) {
    for (const [agentId, agentDef] of Object.entries(config.agents as Record<string, unknown>)) {
      if (!isObject(agentDef)) continue;
      const memory = agentDef.memory;
      if (memory !== undefined && isObject(memory)) {
        const memErrors = validateMemorySection(memory, `agents.${agentId}.memory`);
        errors.push(...memErrors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateMemorySection(memory: Record<string, unknown>, pathPrefix: string): ValidationResult["errors"] {
  const errors: ValidationResult["errors"] = [];

  // Validate recall
  if (memory.recall !== undefined) {
    if (!isObject(memory.recall)) {
      errors.push({ field: `${pathPrefix}.recall`, message: "recall must be an object" });
    } else {
      const recall = memory.recall;
      if (recall.enabled !== undefined && typeof recall.enabled !== "boolean") {
        errors.push({ field: `${pathPrefix}.recall.enabled`, message: "recall.enabled must be a boolean" });
      }
      if (recall.intensity !== undefined) {
        const validIntensities = ["low", "medium", "high"];
        if (typeof recall.intensity !== "string" || !validIntensities.includes(recall.intensity)) {
          errors.push({ field: `${pathPrefix}.recall.intensity`, message: `recall.intensity must be one of: ${validIntensities.join(", ")}` });
        }
      }
      if (recall.cooldownMs !== undefined && typeof recall.cooldownMs !== "number") {
        errors.push({ field: `${pathPrefix}.recall.cooldownMs`, message: "recall.cooldownMs must be a number" });
      }
      if (recall.maxSearches !== undefined && typeof recall.maxSearches !== "number") {
        errors.push({ field: `${pathPrefix}.recall.maxSearches`, message: "recall.maxSearches must be a number" });
      }
      if (recall.maxInjectedChars !== undefined && typeof recall.maxInjectedChars !== "number") {
        errors.push({ field: `${pathPrefix}.recall.maxInjectedChars`, message: "recall.maxInjectedChars must be a number" });
      }
    }
  }

  // Validate persist
  if (memory.persist !== undefined) {
    if (!isObject(memory.persist)) {
      errors.push({ field: `${pathPrefix}.persist`, message: "persist must be an object" });
    } else {
      const persist = memory.persist;
      if (persist.enabled !== undefined && typeof persist.enabled !== "boolean") {
        errors.push({ field: `${pathPrefix}.persist.enabled`, message: "persist.enabled must be a boolean" });
      }
      if (persist.autoExtract !== undefined && typeof persist.autoExtract !== "boolean") {
        errors.push({ field: `${pathPrefix}.persist.autoExtract`, message: "persist.autoExtract must be a boolean" });
      }
      if (persist.extractPrompt !== undefined && typeof persist.extractPrompt !== "string") {
        errors.push({ field: `${pathPrefix}.persist.extractPrompt`, message: "persist.extractPrompt must be a string" });
      }
      if (persist.rules !== undefined) {
        if (!Array.isArray(persist.rules)) {
          errors.push({ field: `${pathPrefix}.persist.rules`, message: "persist.rules must be an array" });
        } else {
          const validTriggers = ["session_end", "task_completed", "task_failed", "periodic"];
          const validActions = ["extract_learnings", "save_decisions", "save_errors", "custom"];
          for (let i = 0; i < persist.rules.length; i++) {
            const rule = persist.rules[i] as Record<string, unknown>;
            if (!isObject(rule)) {
              errors.push({ field: `${pathPrefix}.persist.rules[${i}]`, message: "each rule must be an object" });
              continue;
            }
            if (!validTriggers.includes(rule.trigger as string)) {
              errors.push({ field: `${pathPrefix}.persist.rules[${i}].trigger`, message: `trigger must be one of: ${validTriggers.join(", ")}` });
            }
            if (!validActions.includes(rule.action as string)) {
              errors.push({ field: `${pathPrefix}.persist.rules[${i}].action`, message: `action must be one of: ${validActions.join(", ")}` });
            }
            if (rule.action === "custom" && typeof rule.prompt !== "string") {
              errors.push({ field: `${pathPrefix}.persist.rules[${i}].prompt`, message: "custom action requires a prompt string" });
            }
          }
        }
      }
    }
  }

  // Validate provider
  if (memory.provider !== undefined) {
    if (!isObject(memory.provider)) {
      errors.push({ field: `${pathPrefix}.provider`, message: "provider must be an object" });
    } else {
      const provider = memory.provider;
      const validTypes = ["builtin", "mcp"];
      if (typeof provider.type !== "string" || !validTypes.includes(provider.type)) {
        errors.push({ field: `${pathPrefix}.provider.type`, message: `provider.type must be one of: ${validTypes.join(", ")}` });
      }
      if (provider.type === "mcp") {
        if (!isObject(provider.mcp)) {
          errors.push({ field: `${pathPrefix}.provider.mcp`, message: "provider.mcp is required when type is 'mcp'" });
        } else {
          if (typeof provider.mcp.server !== "string" || (provider.mcp.server as string).length === 0) {
            errors.push({ field: `${pathPrefix}.provider.mcp.server`, message: "provider.mcp.server must be a non-empty string" });
          }
          if (provider.mcp.args !== undefined && !Array.isArray(provider.mcp.args)) {
            errors.push({ field: `${pathPrefix}.provider.mcp.args`, message: "provider.mcp.args must be an array" });
          }
          if (provider.mcp.tools !== undefined && !Array.isArray(provider.mcp.tools)) {
            errors.push({ field: `${pathPrefix}.provider.mcp.tools`, message: "provider.mcp.tools must be an array" });
          }
        }
      }
    }
  }

  return errors;
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
