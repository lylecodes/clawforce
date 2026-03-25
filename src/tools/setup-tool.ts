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
  initProject,
  loadWorkforceConfig,
  loadProject,
  registerWorkforceConfig,
  resolveProjectDir,
} from "../project.js";
import { safeLog } from "../diagnostics.js";
import { validateWorkforceConfig } from "../config-validator.js";
import { recoverOrphanedSessions } from "../enforcement/tracker.js";
import { generateDefaultScopePolicies } from "../profiles.js";
import { registerPolicies } from "../policy/registry.js";
import { buildExplainContent } from "../context/onboarding.js";
import { resolveSkillSource } from "../skills/registry.js";
import { resolveEffectiveScope } from "../scope.js";
import { generateScoped } from "../skills/topics/tools.js";
import { ensureAgentDocs } from "../context/sources/auto-generate.js";
import { generateSoulTemplate, isSoulTemplateUnmodified } from "../context/sources/auto-generate.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, safeExecute } from "./common.js";

const SETUP_ACTIONS = ["explain", "status", "validate", "activate", "scaffold"] as const;

const ClawforceSetupSchema = Type.Object({
  action: stringEnum(SETUP_ACTIONS, { description: "Action to perform. Use 'explain' to get the full reference docs." }),
  yaml_content: Type.Optional(Type.String({ description: "Raw YAML content to validate (for validate action)." })),
  config_path: Type.Optional(Type.String({ description: "Path to a project.yaml file to validate (for validate action)." })),
  project_id: Type.Optional(Type.String({ description: "Project ID — the subdirectory name under projectsDir (for activate/scaffold action)." })),
  agent_id: Type.Optional(Type.String({ description: "Agent ID to target (for scaffold action). Omit to scaffold all agents in the project." })),
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
      "explain: Full reference docs — project.yaml format, roles, accountability, examples. " +
      "status: What projects and employees are currently configured. " +
      "validate: Check a project.yaml config (pass yaml_content or config_path). " +
      "activate: Register or reload a project from disk (pass project_id). " +
      "scaffold: Create SOUL.md templates for agent customization (pass project_id, optionally agent_id).",
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
            return handleScaffold(options.projectsDir, readStringParam(params, "project_id"), readStringParam(params, "agent_id"));

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
  return jsonResult({
    ok: true,
    reference: buildExplainContent(projectsDir),
  });
}

function handleStatus(projectsDir: string): ToolResult {
  const resolvedDir = resolveProjectDir(projectsDir);
  const initialized = isClawforceInitialized();
  const projectIds = getActiveProjectIds();
  const agentIds = getRegisteredAgentIds();

  const projects: Array<{
    id: string;
    agents: Array<{ id: string; extends: string | undefined }>;
  }> = [];

  for (const pid of projectIds) {
    const agents: Array<{ id: string; extends: string | undefined }> = [];
    for (const aid of agentIds) {
      const entry = getAgentConfig(aid);
      if (entry && entry.projectId === pid) {
        agents.push({ id: aid, extends: entry.config.extends });
      }
    }
    projects.push({ id: pid, agents });
  }

  // Scan projectsDir for project directories that exist on disk but may not be active
  const onDiskProjects: string[] = [];
  try {
    if (fs.existsSync(resolvedDir)) {
      const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(resolvedDir, entry.name, "project.yaml");
          if (fs.existsSync(configPath)) {
            onDiskProjects.push(entry.name);
          }
        }
      }
    }
  } catch (err) { safeLog("setup.status.scanProjects", err); }

  const inactiveProjects = onDiskProjects.filter((id) => !projectIds.includes(id));

  return jsonResult({
    ok: true,
    initialized,
    projects_dir: resolvedDir,
    projects_dir_exists: fs.existsSync(resolvedDir),
    project_count: projectIds.length,
    projects,
    inactive_projects_on_disk: inactiveProjects,
    hint: projectIds.length === 0
      ? "No projects configured. Use 'explain' to get the full setup reference, then create a project.yaml and 'activate' it."
      : undefined,
    agent_id_help: "Agent IDs in project.yaml must match the agent IDs configured in OpenClaw. Ask the user to check their OpenClaw agent configuration if they're unsure what IDs to use.",
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

  let content: string;
  if (yamlContent) {
    content = yamlContent;
  } else {
    // Validate that config_path resolves within the projects directory or temp dir
    const resolved = path.resolve(configPath!);
    const allowedRoot = path.resolve(projectsDir);
    if (!resolved.startsWith(allowedRoot + path.sep) && !resolved.startsWith(os.tmpdir())) {
      return jsonResult({
        ok: false,
        reason: `config_path must be within the projects directory. Got: ${configPath}`,
      });
    }
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

  // Check basic structure
  const issues: Array<{ level: string; message: string }> = [];

  if (!raw.id) {
    issues.push({ level: "error", message: "Missing 'id' field — every project needs a unique identifier." });
  }
  if (!raw.name) {
    issues.push({ level: "warn", message: "Missing 'name' field — recommended for readability." });
  }
  if (!raw.dir) {
    issues.push({ level: "warn", message: "Missing 'dir' field — the project's working directory path. Will default to '.'." });
  }

  // Write to a temp file so loadWorkforceConfig can parse it
  // (it expects a file path, so we use a temp approach for yaml_content)
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
    // For raw YAML content, write to temp file then load
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-validate-"));
    const tmpPath = path.join(tmpDir, "project.yaml");
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      wfConfig = loadWorkforceConfig(tmpPath);
    } catch (err) {
      issues.push({
        level: "error",
        message: `Failed to load workforce config: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
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
  } else if (issues.length === 0) {
    issues.push({
      level: "warn",
      message: "No workforce agents found. Use 'extends' to inherit from a preset (manager, employee).",
    });
  }

  const hasErrors = issues.some((i) => i.level === "error");

  return jsonResult({
    ok: !hasErrors,
    valid: !hasErrors,
    issues,
    agent_preview: agentPreview,
  });
}

// NOTE: activate currently uses loadWorkforceConfig + registerWorkforceConfig
// to preserve backward compatibility with existing project.yaml workflows.
// A future domain-based initializeAllDomains path is intentionally deferred
// until project.yaml onboarding is fully migrated.
async function handleActivate(params: Record<string, unknown>, projectsDir: string): Promise<ToolResult> {
  const projectId = readStringParam(params, "project_id", { required: true })!;
  const resolvedDir = resolveProjectDir(projectsDir);
  const projectDir = path.join(resolvedDir, projectId);
  const configPath = path.join(projectDir, "project.yaml");

  if (!fs.existsSync(configPath)) {
    return jsonResult({
      ok: false,
      reason: `No project.yaml found at ${configPath}. Create the file first, then activate.`,
    });
  }

  const activeIds = getActiveProjectIds();
  const isReload = activeIds.includes(projectId);

  // Load and validate workforce config
  const wfConfig = loadWorkforceConfig(configPath);
  const registeredAgents: Array<{ id: string; extends: string | undefined }> = [];

  if (wfConfig) {
    const warnings = validateWorkforceConfig(wfConfig);
    const errors = warnings.filter((w) => w.level === "error");

    if (errors.length > 0 && Object.keys(wfConfig.agents).length === 0) {
      return jsonResult({
        ok: false,
        reason: "Config has errors and no valid agents.",
        errors: errors.map((e) => e.message),
      });
    }

    // registerWorkforceConfig overwrites existing entries in the in-memory registry,
    // so this works for both first activation and reload.
    registerWorkforceConfig(projectId, wfConfig, projectDir);

    // Build combined policy list: explicit + auto-generated scope defaults
    const allPolicies: Array<{ name: string; type: string; target?: string; config: Record<string, unknown> }> = [];
    if (wfConfig.policies && wfConfig.policies.length > 0) {
      allPolicies.push(...wfConfig.policies);
    }
    try {
      const agentEntries = Object.fromEntries(
        Object.entries(wfConfig.agents).map(([id, cfg]) => [id, { extends: cfg.extends }]),
      );
      const scopePolicies = generateDefaultScopePolicies(agentEntries, wfConfig.policies);
      allPolicies.push(...scopePolicies);
    } catch (err) { safeLog("setup.activate.scopePolicies", err); }
    if (allPolicies.length > 0) {
      try { registerPolicies(projectId, allPolicies); }
      catch (err) { safeLog("setup.activate.registerPolicies", err); }
    }

    // Bootstrap per-agent docs (SOUL.md templates)
    for (const [agentId, config] of Object.entries(wfConfig.agents)) {
      registeredAgents.push({ id: agentId, extends: config.extends });
      try {
        ensureAgentDocs(projectDir, agentId, config);
      } catch (err) { safeLog("setup.activate.ensureAgentDocs", err); }
    }
  }

  // Initialize DB + sweep registration (idempotent — safe to call again)
  if (!isReload) {
    try {
      const projectConfig = loadProject(configPath);
      initProject(projectConfig);
    } catch (err) {
      return jsonResult({
        ok: false,
        reason: `Failed to initialize project: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Create goals from config
  if (wfConfig?.goals) {
    try {
      const { createGoal, listGoals } = await import("../goals/ops.js");
      for (const [goalTitle, goalDef] of Object.entries(wfConfig.goals)) {
        // Idempotent: check if goal with this title already exists
        const existing = listGoals(projectId, { status: "active" })
          .find((g: { title: string }) => g.title === goalTitle);
        if (!existing) {
          createGoal({
            projectId,
            title: goalTitle,
            description: goalDef.description,
            acceptanceCriteria: goalDef.acceptance_criteria,
            department: goalDef.department,
            team: goalDef.team,
            ownerAgentId: goalDef.owner_agent_id,
            createdBy: "system:activate",
            allocation: goalDef.allocation,
          });
        }
      }
    } catch (err) { safeLog("setup.activate.createGoals", err); }
  }

  // Recover orphaned sessions
  const orphans = recoverOrphanedSessions(projectId);

  const verb = isReload ? "reloaded" : "activated";
  return jsonResult({
    ok: true,
    project_id: projectId,
    reloaded: isReload,
    agents: registeredAgents,
    orphaned_sessions_recovered: orphans.length,
    message: `Project "${projectId}" ${verb} with ${registeredAgents.length} agent(s) registered.`,
  });
}

function handleScaffold(projectsDir: string, projectId?: string | null, agentId?: string | null): ToolResult {
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

  const resolvedDir = resolveProjectDir(projectsDir);
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
    const allAgentIds = getRegisteredAgentIds();
    for (const aid of allAgentIds) {
      const entry = getAgentConfig(aid);
      if (entry && entry.projectId === resolvedProjectId) {
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
