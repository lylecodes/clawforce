/**
 * Clawforce — Setup tool
 *
 * Onboarding tool for agents to help users configure clawforce.
 * Actions: explain, status, validate, activate.
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
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, safeExecute } from "./common.js";

const SETUP_ACTIONS = ["explain", "status", "validate", "activate"] as const;

const ClawforceSetupSchema = Type.Object({
  action: stringEnum(SETUP_ACTIONS, { description: "Action to perform. Use 'explain' to get the full reference docs." }),
  yaml_content: Type.Optional(Type.String({ description: "Raw YAML content to validate (for validate action)." })),
  config_path: Type.Optional(Type.String({ description: "Path to a project.yaml file to validate (for validate action)." })),
  project_id: Type.Optional(Type.String({ description: "Project ID — the subdirectory name under projectsDir (for activate action)." })),
});

export function createClawforceSetupTool(options: {
  projectsDir: string;
}) {
  return {
    label: "Workforce Setup",
    name: "clawforce_setup",
    description:
      "Set up and configure AI workforce projects. " +
      "explain: Full reference docs — project.yaml format, roles, accountability, examples. " +
      "status: What projects and employees are currently configured. " +
      "validate: Check a project.yaml config (pass yaml_content or config_path). " +
      "activate: Register or reload a project from disk (pass project_id).",
    parameters: ClawforceSetupSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;

        switch (action) {
          case "explain":
            return handleExplain(options.projectsDir);

          case "status":
            return handleStatus(options.projectsDir);

          case "validate":
            return handleValidate(params);

          case "activate":
            return handleActivate(params, options.projectsDir);

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

function handleExplain(projectsDir: string): ToolResult {
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
    agents: Array<{ id: string; role: string }>;
  }> = [];

  for (const pid of projectIds) {
    const agents: Array<{ id: string; role: string }> = [];
    for (const aid of agentIds) {
      const entry = getAgentConfig(aid);
      if (entry && entry.projectId === pid) {
        agents.push({ id: aid, role: entry.config.role });
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

function handleValidate(params: Record<string, unknown>): ToolResult {
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
  let agentPreview: Array<{ id: string; role: string; expectations: number }> = [];
  if (wfConfig) {
    const warnings = validateWorkforceConfig(wfConfig);
    for (const w of warnings) {
      const prefix = w.agentId ? `[${w.agentId}] ` : "";
      issues.push({ level: w.level, message: `${prefix}${w.message}` });
    }

    agentPreview = Object.entries(wfConfig.agents).map(([id, config]) => ({
      id,
      role: config.role,
      expectations: config.expectations.length,
    }));
  } else if (issues.length === 0) {
    issues.push({
      level: "warn",
      message: "No workforce agents found. Agents need a 'role' field (manager, employee, or scheduled).",
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

function handleActivate(params: Record<string, unknown>, projectsDir: string): ToolResult {
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
  const registeredAgents: Array<{ id: string; role: string }> = [];

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
        Object.entries(wfConfig.agents).map(([id, cfg]) => [id, { role: cfg.role }]),
      );
      const scopePolicies = generateDefaultScopePolicies(agentEntries, wfConfig.policies);
      allPolicies.push(...scopePolicies);
    } catch (err) { safeLog("setup.activate.scopePolicies", err); }
    if (allPolicies.length > 0) {
      try { registerPolicies(projectId, allPolicies); }
      catch (err) { safeLog("setup.activate.registerPolicies", err); }
    }

    for (const [agentId, config] of Object.entries(wfConfig.agents)) {
      registeredAgents.push({ id: agentId, role: config.role });
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
