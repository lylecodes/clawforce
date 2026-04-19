/**
 * Clawforce — Global Agent Roster Registry
 *
 * Agents are defined globally and assigned to domains.
 * An agent can belong to multiple domains.
 */

import type { GlobalAgentDef } from "./schema.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

type ConfigRegistryRuntimeState = {
  globalAgents: Map<string, GlobalAgentDef>;
  domainAgents: Map<string, Set<string>>;
  agentDomains: Map<string, Set<string>>;
};

const runtime = getDefaultRuntimeState();

function getConfigRegistryState(): ConfigRegistryRuntimeState {
  return runtime.configRegistry as ConfigRegistryRuntimeState;
}

export function registerGlobalAgents(agents: Record<string, GlobalAgentDef>): void {
  const state = getConfigRegistryState();
  for (const [id, def] of Object.entries(agents)) {
    state.globalAgents.set(id, def);
  }
}

/**
 * Replace the global agent roster with the provided definitions.
 * Removes agents that no longer exist and prunes their domain assignments.
 */
export function syncGlobalAgents(agents: Record<string, GlobalAgentDef>): void {
  const state = getConfigRegistryState();
  const nextIds = new Set(Object.keys(agents));

  for (const agentId of [...state.globalAgents.keys()]) {
    if (nextIds.has(agentId)) continue;
    removeAgentEverywhere(agentId);
  }

  registerGlobalAgents(agents);
}

export function assignAgentsToDomain(domainId: string, agentIds: string[]): void {
  const state = getConfigRegistryState();
  if (!state.domainAgents.has(domainId)) {
    state.domainAgents.set(domainId, new Set());
  }
  const domSet = state.domainAgents.get(domainId)!;
  for (const agentId of agentIds) {
    domSet.add(agentId);
    if (!state.agentDomains.has(agentId)) {
      state.agentDomains.set(agentId, new Set());
    }
    state.agentDomains.get(agentId)!.add(domainId);
  }
}

/**
 * Replace the agents assigned to a domain.
 */
export function setAgentsForDomain(domainId: string, agentIds: string[]): void {
  removeDomain(domainId);
  assignAgentsToDomain(domainId, agentIds);
}

/**
 * Remove a domain assignment from the registry.
 */
export function removeDomain(domainId: string): void {
  const state = getConfigRegistryState();
  const agents = state.domainAgents.get(domainId);
  if (!agents) return;

  for (const agentId of agents) {
    const domains = state.agentDomains.get(agentId);
    if (!domains) continue;
    domains.delete(domainId);
    if (domains.size === 0) {
      state.agentDomains.delete(agentId);
    }
  }

  state.domainAgents.delete(domainId);
}

export function getGlobalAgent(agentId: string): GlobalAgentDef | null {
  return getConfigRegistryState().globalAgents.get(agentId) ?? null;
}

/** Returns the primary (first-assigned) domain for an agent, or null. */
export function getAgentDomain(agentId: string): string | null {
  const domains = getConfigRegistryState().agentDomains.get(agentId);
  if (!domains || domains.size === 0) return null;
  return domains.values().next().value!;
}

/** Returns all domains an agent is assigned to. */
export function getAgentDomains(agentId: string): string[] {
  const domains = getConfigRegistryState().agentDomains.get(agentId);
  if (!domains) return [];
  return [...domains];
}

/** Returns all agents assigned to a domain with their global config. */
export function getDomainAgents(domainId: string): Array<{ id: string; config: GlobalAgentDef }> {
  const state = getConfigRegistryState();
  const agents = state.domainAgents.get(domainId);
  if (!agents) return [];
  return [...agents].map(id => ({
    id,
    config: state.globalAgents.get(id)!,
  })).filter(entry => entry.config != null);
}

/** Returns all registered global agent IDs. */
export function getGlobalAgentIds(): string[] {
  return [...getConfigRegistryState().globalAgents.keys()];
}

/** Clear all registries (for test cleanup). */
export function clearRegistry(): void {
  const state = getConfigRegistryState();
  state.globalAgents.clear();
  state.domainAgents.clear();
  state.agentDomains.clear();
  runtime.configInit.managedDomainsByBaseDir.clear();
  runtime.configInit.domainOwnerBaseDirs.clear();
}

function removeAgentEverywhere(agentId: string): void {
  const state = getConfigRegistryState();
  state.globalAgents.delete(agentId);

  const domains = state.agentDomains.get(agentId);
  if (domains) {
    for (const domainId of domains) {
      const agents = state.domainAgents.get(domainId);
      if (!agents) continue;
      agents.delete(agentId);
      if (agents.size === 0) {
        state.domainAgents.delete(domainId);
      }
    }
  }

  state.agentDomains.delete(agentId);
}
