/**
 * Clawforce — Config tool
 *
 * General-purpose configuration management tool. Users/agents never
 * need to edit YAML directly — this tool handles all config operations
 * with structured params in, structured JSON out.
 *
 * Design:
 * 1. Every write: validate → write YAML → reload runtime → return result
 * 2. Field-level updates (merge, don't overwrite)
 * 3. Never exposes raw YAML — structured params in, JSON out
 * 4. Audit trail — every change emits a config_updated diagnostic event
 * 5. Reuses existing internals: wizard.ts, validate.ts, watcher.ts, schema.ts
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  scaffoldConfigDir,
  initDomain,
  updateDomain,
  deleteDomain,
  addAgentToGlobal,
  removeAgentFromGlobal,
  updateAgentInGlobal,
} from "../config/wizard.js";
import {
  readGlobalConfig,
  readDomainConfig,
  updateDomainConfig,
  updateGlobalConfig,
  upsertGlobalAgent,
  removeGlobalAgent,
  updateGlobalAgent,
  addAgentToDomain,
  removeAgentFromDomain,
  setDomainSection,
  previewGlobalChange,
  previewDomainChange,
  deepMerge,
} from "../config/writer.js";
import { loadGlobalConfig, loadAllDomains } from "../config/loader.js";
import { validateGlobalConfig, validateDomainConfig } from "../config/schema.js";
import { validateAllConfigs } from "../config/validate.js";
import { initializeAllDomains } from "../config/init.js";
import { safeLog } from "../diagnostics.js";
import { getDirectReports } from "../org.js";
import { getAgentConfig } from "../project.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, readBooleanParam, safeExecute } from "./common.js";

// --- Authorization ---

/**
 * Fields considered sensitive — only modifiable by the target agent's manager
 * or a user/system actor. Agents cannot modify these on themselves or others.
 */
const SENSITIVE_FIELDS = new Set([
  "reports_to",
  "extends",
  "coordination",
  "budget",
  "verification",
  "performance_policy",
]);

/**
 * Check if an actor prefix indicates a privileged actor (human user or system).
 */
function isPrivilegedActor(actor: string): boolean {
  return actor.startsWith("user:") || actor === "system";
}

/**
 * Extract the bare agent ID from an actor string.
 * Actor format: "agent:<agentId>" or just an agent ID for legacy callers.
 */
function extractAgentId(actor: string): string | null {
  if (isPrivilegedActor(actor)) return null;
  if (actor.startsWith("agent:")) return actor.slice("agent:".length);
  // Legacy: bare agent ID (not "user:" or "system")
  return actor;
}

/**
 * Check whether a manager agent manages the target agent (target reports to manager).
 */
function isManagerOf(managerId: string, targetAgentId: string, projectId: string | null): boolean {
  if (!projectId) {
    // Fall back to global config: check if target's reports_to == managerId
    // We can't use getDirectReports without a projectId, so check the agent config directly
    const entry = getAgentConfig(targetAgentId);
    if (entry && entry.config.reports_to === managerId) return true;
    return false;
  }
  const reports = getDirectReports(projectId, managerId);
  return reports.includes(targetAgentId);
}

/**
 * Determine the manager of a given agent (who the agent reports_to).
 */
function getManagerOfAgent(targetAgentId: string): string | null {
  const entry = getAgentConfig(targetAgentId);
  if (!entry) return null;
  const reportsTo = entry.config.reports_to;
  if (!reportsTo || reportsTo === "parent") return null;
  return reportsTo;
}

/**
 * Authorize a config change operation.
 *
 * Rules:
 * 1. Privileged actors (user:*, system) can do anything.
 * 2. Self-management: an agent can modify its own NON-sensitive fields.
 * 3. Manager privilege: a manager can modify config for direct reports.
 * 4. Sensitive fields: only modifiable by the target's manager or privileged actors.
 */
export function authorizeConfigChange(
  actor: string,
  targetAgentId: string,
  field: string,
  projectId: string | null,
): { allowed: boolean; reason?: string } {
  // Rule 1: privileged actors bypass all checks
  if (isPrivilegedActor(actor)) {
    return { allowed: true };
  }

  const actorAgentId = extractAgentId(actor);
  if (!actorAgentId) {
    return { allowed: true }; // shouldn't happen, but be safe
  }

  const isSensitive = SENSITIVE_FIELDS.has(field);
  const isSelf = actorAgentId === targetAgentId;
  const actorIsManager = isManagerOf(actorAgentId, targetAgentId, projectId);
  const targetManager = getManagerOfAgent(targetAgentId);

  // Rule 2: self-management of non-sensitive fields is always allowed
  if (isSelf && !isSensitive) {
    return { allowed: true };
  }

  // Rule 3: manager can modify direct reports (including sensitive fields)
  if (actorIsManager) {
    return { allowed: true };
  }

  // Rule 4: sensitive field — only manager or privileged
  if (isSensitive) {
    const managerLabel = targetManager ? `"${targetManager}"` : "no manager assigned";
    return {
      allowed: false,
      reason: `Agent "${actorAgentId}" cannot modify ${targetAgentId}'s "${field}" — only ${targetAgentId}'s manager (${managerLabel}) or the user can do this.`,
    };
  }

  // Non-sensitive field, but modifying another agent — only managers can do this
  if (!isSelf) {
    return {
      allowed: false,
      reason: `Agent "${actorAgentId}" cannot modify ${targetAgentId}'s config — only ${targetAgentId}'s manager${targetManager ? ` ("${targetManager}")` : ""} or the user can do this.`,
    };
  }

  return { allowed: true };
}

/**
 * Authorize adding or removing an agent — restricted to managers of the
 * target's team or privileged actors.
 */
function authorizeAgentLifecycle(
  actor: string,
  targetAgentId: string,
  operation: "add" | "remove",
  reportsTo: string | null,
  projectId: string | null,
): { allowed: boolean; reason?: string } {
  if (isPrivilegedActor(actor)) {
    return { allowed: true };
  }

  const actorAgentId = extractAgentId(actor);
  if (!actorAgentId) {
    return { allowed: true };
  }

  // For add: the agent will report to reportsTo. The actor must be that manager.
  // For remove: check if actor is the target's current manager.
  if (operation === "add") {
    if (reportsTo && reportsTo === actorAgentId) {
      // Actor is adding an agent that reports to them — allowed
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Agent "${actorAgentId}" cannot add agent "${targetAgentId}" — only the intended manager${reportsTo ? ` ("${reportsTo}")` : ""} or the user can do this.`,
    };
  }

  // remove: actor must be manager of the target
  const actorIsManager = isManagerOf(actorAgentId, targetAgentId, projectId);
  if (actorIsManager) {
    return { allowed: true };
  }

  const targetManager = getManagerOfAgent(targetAgentId);
  return {
    allowed: false,
    reason: `Agent "${actorAgentId}" cannot remove agent "${targetAgentId}" — only ${targetAgentId}'s manager${targetManager ? ` ("${targetManager}")` : ""} or the user can do this.`,
  };
}

/**
 * Authorize domain-level config changes — only user/system actors allowed.
 */
function authorizeDomainChange(
  actor: string,
  domain: string,
  operation: string,
): { allowed: boolean; reason?: string } {
  if (isPrivilegedActor(actor)) {
    return { allowed: true };
  }

  const actorAgentId = extractAgentId(actor);
  return {
    allowed: false,
    reason: `Agent "${actorAgentId ?? actor}" cannot ${operation} domain "${domain}" — only the user or system can modify domain-level config.`,
  };
}

// --- Actions ---

const CONFIG_ACTIONS = [
  // Domain management
  "create_domain", "update_domain", "delete_domain", "list_domains",
  // Agent management
  "add_agent", "remove_agent", "update_agent",
  // Budget
  "set_budget",
  // Policy management
  "add_policy", "remove_policy", "update_policy",
  // Safety & operational
  "set_safety", "set_profile",
  // Context files (direction, standards, policies, architecture)
  "set_direction", "set_standards", "set_policies", "set_architecture",
  // Section-level catch-all
  "set_section",
  // Read & validation
  "get_config", "validate", "diff", "reload",
] as const;

// --- Schema ---

const ClawforceConfigSchema = Type.Object({
  action: stringEnum(CONFIG_ACTIONS, { description: "Config action to perform." }),

  // Common identifiers
  domain: Type.Optional(Type.String({ description: "Domain name (required for domain-specific actions)." })),
  agent_id: Type.Optional(Type.String({ description: "Agent ID (for agent management actions)." })),
  actor: Type.Optional(Type.String({ description: "Who is making this change (for audit trail). Defaults to 'system'." })),

  // Domain creation
  agents: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs for domain creation." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Working directory paths for domain." })),
  orchestrator: Type.Optional(Type.String({ description: "Orchestrator agent ID for domain." })),
  template: Type.Optional(Type.String({ description: "Team template (e.g. 'startup')." })),
  operational_profile: Type.Optional(Type.String({ description: "Profile level: low, medium, high, ultra." })),

  // Agent definition fields
  extends: Type.Optional(Type.String({ description: "Preset to extend (manager, employee, ops, verifier)." })),
  persona: Type.Optional(Type.String({ description: "Agent persona description." })),
  title: Type.Optional(Type.String({ description: "Agent title (e.g. 'Lead Engineer')." })),
  model: Type.Optional(Type.String({ description: "Model identifier for agent." })),
  department: Type.Optional(Type.String({ description: "Department the agent belongs to." })),
  team: Type.Optional(Type.String({ description: "Team within the department." })),
  reports_to: Type.Optional(Type.String({ description: "Agent this agent reports to." })),

  // Structured config data (for complex fields)
  config_data: Type.Optional(Type.Unknown({ description: "Structured config data (JSON object) for the operation. Used for budget, policy, safety, section, agent fields, and domain updates." })),

  // Budget
  budget_scope: Type.Optional(Type.String({ description: "Budget scope: 'project' or an agent ID." })),

  // Policy
  policy_name: Type.Optional(Type.String({ description: "Policy name (for add/remove/update policy)." })),

  // Section
  section: Type.Optional(Type.String({ description: "Config section name (for set_section, get_config). E.g. 'channels', 'event_handlers', 'verification', 'monitoring', 'triggers', 'knowledge', 'review', 'goals'." })),

  // Context files (direction, standards, policies, architecture)
  direction_content: Type.Optional(Type.String({ description: "DIRECTION.md content (YAML or plain text). Alias for context_content when action=set_direction." })),
  direction_team: Type.Optional(Type.String({ description: "DEPRECATED: Use context_team instead. Team name for team-specific files." })),
  context_content: Type.Optional(Type.String({ description: "Content for context files (standards, policies, architecture, direction)." })),
  context_team: Type.Optional(Type.String({ description: "Team name for team-specific context files (e.g. STANDARDS-{team}.md). Omit for domain-wide." })),

  // Validation/preview target
  target: Type.Optional(Type.String({ description: "Validation target: 'global', 'domain', 'full', or a domain name. Default: 'full'." })),

  // Get config scope
  scope: Type.Optional(Type.String({ description: "Config scope for get_config: 'global', 'domain', 'agent', 'full'. Default: 'full'." })),

  // Domain update fields
  enabled: Type.Optional(Type.Boolean({ description: "Enable/disable a domain." })),
});

// --- Tool factory ---

export function createClawforceConfigTool(options: {
  baseDir: string;
  projectId?: string;
}) {
  const projectId = options.projectId ?? null;
  return {
    label: "Config Management",
    name: "clawforce_config",
    description:
      "Manage ClawForce configuration — domains, agents, budgets, policies, safety, profiles, and more. " +
      "All config changes are validated before writing and emit audit events. " +
      "Actions: " +
      "create_domain, update_domain, delete_domain, list_domains, " +
      "add_agent, remove_agent, update_agent, " +
      "set_budget, add_policy, remove_policy, update_policy, " +
      "set_safety, set_profile, set_direction, set_standards, set_policies, set_architecture, set_section, " +
      "get_config, validate, diff, reload.",
    parameters: ClawforceConfigSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const actor = readStringParam(params, "actor") ?? "system";
        const baseDir = options.baseDir;

        switch (action) {
          // --- Domain management ---
          case "create_domain":
            return handleCreateDomain(baseDir, params, actor, projectId);
          case "update_domain":
            return handleUpdateDomain(baseDir, params, actor, projectId);
          case "delete_domain":
            return handleDeleteDomain(baseDir, params, actor, projectId);
          case "list_domains":
            return handleListDomains(baseDir);

          // --- Agent management ---
          case "add_agent":
            return handleAddAgent(baseDir, params, actor, projectId);
          case "remove_agent":
            return handleRemoveAgent(baseDir, params, actor, projectId);
          case "update_agent":
            return handleUpdateAgent(baseDir, params, actor, projectId);

          // --- Budget ---
          case "set_budget":
            return handleSetBudget(baseDir, params, actor, projectId);

          // --- Policy ---
          case "add_policy":
            return handleAddPolicy(baseDir, params, actor, projectId);
          case "remove_policy":
            return handleRemovePolicy(baseDir, params, actor, projectId);
          case "update_policy":
            return handleUpdatePolicy(baseDir, params, actor, projectId);

          // --- Safety & operational ---
          case "set_safety":
            return handleSetSafety(baseDir, params, actor, projectId);
          case "set_profile":
            return handleSetProfile(baseDir, params, actor, projectId);

          // --- Context files (direction, standards, policies, architecture) ---
          case "set_direction":
            return handleSetDirection(baseDir, params, actor, projectId);
          case "set_standards":
            return handleSetContextFile(baseDir, params, actor, "STANDARDS", projectId);
          case "set_policies":
            return handleSetContextFile(baseDir, params, actor, "POLICIES", projectId);
          case "set_architecture":
            return handleSetContextFile(baseDir, params, actor, "ARCHITECTURE", projectId);

          // --- Section ---
          case "set_section":
            return handleSetSection(baseDir, params, actor, projectId);

          // --- Read & validation ---
          case "get_config":
            return handleGetConfig(baseDir, params);
          case "validate":
            return handleValidate(baseDir, params);
          case "diff":
            return handleDiff(baseDir, params);
          case "reload":
            return handleReload(baseDir);

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

// --- Handler implementations ---

function handleCreateDomain(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const name = readStringParam(params, "domain", { required: true })!;

  // Authorization: only user/system can create domains
  const authResult = authorizeDomainChange(actor, name, "create");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }
  const agents = params.agents as string[] | undefined;
  if (!agents || !Array.isArray(agents) || agents.length === 0) {
    return jsonResult({ ok: false, reason: "agents array is required for create_domain" });
  }

  const orchestrator = readStringParam(params, "orchestrator");
  const paths = params.paths as string[] | undefined;
  const template = readStringParam(params, "template");
  const profile = readStringParam(params, "operational_profile") as "low" | "medium" | "high" | "ultra" | null;

  // Ensure config dir is scaffolded
  scaffoldConfigDir(baseDir);

  try {
    initDomain(baseDir, {
      name,
      agents,
      orchestrator: orchestrator ?? undefined,
      paths: paths ?? undefined,
      operational_profile: profile ?? undefined,
      template: template ?? undefined,
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }

  // If config_data provided for agent presets, add agents to global
  const configData = params.config_data as Record<string, unknown> | undefined;
  if (configData?.agent_presets && typeof configData.agent_presets === "object") {
    for (const [agentId, preset] of Object.entries(configData.agent_presets as Record<string, string>)) {
      addAgentToGlobal(baseDir, agentId, { extends: preset });
    }
  }

  return jsonResult({
    ok: true,
    action: "create_domain",
    domain: name,
    agents,
    message: `Domain "${name}" created with ${agents.length} agent(s).`,
  });
}

function handleUpdateDomain(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const name = readStringParam(params, "domain", { required: true })!;

  // Authorization: only user/system can modify domain config
  const authResult = authorizeDomainChange(actor, name, "update");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const configData = params.config_data as Record<string, unknown> | undefined;

  // Build updates from explicit params and config_data
  const updates: Record<string, unknown> = {};
  const orchestrator = readStringParam(params, "orchestrator");
  const paths = params.paths as string[] | undefined;
  const agents = params.agents as string[] | undefined;
  const template = readStringParam(params, "template");
  const profile = readStringParam(params, "operational_profile");
  const enabled = readBooleanParam(params, "enabled");

  if (orchestrator !== null) updates.orchestrator = orchestrator;
  if (paths) updates.paths = paths;
  if (agents) updates.agents = agents;
  if (template !== null) updates.template = template;
  if (profile !== null) updates.operational_profile = profile;
  if (enabled !== null) updates.enabled = enabled;

  // Merge config_data fields
  if (configData && typeof configData === "object") {
    for (const [key, value] of Object.entries(configData)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResult({ ok: false, reason: "No updates provided for update_domain" });
  }

  const result = updateDomainConfig(baseDir, name, updates, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "update_domain",
    domain: name,
    updated_fields: Object.keys(updates),
    diff: result.diff,
  });
}

function handleDeleteDomain(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const name = readStringParam(params, "domain", { required: true })!;

  // Authorization: only user/system can delete domains
  const authResult = authorizeDomainChange(actor, name, "delete");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  try {
    deleteDomain(baseDir, name);
  } catch (err) {
    return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }

  return jsonResult({
    ok: true,
    action: "delete_domain",
    domain: name,
    message: `Domain "${name}" deleted.`,
  });
}

function handleListDomains(baseDir: string): ToolResult {
  const domains = loadAllDomains(baseDir);
  const domainsDir = path.join(baseDir, "domains");

  // Scan disk for all domain files (including disabled/invalid ones)
  const onDisk: string[] = [];
  try {
    if (fs.existsSync(domainsDir)) {
      const files = fs.readdirSync(domainsDir).filter(f => f.endsWith(".yaml"));
      for (const file of files) {
        onDisk.push(file.replace(".yaml", ""));
      }
    }
  } catch (err) {
    safeLog("config.listDomains", err);
  }

  const active = domains.map(d => ({
    domain: d.domain,
    agents: d.agents,
    enabled: d.enabled !== false,
    orchestrator: d.orchestrator,
    paths: d.paths,
    operational_profile: d.operational_profile,
    template: d.template,
  }));

  const activeNames = new Set(domains.map(d => d.domain));
  const inactive = onDisk.filter(n => !activeNames.has(n));

  return jsonResult({
    ok: true,
    domains: active,
    inactive_on_disk: inactive,
    total: onDisk.length,
  });
}

function handleAddAgent(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const agentId = readStringParam(params, "agent_id", { required: true })!;
  const domain = readStringParam(params, "domain");
  const reportsTo = readStringParam(params, "reports_to");

  // Authorization: only managers of the target's team or user/system can add agents
  const authResult = authorizeAgentLifecycle(actor, agentId, "add", reportsTo, projectId);
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  // Build agent definition from params
  const agentDef: Record<string, unknown> = {};
  const extendsVal = readStringParam(params, "extends");
  const persona = readStringParam(params, "persona");
  const title = readStringParam(params, "title");
  const model = readStringParam(params, "model");
  const department = readStringParam(params, "department");
  const team = readStringParam(params, "team");

  if (extendsVal) agentDef.extends = extendsVal;
  if (persona) agentDef.persona = persona;
  if (title) agentDef.title = title;
  if (model) agentDef.model = model;
  if (department) agentDef.department = department;
  if (team) agentDef.team = team;
  if (reportsTo) agentDef.reports_to = reportsTo;

  // Merge additional fields from config_data
  const configData = params.config_data as Record<string, unknown> | undefined;
  if (configData && typeof configData === "object") {
    for (const [key, value] of Object.entries(configData)) {
      agentDef[key] = value;
    }
  }

  // Ensure extends has a default
  if (!agentDef.extends) {
    agentDef.extends = "employee";
  }

  // Ensure config dir exists
  scaffoldConfigDir(baseDir);

  const added = addAgentToGlobal(baseDir, agentId, agentDef);
  if (!added) {
    return jsonResult({
      ok: false,
      reason: `Agent "${agentId}" already exists in global config. Use update_agent to modify.`,
    });
  }

  // Optionally add to domain
  if (domain) {
    const domainResult = addAgentToDomain(baseDir, domain, agentId, actor);
    if (!domainResult.ok) {
      return jsonResult({
        ok: true,
        action: "add_agent",
        agent_id: agentId,
        added_to_global: true,
        added_to_domain: false,
        domain_error: domainResult.error,
      });
    }
  }

  return jsonResult({
    ok: true,
    action: "add_agent",
    agent_id: agentId,
    added_to_global: true,
    added_to_domain: domain ? true : false,
    domain: domain ?? undefined,
    definition: agentDef,
  });
}

function handleRemoveAgent(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const agentId = readStringParam(params, "agent_id", { required: true })!;

  // Authorization: only the target's manager or user/system can remove agents
  const authResult = authorizeAgentLifecycle(actor, agentId, "remove", null, projectId);
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const removed = removeAgentFromGlobal(baseDir, agentId, true);
  if (!removed) {
    return jsonResult({ ok: false, reason: `Agent "${agentId}" not found in global config.` });
  }

  return jsonResult({
    ok: true,
    action: "remove_agent",
    agent_id: agentId,
    removed_from_global: true,
    removed_from_domains: true,
    message: `Agent "${agentId}" removed from global config and all domains.`,
  });
}

function handleUpdateAgent(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const agentId = readStringParam(params, "agent_id", { required: true })!;

  // Build updates from params
  const updates: Record<string, unknown> = {};
  const extendsVal = readStringParam(params, "extends");
  const persona = readStringParam(params, "persona");
  const title = readStringParam(params, "title");
  const model = readStringParam(params, "model");
  const department = readStringParam(params, "department");
  const team = readStringParam(params, "team");
  const reportsTo = readStringParam(params, "reports_to");

  if (extendsVal !== null) updates.extends = extendsVal;
  if (persona !== null) updates.persona = persona;
  if (title !== null) updates.title = title;
  if (model !== null) updates.model = model;
  if (department !== null) updates.department = department;
  if (team !== null) updates.team = team;
  if (reportsTo !== null) updates.reports_to = reportsTo;

  // Merge additional fields from config_data
  const configData = params.config_data as Record<string, unknown> | undefined;
  if (configData && typeof configData === "object") {
    for (const [key, value] of Object.entries(configData)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResult({ ok: false, reason: "No updates provided for update_agent" });
  }

  // Authorization: check each field being updated
  for (const field of Object.keys(updates)) {
    const authResult = authorizeConfigChange(actor, agentId, field, projectId);
    if (!authResult.allowed) {
      return jsonResult({ ok: false, reason: authResult.reason });
    }
  }

  try {
    updateAgentInGlobal(baseDir, agentId, updates);
  } catch (err) {
    return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }

  // Read back the updated config
  const globalConfig = loadGlobalConfig(baseDir);
  const updatedDef = globalConfig.agents[agentId];

  return jsonResult({
    ok: true,
    action: "update_agent",
    agent_id: agentId,
    updated_fields: Object.keys(updates),
    current: updatedDef,
  });
}

function handleSetBudget(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain");
  const configData = params.config_data as Record<string, unknown> | undefined;

  if (!configData || typeof configData !== "object") {
    return jsonResult({ ok: false, reason: "config_data (budget object) is required for set_budget" });
  }

  // Authorization: budget is domain-level config — only user/system can modify
  if (domain) {
    const authResult = authorizeDomainChange(actor, domain, "set budget on");
    if (!authResult.allowed) {
      return jsonResult({ ok: false, reason: authResult.reason });
    }
  } else {
    // Global budget — also restricted
    if (!isPrivilegedActor(actor)) {
      const actorAgentId = extractAgentId(actor);
      return jsonResult({
        ok: false,
        reason: `Agent "${actorAgentId ?? actor}" cannot modify global budget — only the user or system can do this.`,
      });
    }
  }

  if (domain) {
    // Set budget on domain
    const result = updateDomainConfig(baseDir, domain, { budget: configData }, actor);
    if (!result.ok) {
      return jsonResult({ ok: false, reason: result.error });
    }
    return jsonResult({
      ok: true,
      action: "set_budget",
      scope: "domain",
      domain,
      budget: configData,
    });
  }

  // Set budget on global config (less common)
  const result = updateGlobalConfig(baseDir, { budget: configData }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }
  return jsonResult({
    ok: true,
    action: "set_budget",
    scope: "global",
    budget: configData,
  });
}

function handleAddPolicy(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;

  // Authorization: policy is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "add policy to");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const configData = params.config_data as Record<string, unknown> | undefined;

  if (!configData || typeof configData !== "object") {
    return jsonResult({ ok: false, reason: "config_data (policy object with name, type, config) is required for add_policy" });
  }

  if (!configData.name || !configData.type) {
    return jsonResult({ ok: false, reason: "Policy must have 'name' and 'type' fields in config_data" });
  }

  const domainConfig = readDomainConfig(baseDir, domain);
  if (!domainConfig) {
    return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
  }

  const policies = (domainConfig.policies ?? []) as unknown[];
  // Check for duplicate policy name
  const existing = policies.find((p: unknown) => {
    const pol = p as Record<string, unknown>;
    return pol.name === configData.name;
  });
  if (existing) {
    return jsonResult({ ok: false, reason: `Policy "${configData.name}" already exists in domain "${domain}". Use update_policy to modify.` });
  }

  policies.push(configData);
  const result = updateDomainConfig(baseDir, domain, { policies }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "add_policy",
    domain,
    policy: configData,
  });
}

function handleRemovePolicy(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;
  const policyName = readStringParam(params, "policy_name", { required: true })!;

  // Authorization: policy is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "remove policy from");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const domainConfig = readDomainConfig(baseDir, domain);
  if (!domainConfig) {
    return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
  }

  const policies = (domainConfig.policies ?? []) as unknown[];
  const filtered = policies.filter((p: unknown) => {
    const pol = p as Record<string, unknown>;
    return pol.name !== policyName;
  });

  if (filtered.length === policies.length) {
    return jsonResult({ ok: false, reason: `Policy "${policyName}" not found in domain "${domain}"` });
  }

  const result = updateDomainConfig(baseDir, domain, { policies: filtered }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "remove_policy",
    domain,
    policy_name: policyName,
  });
}

function handleUpdatePolicy(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;
  const policyName = readStringParam(params, "policy_name", { required: true })!;

  // Authorization: policy is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "update policy in");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const configData = params.config_data as Record<string, unknown> | undefined;

  if (!configData || typeof configData !== "object") {
    return jsonResult({ ok: false, reason: "config_data (policy update fields) is required for update_policy" });
  }

  const domainConfig = readDomainConfig(baseDir, domain);
  if (!domainConfig) {
    return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
  }

  const policies = (domainConfig.policies ?? []) as Record<string, unknown>[];
  const idx = policies.findIndex(p => p.name === policyName);
  if (idx === -1) {
    return jsonResult({ ok: false, reason: `Policy "${policyName}" not found in domain "${domain}"` });
  }

  // Field-level merge on the policy
  policies[idx] = deepMerge(policies[idx]!, configData);
  policies[idx]!.name = policyName; // name is immutable

  const result = updateDomainConfig(baseDir, domain, { policies }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "update_policy",
    domain,
    policy_name: policyName,
    policy: policies[idx],
  });
}

function handleSetSafety(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;

  // Authorization: safety is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "set safety on");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const configData = params.config_data as Record<string, unknown> | undefined;

  if (!configData || typeof configData !== "object") {
    return jsonResult({ ok: false, reason: "config_data (safety settings object) is required for set_safety" });
  }

  // Validate known safety keys
  const knownKeys = new Set([
    "maxSpawnDepth", "costCircuitBreaker", "loopDetectionThreshold",
    "maxConcurrentMeetings", "maxMessageRate", "maxTasksPerSession",
    "maxSessionDurationMs", "spendRateWarningThreshold", "maxConsecutiveFailures",
    "emergencyStop", "maxQueueDepth",
    "maxCallsPerSession", "maxCallsPerMinute", "maxCallsPerMinutePerAgent",
    "retryBackoffBaseMs", "retryBackoffMaxMs",
  ]);

  const unknownKeys = Object.keys(configData).filter(k => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    return jsonResult({
      ok: false,
      reason: `Unknown safety keys: ${unknownKeys.join(", ")}. Valid keys: ${[...knownKeys].join(", ")}`,
    });
  }

  const result = updateDomainConfig(baseDir, domain, { safety: configData }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "set_safety",
    domain,
    safety: configData,
  });
}

function handleSetProfile(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;

  // Authorization: profile is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "set profile on");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const profile = readStringParam(params, "operational_profile", { required: true })!;

  const validProfiles = ["low", "medium", "high", "ultra"];
  if (!validProfiles.includes(profile)) {
    return jsonResult({
      ok: false,
      reason: `Invalid profile "${profile}". Must be one of: ${validProfiles.join(", ")}`,
    });
  }

  const result = updateDomainConfig(baseDir, domain, { operational_profile: profile }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }

  return jsonResult({
    ok: true,
    action: "set_profile",
    domain,
    operational_profile: profile,
  });
}

function handleSetDirection(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;

  // Authorization: direction is domain-level config
  const authResult = authorizeDomainChange(actor, domain, "set direction on");
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const content = readStringParam(params, "direction_content") ?? readStringParam(params, "context_content");
  if (!content) {
    return jsonResult({ ok: false, reason: "direction_content or context_content is required for set_direction" });
  }
  // Support both legacy direction_team and new context_team
  const team = readStringParam(params, "context_team") ?? readStringParam(params, "direction_team");

  // Read domain config to find or set direction path
  const domainConfig = readDomainConfig(baseDir, domain);
  if (!domainConfig) {
    return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
  }

  // Determine the filename: team-specific or domain-wide
  const directionFilename = team
    ? `DIRECTION-${team}.md`
    : (domainConfig.direction ?? `DIRECTION.md`);
  let directionPath: string;

  // If paths exist, put DIRECTION.md in the first project path
  if (domainConfig.paths && domainConfig.paths.length > 0) {
    const projectDir = domainConfig.paths[0]!.startsWith("~/")
      ? path.join(process.env.HOME ?? "/tmp", domainConfig.paths[0]!.slice(1))
      : domainConfig.paths[0]!;
    directionPath = path.join(projectDir, directionFilename);
  } else {
    // Fall back to context dir within domains
    const contextDir = path.join(baseDir, "domains", domain, "context");
    directionPath = path.join(contextDir, directionFilename);
  }

  try {
    const dir = path.dirname(directionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(directionPath, content, "utf-8");
  } catch (err) {
    return jsonResult({
      ok: false,
      reason: `Failed to write ${directionFilename}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Update domain config to reference the direction file if not already set (domain-wide only)
  if (!team && !domainConfig.direction) {
    updateDomainConfig(baseDir, domain, { direction: directionFilename }, actor);
  }

  return jsonResult({
    ok: true,
    action: "set_direction",
    domain,
    ...(team ? { team } : {}),
    path: directionPath,
    message: team
      ? `DIRECTION-${team}.md written for team "${team}" in domain "${domain}".`
      : `DIRECTION.md written for domain "${domain}".`,
  });
}

/**
 * Generic handler for writing context files (STANDARDS.md, POLICIES.md, ARCHITECTURE.md).
 * Supports per-team variants via context_team parameter.
 */
function handleSetContextFile(
  baseDir: string,
  params: Record<string, unknown>,
  actor: string,
  fileBaseName: "STANDARDS" | "POLICIES" | "ARCHITECTURE",
  projectId: string | null,
): ToolResult {
  const domain = readStringParam(params, "domain", { required: true })!;

  // Authorization: context files are domain-level config
  const authResult = authorizeDomainChange(actor, domain, `set ${fileBaseName.toLowerCase()} on`);
  if (!authResult.allowed) {
    return jsonResult({ ok: false, reason: authResult.reason });
  }

  const content = readStringParam(params, "context_content");
  if (!content) {
    return jsonResult({ ok: false, reason: `context_content is required for set_${fileBaseName.toLowerCase()}` });
  }
  const team = readStringParam(params, "context_team");

  // Read domain config
  const domainConfig = readDomainConfig(baseDir, domain);
  if (!domainConfig) {
    return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
  }

  // Determine the filename: team-specific or domain-wide
  const contextFilename = team
    ? `${fileBaseName}-${team}.md`
    : `${fileBaseName}.md`;

  let contextPath: string;

  // If paths exist, put in the first project path's context dir
  if (domainConfig.paths && domainConfig.paths.length > 0) {
    const projectDir = domainConfig.paths[0]!.startsWith("~/")
      ? path.join(process.env.HOME ?? "/tmp", domainConfig.paths[0]!.slice(1))
      : domainConfig.paths[0]!;
    contextPath = path.join(projectDir, contextFilename);
  } else {
    // Fall back to context dir within domains
    const contextDir = path.join(baseDir, "domains", domain, "context");
    contextPath = path.join(contextDir, contextFilename);
  }

  try {
    const dir = path.dirname(contextPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(contextPath, content, "utf-8");
  } catch (err) {
    return jsonResult({
      ok: false,
      reason: `Failed to write ${contextFilename}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const actionName = `set_${fileBaseName.toLowerCase()}`;
  return jsonResult({
    ok: true,
    action: actionName,
    domain,
    ...(team ? { team } : {}),
    path: contextPath,
    message: team
      ? `${contextFilename} written for team "${team}" in domain "${domain}".`
      : `${fileBaseName}.md written for domain "${domain}".`,
  });
}

function handleSetSection(baseDir: string, params: Record<string, unknown>, actor: string, projectId: string | null): ToolResult {
  const domain = readStringParam(params, "domain");
  const section = readStringParam(params, "section", { required: true })!;
  const configData = params.config_data;

  if (configData === undefined) {
    return jsonResult({ ok: false, reason: "config_data is required for set_section" });
  }

  // Authorization: section-level config is domain/global level — restricted
  if (domain) {
    const authResult = authorizeDomainChange(actor, domain, `set section "${section}" on`);
    if (!authResult.allowed) {
      return jsonResult({ ok: false, reason: authResult.reason });
    }
  } else {
    // Global section — restricted to privileged actors
    if (!isPrivilegedActor(actor)) {
      const actorAgentId = extractAgentId(actor);
      return jsonResult({
        ok: false,
        reason: `Agent "${actorAgentId ?? actor}" cannot modify global config section "${section}" — only the user or system can do this.`,
      });
    }
  }

  if (domain) {
    const result = setDomainSection(baseDir, domain, section, configData, actor);
    if (!result.ok) {
      return jsonResult({ ok: false, reason: result.error });
    }
    return jsonResult({
      ok: true,
      action: "set_section",
      scope: "domain",
      domain,
      section,
    });
  }

  // Set on global config
  const result = updateGlobalConfig(baseDir, { [section]: configData }, actor);
  if (!result.ok) {
    return jsonResult({ ok: false, reason: result.error });
  }
  return jsonResult({
    ok: true,
    action: "set_section",
    scope: "global",
    section,
  });
}

function handleGetConfig(baseDir: string, params: Record<string, unknown>): ToolResult {
  const scope = readStringParam(params, "scope") ?? "full";
  const domain = readStringParam(params, "domain");
  const agentId = readStringParam(params, "agent_id");
  const section = readStringParam(params, "section");

  switch (scope) {
    case "global": {
      const config = loadGlobalConfig(baseDir);
      if (section) {
        return jsonResult({ ok: true, scope: "global", section, data: (config as unknown as Record<string, unknown>)[section] ?? null });
      }
      return jsonResult({ ok: true, scope: "global", config });
    }

    case "domain": {
      if (!domain) {
        return jsonResult({ ok: false, reason: "domain parameter is required when scope is 'domain'" });
      }
      const domainConfig = readDomainConfig(baseDir, domain);
      if (!domainConfig) {
        return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
      }
      if (section) {
        return jsonResult({ ok: true, scope: "domain", domain, section, data: (domainConfig as unknown as Record<string, unknown>)[section] ?? null });
      }
      return jsonResult({ ok: true, scope: "domain", domain, config: domainConfig });
    }

    case "agent": {
      if (!agentId) {
        return jsonResult({ ok: false, reason: "agent_id parameter is required when scope is 'agent'" });
      }
      const globalConfig = loadGlobalConfig(baseDir);
      const agentDef = globalConfig.agents[agentId];
      if (!agentDef) {
        return jsonResult({ ok: false, reason: `Agent "${agentId}" not found in global config` });
      }
      // Also find which domains this agent belongs to
      const domains = loadAllDomains(baseDir);
      const memberOf = domains
        .filter(d => d.agents.includes(agentId))
        .map(d => d.domain);
      return jsonResult({
        ok: true,
        scope: "agent",
        agent_id: agentId,
        definition: agentDef,
        domains: memberOf,
      });
    }

    case "full": {
      const globalConfig = loadGlobalConfig(baseDir);
      const domains = loadAllDomains(baseDir);
      return jsonResult({
        ok: true,
        scope: "full",
        global: globalConfig,
        domains: domains.map(d => ({
          domain: d.domain,
          agents: d.agents,
          enabled: d.enabled !== false,
          orchestrator: d.orchestrator,
          paths: d.paths,
          operational_profile: d.operational_profile,
        })),
        agent_count: Object.keys(globalConfig.agents).length,
        domain_count: domains.length,
      });
    }

    default:
      return jsonResult({ ok: false, reason: `Unknown scope: ${scope}. Use 'global', 'domain', 'agent', or 'full'.` });
  }
}

function handleValidate(baseDir: string, params: Record<string, unknown>): ToolResult {
  const target = readStringParam(params, "target") ?? "full";

  switch (target) {
    case "global": {
      const config = loadGlobalConfig(baseDir);
      const result = validateGlobalConfig(config);
      return jsonResult({
        ok: true,
        target: "global",
        valid: result.valid,
        errors: result.errors,
      });
    }

    case "domain": {
      const domain = readStringParam(params, "domain");
      if (!domain) {
        return jsonResult({ ok: false, reason: "domain parameter is required when target is 'domain'" });
      }
      const domainConfig = readDomainConfig(baseDir, domain);
      if (!domainConfig) {
        return jsonResult({ ok: false, reason: `Domain "${domain}" does not exist` });
      }
      const result = validateDomainConfig(domainConfig);
      return jsonResult({
        ok: true,
        target: "domain",
        domain,
        valid: result.valid,
        errors: result.errors,
      });
    }

    case "full": {
      const report = validateAllConfigs(baseDir);
      return jsonResult({
        ok: true,
        target: "full",
        valid: report.valid,
        issues: report.issues,
      });
    }

    default:
      return jsonResult({ ok: false, reason: `Unknown validation target: ${target}. Use 'global', 'domain', or 'full'.` });
  }
}

function handleDiff(baseDir: string, params: Record<string, unknown>): ToolResult {
  const domain = readStringParam(params, "domain");
  const configData = params.config_data as Record<string, unknown> | undefined;

  if (!configData || typeof configData !== "object") {
    return jsonResult({ ok: false, reason: "config_data (proposed changes object) is required for diff" });
  }

  if (domain) {
    const preview = previewDomainChange(baseDir, domain, configData);
    return jsonResult({
      ok: true,
      scope: "domain",
      domain,
      valid: preview.valid,
      errors: preview.errors,
      before: preview.before,
      after: preview.after,
    });
  }

  const preview = previewGlobalChange(baseDir, configData);
  return jsonResult({
    ok: true,
    scope: "global",
    valid: preview.valid,
    errors: preview.errors,
    before: preview.before,
    after: preview.after,
  });
}

function handleReload(baseDir: string): ToolResult {
  try {
    const result = initializeAllDomains(baseDir);
    return jsonResult({
      ok: true,
      action: "reload",
      domains_loaded: result.domains,
      errors: result.errors,
      warnings: result.warnings,
    });
  } catch (err) {
    return jsonResult({
      ok: false,
      reason: `Reload failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
