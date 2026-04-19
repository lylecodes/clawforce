import { validateRuleDefinition } from "../../config/schema.js";
import { getAgentConfig } from "../../project.js";
import { normalizeExecutionConfig } from "../../execution/config.js";
import {
  canonicalizeSafetyConfig,
  normalizeAgentConfigInput,
} from "./config-saves.js";
import { EVENT_ACTION_TYPES } from "../../types.js";

export function validateConfigSection(
  section: string,
  data: unknown,
  projectId?: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (data == null) {
    errors.push(`${section}: data is required`);
    return { errors, warnings };
  }

  switch (section) {
    case "agents": {
      if (!Array.isArray(data) && !isPlainObject(data)) {
        errors.push("agents: must be an array or object of agent configs");
        break;
      }
      const agents = normalizeAgentConfigInput(data);
      for (const [index, agentConfig] of agents.entries()) {
        const agentId = readStringBody(agentConfig, "id");
        if (!agentId) {
          errors.push(`agents[${index}].id: must be a non-empty string`);
          continue;
        }
        if (agentConfig == null || typeof agentConfig !== "object") {
          errors.push(`agents.${agentId}: config must be an object`);
          continue;
        }
        const cfg = agentConfig as Record<string, unknown>;
        if (cfg.persona !== undefined && typeof cfg.persona !== "string") {
          errors.push(`agents.${agentId}.persona: must be a string`);
        }
        if (cfg.title !== undefined && typeof cfg.title !== "string") {
          errors.push(`agents.${agentId}.title: must be a string`);
        }
      }
      break;
    }
    case "budget": {
      if (typeof data !== "object" || Array.isArray(data)) {
        errors.push("budget: must be an object");
        break;
      }
      const budget = data as Record<string, unknown>;
      const windowKeys = ["hourly", "daily", "monthly"];
      for (const wk of windowKeys) {
        if (budget[wk] === undefined) continue;
        if (typeof budget[wk] !== "object" || budget[wk] === null) {
          errors.push(`budget.${wk}: must be an object`);
          continue;
        }
        const win = budget[wk] as Record<string, unknown>;
        for (const dim of ["cents", "tokens", "requests"]) {
          if (win[dim] === undefined) continue;
          if (typeof win[dim] !== "number") {
            errors.push(`budget.${wk}.${dim}: must be a number`);
          } else if ((win[dim] as number) < 0) {
            errors.push(`budget.${wk}.${dim}: must be non-negative`);
          }
        }
      }
      break;
    }
    case "safety": {
      if (!isPlainObject(data)) {
        errors.push("safety: must be an object");
        break;
      }
      const safety = canonicalizeSafetyConfig(data);
      if (safety.maxSpawnDepth !== undefined) {
        if (typeof safety.maxSpawnDepth !== "number") {
          errors.push("safety.maxSpawnDepth: must be a number");
        } else if ((safety.maxSpawnDepth as number) < 1 || (safety.maxSpawnDepth as number) > 100) {
          errors.push("safety.maxSpawnDepth: must be between 1 and 100");
        }
      }
      if (safety.costCircuitBreaker !== undefined) {
        if (typeof safety.costCircuitBreaker !== "number") {
          errors.push("safety.costCircuitBreaker: must be a number");
        } else if ((safety.costCircuitBreaker as number) < 0) {
          errors.push("safety.costCircuitBreaker: must be non-negative");
        }
      }
      break;
    }
    case "defaults": {
      if (!isPlainObject(data)) {
        errors.push("defaults: must be an object");
        break;
      }
      validatePartialAgentConfigShape("defaults", data, errors);
      break;
    }
    case "role_defaults": {
      if (!isPlainObject(data)) {
        errors.push("role_defaults: must be an object");
        break;
      }
      for (const [role, value] of Object.entries(data)) {
        if (!isPlainObject(value)) {
          errors.push(`role_defaults.${role}: must be an object`);
          continue;
        }
        validatePartialAgentConfigShape(`role_defaults.${role}`, value, errors);
      }
      break;
    }
    case "team_templates": {
      if (!isPlainObject(data)) {
        errors.push("team_templates: must be an object");
        break;
      }
      for (const [team, value] of Object.entries(data)) {
        if (!isPlainObject(value)) {
          errors.push(`team_templates.${team}: must be an object`);
          continue;
        }
        validatePartialAgentConfigShape(`team_templates.${team}`, value, errors);
      }
      break;
    }
    case "profile": {
      if (!isPlainObject(data)) {
        errors.push("profile: must be an object");
        break;
      }
      const profile = data as Record<string, unknown>;
      if (profile.operational_profile !== undefined && typeof profile.operational_profile !== "string") {
        errors.push("profile.operational_profile: must be a string");
      }
      break;
    }
    case "execution": {
      try {
        normalizeExecutionConfig(data);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      break;
    }
    case "rules": {
      if (!Array.isArray(data)) {
        errors.push("rules: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        const validation = validateRuleDefinition(value);
        if (!validation.valid) {
          for (const error of validation.errors) {
            errors.push(`rules[${index}].${error.field}: ${error.message}`);
          }
        }
        if (isPlainObject(value) && value.action && isPlainObject(value.action)) {
          const agentId = typeof value.action.agent === "string" ? value.action.agent.trim() : "";
          if (agentId && projectId) {
            const entry = getAgentConfig(agentId);
            if (!entry || entry.projectId !== projectId) {
              warnings.push(`rules[${index}].action.agent: references unknown agent "${agentId}"`);
            }
          }
        }
      }
      break;
    }
    case "initiatives": {
      if (!isPlainObject(data)) {
        errors.push("initiatives: must be an object");
        break;
      }
      for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
        if (!isPlainObject(value)) {
          errors.push(`initiatives.${name}: must be an object`);
          continue;
        }
        const allocation = (value as Record<string, unknown>).allocation_pct;
        if (allocation !== undefined) {
          if (typeof allocation !== "number") {
            errors.push(`initiatives.${name}.allocation_pct: must be a number`);
          } else if (allocation < 0 || allocation > 100) {
            errors.push(`initiatives.${name}.allocation_pct: must be between 0 and 100`);
          }
        }
      }
      break;
    }
    case "workflows": {
      if (!Array.isArray(data)) {
        errors.push("workflows: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        if (typeof value !== "string" || !value.trim()) {
          errors.push(`workflows[${index}]: must be a non-empty string`);
        }
      }
      break;
    }
    case "knowledge": {
      if (!isPlainObject(data)) {
        errors.push("knowledge: must be an object");
      }
      break;
    }
    case "event_handlers": {
      if (!isPlainObject(data)) {
        errors.push("event_handlers: must be an object");
        break;
      }
      validateEventHandlersShape(data, errors, warnings, projectId);
      break;
    }
    case "jobs": {
      if (!Array.isArray(data)) {
        errors.push("jobs: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        if (!isPlainObject(value)) {
          errors.push(`jobs[${index}]: must be an object`);
          continue;
        }
        if (typeof value.id !== "string" || !value.id.trim()) {
          errors.push(`jobs[${index}].id: must be a non-empty string`);
        }
        if (typeof value.agent !== "string" || !value.agent.trim()) {
          errors.push(`jobs[${index}].agent: must be a non-empty string`);
        }
        if (value.cron !== undefined && typeof value.cron !== "string") {
          errors.push(`jobs[${index}].cron: must be a string`);
        }
        if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
          errors.push(`jobs[${index}].enabled: must be a boolean`);
        }
      }
      break;
    }
    case "dashboard_assistant": {
      if (!isPlainObject(data)) {
        errors.push("dashboard_assistant: must be an object");
        break;
      }
      if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
        errors.push("dashboard_assistant.enabled: must be a boolean");
      }
      if (data.model !== undefined && typeof data.model !== "string") {
        errors.push("dashboard_assistant.model: must be a string");
      }
      if (data.agentId !== undefined) {
        if (typeof data.agentId !== "string") {
          errors.push("dashboard_assistant.agentId: must be a string");
        } else if (!data.agentId.trim()) {
          errors.push("dashboard_assistant.agentId: must be a non-empty string");
        } else if (projectId) {
          const entry = getAgentConfig(data.agentId.trim());
          if (!entry || entry.projectId !== projectId) {
            errors.push("dashboard_assistant.agentId: must reference an agent in this domain");
          }
        }
      }
      break;
    }
    default:
      if (typeof data !== "object") {
        warnings.push(`${section}: expected an object`);
      }
      break;
  }

  return { errors, warnings };
}

export function buildConfigPreviewResponse(
  changes: string[],
  valid: boolean,
  errors?: string[],
): Record<string, unknown> {
  if (!valid) {
    return {
      costDelta: changes.length > 0 ? `~${changes.length} field(s) changed` : "Validation failed",
      costDirection: "neutral" as const,
      consequence: errors && errors.length > 0
        ? `Validation errors: ${errors.join("; ")}`
        : "Proposed configuration would fail validation.",
      risk: "HIGH",
      riskExplanation: "The proposed configuration is invalid and would not be applied safely.",
      ...(errors && errors.length > 0 ? { errors } : {}),
    };
  }

  return {
    costDelta: changes.length > 0 ? `~${changes.length} field(s) changed` : "No change",
    costDirection: "neutral" as const,
    consequence: changes.length > 0
      ? `Modified fields: ${changes.join(", ")}. Changes will take effect after save.`
      : "No changes detected between current and proposed configuration.",
    risk: changes.length > 3 ? "MEDIUM" : "LOW",
    riskExplanation: changes.length > 3
      ? "Multiple fields changed — review carefully before applying."
      : "Minor configuration change with low operational risk.",
  };
}

function validatePartialAgentConfigShape(
  prefix: string,
  data: Record<string, unknown>,
  errors: string[],
): void {
  if (data.title !== undefined && typeof data.title !== "string") {
    errors.push(`${prefix}.title: must be a string`);
  }
  if (data.persona !== undefined && typeof data.persona !== "string") {
    errors.push(`${prefix}.persona: must be a string`);
  }
  if (data.reports_to !== undefined && typeof data.reports_to !== "string") {
    errors.push(`${prefix}.reports_to: must be a string`);
  }
  if (data.department !== undefined && typeof data.department !== "string") {
    errors.push(`${prefix}.department: must be a string`);
  }
  if (data.team !== undefined && typeof data.team !== "string") {
    errors.push(`${prefix}.team: must be a string`);
  }
  if (data.channel !== undefined && typeof data.channel !== "string") {
    errors.push(`${prefix}.channel: must be a string`);
  }
  if (data.runtimeRef !== undefined && typeof data.runtimeRef !== "string") {
    errors.push(`${prefix}.runtimeRef: must be a string`);
  }
  if (data.runtime_ref !== undefined && typeof data.runtime_ref !== "string") {
    errors.push(`${prefix}.runtime_ref: must be a string`);
  }
  if (data.runtime !== undefined) {
    if (!isPlainObject(data.runtime)) {
      errors.push(`${prefix}.runtime: must be an object`);
    } else {
      const runtime = data.runtime as Record<string, unknown>;
      if (runtime.bootstrapConfig !== undefined && !isPlainObject(runtime.bootstrapConfig)) {
        errors.push(`${prefix}.runtime.bootstrapConfig: must be an object`);
      }
      if (runtime.bootstrap_config !== undefined && !isPlainObject(runtime.bootstrap_config)) {
        errors.push(`${prefix}.runtime.bootstrap_config: must be an object`);
      }
      if (runtime.bootstrapExcludeFiles !== undefined && !Array.isArray(runtime.bootstrapExcludeFiles)) {
        errors.push(`${prefix}.runtime.bootstrapExcludeFiles: must be an array`);
      }
      if (runtime.bootstrap_exclude_files !== undefined && !Array.isArray(runtime.bootstrap_exclude_files)) {
        errors.push(`${prefix}.runtime.bootstrap_exclude_files: must be an array`);
      }
      if (runtime.allowedTools !== undefined && !Array.isArray(runtime.allowedTools)) {
        errors.push(`${prefix}.runtime.allowedTools: must be an array`);
      }
      if (runtime.allowed_tools !== undefined && !Array.isArray(runtime.allowed_tools)) {
        errors.push(`${prefix}.runtime.allowed_tools: must be an array`);
      }
      if (runtime.workspacePaths !== undefined && !Array.isArray(runtime.workspacePaths)) {
        errors.push(`${prefix}.runtime.workspacePaths: must be an array`);
      }
      if (runtime.workspace_paths !== undefined && !Array.isArray(runtime.workspace_paths)) {
        errors.push(`${prefix}.runtime.workspace_paths: must be an array`);
      }
    }
  }
  if (data.briefing !== undefined && !Array.isArray(data.briefing)) {
    errors.push(`${prefix}.briefing: must be an array`);
  }
  if (data.expectations !== undefined && !Array.isArray(data.expectations)) {
    errors.push(`${prefix}.expectations: must be an array`);
  }
  if (data.performance_policy !== undefined && !isPlainObject(data.performance_policy)) {
    errors.push(`${prefix}.performance_policy: must be an object`);
  }
}

function validateEventHandlersShape(
  data: Record<string, unknown>,
  errors: string[],
  warnings: string[],
  projectId?: string,
): void {
  for (const [eventType, rawConfig] of Object.entries(data)) {
    if (!eventType.trim()) {
      errors.push("event_handlers: contains empty event type key");
      continue;
    }

    const handlerConfig = Array.isArray(rawConfig)
      ? { actions: rawConfig, override_builtin: false }
      : isPlainObject(rawConfig)
        ? rawConfig
        : null;

    if (!handlerConfig) {
      errors.push(`event_handlers.${eventType}: must be an array or object`);
      continue;
    }

    const actions = Array.isArray(handlerConfig.actions)
      ? handlerConfig.actions
      : Array.isArray(rawConfig)
        ? rawConfig
        : null;

    if (!actions) {
      errors.push(`event_handlers.${eventType}.actions: must be an array`);
      continue;
    }

    if (
      isPlainObject(handlerConfig) &&
      handlerConfig.override_builtin !== undefined &&
      typeof handlerConfig.override_builtin !== "boolean"
    ) {
      errors.push(`event_handlers.${eventType}.override_builtin: must be a boolean`);
    }

    for (const [index, action] of actions.entries()) {
      validateEventHandlerAction(
        eventType,
        index,
        action,
        errors,
        warnings,
        projectId,
      );
    }
  }
}

function validateEventHandlerAction(
  eventType: string,
  index: number,
  action: unknown,
  errors: string[],
  warnings: string[],
  projectId?: string,
): void {
  const prefix = `event_handlers.${eventType}[${index}]`;
  if (!isPlainObject(action)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  const actionType = typeof action.action === "string" ? action.action : "";
  if (!actionType) {
    errors.push(`${prefix}.action: must be a non-empty string`);
    return;
  }
  if (!EVENT_ACTION_TYPES.includes(actionType as typeof EVENT_ACTION_TYPES[number])) {
    errors.push(`${prefix}.action: unknown action "${actionType}"`);
    return;
  }

  switch (actionType) {
    case "create_task": {
      if (typeof action.template !== "string" || !action.template.trim()) {
        errors.push(`${prefix}.template: must be a non-empty string`);
      }
      if (action.description !== undefined && typeof action.description !== "string") {
        errors.push(`${prefix}.description: must be a string`);
      }
      if (action.priority !== undefined && typeof action.priority !== "string") {
        errors.push(`${prefix}.priority: must be a string`);
      }
      if (action.assign_to !== undefined) {
        if (typeof action.assign_to !== "string") {
          errors.push(`${prefix}.assign_to: must be a string`);
        } else if (action.assign_to !== "auto" && projectId) {
          const entry = getAgentConfig(action.assign_to.trim());
          if (!entry || entry.projectId !== projectId) {
            warnings.push(`${prefix}.assign_to: references unknown agent "${action.assign_to}"`);
          }
        }
      }
      if (action.department !== undefined && typeof action.department !== "string") {
        errors.push(`${prefix}.department: must be a string`);
      }
      if (action.team !== undefined && typeof action.team !== "string") {
        errors.push(`${prefix}.team: must be a string`);
      }
      break;
    }
    case "notify": {
      if (typeof action.message !== "string" || !action.message.trim()) {
        errors.push(`${prefix}.message: must be a non-empty string`);
      }
      if (action.to !== undefined) {
        if (typeof action.to !== "string") {
          errors.push(`${prefix}.to: must be a string`);
        } else if (projectId) {
          const entry = getAgentConfig(action.to.trim());
          if (!entry || entry.projectId !== projectId) {
            warnings.push(`${prefix}.to: references unknown agent "${action.to}"`);
          }
        }
      }
      if (action.priority !== undefined && typeof action.priority !== "string") {
        errors.push(`${prefix}.priority: must be a string`);
      }
      break;
    }
    case "escalate": {
      if (typeof action.to !== "string" || !action.to.trim()) {
        errors.push(`${prefix}.to: must be a non-empty string`);
      } else if (action.to !== "manager" && projectId) {
        const entry = getAgentConfig(action.to.trim());
        if (!entry || entry.projectId !== projectId) {
          warnings.push(`${prefix}.to: references unknown agent "${action.to}"`);
        }
      }
      if (action.message !== undefined && typeof action.message !== "string") {
        errors.push(`${prefix}.message: must be a string`);
      }
      break;
    }
    case "enqueue_work": {
      if (action.task_id !== undefined && typeof action.task_id !== "string") {
        errors.push(`${prefix}.task_id: must be a string`);
      }
      if (action.priority !== undefined && typeof action.priority !== "number") {
        errors.push(`${prefix}.priority: must be a number`);
      }
      break;
    }
    case "emit_event": {
      if (typeof action.event_type !== "string" || !action.event_type.trim()) {
        errors.push(`${prefix}.event_type: must be a non-empty string`);
      }
      if (action.event_payload !== undefined) {
        if (!isPlainObject(action.event_payload)) {
          errors.push(`${prefix}.event_payload: must be an object`);
        } else {
          for (const [key, value] of Object.entries(action.event_payload)) {
            if (typeof value !== "string") {
              errors.push(`${prefix}.event_payload.${key}: must be a string`);
            }
          }
        }
      }
      if (action.dedup_key !== undefined && typeof action.dedup_key !== "string") {
        errors.push(`${prefix}.dedup_key: must be a string`);
      }
      break;
    }
    case "dispatch_agent": {
      if (typeof action.agent_role !== "string" || !action.agent_role.trim()) {
        errors.push(`${prefix}.agent_role: must be a non-empty string`);
      }
      if (action.model !== undefined && typeof action.model !== "string") {
        errors.push(`${prefix}.model: must be a string`);
      }
      if (action.session_type !== undefined) {
        if (
          typeof action.session_type !== "string" ||
          !["reactive", "active", "planning"].includes(action.session_type)
        ) {
          errors.push(`${prefix}.session_type: must be one of reactive, active, planning`);
        }
      }
      if (action.payload !== undefined && !isPlainObject(action.payload)) {
        errors.push(`${prefix}.payload: must be an object`);
      }
      break;
    }
  }
}

function readStringBody(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
