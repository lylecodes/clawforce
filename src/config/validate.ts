/**
 * Clawforce — Config validation module
 *
 * Validates split config directories (`config.yaml` + `domains/*.yaml`) and
 * reports all issues at once.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { BUILTIN_AGENT_PRESETS } from "../presets.js";
import { VALID_BRIEFING_SOURCES, KNOWN_TOOLS } from "../config-validator.js";
import { normalizeEntityKindsConfig, validateEntityKindsInConfig } from "../entities/config.js";
import { normalizeExecutionConfig } from "../execution/config.js";

export type ValidationSeverity = "error" | "warn" | "suggest";

export type ValidationIssue = {
  severity: ValidationSeverity;
  file?: string;
  path?: string;
  agentId?: string;
  code: string;
  message: string;
};

export type ValidationReport = {
  valid: boolean;
  issues: ValidationIssue[];
};

const GLOBAL_CONFIG_FILE = "config.yaml";
const DOMAINS_DIR = "domains";

const KNOWN_GLOBAL_KEYS = new Set([
  "agents",
  "mixins",
  "defaults",
  "adapter",
  "codex",
  "claude_code",
  "team_templates",
]);

const KNOWN_AGENT_KEYS = new Set([
  "extends",
  "title",
  "persona",
  "tools",
  "permissions",
  "channel",
  "department",
  "team",
  "group",
  "subgroup",
  "reports_to",
  "briefing",
  "exclude_briefing",
  "expectations",
  "performance_policy",
  "compaction",
  "skill_pack",
  "mixins",
  "coordination",
  "jobs",
  "scheduling",
  "skillCap",
  "skill_cap",
  "memory",
  "observe",
  "compactBriefing",
  "contextBudgetChars",
  "context_budget_chars",
  "maxTurnsPerSession",
  "max_turns_per_session",
  "runtimeRef",
  "runtime_ref",
  "runtime",
  "model",
  "auto_recovery",
  "bootstrapConfig",
  "bootstrap_config",
  "bootstrapExcludeFiles",
  "bootstrap_exclude_files",
  "allowedTools",
  "allowed_tools",
  "workspacePaths",
  "workspace_paths",
]);

const KNOWN_DOMAIN_KEYS = new Set([
  "domain",
  "enabled",
  "direction",
  "template",
  "paths",
  "agents",
  "policies",
  "budget",
  "workflows",
  "rules",
  "manager",
  "context_sources",
  "expectations",
  "jobs",
  "knowledge",
  "safety",
  "channels",
  "event_handlers",
  "triggers",
  "verification",
  "execution",
  "dashboard_assistant",
  "operational_profile",
  "defaults",
  "role_defaults",
  "team_templates",
  "manager_overrides",
  "dispatch",
  "lifecycle",
  "sweep",
  "trust",
  "context",
  "memory",
  "goals",
  "entities",
  "monitoring",
  "skills",
]);

const KNOWN_PRESETS = new Set(Object.keys(BUILTIN_AGENT_PRESETS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(baseDir: string, rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

function parseYamlFile(
  filePath: string,
  fileLabel: string,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    issues.push({
      severity: "error",
      file: fileLabel,
      code: "FILE_NOT_FOUND",
      message: `${fileLabel} not found in config directory`,
    });
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (!isRecord(parsed)) {
      issues.push({
        severity: "error",
        file: fileLabel,
        code: "YAML_EMPTY",
        message: `${fileLabel} is empty or not an object`,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    issues.push({
      severity: "error",
      file: fileLabel,
      code: "YAML_PARSE_ERROR",
      message: `YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
}

function validateJobTriggers(
  fileLabel: string,
  agentId: string,
  jobs: Record<string, Record<string, unknown>>,
  issues: ValidationIssue[],
): void {
  const knownTriggerEvents = new Set([
    "ci_failed",
    "pr_opened",
    "deploy_finished",
    "task_completed",
    "task_failed",
    "task_assigned",
    "task_created",
    "sweep_finding",
    "dispatch_succeeded",
    "dispatch_failed",
    "task_review_ready",
    "dispatch_dead_letter",
    "proposal_approved",
    "proposal_created",
    "proposal_rejected",
    "message_sent",
    "protocol_started",
    "protocol_responded",
    "protocol_completed",
    "protocol_expired",
    "protocol_escalated",
    "goal_created",
    "goal_achieved",
    "goal_abandoned",
    "custom",
  ]);

  for (const [jobName, jobDef] of Object.entries(jobs)) {
    if (!isRecord(jobDef)) continue;
    const triggers = jobDef.triggers;
    if (triggers === undefined) continue;

    if (!Array.isArray(triggers)) {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.jobs.${jobName}.triggers`,
        agentId,
        code: "INVALID_TRIGGERS",
        message: `Job ${jobName} on ${agentId}: triggers must be an array`,
      });
      continue;
    }

    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      if (!isRecord(trigger)) {
        issues.push({
          severity: "error",
          file: fileLabel,
          path: `agents.${agentId}.jobs.${jobName}.triggers[${i}]`,
          agentId,
          code: "INVALID_TRIGGER",
          message: `Job ${jobName} on ${agentId}: trigger[${i}] must be an object with an "on" field`,
        });
        continue;
      }

      if (typeof trigger.on !== "string" || !trigger.on.trim()) {
        issues.push({
          severity: "error",
          file: fileLabel,
          path: `agents.${agentId}.jobs.${jobName}.triggers[${i}].on`,
          agentId,
          code: "MISSING_TRIGGER_EVENT",
          message: `Job ${jobName} on ${agentId}: trigger[${i}] missing required "on" event type`,
        });
      } else if (!knownTriggerEvents.has(trigger.on)) {
        issues.push({
          severity: "warn",
          file: fileLabel,
          path: `agents.${agentId}.jobs.${jobName}.triggers[${i}].on`,
          agentId,
          code: "UNKNOWN_TRIGGER_EVENT",
          message: `Job ${jobName} on ${agentId}: unknown trigger event "${trigger.on}"`,
        });
      }
    }
  }
}

function validateAgentMemory(
  fileLabel: string,
  agentId: string,
  memory: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  if (isRecord(memory.recall)) {
    const recall = memory.recall;
    if (recall.intensity !== undefined) {
      const validIntensities = ["low", "medium", "high"];
      if (typeof recall.intensity !== "string" || !validIntensities.includes(recall.intensity)) {
        issues.push({
          severity: "error",
          file: fileLabel,
          path: `agents.${agentId}.memory.recall.intensity`,
          agentId,
          code: "INVALID_MEMORY_RECALL_INTENSITY",
          message: `Agent ${agentId}: memory.recall.intensity must be one of: ${validIntensities.join(", ")}`,
        });
      }
    }
    if (recall.cooldownMs !== undefined && typeof recall.cooldownMs !== "number") {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.memory.recall.cooldownMs`,
        agentId,
        code: "TYPE_COERCION",
        message: `Agent ${agentId}: memory.recall.cooldownMs must be a number`,
      });
    }
  }

  if (isRecord(memory.persist) && Array.isArray(memory.persist.rules)) {
    const validTriggers = new Set(["session_end", "task_completed", "task_failed", "periodic"]);
    const validActions = new Set(["extract_learnings", "save_decisions", "save_errors", "custom"]);
    for (let i = 0; i < memory.persist.rules.length; i++) {
      const rule = memory.persist.rules[i];
      if (!isRecord(rule)) continue;

      if (typeof rule.trigger === "string" && !validTriggers.has(rule.trigger)) {
        issues.push({
          severity: "error",
          file: fileLabel,
          path: `agents.${agentId}.memory.persist.rules[${i}].trigger`,
          agentId,
          code: "INVALID_PERSIST_TRIGGER",
          message: `Agent ${agentId}: memory.persist.rules[${i}].trigger "${rule.trigger}" is not valid`,
        });
      }
      if (typeof rule.action === "string" && !validActions.has(rule.action)) {
        issues.push({
          severity: "error",
          file: fileLabel,
          path: `agents.${agentId}.memory.persist.rules[${i}].action`,
          agentId,
          code: "INVALID_PERSIST_ACTION",
          message: `Agent ${agentId}: memory.persist.rules[${i}].action "${rule.action}" is not valid`,
        });
      }
      if (rule.action === "custom" && typeof rule.prompt !== "string") {
        issues.push({
          severity: "warn",
          file: fileLabel,
          path: `agents.${agentId}.memory.persist.rules[${i}].prompt`,
          agentId,
          code: "MISSING_CUSTOM_PROMPT",
          message: `Agent ${agentId}: memory.persist.rules[${i}] uses "custom" action but has no prompt`,
        });
      }
    }
  }

  if (isRecord(memory.provider)) {
    const provider = memory.provider;
    const validProviderTypes = ["builtin", "mcp"];
    if (provider.type !== undefined && (typeof provider.type !== "string" || !validProviderTypes.includes(provider.type))) {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.memory.provider.type`,
        agentId,
        code: "INVALID_PROVIDER_TYPE",
        message: `Agent ${agentId}: memory.provider.type must be one of: ${validProviderTypes.join(", ")}`,
      });
    }
    if (provider.type === "mcp" && !isRecord(provider.mcp)) {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.memory.provider.mcp`,
        agentId,
        code: "MISSING_MCP_CONFIG",
        message: `Agent ${agentId}: memory.provider.mcp is required when type is "mcp"`,
      });
    }
  }
}

function validateGlobalAgents(
  globalConfig: Record<string, unknown>,
  fileLabel: string,
  domainConfigs: Array<{ file: string; config: Record<string, unknown> }>,
  issues: ValidationIssue[],
): Record<string, Record<string, unknown>> {
  for (const key of Object.keys(globalConfig)) {
    if (!KNOWN_GLOBAL_KEYS.has(key)) {
      issues.push({
        severity: "warn",
        file: fileLabel,
        path: key,
        code: "YAML_UNKNOWN_KEY",
        message: `Unknown top-level key "${key}" — may be a typo`,
      });
    }
  }

  if (Array.isArray(globalConfig.agents)) {
    issues.push({
      severity: "error",
      file: fileLabel,
      path: "agents",
      code: "TYPE_COERCION",
      message: "agents must be an object/map, got array",
    });
    return {};
  }

  if (globalConfig.agents !== undefined && !isRecord(globalConfig.agents)) {
    issues.push({
      severity: "error",
      file: fileLabel,
      path: "agents",
      code: "TYPE_COERCION",
      message: `agents must be an object/map, got ${typeof globalConfig.agents}`,
    });
    return {};
  }

  const agents = isRecord(globalConfig.agents)
    ? globalConfig.agents as Record<string, Record<string, unknown>>
    : {};

  for (const key of Object.keys(agents)) {
    if (/^\d+$/.test(key)) {
      issues.push({
        severity: "warn",
        file: fileLabel,
        path: `agents.${key}`,
        agentId: key,
        code: "NUMERIC_AGENT_ID",
        message: `Agent ID "${key}" is numeric — YAML may have coerced this from an unquoted number. Use a string ID.`,
      });
    }
  }

  const mixins = globalConfig.mixins;
  if (mixins !== undefined) {
    if (!isRecord(mixins)) {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: "mixins",
        code: "INVALID_MIXINS",
        message: "mixins must be an object mapping mixin names to config fragments",
      });
    } else {
      for (const mixinName of Object.keys(mixins)) {
        const cycle = detectMixinCycle(mixinName, mixins as Record<string, Record<string, unknown>>, []);
        if (cycle) {
          issues.push({
            severity: "error",
            file: fileLabel,
            path: `mixins.${mixinName}`,
            code: "CIRCULAR_MIXIN",
            message: `Circular mixin reference: ${cycle}`,
          });
        }
      }
    }
  }

  for (const [agentId, agentDef] of Object.entries(agents)) {
    if (!isRecord(agentDef)) continue;

    for (const key of Object.keys(agentDef)) {
      if (!KNOWN_AGENT_KEYS.has(key)) {
        issues.push({
          severity: "warn",
          file: fileLabel,
          path: `agents.${agentId}.${key}`,
          agentId,
          code: "YAML_UNKNOWN_KEY",
          message: `Unknown agent config key "${key}" on ${agentId}`,
        });
      }
    }

    const expectations = agentDef.expectations;
    if (Array.isArray(expectations) && expectations.length === 0) {
      for (const domainEntry of domainConfigs) {
        if (!Array.isArray(domainEntry.config.agents) || !domainEntry.config.agents.includes(agentId)) continue;
        const defaults = isRecord(domainEntry.config.defaults)
          ? domainEntry.config.defaults
          : undefined;
        if (Array.isArray(defaults?.expectations) && defaults.expectations.length > 0) {
          issues.push({
            severity: "warn",
            file: fileLabel,
            path: `agents.${agentId}.expectations`,
            agentId,
            code: "EXPECTATION_OVERRIDE_CONFLICT",
            message: `Agent ${agentId} sets expectations: [] but domain "${domainEntry.config.domain}" defines default expectations — the explicit agent override will win.`,
          });
        }
      }
    }

    const extendsVal = agentDef.extends;
    if (typeof extendsVal === "string" && !KNOWN_PRESETS.has(extendsVal)) {
      issues.push({
        severity: "warn",
        file: fileLabel,
        path: `agents.${agentId}.extends`,
        agentId,
        code: "UNKNOWN_PRESET",
        message: `Agent ${agentId} extends unknown preset "${extendsVal}"`,
      });
    }

    const agentMixins = agentDef.mixins;
    if (Array.isArray(agentMixins)) {
      const definedMixins = isRecord(globalConfig.mixins)
        ? globalConfig.mixins
        : undefined;
      for (const mixinName of agentMixins) {
        if (typeof mixinName !== "string") {
          issues.push({
            severity: "error",
            file: fileLabel,
            path: `agents.${agentId}.mixins`,
            agentId,
            code: "INVALID_MIXIN_REF",
            message: `Agent ${agentId} has non-string mixin reference`,
          });
        } else if (!definedMixins || !(mixinName in definedMixins)) {
          issues.push({
            severity: "error",
            file: fileLabel,
            path: `agents.${agentId}.mixins`,
            agentId,
            code: "UNKNOWN_MIXIN",
            message: `Agent ${agentId} references undefined mixin "${mixinName}"`,
          });
        }
      }
    }

    if (typeof (agentDef.skillCap ?? agentDef.skill_cap) === "string") {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.skillCap`,
        agentId,
        code: "TYPE_COERCION",
        message: `Agent ${agentId}: skillCap must be a number, got string "${String(agentDef.skillCap ?? agentDef.skill_cap)}"`,
      });
    }

    if (typeof (agentDef.contextBudgetChars ?? agentDef.context_budget_chars) === "string") {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.contextBudgetChars`,
        agentId,
        code: "TYPE_COERCION",
        message: `Agent ${agentId}: contextBudgetChars must be a number, got string "${String(agentDef.contextBudgetChars ?? agentDef.context_budget_chars)}"`,
      });
    }

    if (typeof (agentDef.maxTurnsPerSession ?? agentDef.max_turns_per_session) === "string") {
      issues.push({
        severity: "error",
        file: fileLabel,
        path: `agents.${agentId}.maxTurnsPerSession`,
        agentId,
        code: "TYPE_COERCION",
        message: `Agent ${agentId}: maxTurnsPerSession must be a number, got string "${String(agentDef.maxTurnsPerSession ?? agentDef.max_turns_per_session)}"`,
      });
    }

    if (Array.isArray(agentDef.briefing)) {
      for (const entry of agentDef.briefing) {
        if (isRecord(entry) && typeof entry.source === "string" && !VALID_BRIEFING_SOURCES.has(entry.source)) {
          issues.push({
            severity: "warn",
            file: fileLabel,
            path: `agents.${agentId}.briefing`,
            agentId,
            code: "UNKNOWN_BRIEFING_SOURCE",
            message: `Agent ${agentId}: briefing source "${entry.source}" is not a known source — may be a typo`,
          });
        }
      }
    }

    if (Array.isArray(expectations)) {
      for (const exp of expectations) {
        if (isRecord(exp) && typeof exp.tool === "string" && !KNOWN_TOOLS.has(exp.tool) && !exp.tool.startsWith("memory_")) {
          issues.push({
            severity: "warn",
            file: fileLabel,
            path: `agents.${agentId}.expectations`,
            agentId,
            code: "UNKNOWN_EXPECTATION_TOOL",
            message: `Agent ${agentId}: expectation references unknown tool "${exp.tool}"`,
          });
        }
      }
    }

    if (isRecord(agentDef.jobs)) {
      for (const [jobName, job] of Object.entries(agentDef.jobs as Record<string, Record<string, unknown>>)) {
        if (!isRecord(job)) continue;
        const jobBriefing = job.briefing;
        if (Array.isArray(jobBriefing)) {
          for (const entry of jobBriefing) {
            if (isRecord(entry) && typeof entry.source === "string" && !VALID_BRIEFING_SOURCES.has(entry.source)) {
              issues.push({
                severity: "warn",
                file: fileLabel,
                path: `agents.${agentId}.jobs.${jobName}.briefing`,
                agentId,
                code: "UNKNOWN_BRIEFING_SOURCE",
                message: `Agent ${agentId}, job "${jobName}": briefing source "${entry.source}" is not a known source — may be a typo`,
              });
            }
          }
        }

        if (typeof job.frequency === "string" && !/^\d+\/(hour|day|week)$/.test(job.frequency)) {
          issues.push({
            severity: "warn",
            file: fileLabel,
            path: `agents.${agentId}.jobs.${jobName}.frequency`,
            agentId,
            code: "INVALID_FREQUENCY",
            message: `Agent ${agentId}, job "${jobName}": invalid frequency "${job.frequency}" — must be "N/period" where period is hour, day, or week`,
          });
        }
      }

      validateJobTriggers(fileLabel, agentId, agentDef.jobs as Record<string, Record<string, unknown>>, issues);
    }

    if (isRecord(agentDef.memory)) {
      validateAgentMemory(fileLabel, agentId, agentDef.memory, issues);
    }
  }

  return agents;
}

function validateDomains(
  baseDir: string,
  agents: Record<string, Record<string, unknown>>,
  domains: Array<{ file: string; config: Record<string, unknown> }>,
  issues: ValidationIssue[],
): void {
  const referencedAgents = new Set<string>();

  for (const { file, config } of domains) {
    for (const key of Object.keys(config)) {
      if (!KNOWN_DOMAIN_KEYS.has(key)) {
        issues.push({
          severity: "warn",
          file,
          path: key,
          code: "YAML_UNKNOWN_KEY",
          message: `Unknown domain config key "${key}"`,
        });
      }
    }

    const domainAgents = Array.isArray(config.agents) ? config.agents : [];
    for (const agentRef of domainAgents) {
      if (typeof agentRef !== "string") continue;
      referencedAgents.add(agentRef);
      if (!agents[agentRef]) {
        issues.push({
          severity: "error",
          file,
          path: "agents",
          agentId: agentRef,
          code: "DOMAIN_AGENT_NOT_GLOBAL",
          message: `Domain references agent "${agentRef}" not defined in config.yaml`,
        });
      }
    }

    if (config.manager !== undefined && !isRecord(config.manager)) {
      issues.push({
        severity: "error",
        file,
        path: "manager",
        code: "TYPE_COERCION",
        message: "manager must be an object with at least manager.agentId when provided",
      });
      continue;
    }

    const managerEnabled = isRecord(config.manager)
      ? config.manager.enabled !== false
      : true;
    const managerAgentId = managerEnabled && isRecord(config.manager) && typeof config.manager.agentId === "string"
      ? config.manager.agentId.trim()
      : "";
    if (managerAgentId && !domainAgents.includes(managerAgentId)) {
      issues.push({
        severity: "error",
        file,
        path: "manager.agentId",
        code: "MANAGER_NOT_IN_DOMAIN",
        message: `Domain manager "${managerAgentId}" is not in the domain agents list`,
      });
    }

    if (config.entities !== undefined) {
      try {
        const normalized = normalizeEntityKindsConfig(config.entities);
        const entityErrors = validateEntityKindsInConfig({
          agents,
          entities: normalized,
        });
        for (const error of entityErrors) {
          issues.push({
            severity: "error",
            file,
            path: "entities",
            code: "INVALID_ENTITY_CONFIG",
            message: error,
          });
        }
      } catch (err) {
        issues.push({
          severity: "error",
          file,
          path: "entities",
          code: "INVALID_ENTITY_CONFIG",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (config.execution !== undefined) {
      try {
        normalizeExecutionConfig(config.execution);
      } catch (err) {
        issues.push({
          severity: "error",
          file,
          path: "execution",
          code: "INVALID_EXECUTION_CONFIG",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (config.skills !== undefined) {
      if (!isRecord(config.skills)) {
        issues.push({
          severity: "error",
          file,
          path: "skills",
          code: "INVALID_DOMAIN_SKILLS",
          message: "skills must be an object mapping topic IDs to skill definitions",
        });
      } else {
        const firstPath = Array.isArray(config.paths) && typeof config.paths[0] === "string"
          ? String(config.paths[0]).trim()
          : "";
        if (!firstPath) {
          issues.push({
            severity: "error",
            file,
            path: "skills",
            code: "DOMAIN_SKILLS_REQUIRE_PATHS",
            message: "Domain skills require at least one project path so topic files can be resolved safely",
          });
        } else {
          const projectDir = resolveConfigPath(baseDir, firstPath);
          for (const [skillId, skillDef] of Object.entries(config.skills)) {
            if (!isRecord(skillDef)) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}`,
                code: "INVALID_DOMAIN_SKILLS",
                message: `Skill "${skillId}" must be an object`,
              });
              continue;
            }

            if (typeof skillDef.title !== "string" || !skillDef.title.trim()) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}.title`,
                code: "INVALID_DOMAIN_SKILLS",
                message: `Skill "${skillId}" must define a non-empty title`,
              });
            }
            if (typeof skillDef.description !== "string" || !skillDef.description.trim()) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}.description`,
                code: "INVALID_DOMAIN_SKILLS",
                message: `Skill "${skillId}" must define a non-empty description`,
              });
            }
            if (typeof skillDef.path !== "string" || !skillDef.path.trim()) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}.path`,
                code: "INVALID_DOMAIN_SKILLS",
                message: `Skill "${skillId}" must define a non-empty path`,
              });
              continue;
            }

            const resolvedSkillPath = path.resolve(projectDir, skillDef.path);
            if (resolvedSkillPath !== projectDir && !resolvedSkillPath.startsWith(projectDir + path.sep)) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}.path`,
                code: "SKILL_PATH_OUTSIDE_PROJECT",
                message: `Skill "${skillId}" resolves outside the project path and will not be loaded`,
              });
              continue;
            }

            if (!fs.existsSync(resolvedSkillPath)) {
              issues.push({
                severity: "error",
                file,
                path: `skills.${skillId}.path`,
                code: "SKILL_FILE_NOT_FOUND",
                message: `Skill "${skillId}" file not found at ${resolvedSkillPath}`,
              });
            }
          }
        }
      }
    }
  }

  for (const agentId of Object.keys(agents)) {
    if (!referencedAgents.has(agentId)) {
      issues.push({
        severity: "suggest",
        file: GLOBAL_CONFIG_FILE,
        agentId,
        code: "ORPHAN_AGENT",
        message: `Agent "${agentId}" is defined but not included in any domain`,
      });
    }
  }
}

export function validateAllConfigs(baseDir: string): ValidationReport {
  const issues: ValidationIssue[] = [];
  const globalPath = path.join(baseDir, GLOBAL_CONFIG_FILE);
  const globalConfig = parseYamlFile(globalPath, GLOBAL_CONFIG_FILE, issues);
  if (!globalConfig) {
    return { valid: false, issues };
  }

  const domainsDir = path.join(baseDir, DOMAINS_DIR);
  const domainFiles = fs.existsSync(domainsDir)
    ? fs.readdirSync(domainsDir).filter((file) => file.endsWith(".yaml")).sort()
    : [];

  if (domainFiles.length === 0) {
    issues.push({
      severity: "error",
      file: `${DOMAINS_DIR}/`,
      code: "FILE_NOT_FOUND",
      message: "No domain configs found in domains/",
    });
  }

  const domainConfigs: Array<{ file: string; config: Record<string, unknown> }> = [];
  for (const file of domainFiles) {
    const fileLabel = path.join(DOMAINS_DIR, file);
    const domainConfig = parseYamlFile(path.join(domainsDir, file), fileLabel, issues);
    if (domainConfig) {
      domainConfigs.push({ file: fileLabel, config: domainConfig });
    }
  }

  const agents = validateGlobalAgents(globalConfig, GLOBAL_CONFIG_FILE, domainConfigs, issues);
  validateDomains(baseDir, agents, domainConfigs, issues);

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function detectMixinCycle(
  name: string,
  allMixins: Record<string, Record<string, unknown>>,
  chain: string[],
): string | null {
  if (chain.includes(name)) {
    return [...chain, name].join(" → ");
  }

  const mixin = allMixins[name];
  if (!mixin) return null;
  const nested = mixin.mixins;
  if (!Array.isArray(nested)) return null;

  for (const child of nested) {
    if (typeof child !== "string") continue;
    const cycle = detectMixinCycle(child, allMixins, [...chain, name]);
    if (cycle) return cycle;
  }

  return null;
}
