/**
 * Clawforce — Org hierarchy helpers
 *
 * Scans the agent config registry to build org relationships:
 * direct reports, escalation chains, and department/team groupings.
 */

import { getAgentConfig, getRegisteredAgentIds } from "./project.js";

/**
 * Get all agents that report to a given manager within a project.
 */
export function getDirectReports(projectId: string, managerId: string): string[] {
  const allIds = getRegisteredAgentIds();
  const reports: string[] = [];

  for (const agentId of allIds) {
    const entry = getAgentConfig(agentId);
    if (!entry) continue;
    if (entry.projectId !== projectId) continue;
    if (entry.config.reports_to === managerId) {
      reports.push(agentId);
    }
  }

  return reports;
}

/**
 * Resolve the full escalation chain from an agent up to the root.
 * Returns an ordered list of agent IDs: [immediate manager, their manager, ...].
 * Stops at "parent" or when no reports_to is defined.
 * Includes cycle detection — returns the chain up to the cycle point.
 */
export function resolveEscalationChain(projectId: string, startAgentId: string): {
  chain: string[];
  hasCycle: boolean;
} {
  const chain: string[] = [];
  const visited = new Set<string>();
  visited.add(startAgentId);

  let currentId = startAgentId;

  while (true) {
    const entry = getAgentConfig(currentId);
    if (!entry || entry.projectId !== projectId) break;

    const reportsTo = entry.config.reports_to;
    if (!reportsTo || reportsTo === "parent") break;

    if (visited.has(reportsTo)) {
      // Cycle detected
      return { chain, hasCycle: true };
    }

    chain.push(reportsTo);
    visited.add(reportsTo);
    currentId = reportsTo;
  }

  return { chain, hasCycle: false };
}

/**
 * Get all agents in the same department within a project.
 */
export function getDepartmentAgents(projectId: string, department: string): string[] {
  const allIds = getRegisteredAgentIds();
  const result: string[] = [];

  for (const agentId of allIds) {
    const entry = getAgentConfig(agentId);
    if (!entry) continue;
    if (entry.projectId !== projectId) continue;
    if (entry.config.department === department) {
      result.push(agentId);
    }
  }

  return result;
}

/**
 * Get all agents in the same team within a project.
 */
export function getTeamAgents(projectId: string, team: string): string[] {
  const allIds = getRegisteredAgentIds();
  const result: string[] = [];

  for (const agentId of allIds) {
    const entry = getAgentConfig(agentId);
    if (!entry) continue;
    if (entry.projectId !== projectId) continue;
    if (entry.config.team === team) {
      result.push(agentId);
    }
  }

  return result;
}
