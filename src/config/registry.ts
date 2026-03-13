/**
 * Clawforce — Global Agent Roster Registry
 *
 * Agents are defined globally and assigned to domains.
 * An agent can belong to multiple domains.
 */

import type { GlobalAgentDef } from "./schema.js";

// agentId → definition
const globalAgents = new Map<string, GlobalAgentDef>();

// domainId → Set<agentId>
const domainAgents = new Map<string, Set<string>>();

// agentId → Set<domainId>
const agentDomains = new Map<string, Set<string>>();

export function registerGlobalAgents(agents: Record<string, GlobalAgentDef>): void {
  for (const [id, def] of Object.entries(agents)) {
    globalAgents.set(id, def);
  }
}

export function assignAgentsToDomain(domainId: string, agentIds: string[]): void {
  if (!domainAgents.has(domainId)) {
    domainAgents.set(domainId, new Set());
  }
  const domSet = domainAgents.get(domainId)!;
  for (const agentId of agentIds) {
    domSet.add(agentId);
    if (!agentDomains.has(agentId)) {
      agentDomains.set(agentId, new Set());
    }
    agentDomains.get(agentId)!.add(domainId);
  }
}

export function getGlobalAgent(agentId: string): GlobalAgentDef | null {
  return globalAgents.get(agentId) ?? null;
}

/** Returns the primary (first-assigned) domain for an agent, or null. */
export function getAgentDomain(agentId: string): string | null {
  const domains = agentDomains.get(agentId);
  if (!domains || domains.size === 0) return null;
  return domains.values().next().value!;
}

/** Returns all domains an agent is assigned to. */
export function getAgentDomains(agentId: string): string[] {
  const domains = agentDomains.get(agentId);
  if (!domains) return [];
  return [...domains];
}

/** Returns all agents assigned to a domain with their global config. */
export function getDomainAgents(domainId: string): Array<{ id: string; config: GlobalAgentDef }> {
  const agents = domainAgents.get(domainId);
  if (!agents) return [];
  return [...agents].map(id => ({
    id,
    config: globalAgents.get(id)!,
  })).filter(entry => entry.config != null);
}

/** Returns all registered global agent IDs. */
export function getGlobalAgentIds(): string[] {
  return [...globalAgents.keys()];
}

/** Clear all registries (for test cleanup). */
export function clearRegistry(): void {
  globalAgents.clear();
  domainAgents.clear();
  agentDomains.clear();
}
