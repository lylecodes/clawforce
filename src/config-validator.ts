/**
 * Clawforce — Config validator
 *
 * Validates workforce configs at gateway start.
 * Returns warnings (non-fatal) so the plugin can still load with partial configs.
 */

import type { DomainConfig } from "./config/schema.js";
import { validatePolicyConfigs } from "./policy/normalizer.js";
import { isKnownCategory } from "./risk/categories.js";
import type { AgentConfig, CompactionConfig, ContextSource, RiskGateAction, RiskTier, WorkforceConfig } from "./types.js";
import { EVENT_ACTION_TYPES, OPERATIONAL_PROFILES } from "./types.js";

const VALID_RISK_TIERS: RiskTier[] = ["low", "medium", "high", "critical"];
const VALID_GATE_ACTIONS: RiskGateAction[] = ["none", "delay", "confirm", "approval", "human_approval"];

/**
 * All valid briefing source names — derived from the ContextSource union type
 * and the assembler switch statement. Keep in sync when new sources are added.
 */
export const VALID_BRIEFING_SOURCES: ReadonlySet<string> = new Set([
  "instructions", "custom", "project_md", "task_board", "assigned_task",
  "knowledge", "file", "skill", "memory", "memory_instructions",
  "memory_review_context", "escalations", "workflows", "activity",
  "sweep_status", "proposals", "agent_status", "cost_summary",
  "policy_status", "health_status", "team_status", "team_performance",
  "soul", "tools_reference", "pending_messages", "goal_hierarchy",
  "channel_messages", "planning_delta", "velocity", "preferences",
  "trust_scores", "resources", "initiative_status", "cost_forecast",
  "available_capacity", "knowledge_candidates", "budget_guidance",
  "onboarding_welcome", "weekly_digest", "intervention_suggestions",
  "custom_stream", "observed_events", "direction", "policies",
  "standards", "architecture", "task_creation_standards",
  "execution_standards", "review_standards", "rejection_standards",
  "worker_findings", "recent_decisions", "clawforce_health_report",
]);

/**
 * All known ClawForce tools — derived from DEFAULT_ACTION_SCOPES in profiles.ts.
 */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "clawforce_task", "clawforce_verify", "clawforce_message",
  "clawforce_context", "clawforce_ops",
  "clawforce_memory", "clawforce_skill", "clawforce_knowledge",
  "clawforce_scale", "clawforce_workflow", "clawforce_channel",
  "clawforce_goal", "clawforce_log",
]);

const VALID_PERFORMANCE_ACTIONS = new Set([
  "retry", "alert", "terminate_and_alert", "disable", "escalate",
]);

export type ConfigWarning = {
  level: "warn" | "error" | "suggest";
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
    for (const [eventType, handlerConfig] of Object.entries(config.event_handlers)) {
      if (!eventType || eventType.length === 0) {
        warnings.push({ level: "error", message: "event_handlers contains empty event type key." });
        continue;
      }
      const actions = handlerConfig.actions;
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
    if (s.maxCallsPerSession !== undefined && (s.maxCallsPerSession < 1 || !Number.isInteger(s.maxCallsPerSession))) {
      warnings.push({ level: "error", message: `safety.max_calls_per_session must be a positive integer, got ${s.maxCallsPerSession}.` });
    }
    if (s.maxCallsPerMinute !== undefined && (s.maxCallsPerMinute < 1 || !Number.isInteger(s.maxCallsPerMinute))) {
      warnings.push({ level: "error", message: `safety.max_calls_per_minute must be a positive integer, got ${s.maxCallsPerMinute}.` });
    }
    if (s.maxCallsPerMinutePerAgent !== undefined && (s.maxCallsPerMinutePerAgent < 1 || !Number.isInteger(s.maxCallsPerMinutePerAgent))) {
      warnings.push({ level: "error", message: `safety.max_calls_per_minute_per_agent must be a positive integer, got ${s.maxCallsPerMinutePerAgent}.` });
    }
    if (s.retryBackoffBaseMs !== undefined && s.retryBackoffBaseMs < 1000) {
      warnings.push({ level: "error", message: `safety.retry_backoff_base_ms must be at least 1000ms, got ${s.retryBackoffBaseMs}.` });
    }
    if (s.retryBackoffMaxMs !== undefined && s.retryBackoffMaxMs < 1000) {
      warnings.push({ level: "error", message: `safety.retry_backoff_max_ms must be at least 1000ms, got ${s.retryBackoffMaxMs}.` });
    }
    if (s.retryBackoffBaseMs !== undefined && s.retryBackoffMaxMs !== undefined && s.retryBackoffBaseMs > s.retryBackoffMaxMs) {
      warnings.push({ level: "warn", message: `safety.retry_backoff_base_ms (${s.retryBackoffBaseMs}) exceeds retry_backoff_max_ms (${s.retryBackoffMaxMs}) — base will be clamped.` });
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

  // Suggestions (non-blocking guidance)
  const agentCount = Object.keys(config.agents).length;
  if (agentCount >= 3 && !config.budgets) {
    warnings.push({
      level: "suggest",
      message: `You have ${agentCount} agents but no budget config — consider setting budget limits.`,
    });
  }

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (
      (!agentConfig.expectations || agentConfig.expectations.length === 0) &&
      agentConfig.extends !== "assistant"
    ) {
      warnings.push({
        level: "suggest",
        agentId,
        message: `Agent "${agentId}" has no expectations — compliance tracking won't be useful without them.`,
      });
    }
  }

  // Skill cap warnings — check custom skill count against agent skillCap
  const customSkillCount = config.skills ? Object.keys(config.skills).length : 0;
  if (customSkillCount > 0) {
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.skillCap !== undefined && agentConfig.skillCap > 0) {
        if (customSkillCount >= agentConfig.skillCap) {
          warnings.push({
            level: "suggest",
            agentId,
            message: `Agent has ${customSkillCount} custom skill(s) which meets or exceeds skillCap of ${agentConfig.skillCap} — consider splitting this agent into specialists.`,
          });
        } else if (customSkillCount >= agentConfig.skillCap - 2) {
          warnings.push({
            level: "suggest",
            agentId,
            message: `Agent has ${customSkillCount} custom skill(s), approaching skillCap of ${agentConfig.skillCap} — plan for growth.`,
          });
        }
      }
    }
  }

  // Validate team_template references
  if (config.team_templates) {
    const templateNames = new Set(Object.keys(config.team_templates));
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.team && !templateNames.has(agentConfig.team)) {
        // Not an error — team field is valid without a template. Just suggest.
        warnings.push({
          level: "suggest",
          agentId,
          message: `Agent has team "${agentConfig.team}" but no matching team_template — team defaults won't apply.`,
        });
      }
    }
    // Warn about unused team templates
    const usedTeams = new Set(
      Object.values(config.agents).map(a => a.team).filter(Boolean) as string[]
    );
    for (const templateName of templateNames) {
      if (!usedTeams.has(templateName)) {
        warnings.push({
          level: "suggest",
          message: `team_template "${templateName}" is defined but no agent has team: "${templateName}".`,
        });
      }
    }
  }

  // Semantic validation: expectations reference tools in the agent's allowed tools
  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.allowedTools && agentConfig.allowedTools.length > 0) {
      const allowedSet = new Set(agentConfig.allowedTools);
      for (const exp of agentConfig.expectations) {
        // ClawForce tools (clawforce_*) are always available — not gated by allowedTools
        if (exp.tool.startsWith("clawforce_") || exp.tool.startsWith("memory_")) continue;
        if (!allowedSet.has(exp.tool)) {
          warnings.push({
            level: "warn",
            agentId,
            message: `Expectation references tool "${exp.tool}" which is not in allowedTools — expectation may never be satisfied.`,
          });
        }
      }
    }

    // Validate expectation tool names against known tools
    for (const exp of agentConfig.expectations) {
      if (!KNOWN_TOOLS.has(exp.tool) && !exp.tool.startsWith("memory_")) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Expectation references unknown tool "${exp.tool}" — may be a typo.`,
        });
      }
    }

    // Validate performance_policy action
    if (agentConfig.performance_policy?.action && !VALID_PERFORMANCE_ACTIONS.has(agentConfig.performance_policy.action)) {
      warnings.push({
        level: "warn",
        agentId,
        message: `Performance policy action "${agentConfig.performance_policy.action}" is not recognized — valid: ${[...VALID_PERFORMANCE_ACTIONS].join(", ")}.`,
      });
    }

    // Validate briefing sources against known sources
    for (const source of agentConfig.briefing) {
      const sourceName = typeof source === "string" ? source : source.source;
      if (sourceName && !VALID_BRIEFING_SOURCES.has(sourceName)) {
        warnings.push({
          level: "warn",
          agentId,
          message: `Briefing source "${sourceName}" is not a known source — may be a typo.`,
        });
      }
    }

    // Validate job-level fields
    if (agentConfig.jobs) {
      for (const [jobName, job] of Object.entries(agentConfig.jobs)) {
        // Job briefing source validation
        if (job.briefing) {
          for (const source of job.briefing) {
            const sourceName = typeof source === "string" ? source : source.source;
            if (sourceName && !VALID_BRIEFING_SOURCES.has(sourceName)) {
              warnings.push({
                level: "warn",
                agentId,
                message: `Job "${jobName}" briefing source "${sourceName}" is not a known source — may be a typo.`,
              });
            }
          }
        }

        // Job frequency validation
        if (job.frequency && !/^\d+\/(hour|day|week)$/.test(job.frequency)) {
          warnings.push({
            level: "warn",
            agentId,
            message: `Job "${jobName}" has invalid frequency "${job.frequency}" — must be "N/period" where period is hour, day, or week.`,
          });
        }

        // Job performance_policy action validation
        if (job.performance_policy?.action && !VALID_PERFORMANCE_ACTIONS.has(job.performance_policy.action)) {
          warnings.push({
            level: "warn",
            agentId,
            message: `Job "${jobName}" performance policy action "${job.performance_policy.action}" is not recognized — valid: ${[...VALID_PERFORMANCE_ACTIONS].join(", ")}.`,
          });
        }
      }
    }
  }

  return warnings;
}


/**
 * Validate domain config quality — returns non-blocking suggestions.
 */
export function validateDomainQuality(domain: DomainConfig): ConfigWarning[] {
  const results: ConfigWarning[] = [];

  // Reject runtime fields on domain-level agent defs
  const rawDomain = domain as Record<string, unknown>;
  if (rawDomain.model !== undefined) {
    results.push({
      level: "error",
      message: `Domain "${domain.domain}": "model" is a runtime setting — configure it in OpenClaw's agent config, not Clawforce.`,
    });
  }

  if (!domain.orchestrator) {
    results.push({
      level: "suggest",
      message: `Domain "${domain.domain}" has no orchestrator — consider assigning one for coordination.`,
    });
  }

  if (!domain.paths || domain.paths.length === 0) {
    results.push({
      level: "suggest",
      message: `Domain "${domain.domain}" has no paths configured — add code paths if this domain works with repositories.`,
    });
  }

  if (!domain.rules || domain.rules.length === 0) {
    results.push({
      level: "suggest",
      message: `Domain "${domain.domain}" has no rules — rules automate recurring decisions and reduce LLM costs.`,
    });
  }

  // Validate operational_profile if present
  if (domain.operational_profile !== undefined) {
    if (!OPERATIONAL_PROFILES.includes(domain.operational_profile as any)) {
      results.push({
        level: "error",
        message: `Domain "${domain.domain}": operational_profile "${domain.operational_profile}" is invalid. Valid: ${OPERATIONAL_PROFILES.join(", ")}`,
      });
    }
  }

  // Validate role_defaults reference known preset names
  if (domain.role_defaults) {
    const KNOWN_ROLES = new Set(["manager", "employee", "assistant", "verifier", "dashboard-assistant", "onboarding", "scheduled"]);
    for (const roleName of Object.keys(domain.role_defaults)) {
      if (!KNOWN_ROLES.has(roleName)) {
        results.push({
          level: "warn",
          message: `Domain "${domain.domain}": role_defaults references unknown role "${roleName}" — ensure agents use \`extends: "${roleName}"\` for this to take effect.`,
        });
      }
    }
  }

  // Validate team_templates
  if (domain.team_templates) {
    const domainAgentIds = new Set(domain.agents);
    for (const [teamName, template] of Object.entries(domain.team_templates)) {
      if (!teamName || teamName.length === 0) {
        results.push({
          level: "error",
          message: `Domain "${domain.domain}": team_templates contains empty team name.`,
        });
      }
      if (template && typeof template === "object" && (template as Record<string, unknown>).model !== undefined) {
        results.push({
          level: "error",
          message: `Domain "${domain.domain}": team_template "${teamName}" contains "model" — model is a runtime setting, configure it in OpenClaw's agent config.`,
        });
      }
    }
  }

  return results;
}

function validateAgentConfig(agentId: string, config: AgentConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // Reject runtime fields that belong in OpenClaw's agent config
  const raw = config as Record<string, unknown>;
  if (raw.model !== undefined) {
    warnings.push({
      level: "error",
      agentId,
      message: `"model" is a runtime setting — configure it in OpenClaw's agent config (~/.openclaw/ agents section), not Clawforce.`,
    });
  }
  if (raw.provider !== undefined) {
    warnings.push({
      level: "error",
      agentId,
      message: `"provider" is a runtime setting — configure it in OpenClaw's agent config, not Clawforce.`,
    });
  }

  // Validate new profile fields
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
      "memory_instructions", "memory_review_context",
      "escalations", "workflows", "activity", "sweep_status",
      "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
      "team_status", "team_performance", "soul", "tools_reference",
      "pending_messages", "goal_hierarchy", "channel_messages", "planning_delta",
      "velocity", "preferences", "trust_scores", "resources",
      "initiative_status", "cost_forecast", "available_capacity", "knowledge_candidates",
      "budget_guidance", "onboarding_welcome", "weekly_digest", "intervention_suggestions",
      "custom_stream",
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

  // Validate memory governance config
  if (raw.memory !== undefined) {
    const mem = raw.memory as Record<string, unknown> | undefined;
    if (typeof mem === "object" && mem !== null) {
      if (mem.instructions !== undefined) {
        if (typeof mem.instructions !== "boolean" && typeof mem.instructions !== "string") {
          warnings.push({
            level: "error",
            agentId,
            message: "memory.instructions must be a boolean or string.",
          });
        }
      }

      if (mem.expectations !== undefined && typeof mem.expectations !== "boolean") {
        warnings.push({
          level: "error",
          agentId,
          message: "memory.expectations must be a boolean.",
        });
      }

      if (mem.review !== undefined && typeof mem.review === "object" && mem.review !== null) {
        const rv = mem.review as Record<string, unknown>;

        if (rv.aggressiveness !== undefined) {
          if (typeof rv.aggressiveness !== "string" || !["low", "medium", "high"].includes(rv.aggressiveness)) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.aggressiveness must be "low", "medium", or "high" — got "${rv.aggressiveness}".`,
            });
          }
        }

        if (rv.scope !== undefined) {
          if (typeof rv.scope !== "string" || !["self", "reports", "all"].includes(rv.scope)) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.scope must be "self", "reports", or "all" — got "${rv.scope}".`,
            });
          }
        }

        if (rv.cron !== undefined && typeof rv.cron === "string") {
          const isInterval = /^(\d+[smhd]|\d+|every:\d+)$/.test(rv.cron);
          const isCronExpr = rv.cron.trim().split(/\s+/).length >= 5 || rv.cron.startsWith("cron:");
          const isOneShot = rv.cron.startsWith("at:") || /^\d{4}-\d{2}-\d{2}T/.test(rv.cron);
          if (!isInterval && !isCronExpr && !isOneShot) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.cron has unrecognized format "${rv.cron}" — will default to daily 6pm.`,
            });
          }
        }
      }
    }
  }

  return warnings;
}
