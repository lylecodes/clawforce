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
  "team_templates",
]);

const KNOWN_AGENT_KEYS = new Set([
  "extends", "role", "title", "description", "department", "team",
  "group", "subgroup", "reports_to", "briefing", "expectations",
  "performance_policy", "tools", "verification", "jobs", "scheduling",
  "memory", "auto_recovery", "channel", "observe", "compaction",
  "skill_pack", "coordination", "skillCap", "contextBudgetChars",
  "maxTurnsPerSession", "model", "exclude_briefing",
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
