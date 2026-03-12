/**
 * Clawforce — Config validator
 *
 * Validates workforce configs at gateway start.
 * Returns warnings (non-fatal) so the plugin can still load with partial configs.
 */

import { validatePolicyConfigs } from "./policy/normalizer.js";
import { isKnownCategory } from "./risk/categories.js";
import type { AgentConfig, CompactionConfig, ContextSource, RiskGateAction, RiskTier, WorkforceConfig } from "./types.js";
import { EVENT_ACTION_TYPES } from "./types.js";

const VALID_RISK_TIERS: RiskTier[] = ["low", "medium", "high", "critical"];
const VALID_GATE_ACTIONS: RiskGateAction[] = ["none", "delay", "confirm", "approval", "human_approval"];

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
    const validTools = ["clawforce_task", "clawforce_log", "clawforce_verify", "clawforce_workflow", "clawforce_setup", "clawforce_compact", "clawforce_ops", "clawforce_context", "memory_search", "memory_get"];
    const policyErrors = validatePolicyConfigs(config.policies, validTools);
    for (const err of policyErrors) {
      warnings.push({
        level: "warn",
        message: `Policy "${err.name}": ${err.message}`,
      });
    }
  }

  // Validate custom skill topics
  if (config.skills) {
    for (const [skillId, skill] of Object.entries(config.skills)) {
      if (!skill.title) {
        warnings.push({ level: "error", message: `Skill "${skillId}" is missing a title.` });
      }
      if (!skill.path) {
        warnings.push({ level: "error", message: `Skill "${skillId}" is missing a path.` });
      }
      if (skill.path && skill.path.includes("..")) {
        warnings.push({ level: "error", message: `Skill "${skillId}" path contains "..": path traversal not allowed.` });
      }
    }
  }

  // Validate skill_packs
  if (config.skill_packs) {
    const packIds = new Set(Object.keys(config.skill_packs));
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.skill_pack && !packIds.has(agentConfig.skill_pack)) {
        warnings.push({
          level: "error",
          agentId,
          message: `Agent references skill_pack "${agentConfig.skill_pack}" which is not defined in skill_packs.`,
        });
      }
    }
  }

  // Validate event_handlers
  if (config.event_handlers) {
    const agentIds = new Set(Object.keys(config.agents));
    for (const [eventType, actions] of Object.entries(config.event_handlers)) {
      if (!eventType || eventType.length === 0) {
        warnings.push({ level: "error", message: "event_handlers contains empty event type key." });
        continue;
      }
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        const prefix = `event_handlers.${eventType}[${i}]`;

        if (!EVENT_ACTION_TYPES.includes(action.action as typeof EVENT_ACTION_TYPES[number])) {
          warnings.push({ level: "error", message: `${prefix}: unknown action "${action.action}". Valid: ${EVENT_ACTION_TYPES.join(", ")}` });
          continue;
        }

        switch (action.action) {
          case "create_task":
            if (!action.template) {
              warnings.push({ level: "error", message: `${prefix}: create_task requires a "template" field.` });
            }
            if (action.assign_to && action.assign_to !== "auto" && !agentIds.has(action.assign_to)) {
              warnings.push({ level: "warn", message: `${prefix}: assign_to "${action.assign_to}" not found in configured agents.` });
            }
            break;
          case "notify":
            if (!action.message) {
              warnings.push({ level: "error", message: `${prefix}: notify requires a "message" field.` });
            }
            break;
          case "escalate":
            if (!action.to) {
              warnings.push({ level: "error", message: `${prefix}: escalate requires a "to" field.` });
            }
            if (action.to && action.to !== "manager" && !agentIds.has(action.to)) {
              warnings.push({ level: "warn", message: `${prefix}: escalate target "${action.to}" not found in configured agents.` });
            }
            break;
          case "emit_event":
            if (!action.event_type) {
              warnings.push({ level: "error", message: `${prefix}: emit_event requires an "event_type" field.` });
            }
            break;
        }
      }
    }
  }

  // Validate tool gates
  if (config.toolGates) {
    for (const [toolName, gate] of Object.entries(config.toolGates)) {
      const prefix = `toolGates["${toolName}"]`;

      if (!gate.category) {
        warnings.push({ level: "error", message: `${prefix}: missing category.` });
      } else if (!isKnownCategory(gate.category)) {
        warnings.push({ level: "warn", message: `${prefix}: category "${gate.category}" is not a built-in category — ensure it's intentional.` });
      }

      if (!VALID_RISK_TIERS.includes(gate.tier)) {
        warnings.push({ level: "error", message: `${prefix}: invalid tier "${gate.tier}". Valid: ${VALID_RISK_TIERS.join(", ")}` });
      }

      if (gate.gate !== undefined && !VALID_GATE_ACTIONS.includes(gate.gate)) {
        warnings.push({ level: "error", message: `${prefix}: invalid gate "${gate.gate}". Valid: ${VALID_GATE_ACTIONS.join(", ")}` });
      }
    }
  }

  // Validate bulk thresholds
  if (config.bulkThresholds) {
    for (const [category, threshold] of Object.entries(config.bulkThresholds)) {
      const prefix = `bulkThresholds["${category}"]`;

      if (!threshold.windowMs || threshold.windowMs <= 0) {
        warnings.push({ level: "error", message: `${prefix}: windowMs must be positive.` });
      }

      if (!threshold.maxCount || threshold.maxCount <= 0) {
        warnings.push({ level: "error", message: `${prefix}: maxCount must be positive.` });
      }

      if (!VALID_RISK_TIERS.includes(threshold.escalateTo)) {
        warnings.push({ level: "error", message: `${prefix}: invalid escalateTo "${threshold.escalateTo}". Valid: ${VALID_RISK_TIERS.join(", ")}` });
      }
    }
  }

  // Validate safety config
  if (config.safety) {
    const s = config.safety;
    if (s.maxSpawnDepth !== undefined && (s.maxSpawnDepth < 1 || !Number.isInteger(s.maxSpawnDepth))) {
      warnings.push({ level: "error", message: `safety.max_spawn_depth must be a positive integer, got ${s.maxSpawnDepth}.` });
    }
    if (s.costCircuitBreaker !== undefined && s.costCircuitBreaker <= 0) {
      warnings.push({ level: "error", message: `safety.cost_circuit_breaker must be positive, got ${s.costCircuitBreaker}.` });
    }
    if (s.costCircuitBreaker !== undefined && s.costCircuitBreaker <= 1.0) {
      warnings.push({ level: "warn", message: `safety.cost_circuit_breaker is ${s.costCircuitBreaker} (≤1.0) — circuit breaker will trigger before reaching budget limit.` });
    }
    if (s.loopDetectionThreshold !== undefined && (s.loopDetectionThreshold < 1 || !Number.isInteger(s.loopDetectionThreshold))) {
      warnings.push({ level: "error", message: `safety.loop_detection_threshold must be a positive integer, got ${s.loopDetectionThreshold}.` });
    }
    if (s.maxConcurrentMeetings !== undefined && (s.maxConcurrentMeetings < 1 || !Number.isInteger(s.maxConcurrentMeetings))) {
      warnings.push({ level: "error", message: `safety.max_concurrent_meetings must be a positive integer, got ${s.maxConcurrentMeetings}.` });
    }
    if (s.maxMessageRate !== undefined && (s.maxMessageRate < 1 || !Number.isInteger(s.maxMessageRate))) {
      warnings.push({ level: "error", message: `safety.max_message_rate must be a positive integer, got ${s.maxMessageRate}.` });
    }
  }

  // Validate review config
  if (config.review) {
    if (config.review.verifierAgent && !agentIds.has(config.review.verifierAgent)) {
      warnings.push({
        level: "error",
        message: `review.verifier_agent "${config.review.verifierAgent}" is not defined in this project's agents.`,
      });
    }
    if (config.review.autoEscalateAfterHours !== undefined && config.review.autoEscalateAfterHours <= 0) {
      warnings.push({
        level: "error",
        message: `review.auto_escalate_after_hours must be positive, got ${config.review.autoEscalateAfterHours}.`,
      });
    }
    if (config.review.selfReviewAllowed && !config.review.selfReviewMaxPriority) {
      warnings.push({
        level: "warn",
        message: "review.self_review_allowed is true but no self_review_max_priority set — defaults to P3.",
      });
    }
    if (config.review.selfReviewMaxPriority && !config.review.selfReviewAllowed) {
      warnings.push({
        level: "warn",
        message: "review.self_review_max_priority set but self_review_allowed is false — priority threshold will be ignored.",
      });
    }
  }

  // Validate channel config
  if (config.channels) {
    const channelNames = new Set<string>();
    for (let i = 0; i < config.channels.length; i++) {
      const ch = config.channels[i]!;
      const prefix = `channels[${i}]`;

      if (!ch.name) {
        warnings.push({ level: "error", message: `${prefix}: missing channel name.` });
        continue;
      }
      if (channelNames.has(ch.name)) {
        warnings.push({ level: "error", message: `${prefix}: duplicate channel name "${ch.name}".` });
      }
      channelNames.add(ch.name);

      if (ch.type && !["topic", "meeting"].includes(ch.type)) {
        warnings.push({ level: "error", message: `${prefix}: invalid type "${ch.type}". Must be: topic, meeting.` });
      }

      if (ch.members) {
        for (const member of ch.members) {
          if (!agentIds.has(member)) {
            warnings.push({ level: "warn", message: `${prefix}: member "${member}" not found in agents.` });
          }
        }
      }
    }
  }

  // Check manager has propose requirement if approval policy exists
  if (config.approval?.policy) {
    const managers = Object.entries(config.agents).filter(
      ([, c]) => c.coordination?.enabled,
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

  if (config.skillCap !== undefined && config.skillCap < 1) {
    warnings.push({
      level: "warn",
      agentId,
      message: `Skill cap must be a positive number (got ${config.skillCap}).`,
    });
  }

  if (config.permissions?.budget_limit_cents !== undefined && config.permissions.budget_limit_cents <= 0) {
    warnings.push({
      level: "warn",
      agentId,
      message: "Agent has non-positive budget_limit_cents — agent won't be able to spend.",
    });
  }

  // Warn if expectations are empty and the agent inherits from a preset that
  // normally provides them (manager/employee). Agents with no `extends` or a
  // custom preset may intentionally have zero expectations.
  if (
    config.expectations.length === 0 &&
    (config.extends === "manager" || config.extends === "employee")
  ) {
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
    // Derive critical sources from config shape:
    //  - coordination.enabled → needs "task_board"
    //  - extends === "employee" (or default) → needs "assigned_task"
    const criticalSources: string[] = [];
    if (config.coordination?.enabled || config.extends === "manager") {
      criticalSources.push("task_board");
    }
    if (config.extends === "employee" || (!config.extends && !config.coordination?.enabled)) {
      criticalSources.push("assigned_task");
    }
    for (const excluded of config.exclude_briefing) {
      if (criticalSources.includes(excluded)) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Excluding critical baseline source "${excluded}" — agent may lack essential context.`,
        });
      }
    }

    const VALID_SOURCES: ContextSource["source"][] = [
      "instructions", "custom", "project_md", "task_board",
      "assigned_task", "knowledge", "file", "skill", "memory",
      "escalations", "workflows", "activity", "sweep_status",
      "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
      "team_status", "team_performance", "soul", "tools_reference",
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

  // Validate jobs
  if (config.jobs) {
    for (const [jobName, job] of Object.entries(config.jobs)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(jobName)) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Job "${jobName}" has invalid name — use lowercase alphanumeric with hyphens/underscores, starting with a letter.`,
        });
      }

      if (job.briefing) {
        for (const source of job.briefing) {
          if (source.source === "file" && !source.path) {
            warnings.push({
              level: "error",
              agentId,
              message: `Job "${jobName}": context source 'file' requires a 'path' property.`,
            });
          }
        }
      }

      if (job.expectations && job.expectations.length === 0) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Job "${jobName}" has empty expectations — nothing will be enforced.`,
        });
      }

      if (job.cron) {
        const isInterval = /^(\d+[smhd]|\d+|every:\d+)$/.test(job.cron);
        const isCronExpr = job.cron.trim().split(/\s+/).length >= 5 || job.cron.startsWith("cron:");
        const isOneShot = job.cron.startsWith("at:") || /^\d{4}-\d{2}-\d{2}T/.test(job.cron);
        if (!isInterval && !isCronExpr && !isOneShot) {
          warnings.push({
            level: "warn",
            agentId,
            message: `Job "${jobName}" has unrecognized cron format "${job.cron}" — will default to 5m interval.`,
          });
        }
      }

      if (job.cronTimezone && !job.cron) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Job "${jobName}" has cronTimezone but no cron schedule — timezone will be ignored.`,
        });
      }

      if (job.delivery && !["none", "announce", "webhook"].includes(job.delivery.mode)) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Job "${jobName}" has invalid delivery mode "${job.delivery.mode}" — must be "none", "announce", or "webhook".`,
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

      // Ensure compaction expectation exists when compaction is enabled.
      // Skip for assistant preset — assistants intentionally have no enforcement expectations.
      const hasCompactOutput = config.expectations.some(
        (r) => r.tool === "clawforce_compact",
      );
      if (!hasCompactOutput && config.compaction && config.extends !== "assistant") {
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
