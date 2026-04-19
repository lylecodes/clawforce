import type {
  DomainExecutionCommandPolicy,
  DomainExecutionConfig,
  DomainExecutionEffect,
  DomainExecutionToolPolicy,
  WorkforceConfig,
} from "../types.js";
import {
  DOMAIN_EXECUTION_EFFECTS,
  DOMAIN_EXECUTION_MODES,
} from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutionMode(value: unknown): value is DomainExecutionConfig["mode"] {
  return typeof value === "string"
    && (DOMAIN_EXECUTION_MODES as readonly string[]).includes(value);
}

function isExecutionEffect(value: unknown): value is DomainExecutionEffect {
  return typeof value === "string"
    && (DOMAIN_EXECUTION_EFFECTS as readonly string[]).includes(value);
}

function normalizeToolPolicy(
  raw: unknown,
  path: string,
): DomainExecutionToolPolicy {
  if (isExecutionEffect(raw)) {
    return { default: raw };
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object or execution effect`);
  }

  const actions: Record<string, DomainExecutionEffect> = {};
  const actionSource = isRecord(raw.actions) ? raw.actions : undefined;
  const sourceEntries = actionSource
    ? Object.entries(actionSource)
    : Object.entries(raw).filter(([key]) => key !== "default" && key !== "actions");

  for (const [action, effectRaw] of sourceEntries) {
    if (!isExecutionEffect(effectRaw)) {
      throw new Error(`${path}.${action} must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
    }
    actions[action] = effectRaw;
  }

  const result: DomainExecutionToolPolicy = {};
  if (raw.default !== undefined) {
    if (!isExecutionEffect(raw.default)) {
      throw new Error(`${path}.default must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
    }
    result.default = raw.default;
  }
  if (Object.keys(actions).length > 0) {
    result.actions = actions;
  }
  if (!result.default && !result.actions) {
    throw new Error(`${path} must define at least one action or default effect`);
  }
  return result;
}

function normalizeCommandPolicy(
  raw: unknown,
  path: string,
): DomainExecutionCommandPolicy {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object`);
  }
  if (typeof raw.match !== "string" || raw.match.trim().length === 0) {
    throw new Error(`${path}.match must be a non-empty string`);
  }
  if (!isExecutionEffect(raw.effect)) {
    throw new Error(`${path}.effect must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
  }
  return {
    match: raw.match.trim(),
    effect: raw.effect,
    ...(typeof raw.reason === "string" && raw.reason.trim()
      ? { reason: raw.reason.trim() }
      : {}),
  };
}

export function normalizeExecutionConfig(raw: unknown): DomainExecutionConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new Error("execution must be an object");
  }

  const result: DomainExecutionConfig = {
    mode: "live",
  };

  if (raw.mode !== undefined) {
    if (!isExecutionMode(raw.mode)) {
      throw new Error(`execution.mode must be one of: ${DOMAIN_EXECUTION_MODES.join(", ")}`);
    }
    result.mode = raw.mode;
  }

  const defaultMutationPolicyRaw = raw.default_mutation_policy ?? raw.defaultMutationPolicy;
  if (defaultMutationPolicyRaw !== undefined) {
    if (!isExecutionEffect(defaultMutationPolicyRaw)) {
      throw new Error(`execution.default_mutation_policy must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
    }
    result.defaultMutationPolicy = defaultMutationPolicyRaw;
  }

  if (raw.environments !== undefined) {
    if (!isRecord(raw.environments)) {
      throw new Error("execution.environments must be an object");
    }
    const environments: NonNullable<DomainExecutionConfig["environments"]> = {};
    const primary = raw.environments.primary;
    const verification = raw.environments.verification;
    if (primary !== undefined) {
      if (typeof primary !== "string" || primary.trim().length === 0) {
        throw new Error("execution.environments.primary must be a non-empty string");
      }
      environments.primary = primary.trim();
    }
    if (verification !== undefined) {
      if (typeof verification !== "string" || verification.trim().length === 0) {
        throw new Error("execution.environments.verification must be a non-empty string");
      }
      environments.verification = verification.trim();
    }
    if (Object.keys(environments).length > 0) {
      result.environments = environments;
    }
  }

  if (raw.policies !== undefined) {
    if (!isRecord(raw.policies)) {
      throw new Error("execution.policies must be an object");
    }
    const policies: NonNullable<DomainExecutionConfig["policies"]> = {};

    if (raw.policies.tools !== undefined) {
      if (!isRecord(raw.policies.tools)) {
        throw new Error("execution.policies.tools must be an object");
      }
      const tools: Record<string, DomainExecutionToolPolicy> = {};
      for (const [toolName, toolPolicy] of Object.entries(raw.policies.tools)) {
        tools[toolName] = normalizeToolPolicy(toolPolicy, `execution.policies.tools.${toolName}`);
      }
      if (Object.keys(tools).length > 0) {
        policies.tools = tools;
      }
    }

    if (raw.policies.commands !== undefined) {
      if (!Array.isArray(raw.policies.commands)) {
        throw new Error("execution.policies.commands must be an array");
      }
      policies.commands = raw.policies.commands.map((entry, index) =>
        normalizeCommandPolicy(entry, `execution.policies.commands[${index}]`));
    }

    if (policies.tools || policies.commands) {
      result.policies = policies;
    }
  }

  return result;
}

export function validateNormalizedExecutionConfig(
  config: WorkforceConfig["execution"],
): string[] {
  if (!config) return [];
  const errors: string[] = [];

  if (config.mode && !(DOMAIN_EXECUTION_MODES as readonly string[]).includes(config.mode)) {
    errors.push(`execution.mode must be one of: ${DOMAIN_EXECUTION_MODES.join(", ")}`);
  }
  if (config.defaultMutationPolicy && !(DOMAIN_EXECUTION_EFFECTS as readonly string[]).includes(config.defaultMutationPolicy)) {
    errors.push(`execution.defaultMutationPolicy must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
  }

  if (config.policies?.tools) {
    for (const [toolName, policy] of Object.entries(config.policies.tools)) {
      if (policy.default && !(DOMAIN_EXECUTION_EFFECTS as readonly string[]).includes(policy.default)) {
        errors.push(`execution.policies.tools.${toolName}.default must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
      }
      for (const [actionName, effect] of Object.entries(policy.actions ?? {})) {
        if (!(DOMAIN_EXECUTION_EFFECTS as readonly string[]).includes(effect)) {
          errors.push(`execution.policies.tools.${toolName}.actions.${actionName} must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
        }
      }
    }
  }

  for (const [index, command] of (config.policies?.commands ?? []).entries()) {
    if (!command.match || command.match.trim().length === 0) {
      errors.push(`execution.policies.commands[${index}].match must be a non-empty string`);
    }
    if (!(DOMAIN_EXECUTION_EFFECTS as readonly string[]).includes(command.effect)) {
      errors.push(`execution.policies.commands[${index}].effect must be one of: ${DOMAIN_EXECUTION_EFFECTS.join(", ")}`);
    }
  }

  return errors;
}
