/**
 * Clawforce — Domain config schema types and validators
 *
 * Defines the shape of global and domain-level configuration,
 * plus runtime validators that return structured error lists.
 */

import type { RuleDefinition } from "../types.js";

// --- Types ---

export type GlobalAgentDef = {
  extends: string;
  model?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  [key: string]: unknown;
};

export type GlobalDefaults = {
  model?: string;
  performance_policy?: {
    action: "retry" | "alert" | "terminate_and_alert";
    max_retries?: number;
    then?: string;
  };
};

export type GlobalConfig = {
  defaults?: GlobalDefaults;
  agents: Record<string, GlobalAgentDef>;
};

export type DomainConfig = {
  domain: string;
  orchestrator?: string;
  paths?: string[];
  agents: string[];
  policies?: Record<string, unknown>;
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
  event_handlers?: unknown[];
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
