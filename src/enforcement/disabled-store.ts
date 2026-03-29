/**
 * Clawforce — Persistent disabled agent store
 *
 * Persists disabled agents to SQLite so the state survives restarts.
 * Replaces the in-memory Set<string> that was previously used in index.ts.
 *
 * Also supports hierarchical disable scopes (agent, team, department)
 * so entire teams/departments can be disabled without touching individual agents.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { getAgentConfig } from "../project.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisabledAgent = {
  agentId: string;
  reason: string;
  disabledAt: number;
};

export type DisableScope = "agent" | "team" | "department" | "domain";

export type DisabledScopeEntry = {
  id: string;
  projectId: string;
  scopeType: DisableScope;
  scopeValue: string;
  reason: string;
  disabledAt: number;
  disabledBy: string | null;
};

// ---------------------------------------------------------------------------
// Legacy per-agent functions (preserved for backward compatibility)
// ---------------------------------------------------------------------------

export function disableAgent(projectId: string, agentId: string, reason: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, projectId, agentId, reason, now);
}

export function isAgentDisabled(projectId: string, agentId: string, dbOverride?: DatabaseSync): boolean {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT 1 FROM disabled_agents WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId);
  return !!row;
}

export function listDisabledAgents(projectId: string, dbOverride?: DatabaseSync): DisabledAgent[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT agent_id, reason, disabled_at FROM disabled_agents WHERE project_id = ? ORDER BY disabled_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  return rows.map((row) => ({
    agentId: row.agent_id as string,
    reason: row.reason as string,
    disabledAt: row.disabled_at as number,
  }));
}

export function enableAgent(projectId: string, agentId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "DELETE FROM disabled_agents WHERE project_id = ? AND agent_id = ?",
  ).run(projectId, agentId);
}

// ---------------------------------------------------------------------------
// Hierarchical scope functions
// ---------------------------------------------------------------------------

/**
 * Disable a scope (agent, team, or department) for a project.
 */
export function disableScope(
  projectId: string,
  scopeType: DisableScope,
  scopeValue: string,
  reason: string,
  disabledBy?: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO disabled_scopes (id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, scopeType, scopeValue, reason, now, disabledBy ?? null);
}

/**
 * Enable (remove disable) a scope for a project.
 */
export function enableScope(
  projectId: string,
  scopeType: DisableScope,
  scopeValue: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "DELETE FROM disabled_scopes WHERE project_id = ? AND scope_type = ? AND scope_value = ?",
  ).run(projectId, scopeType, scopeValue);
}

/**
 * Check whether an agent is effectively disabled — either directly,
 * or via a team/department scope, or via the legacy disabled_agents table.
 *
 * To avoid circular imports when `getAgentConfig` is not available
 * (or when the caller already has the agent's team/department), pass
 * them as optional params.
 */
export function isAgentEffectivelyDisabled(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
  opts?: { team?: string; department?: string },
): boolean {
  const db = dbOverride ?? getDb(projectId);

  // 0. Check domain-level disable — if the entire domain is disabled, all agents are disabled
  const domainScope = db.prepare(
    "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId);
  if (domainScope) return true;

  // 1. Check legacy disabled_agents table
  const legacyRow = db.prepare(
    "SELECT 1 FROM disabled_agents WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId);
  if (legacyRow) return true;

  // 2. Check disabled_scopes for agent-level scope
  const agentScope = db.prepare(
    "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'agent' AND scope_value = ?",
  ).get(projectId, agentId);
  if (agentScope) return true;

  // 3. Resolve team/department — use provided opts or look up from config
  let team = opts?.team;
  let department = opts?.department;
  if (team === undefined || department === undefined) {
    const entry = getAgentConfig(agentId);
    if (entry) {
      if (team === undefined) team = entry.config.team;
      if (department === undefined) department = entry.config.department;
    }
  }

  // 4. Check disabled_scopes for team-level scope
  if (team) {
    const teamScope = db.prepare(
      "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'team' AND scope_value = ?",
    ).get(projectId, team);
    if (teamScope) return true;
  }

  // 5. Check disabled_scopes for department-level scope
  if (department) {
    const deptScope = db.prepare(
      "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'department' AND scope_value = ?",
    ).get(projectId, department);
    if (deptScope) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Domain-level disable functions
// ---------------------------------------------------------------------------

/**
 * Disable an entire domain (project). Uses the disabled_scopes table
 * with scope_type="domain" and scope_value=projectId.
 * When a domain is disabled, ALL dispatches for the project are blocked.
 */
export function disableDomain(
  projectId: string,
  reason: string,
  disabledBy?: string,
  dbOverride?: DatabaseSync,
): void {
  disableScope(projectId, "domain", projectId, reason, disabledBy, dbOverride);
}

/**
 * Enable (remove disable) for a domain.
 */
export function enableDomain(
  projectId: string,
  dbOverride?: DatabaseSync,
): void {
  enableScope(projectId, "domain", projectId, dbOverride);
}

/**
 * Check if a domain is currently disabled.
 */
export function isDomainDisabled(
  projectId: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT 1 FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId);
  return !!row;
}

/**
 * Get domain disable details (reason, timestamp, who disabled it).
 * Returns null if domain is not disabled.
 */
export function getDomainDisableInfo(
  projectId: string,
  dbOverride?: DatabaseSync,
): DisabledScopeEntry | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    scopeType: row.scope_type as DisableScope,
    scopeValue: row.scope_value as string,
    reason: row.reason as string,
    disabledAt: row.disabled_at as number,
    disabledBy: (row.disabled_by as string) ?? null,
  };
}

/**
 * List all disabled scopes for a project.
 */
export function listDisabledScopes(
  projectId: string,
  dbOverride?: DatabaseSync,
): DisabledScopeEntry[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by FROM disabled_scopes WHERE project_id = ? ORDER BY disabled_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    scopeType: row.scope_type as DisableScope,
    scopeValue: row.scope_value as string,
    reason: row.reason as string,
    disabledAt: row.disabled_at as number,
    disabledBy: (row.disabled_by as string) ?? null,
  }));
}
