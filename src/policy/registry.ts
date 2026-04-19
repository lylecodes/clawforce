/**
 * Clawforce — Policy registry
 *
 * In-memory policy cache. Policies are loaded from project config
 * and cached for fast runtime lookups.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";
import type { PolicyDefinition, PolicyType } from "../types.js";

type PolicyRegistryRuntimeState = {
  cache: Map<string, PolicyDefinition[]>;
};

const runtime = getDefaultRuntimeState();

function getPolicyCache(): PolicyRegistryRuntimeState["cache"] {
  return (runtime.policy as PolicyRegistryRuntimeState).cache;
}

/**
 * Register policies from project config into the in-memory cache and DB.
 */
export function registerPolicies(
  projectId: string,
  policies: Array<{
    name: string;
    type: string;
    target?: string;
    config: Record<string, unknown>;
  }>,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const registered: PolicyDefinition[] = [];

  // Treat config registration as a full replacement for the project's
  // active policy set so repeated activation/reload does not accumulate
  // stale or duplicate config policies in SQLite.
  try {
    db.prepare("DELETE FROM policies WHERE project_id = ?").run(projectId);
  } catch (err) {
    safeLog("policy.register.clear", err);
  }

  for (let i = 0; i < policies.length; i++) {
    const p = policies[i]!;
    const id = crypto.randomUUID();

    try {
      db.prepare(`
        INSERT OR REPLACE INTO policies (id, project_id, name, type, target_agent, config, enabled, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(id, projectId, p.name, p.type, p.target ?? null, JSON.stringify(p.config), i, now, now);
    } catch (err) {
      safeLog("policy.register", err);
    }

    registered.push({
      id,
      projectId,
      name: p.name,
      type: p.type as PolicyType,
      targetAgent: p.target,
      config: p.config,
      enabled: true,
      priority: i,
      createdAt: now,
      updatedAt: now,
    });
  }

  getPolicyCache().set(projectId, registered);
}

/**
 * Get all active policies for a project, optionally filtered by agent.
 */
export function getPolicies(
  projectId: string,
  agentId?: string,
): PolicyDefinition[] {
  const all = getPolicyCache().get(projectId) ?? [];
  if (!agentId) return all.filter((p) => p.enabled);

  return all.filter((p) =>
    p.enabled && (!p.targetAgent || p.targetAgent === agentId),
  );
}

export function clearProjectPolicies(
  projectId: string,
  dbOverride?: DatabaseSync,
): void {
  getPolicyCache().delete(projectId);

  try {
    const db = dbOverride ?? getDb(projectId);
    db.prepare("DELETE FROM policies WHERE project_id = ?").run(projectId);
  } catch (err) {
    safeLog("policy.clear", err);
  }
}

/** Clear cache (for testing). */
export function resetPolicyRegistryForTest(): void {
  getPolicyCache().clear();
}
