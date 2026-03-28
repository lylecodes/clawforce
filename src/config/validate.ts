/**
 * Clawforce — Config validation module
 *
 * Validates all config at load time, reporting ALL issues at once.
 * Catches YAML errors, schema violations, and semantic conflicts
 * between presets, agent config, and domain defaults.
 */

import fs from "node:fs";
import path from "node:path";
import { safeLog } from "../diagnostics.js";
import { VALID_BRIEFING_SOURCES, KNOWN_TOOLS } from "../config-validator.js";

// --- Types ---

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

// --- Known keys ---

const KNOWN_GLOBAL_KEYS = new Set([
  "version", "project_id", "name", "description", "project_dir",
  "agents", "domains", "defaults", "budget", "telemetry", "profiles",
  "team_templates", "mixins",
]);

const KNOWN_AGENT_KEYS = new Set([
  "extends", "role", "title", "description", "department", "team",
  "group", "subgroup", "reports_to", "briefing", "expectations",
  "performance_policy", "tools", "verification", "jobs", "scheduling",
  "memory", "auto_recovery", "channel", "observe", "compaction",
  "skill_pack", "coordination", "skillCap", "contextBudgetChars",
  "maxTurnsPerSession", "model", "exclude_briefing", "mixins",
]);

const KNOWN_DOMAIN_KEYS = new Set([
  "agents", "manager", "worker_agents", "paths", "defaults",
  "manager_overrides", "orchestrator", "dispatch", "verification",
  "role_defaults", "team_templates",
]);

// --- Core ---

/**
 * Validate all config files in a project directory.
 * Returns a report with all issues found.
 */
export function validateAllConfigs(baseDir: string): ValidationReport {
  const issues: ValidationIssue[] = [];

  // Find project.yaml
  const projectYaml = path.join(baseDir, "project.yaml");
  if (!fs.existsSync(projectYaml)) {
    issues.push({
      severity: "error",
      file: "project.yaml",
      code: "FILE_NOT_FOUND",
      message: "project.yaml not found in config directory",
    });
    return { valid: false, issues };
  }

  // Try to parse YAML
  let parsed: Record<string, unknown>;
  try {
    const content = fs.readFileSync(projectYaml, "utf-8");
    // Dynamic import would be ideal but we need sync. Use a simple check.
    const yaml = requireYaml();
    if (!yaml) {
      issues.push({
        severity: "warn",
        file: "project.yaml",
        code: "YAML_PARSER_UNAVAILABLE",
        message: "YAML parser not available — skipping syntax validation",
      });
      return { valid: true, issues };
    }
    parsed = yaml.parse(content) as Record<string, unknown>;
  } catch (err) {
    issues.push({
      severity: "error",
      file: "project.yaml",
      code: "YAML_PARSE_ERROR",
      message: `YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, issues };
  }

  if (!parsed || typeof parsed !== "object") {
    issues.push({
      severity: "error",
      file: "project.yaml",
      code: "YAML_EMPTY",
      message: "project.yaml is empty or not an object",
    });
    return { valid: false, issues };
  }

  // Check unknown top-level keys
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_GLOBAL_KEYS.has(key) && key !== "domain") {
      issues.push({
        severity: "warn",
        file: "project.yaml",
        path: key,
        code: "YAML_UNKNOWN_KEY",
        message: `Unknown top-level key "${key}" — may be a typo`,
      });
    }
  }

  // Validate agents
  const agents = parsed.agents as Record<string, Record<string, unknown>> | undefined;
  if (agents && typeof agents === "object") {
    for (const [agentId, agentDef] of Object.entries(agents)) {
      if (!agentDef || typeof agentDef !== "object") continue;

      // Check unknown agent keys
      for (const key of Object.keys(agentDef)) {
        if (!KNOWN_AGENT_KEYS.has(key)) {
          issues.push({
            severity: "warn",
            file: "project.yaml",
            path: `agents.${agentId}.${key}`,
            agentId,
            code: "YAML_UNKNOWN_KEY",
            message: `Unknown agent config key "${key}" on ${agentId}`,
          });
        }
      }

      // Check expectation override conflict
      if ("expectations" in agentDef) {
        const expectations = agentDef.expectations;
        if (Array.isArray(expectations) && expectations.length === 0) {
          // User explicitly set expectations: [] — check if domain defaults will try to add some
          const domain = (parsed.domain ?? parsed.domains) as Record<string, unknown> | undefined;
          const defaults = domain?.defaults as Record<string, unknown> | undefined;
          if (defaults?.expectations && Array.isArray(defaults.expectations) && (defaults.expectations as unknown[]).length > 0) {
            issues.push({
              severity: "warn",
              file: "project.yaml",
              path: `agents.${agentId}.expectations`,
              agentId,
              code: "EXPECTATION_OVERRIDE_CONFLICT",
              message: `Agent ${agentId} sets expectations: [] but domain defaults define expectations — user override will be respected (domain defaults skipped)`,
            });
          }
        }
      }

      // Check unknown preset
      const extendsVal = agentDef.extends ?? agentDef.role;
      if (extendsVal && typeof extendsVal === "string") {
        const knownPresets = new Set(["manager", "employee", "ops", "verifier", "analyst", "orchestrator"]);
        if (!knownPresets.has(extendsVal)) {
          issues.push({
            severity: "warn",
            file: "project.yaml",
            path: `agents.${agentId}.extends`,
            agentId,
            code: "UNKNOWN_PRESET",
            message: `Agent ${agentId} extends unknown preset "${extendsVal}"`,
          });
        }
      }

      // Check mixin references exist
      const agentMixins = agentDef.mixins;
      if (Array.isArray(agentMixins)) {
        const definedMixins = parsed.mixins as Record<string, unknown> | undefined;
        for (const mixinName of agentMixins) {
          if (typeof mixinName !== "string") {
            issues.push({
              severity: "error",
              file: "project.yaml",
              path: `agents.${agentId}.mixins`,
              agentId,
              code: "INVALID_MIXIN_REF",
              message: `Agent ${agentId} has non-string mixin reference`,
            });
          } else if (!definedMixins || !(mixinName in definedMixins)) {
            issues.push({
              severity: "error",
              file: "project.yaml",
              path: `agents.${agentId}.mixins`,
              agentId,
              code: "UNKNOWN_MIXIN",
              message: `Agent ${agentId} references undefined mixin "${mixinName}"`,
            });
          }
        }
      }

      // --- Type coercion checks ---
      if ("skillCap" in agentDef && typeof agentDef.skillCap === "string") {
        issues.push({
          severity: "error",
          file: "project.yaml",
          path: `agents.${agentId}.skillCap`,
          agentId,
          code: "TYPE_COERCION",
          message: `Agent ${agentId}: skillCap must be a number, got string "${agentDef.skillCap}"`,
        });
      }

      if ("contextBudgetChars" in agentDef && typeof agentDef.contextBudgetChars === "string") {
        issues.push({
          severity: "error",
          file: "project.yaml",
          path: `agents.${agentId}.contextBudgetChars`,
          agentId,
          code: "TYPE_COERCION",
          message: `Agent ${agentId}: contextBudgetChars must be a number, got string "${agentDef.contextBudgetChars}"`,
        });
      }

      if ("maxTurnsPerSession" in agentDef && typeof agentDef.maxTurnsPerSession === "string") {
        issues.push({
          severity: "error",
          file: "project.yaml",
          path: `agents.${agentId}.maxTurnsPerSession`,
          agentId,
          code: "TYPE_COERCION",
          message: `Agent ${agentId}: maxTurnsPerSession must be a number, got string "${agentDef.maxTurnsPerSession}"`,
        });
      }

      // --- Briefing source validation ---
      const briefing = agentDef.briefing ?? agentDef.context_in;
      if (Array.isArray(briefing)) {
        for (const entry of briefing) {
          if (entry && typeof entry === "object" && "source" in entry) {
            const src = (entry as Record<string, unknown>).source;
            if (typeof src === "string" && !VALID_BRIEFING_SOURCES.has(src)) {
              issues.push({
                severity: "warn",
                file: "project.yaml",
                path: `agents.${agentId}.briefing`,
                agentId,
                code: "UNKNOWN_BRIEFING_SOURCE",
                message: `Agent ${agentId}: briefing source "${src}" is not a known source — may be a typo`,
              });
            }
          }
        }
      }

      // --- Expectation tool validation ---
      const expectations = agentDef.expectations ?? agentDef.required_outputs;
      if (Array.isArray(expectations)) {
        for (const exp of expectations) {
          if (exp && typeof exp === "object" && "tool" in exp) {
            const tool = (exp as Record<string, unknown>).tool;
            if (typeof tool === "string" && !KNOWN_TOOLS.has(tool) && !tool.startsWith("memory_")) {
              issues.push({
                severity: "warn",
                file: "project.yaml",
                path: `agents.${agentId}.expectations`,
                agentId,
                code: "UNKNOWN_EXPECTATION_TOOL",
                message: `Agent ${agentId}: expectation references unknown tool "${tool}"`,
              });
            }
          }
        }
      }

      // --- Job validation ---
      const jobs = agentDef.jobs as Record<string, Record<string, unknown>> | undefined;
      if (jobs && typeof jobs === "object") {
        for (const [jobName, job] of Object.entries(jobs)) {
          if (!job || typeof job !== "object") continue;

          // Job briefing source validation
          const jobBriefing = job.briefing as unknown[];
          if (Array.isArray(jobBriefing)) {
            for (const entry of jobBriefing) {
              if (entry && typeof entry === "object" && "source" in (entry as Record<string, unknown>)) {
                const src = (entry as Record<string, unknown>).source;
                if (typeof src === "string" && !VALID_BRIEFING_SOURCES.has(src)) {
                  issues.push({
                    severity: "warn",
                    file: "project.yaml",
                    path: `agents.${agentId}.jobs.${jobName}.briefing`,
                    agentId,
                    code: "UNKNOWN_BRIEFING_SOURCE",
                    message: `Agent ${agentId}, job "${jobName}": briefing source "${src}" is not a known source — may be a typo`,
                  });
                }
              }
            }
          }

          // Job frequency validation
          const freq = job.frequency;
          if (typeof freq === "string" && !/^\d+\/(hour|day|week)$/.test(freq)) {
            issues.push({
              severity: "warn",
              file: "project.yaml",
              path: `agents.${agentId}.jobs.${jobName}.frequency`,
              agentId,
              code: "INVALID_FREQUENCY",
              message: `Agent ${agentId}, job "${jobName}": invalid frequency "${freq}" — must be "N/period" where period is hour, day, or week`,
            });
          }
        }
      }
    }
  }

  // --- Global type coercion checks ---
  if (Array.isArray(parsed.agents)) {
    issues.push({
      severity: "error",
      file: "project.yaml",
      path: "agents",
      code: "TYPE_COERCION",
      message: "agents must be an object/map, got array",
    });
  } else if (parsed.agents !== undefined && typeof parsed.agents !== "object") {
    issues.push({
      severity: "error",
      file: "project.yaml",
      path: "agents",
      code: "TYPE_COERCION",
      message: `agents must be an object/map, got ${typeof parsed.agents}`,
    });
  }

  // Check for number agent IDs (YAML parses `123:` as a number key)
  if (agents && typeof agents === "object") {
    for (const key of Object.keys(agents)) {
      if (/^\d+$/.test(key)) {
        issues.push({
          severity: "warn",
          file: "project.yaml",
          path: `agents.${key}`,
          agentId: key,
          code: "NUMERIC_AGENT_ID",
          message: `Agent ID "${key}" is numeric — YAML may have coerced this from an unquoted number. Use a string ID.`,
        });
      }
    }
  }

  // Validate mixins section
  const mixins = parsed.mixins as Record<string, Record<string, unknown>> | undefined;
  if (mixins !== undefined) {
    if (typeof mixins !== "object" || mixins === null || Array.isArray(mixins)) {
      issues.push({
        severity: "error",
        file: "project.yaml",
        path: "mixins",
        code: "INVALID_MIXINS",
        message: "mixins must be an object mapping mixin names to config fragments",
      });
    } else {
      // Check for circular mixin references
      for (const mixinName of Object.keys(mixins)) {
        const cycle = detectMixinCycle(mixinName, mixins, []);
        if (cycle) {
          issues.push({
            severity: "error",
            file: "project.yaml",
            path: `mixins.${mixinName}`,
            code: "CIRCULAR_MIXIN",
            message: `Circular mixin reference: ${cycle}`,
          });
        }
      }
    }
  }

  // Validate job triggers — check trigger event types are known
  if (agents && typeof agents === "object") {
    const knownTriggerEvents = new Set([
      "ci_failed", "pr_opened", "deploy_finished", "task_completed",
      "task_failed", "task_assigned", "task_created", "sweep_finding",
      "dispatch_succeeded", "dispatch_failed", "task_review_ready",
      "dispatch_dead_letter", "proposal_approved", "proposal_created",
      "proposal_rejected", "message_sent",
      "protocol_started", "protocol_responded", "protocol_completed",
      "protocol_expired", "protocol_escalated",
      "goal_created", "goal_achieved", "goal_abandoned", "custom",
    ]);
    for (const [agentId, agentDef] of Object.entries(agents)) {
      if (!agentDef || typeof agentDef !== "object") continue;
      const agentJobs = agentDef.jobs as Record<string, Record<string, unknown>> | undefined;
      if (!agentJobs || typeof agentJobs !== "object") continue;
      for (const [jobName, jobDef] of Object.entries(agentJobs)) {
        if (!jobDef || typeof jobDef !== "object") continue;
        const triggers = jobDef.triggers;
        if (!triggers) continue;
        if (!Array.isArray(triggers)) {
          issues.push({
            severity: "error",
            file: "project.yaml",
            path: `agents.${agentId}.jobs.${jobName}.triggers`,
            agentId,
            code: "INVALID_TRIGGERS",
            message: `Job ${jobName} on ${agentId}: triggers must be an array`,
          });
          continue;
        }
        for (let i = 0; i < triggers.length; i++) {
          const trigger = triggers[i] as Record<string, unknown> | undefined;
          if (!trigger || typeof trigger !== "object") {
            issues.push({
              severity: "error",
              file: "project.yaml",
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
              file: "project.yaml",
              path: `agents.${agentId}.jobs.${jobName}.triggers[${i}].on`,
              agentId,
              code: "MISSING_TRIGGER_EVENT",
              message: `Job ${jobName} on ${agentId}: trigger[${i}] missing required "on" event type`,
            });
          } else if (!knownTriggerEvents.has(trigger.on)) {
            issues.push({
              severity: "warn",
              file: "project.yaml",
              path: `agents.${agentId}.jobs.${jobName}.triggers[${i}].on`,
              agentId,
              code: "UNKNOWN_TRIGGER_EVENT",
              message: `Job ${jobName} on ${agentId}: unknown trigger event "${trigger.on}"`,
            });
          }
        }
      }
    }
  }

  // Validate domain
  const domain = (parsed.domain ?? parsed.domains) as Record<string, unknown> | undefined;
  if (domain && typeof domain === "object") {
    // Check unknown domain keys
    for (const key of Object.keys(domain)) {
      if (!KNOWN_DOMAIN_KEYS.has(key)) {
        issues.push({
          severity: "warn",
          file: "project.yaml",
          path: `domain.${key}`,
          code: "YAML_UNKNOWN_KEY",
          message: `Unknown domain config key "${key}"`,
        });
      }
    }

    // Check domain agents reference valid global agents
    const domainAgents = domain.agents as string[] | undefined;
    if (domainAgents && Array.isArray(domainAgents) && agents) {
      for (const agentRef of domainAgents) {
        if (!agents[agentRef]) {
          issues.push({
            severity: "error",
            file: "project.yaml",
            path: `domain.agents`,
            agentId: agentRef,
            code: "DOMAIN_AGENT_NOT_GLOBAL",
            message: `Domain references agent "${agentRef}" not defined in agents section`,
          });
        }
      }
    }

    // Check manager is in domain agents
    const manager = domain.manager as string | undefined;
    if (manager && domainAgents && !domainAgents.includes(manager)) {
      issues.push({
        severity: "error",
        file: "project.yaml",
        path: "domain.manager",
        code: "ORCHESTRATOR_NOT_IN_DOMAIN",
        message: `Domain manager "${manager}" is not in the domain agents list`,
      });
    }
  }

  // Check orphan agents (defined globally but not in any domain)
  if (agents && domain) {
    const domainAgents = new Set((domain.agents as string[]) ?? []);
    for (const agentId of Object.keys(agents)) {
      if (!domainAgents.has(agentId)) {
        issues.push({
          severity: "suggest",
          file: "project.yaml",
          agentId,
          code: "ORPHAN_AGENT",
          message: `Agent "${agentId}" is defined but not included in any domain`,
        });
      }
    }
  }

  const hasErrors = issues.some(i => i.severity === "error");
  return { valid: !hasErrors, issues };
}

// --- Helpers ---

/**
 * Detect circular mixin references by walking the mixin.mixins graph.
 * Returns the cycle chain as a string if found, null otherwise.
 */
function detectMixinCycle(
  name: string,
  allMixins: Record<string, Record<string, unknown>>,
  path: string[],
): string | null {
  if (path.includes(name)) {
    return [...path, name].join(" → ");
  }

  const mixin = allMixins[name];
  if (!mixin) return null;

  const nested = mixin.mixins;
  if (!Array.isArray(nested)) return null;

  for (const child of nested) {
    if (typeof child !== "string") continue;
    const cycle = detectMixinCycle(child, allMixins, [...path, name]);
    if (cycle) return cycle;
  }

  return null;
}

function requireYaml(): { parse: (s: string) => unknown } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("yaml") as { parse: (s: string) => unknown };
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("js-yaml") as { parse: (s: string) => unknown };
    } catch {
      return null;
    }
  }
}
