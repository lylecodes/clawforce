import { getExtendedProjectConfig } from "../project.js";
import type {
  DomainExecutionConfig,
  DomainExecutionEffect,
  DomainExecutionToolPolicy,
} from "../types.js";

const CLAWFORCE_GOVERNANCE_SAFE_TOOLS = new Set([
  "clawforce_task",
  "clawforce_log",
  "clawforce_workflow",
  "clawforce_context",
  "clawforce_message",
  "clawforce_goal",
  "clawforce_entity",
  "clawforce_channel",
]);

const SENSITIVE_CLAWFORCE_TOOL_ACTIONS: Record<string, Set<string>> = {
  clawforce_config: new Set([
    "create_domain",
    "update_domain",
    "delete_domain",
    "add_agent",
    "remove_agent",
    "update_agent",
    "set_budget",
    "add_policy",
    "remove_policy",
    "update_policy",
    "set_safety",
    "set_profile",
    "set_direction",
    "set_standards",
    "set_policies",
    "set_architecture",
    "set_section",
    "reload",
  ]),
  clawforce_setup: new Set(["activate", "scaffold"]),
  clawforce_ops: new Set([
    "kill_agent",
    "disable_agent",
    "enable_agent",
    "reassign",
    "trigger_sweep",
    "dispatch_worker",
    "emit_event",
    "enqueue_work",
    "process_events",
    "create_job",
    "update_job",
    "delete_job",
    "allocate_budget",
    "init_apply",
    "emergency_stop",
    "emergency_resume",
    "disable_domain",
    "enable_domain",
  ]),
};

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

export function getEffectiveExecutionConfig(projectId: string): Required<Pick<DomainExecutionConfig, "mode">> & DomainExecutionConfig {
  const execution = getExtendedProjectConfig(projectId)?.execution;
  return {
    mode: execution?.mode ?? "live",
    ...execution,
  };
}

export function getDefaultMutationEffect(config?: DomainExecutionConfig): DomainExecutionEffect {
  if (config?.defaultMutationPolicy) {
    return config.defaultMutationPolicy;
  }
  return (config?.mode ?? "live") === "dry_run" ? "simulate" : "allow";
}

function getToolPolicy(
  config: DomainExecutionConfig | undefined,
  toolName: string,
): DomainExecutionToolPolicy | undefined {
  return config?.policies?.tools?.[toolName];
}

export function hasExplicitToolExecutionPolicy(
  config: DomainExecutionConfig | undefined,
  toolName: string,
): boolean {
  return getToolPolicy(config, toolName) !== undefined;
}

function isSensitiveClawforceToolAction(toolName: string, action?: string): boolean {
  const actions = SENSITIVE_CLAWFORCE_TOOL_ACTIONS[toolName];
  if (!actions) return false;
  if (!action) return true;
  return actions.has(action);
}

export function shouldEnforceToolExecutionPolicy(
  config: DomainExecutionConfig | undefined,
  toolName: string,
  action?: string,
): boolean {
  const mode = config?.mode ?? "live";
  if (hasExplicitToolExecutionPolicy(config, toolName)) return true;
  if (mode !== "dry_run") return false;

  if (!toolName.startsWith("clawforce_")) {
    return true;
  }

  if (CLAWFORCE_GOVERNANCE_SAFE_TOOLS.has(toolName)) {
    return false;
  }

  return isSensitiveClawforceToolAction(toolName, action);
}

export function resolveToolExecutionEffect(
  config: DomainExecutionConfig | undefined,
  toolName: string,
  action?: string,
): DomainExecutionEffect {
  const toolPolicy = getToolPolicy(config, toolName);
  if (!toolPolicy) {
    return shouldEnforceToolExecutionPolicy(config, toolName, action)
      ? getDefaultMutationEffect(config)
      : "allow";
  }
  if (action && toolPolicy.actions?.[action]) {
    return toolPolicy.actions[action]!;
  }
  if (toolPolicy.default) {
    return toolPolicy.default;
  }
  return getDefaultMutationEffect(config);
}

export function resolveCommandExecutionEffect(
  config: DomainExecutionConfig | undefined,
  command: string,
): DomainExecutionEffect {
  const matched = config?.policies?.commands?.find((policy) =>
    wildcardToRegex(policy.match).test(command));
  return matched?.effect ?? getDefaultMutationEffect(config);
}
