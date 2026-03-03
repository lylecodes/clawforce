/**
 * Clawforce — Policy registry
 *
 * In-memory policy cache. Policies are loaded from project config
 * and cached for fast runtime lookups.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import type { PolicyDefinition, PolicyType } from "../types.js";

/** In-memory policy cache: projectId → PolicyDefinition[] */
const policyCache = new Map<string, PolicyDefinition[]>();

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

  policyCache.set(projectId, registered);
}

/**
 * Get all active policies for a project, optionally filtered by agent.
 */
export function getPolicies(
  projectId: string,
  agentId?: string,
): PolicyDefinition[] {
  const all = policyCache.get(projectId) ?? [];
  if (!agentId) return all.filter((p) => p.enabled);

  return all.filter((p) =>
    p.enabled && (!p.targetAgent || p.targetAgent === agentId),
  );
}

/**
 * Toggle a policy enabled/disabled.
 */
export function togglePolicy(
  projectId: string,
  policyId: string,
  enabled: boolean,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const result = db.prepare(
    "UPDATE policies SET enabled = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).run(enabled ? 1 : 0, now, policyId, projectId);

  // Update cache
  const cached = policyCache.get(projectId);
  if (cached) {
    const policy = cached.find((p) => p.id === policyId);
    if (policy) policy.enabled = enabled;
  }

  return result.changes > 0;
}

/** Clear cache (for testing). */
export function resetPolicyRegistryForTest(): void {
  policyCache.clear();
}
