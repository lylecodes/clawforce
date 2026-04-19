/**
 * Clawforce — Setup tool
 *
 * Onboarding tool for agents to help users configure clawforce.
 * Actions: explain, status, validate, activate, scaffold.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Type } from "@sinclair/typebox";
import { getActiveProjectIds, isClawforceInitialized } from "../lifecycle.js";
import {
  getAgentConfig,
  getRegisteredAgentIds,
  loadWorkforceConfig,
  parseWorkforceConfigContent,
  resolveProjectDir,
} from "../project.js";
import { safeLog } from "../diagnostics.js";
import { validateWorkforceConfig } from "../config-validator.js";
import { recoverOrphanedSessions } from "../enforcement/tracker.js";
import { buildExplainContent } from "../context/onboarding.js";
import { resolveSkillSource } from "../skills/registry.js";
import { resolveEffectiveScope } from "../scope.js";
import { generateScoped } from "../skills/topics/tools.js";
import { generateSoulTemplate, isSoulTemplateUnmodified } from "../context/sources/auto-generate.js";
import { reloadDomain } from "../config/init.js";
import { validateDomainConfig } from "../config/schema.js";
import { runCreateStarterDomainCommand } from "../app/commands/domain-setup.js";
import {
  buildSetupReport,
  buildSetupExplanation,
  renderSetupExplain,
  resolveSetupRoot,
} from "../setup/report.js";
import { STARTER_WORKFLOW_TYPES } from "../setup/workflows.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, safeExecute } from "./common.js";

const SETUP_ACTIONS = ["explain", "status", "validate", "activate", "scaffold"] as const;

const ClawforceSetupSchema = Type.Object({
  action: stringEnum(SETUP_ACTIONS, { description: "Action to perform. Use 'explain' to get the full reference docs." }),
  yaml_content: Type.Optional(Type.String({ description: "Raw config YAML content to validate (for validate action)." })),
  config_path: Type.Optional(Type.String({ description: "Path to a config directory, config.yaml, or domains/*.yaml file to validate (for validate action)." })),
  project_id: Type.Optional(Type.String({ description: "Domain ID (for activate/scaffold action)." })),
  agent_id: Type.Optional(Type.String({ description: "Agent ID to target for SOUL scaffolding. Omit to scaffold all agents in the active domain." })),
  mode: Type.Optional(stringEnum(["new", "governance"] as const, { description: "Starter-domain scaffold mode. Pass with scaffold to create a real starter domain." })),
  workflow: Type.Optional(stringEnum(STARTER_WORKFLOW_TYPES, { description: "Starter workflow capability to scaffold and validate as part of setup." })),
  mission: Type.Optional(Type.String({ description: "Mission prompt for new-mode starter scaffolds." })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Project paths for starter-domain scaffolds." })),
  operational_profile: Type.Optional(Type.String({ description: "Operational profile for starter-domain scaffolds (low, medium, high, ultra)." })),
  existing_agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Existing agent IDs to attach in governance-mode starter scaffolds." })),
  lead_agent_id: Type.Optional(Type.String({ description: "Lead agent ID for governance-mode starter scaffolds." })),
  topic: Type.Optional(Type.String({ description: "Skill topic ID to query (e.g. 'roles', 'tasks', 'memory'). Omit for full reference." })),
});

export function createClawforceSetupTool(options: {
  projectsDir: string;
  agentId?: string;
}) {
  return {
    label: "Workforce Setup",
    name: "clawforce_setup",
    description:
      "Set up and configure AI workforce projects. " +
      "explain: Full reference docs — domain config format, roles, accountability, examples. " +
      "status: What projects and employees are currently configured. " +
      "validate: Check split config files or a YAML config document (pass yaml_content or config_path). " +
      "activate: Load or reload a configured domain from disk (pass project_id). " +
      "scaffold: Create a starter domain when mode=new|governance is passed, otherwise scaffold SOUL.md templates for agent customization.",
    parameters: ClawforceSetupSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;

        switch (action) {
          case "explain":
            return handleExplain(options.projectsDir, options.agentId, readStringParam(params, "topic"));

          case "status":
            return handleStatus(options.projectsDir);

          case "validate":
            return handleValidate(params, options.projectsDir);

          case "activate":
            return handleActivate(params, options.projectsDir);

          case "scaffold":
            return handleScaffold(options.projectsDir, params);

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

function handleExplain(projectsDir: string, agentId?: string, topic?: string | null): ToolResult {
  if (topic) {
    // When topic is "tools" and we have an agentId, return scoped content
    if (topic === "tools" && agentId) {
      const scope = resolveEffectiveScope(agentId);
      if (scope) {
        const content = generateScoped(scope);
        return jsonResult({ ok: true, topic, reference: content });
      }
    }

    // Resolve the agent's actual preset for topic access checks
    const agentEntry = agentId ? getAgentConfig(agentId) : null;
    const preset = agentEntry?.config.extends ?? "manager";
    const content = resolveSkillSource(preset, topic, undefined, agentEntry?.projectId);
    if (content === null) {
      return jsonResult({ ok: false, reason: `Unknown topic: "${topic}".` });
    }
    return jsonResult({ ok: true, topic, reference: content });
  }
  const report = buildSetupReport(resolveProjectDir(projectsDir));
  return jsonResult({
    ok: true,
    explanation: buildSetupExplanation(report),
    setup: report,
    reference: `${buildExplainContent(projectsDir)}\n\n${renderSetupExplain(report)}`,
  });
}

function handleStatus(projectsDir: string): ToolResult {
  const resolvedDir = resolveProjectDir(projectsDir);
  const initialized = isClawforceInitialized();
  const projectIds = getActiveProjectIds();

  const projects: Array<{
    id: string;
    agents: Array<{ id: string; extends: string | undefined }>;
  }> = [];

  for (const pid of projectIds) {
    const agents: Array<{ id: string; extends: string | undefined }> = [];
    for (const aid of getRegisteredAgentIds(pid)) {
      const entry = getAgentConfig(aid, pid);
      if (entry) {
        agents.push({ id: aid, extends: entry.config.extends });
      }
    }
    projects.push({ id: pid, agents });
  }

  const onDiskProjects: string[] = [];
  try {
    const domainsDir = path.join(resolvedDir, "domains");
    if (fs.existsSync(domainsDir)) {
      const entries = fs.readdirSync(domainsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".yaml")) {
          onDiskProjects.push(entry.name.replace(/\.yaml$/, ""));
        }
      }
    }
  } catch (err) { safeLog("setup.status.scanProjects", err); }

  const inactiveProjects = onDiskProjects.filter((id) => !projectIds.includes(id));
  const report = buildSetupReport(resolvedDir);

  return jsonResult({
    ok: true,
    initialized,
    projects_dir: resolvedDir,
    projects_dir_exists: fs.existsSync(resolvedDir),
    project_count: projectIds.length,
    projects,
    inactive_projects_on_disk: inactiveProjects,
    setup: report,
    hint: projectIds.length === 0
      ? "No domains configured. Use 'explain' to get the full setup reference, then create config.yaml + domains/*.yaml and 'activate' one."
      : undefined,
    agent_id_help: "Agent IDs in your domain config must match the agent IDs available in your chosen execution environment. If you're unsure, check the runtime or adapter configuration you plan to dispatch through.",
  });
}

function handleValidate(params: Record<string, unknown>, projectsDir: string): ToolResult {
  const yamlContent = readStringParam(params, "yaml_content");
  const configPath = readStringParam(params, "config_path");

  if (!yamlContent && !configPath) {
    return jsonResult({
      ok: false,
      reason: "Provide either yaml_content (raw YAML string) or config_path (file path) to validate.",
    });
  }

  if (configPath) {
    // Validate that config_path resolves within the projects directory or temp dir
    const resolved = path.resolve(configPath);
    const allowedRoot = path.resolve(projectsDir);
    const tempRoot = path.resolve(os.tmpdir());
    const withinProjectsDir = resolved === allowedRoot || resolved.startsWith(allowedRoot + path.sep);
    const withinTempDir = resolved === tempRoot || resolved.startsWith(tempRoot + path.sep);
    if (!withinProjectsDir && !withinTempDir) {
      return jsonResult({
        ok: false,
        reason: `config_path must be within the projects directory. Got: ${configPath}`,
      });
    }

    if (!fs.existsSync(resolved)) {
      return jsonResult({
        ok: false,
        reason: `Cannot read file: ENOENT: no such file or directory, open '${configPath}'`,
      });
    }

    const configRoot = resolveSetupRoot(resolved);
    if (configRoot) {
      const report = buildSetupReport(configRoot);
      return jsonResult({
        ok: report.valid,
        valid: report.valid,
        issues: report.issues.map((issue) => ({
          level: issue.severity,
          file: issue.file,
          path: issue.path,
          agentId: issue.agentId,
          code: issue.code,
          message: issue.message,
        })),
        checks: report.checks,
        next_steps: report.nextSteps,
      });
    }
  }

  let content: string;
  if (yamlContent) {
    content = yamlContent;
  } else {
    try {
      content = fs.readFileSync(configPath!, "utf-8");
    } catch (err) {
      return jsonResult({
        ok: false,
        reason: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Parse YAML
  let raw: Record<string, unknown>;
  try {
    raw = YAML.parse(content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      return jsonResult({ ok: false, reason: "Invalid YAML: parsed result is not an object." });
    }
  } catch (err) {
    return jsonResult({
      ok: false,
      reason: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const issues: Array<{ level: string; message: string }> = [];

  if (typeof raw.domain === "string") {
    const result = validateDomainConfig(raw);
    for (const error of result.errors) {
      issues.push({ level: "error", message: `${error.field}: ${error.message}` });
    }
    const hasErrors = issues.some((i) => i.level === "error");
    return jsonResult({
      ok: !hasErrors,
      valid: !hasErrors,
      issues,
      domain_preview: {
        domain: raw.domain,
        agents: Array.isArray(raw.agents) ? raw.agents : [],
      },
    });
  }

  let wfConfig;
  if (configPath) {
    try {
      wfConfig = loadWorkforceConfig(configPath);
    } catch (err) {
      issues.push({
        level: "error",
        message: `Failed to load workforce config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    try {
      wfConfig = parseWorkforceConfigContent(content);
    } catch (err) {
      issues.push({
        level: "error",
        message: `Failed to load workforce config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Validate workforce config
  let agentPreview: Array<{ id: string; extends: string | undefined; expectations: number }> = [];
  if (wfConfig) {
    const warnings = validateWorkforceConfig(wfConfig);
    for (const w of warnings) {
      const prefix = w.agentId ? `[${w.agentId}] ` : "";
      issues.push({ level: w.level, message: `${prefix}${w.message}` });
    }

    agentPreview = Object.entries(wfConfig.agents).map(([id, config]) => ({
      id,
      extends: config.extends,
      expectations: config.expectations.length,
    }));
  }

  const hasErrors = issues.some((i) => i.level === "error");

  return jsonResult({
    ok: !hasErrors,
    valid: !hasErrors,
    issues,
    agent_preview: agentPreview,
  });
}

async function handleActivate(params: Record<string, unknown>, projectsDir: string): Promise<ToolResult> {
  const projectId = readStringParam(params, "project_id", { required: true })!;
  const resolvedDir = resolveProjectDir(projectsDir);
  const domainPath = path.join(resolvedDir, "domains", `${projectId}.yaml`);

  if (!fs.existsSync(domainPath)) {
    return jsonResult({
      ok: false,
      reason: `No domain config found at ${domainPath}. Create the file first, then activate.`,
    });
  }

  const activeIds = getActiveProjectIds();
  const isReload = activeIds.includes(projectId);
  const result = reloadDomain(resolvedDir, projectId);
  if (!result.domains.includes(projectId)) {
    const matchingErrors = result.errors.filter((err) => err.includes(`"${projectId}"`));
    const reason = matchingErrors[0] ?? `Domain "${projectId}" was not loaded.`;
    return jsonResult({
      ok: false,
      reason,
      errors: matchingErrors.length > 0 ? matchingErrors : result.errors,
      warnings: result.warnings,
    });
  }

  const orphans = recoverOrphanedSessions(projectId);
  const agents = getRegisteredAgentIds(projectId).map((agentId) => {
    const entry = getAgentConfig(agentId, projectId);
    return { id: agentId, extends: entry?.config.extends };
  });

  const verb = isReload ? "reloaded" : "activated";
  return jsonResult({
    ok: true,
    project_id: projectId,
    reloaded: isReload,
    agents,
    orphaned_sessions_recovered: orphans.length,
    warnings: result.warnings,
    message: `Project "${projectId}" ${verb} with ${agents.length} agent(s) registered.`,
  });
}

function handleScaffold(projectsDir: string, params: Record<string, unknown>): ToolResult {
  const resolvedDir = resolveProjectDir(projectsDir);
  const projectId = readStringParam(params, "project_id");
  const agentId = readStringParam(params, "agent_id");
  const mode = readStringParam(params, "mode");

  if (mode) {
    if (!projectId) {
      return jsonResult({ ok: false, reason: "project_id is required when scaffold mode is set." });
    }

    const rawPaths = Array.isArray(params.paths)
      ? params.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const existingAgents = Array.isArray(params.existing_agents)
      ? params.existing_agents.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const result = runCreateStarterDomainCommand({
      domainId: projectId,
      mode,
      workflow: readStringParam(params, "workflow") ?? undefined,
      mission: readStringParam(params, "mission") ?? undefined,
      paths: rawPaths,
      operational_profile: readStringParam(params, "operational_profile") ?? undefined,
      existingAgents,
      leadAgentId: readStringParam(params, "lead_agent_id") ?? undefined,
    }, "clawforce_setup", { baseDir: resolvedDir });

    if (!result.ok) {
      return jsonResult({ ok: false, reason: result.error });
    }

    return jsonResult({
      ok: true,
      project_id: result.domainId,
      mode: result.mode,
      created_agent_ids: result.createdAgentIds,
      reused_agent_ids: result.reusedAgentIds,
      reload_errors: result.reloadErrors,
      setup: buildSetupReport(resolvedDir, result.domainId),
      message: `${result.message} Review setup.status or setup.validate before starting the controller.`,
    });
  }

  // Auto-resolve project if not specified
  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    const activeIds = getActiveProjectIds();
    if (activeIds.length === 0) {
      return jsonResult({ ok: false, reason: "No active projects. Activate a project first." });
    }
    if (activeIds.length > 1) {
      return jsonResult({ ok: false, reason: `Multiple projects active (${activeIds.join(", ")}). Specify project_id.` });
    }
    resolvedProjectId = activeIds[0]!;
  }

  const projectDir = path.join(resolvedDir, resolvedProjectId);

  if (!fs.existsSync(projectDir)) {
    return jsonResult({ ok: false, reason: `Project directory not found: ${projectDir}` });
  }

  const scaffolded: string[] = [];
  const skipped: string[] = [];

  if (agentId) {
    // Scaffold single agent
    const result = scaffoldAgent(projectDir, agentId);
    if (result === "scaffolded") scaffolded.push(agentId);
    else skipped.push(agentId);
  } else {
    // Scaffold all agents in the project
    const allAgentIds = getRegisteredAgentIds(resolvedProjectId);
    for (const aid of allAgentIds) {
      const entry = getAgentConfig(aid, resolvedProjectId);
      if (entry) {
        const result = scaffoldAgent(projectDir, aid);
        if (result === "scaffolded") scaffolded.push(aid);
        else skipped.push(aid);
      }
    }
  }

  return jsonResult({
    ok: true,
    project_id: resolvedProjectId,
    scaffolded,
    skipped,
    message: scaffolded.length > 0
      ? `Scaffolded SOUL.md for: ${scaffolded.join(", ")}. Edit these files to customize each agent's identity and domain expertise.`
      : "No agents needed scaffolding (all already have customized SOUL.md files).",
  });
}

function scaffoldAgent(projectDir: string, agentId: string): "scaffolded" | "skipped" {
  if (agentId.includes("..") || agentId.includes("/") || agentId.includes("\\")) {
    return "skipped";
  }

  const agentDir = path.join(projectDir, "agents", agentId);
  const soulPath = path.join(agentDir, "SOUL.md");

  // Check if SOUL.md already exists and has been customized
  if (fs.existsSync(soulPath)) {
    try {
      const content = fs.readFileSync(soulPath, "utf-8");
      if (!isSoulTemplateUnmodified(content)) {
        return "skipped"; // User has customized it
      }
    } catch {
      return "skipped";
    }
  }

  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(soulPath, generateSoulTemplate(agentId), "utf-8");
    return "scaffolded";
  } catch {
    return "skipped";
  }
}
