/**
 * Clawforce — Config validator
 *
 * Validates workforce configs at gateway start.
 * Returns warnings (non-fatal) so the plugin can still load with partial configs.
 */

import { CRITICAL_SOURCES } from "./profiles.js";
import { validatePolicyConfigs } from "./policy/normalizer.js";
import type { AgentConfig, CompactionConfig, ContextSource, WorkforceConfig } from "./types.js";

export type ConfigWarning = {
  level: "warn" | "error";
  agentId?: string;
  message: string;
};

/**
 * Validate a workforce project config.
 * Returns a list of warnings/errors. Empty list = valid.
 */
export function validateWorkforceConfig(config: WorkforceConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  if (!config.name || config.name === "unnamed") {
    warnings.push({ level: "warn", message: "Project has no name configured." });
  }

  if (Object.keys(config.agents).length === 0) {
    warnings.push({ level: "error", message: "No agents configured." });
    return warnings;
  }

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    warnings.push(...validateAgentConfig(agentId, agentConfig));
  }

  // Check reports_to targets exist in the project
  const agentIds = new Set(Object.keys(config.agents));
  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.reports_to && agentConfig.reports_to !== "parent" && !agentIds.has(agentConfig.reports_to)) {
      warnings.push({
        level: "error",
        agentId,
        message: `reports_to target "${agentConfig.reports_to}" is not defined in this project's agents.`,
      });
    }
  }

  // Detect escalation cycles and overly deep chains
  const agentEntries = Object.entries(config.agents);
  for (const [agentId, agentConfig] of agentEntries) {
    if (!agentConfig.reports_to || agentConfig.reports_to === "parent") continue;

    const visited = new Set<string>([agentId]);
    let current = agentConfig.reports_to;
    let depth = 0;

    while (current && current !== "parent") {
      depth++;
      if (visited.has(current)) {
        warnings.push({
          level: "error",
          agentId,
          message: `Escalation cycle detected: chain from "${agentId}" loops back to "${current}".`,
        });
        break;
      }
      visited.add(current);

      const nextConfig = config.agents[current];
      if (!nextConfig) break;
      current = nextConfig.reports_to ?? "parent";
    }

    if (depth > 5) {
      warnings.push({
        level: "warn",
        agentId,
        message: `Escalation chain is ${depth} levels deep — consider flattening the hierarchy.`,
      });
    }
  }

  // Validate policy configs if present
  if (config.policies && config.policies.length > 0) {
    const validTools = ["clawforce_task", "clawforce_log", "clawforce_verify", "clawforce_workflow", "clawforce_setup", "clawforce_compact", "clawforce_ops", "clawforce_memory"];
    const policyErrors = validatePolicyConfigs(config.policies, validTools);
    for (const err of policyErrors) {
      warnings.push({
        level: "warn",
        message: `Policy "${err.name}": ${err.message}`,
      });
    }
  }

  // Check manager has propose requirement if approval policy exists
  if (config.approval?.policy) {
    const managers = Object.entries(config.agents).filter(
      ([, c]) => c.role === "manager",
    );
    for (const [agentId, mgrConfig] of managers) {
      const hasPropose = mgrConfig.expectations.some(
        (r) => r.tool === "clawforce_task" &&
          (Array.isArray(r.action)
            ? r.action.includes("propose") || r.action.includes("get_approval_context")
            : r.action === "propose" || r.action === "get_approval_context"),
      );
      if (!hasPropose) {
        warnings.push({
          level: "warn",
          agentId,
          message: "Manager has approval policy but no expectation for clawforce_task get_approval_context.",
        });
      }
    }
  }

  return warnings;
}

/** @deprecated Use validateWorkforceConfig instead. */
export const validateEnforcementConfig = validateWorkforceConfig;

function validateAgentConfig(agentId: string, config: AgentConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // Validate new profile fields
  if (config.model !== undefined && config.model.length === 0) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Agent has empty model field — will use platform default.",
    });
  }

  if (config.persona !== undefined && config.persona.length > 4000) {
    warnings.push({
      level: "warn",
      agentId,
      message: `Agent persona is ${config.persona.length} chars — consider keeping it under 4000 for context budget.`,
    });
  }

  if (config.permissions?.budget_limit_cents !== undefined && config.permissions.budget_limit_cents <= 0) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Agent has non-positive budget_limit_cents — agent won't be able to spend.",
    });
  }

  // Must have at least one expectation
  if (config.expectations.length === 0) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Agent has no expectations — nothing will be enforced.",
    });
  }

  // Validate expectations have valid tool names
  for (const req of config.expectations) {
    if (!req.tool) {
      warnings.push({
        level: "error",
        agentId,
        message: "Expectation missing tool name.",
      });
    }
    if (req.min_calls < 1) {
      warnings.push({
        level: "warn",
        agentId,
        message: `Expectation for ${req.tool} has min_calls < 1 — will never trigger.`,
      });
    }
  }

  // Validate performance policy
  if (config.performance_policy.action === "retry" && !config.performance_policy.max_retries) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Performance policy is 'retry' but no max_retries set — will default to 1.",
    });
  }

  if (config.performance_policy.action === "retry" && !config.performance_policy.then) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Performance policy is 'retry' but no 'then' action set for when retries are exhausted.",
    });
  }

  // Scheduled agents should have clawforce_log outcome requirement
  if (config.role === "scheduled") {
    const hasOutcome = config.expectations.some(
      (r) => r.tool === "clawforce_log" &&
        (Array.isArray(r.action) ? r.action.includes("outcome") : r.action === "outcome"),
    );
    if (!hasOutcome) {
      warnings.push({
        level: "warn",
        agentId,
        message: "Scheduled agent has no expectation for clawforce_log outcome — runs won't be audited.",
      });
    }
  }

  // Validate reports_to
  if (config.reports_to !== undefined && config.reports_to !== "parent") {
    // Named agent target — warn if the target agent isn't also configured
    // (can't fully validate here since we only see one agent at a time,
    // but we can flag obviously invalid values)
    if (config.reports_to === agentId) {
      warnings.push({
        level: "error",
        agentId,
        message: "Agent reports_to itself — this would cause infinite escalation loops.",
      });
    }
  }

  // Validate context sources
  for (const source of config.briefing) {
    if (source.source === "file" && !source.path) {
      warnings.push({
        level: "error",
        agentId,
        message: "Context source 'file' requires a 'path' property.",
      });
    }
    if (source.source === "custom" && !source.content) {
      warnings.push({
        level: "warn",
        agentId,
        message: "Context source 'custom' has no 'content' — will inject nothing.",
      });
    }
  }

  // Validate exclude_briefing
  if (config.exclude_briefing && config.exclude_briefing.length > 0) {
    const criticalForRole = CRITICAL_SOURCES[config.role];
    if (criticalForRole) {
      for (const excluded of config.exclude_briefing) {
        if (criticalForRole.includes(excluded)) {
          warnings.push({
            level: "warn",
            agentId,
            message: `Excluding critical baseline source "${excluded}" for role "${config.role}" — agent may lack essential context.`,
          });
        }
      }
    }

    const VALID_SOURCES: ContextSource["source"][] = [
      "instructions", "custom", "project_md", "task_board",
      "assigned_task", "knowledge", "file", "skill", "memory",
      "escalations", "workflows", "activity", "sweep_status",
      "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
      "team_status", "team_performance",
    ];
    for (const excluded of config.exclude_briefing) {
      if (!VALID_SOURCES.includes(excluded as ContextSource["source"])) {
        warnings.push({
          level: "warn",
          agentId,
          message: `exclude_briefing contains unknown source "${excluded}" — will be ignored.`,
        });
      }
    }
  }

  // Validate compaction config
  if (config.compaction !== undefined) {
    const compaction = typeof config.compaction === "boolean"
      ? { enabled: config.compaction }
      : config.compaction as CompactionConfig;

    if (compaction.enabled) {
      // Check that agent has compactable sources (file or project_md)
      const hasCompactableSource = config.briefing.some(
        (s) => s.source === "project_md" || s.source === "file",
      );
      const hasExplicitFiles = compaction.files && compaction.files.length > 0;

      if (!hasCompactableSource && !hasExplicitFiles) {
        warnings.push({
          level: "warn",
          agentId,
          message: "Compaction is enabled but agent has no file or project_md sources and no explicit compaction files — nothing to compact.",
        });
      }

      // Ensure compaction expectation exists
      const hasCompactOutput = config.expectations.some(
        (r) => r.tool === "clawforce_compact",
      );
      if (!hasCompactOutput) {
        warnings.push({
          level: "warn",
          agentId,
          message: "Compaction is enabled but no expectation for clawforce_compact — compaction won't be enforced.",
        });
      }
    }
  }

  return warnings;
}
