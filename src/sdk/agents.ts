/**
 * Clawforce SDK — Agents Namespace
 *
 * Wraps internal agent registry and org-chart functions with the public SDK
 * vocabulary:
 *   role       → extends      (internal)
 *   group      → department   (internal)
 *   subgroup   → team         (internal)
 *   reportsTo  → reports_to   (internal)
 *
 * No internal files are modified — this is a pure wrapper layer.
 */

import {
  getAgentConfig,
  getRegisteredAgentIds,
} from "../project.js";
import {
  getDirectReports,
  getDepartmentAgents,
} from "../org.js";
import { getAgentCapabilities, hasCapability as capabilityCheck } from "./capabilities.js";
import type { AgentCapability, AgentInfo } from "./types.js";

/** Convert an internal agent registry entry into the public AgentInfo shape. */
function toAgentInfo(agentId: string, projectId?: string): AgentInfo | undefined {
  const entry = getAgentConfig(agentId, projectId);
  if (!entry) return undefined;
  const { config } = entry;
  return {
    id: agentId,
    role: config.extends,
    title: config.title,
    group: config.department,
    subgroup: config.team,
    groups: undefined, // not present on the internal AgentConfig
    capabilities: getAgentCapabilities({
      extends: config.extends,
      coordination: config.coordination,
    }),
    status: "active",
  };
}

export class AgentsNamespace {
  constructor(readonly domain: string) {}

  /**
   * List all agents registered in this domain, with optional group filter.
   * `group` maps to the internal `department` field.
   */
  list(filters?: { group?: string }): AgentInfo[] {
    const allIds = getRegisteredAgentIds(this.domain);
    const result: AgentInfo[] = [];

    for (const agentId of allIds) {
      const entry = getAgentConfig(agentId, this.domain);
      if (!entry) continue;

      // Apply group filter (group → department)
      if (filters?.group !== undefined && entry.config.department !== filters.group) {
        continue;
      }

      const info = toAgentInfo(agentId, this.domain);
      if (info) result.push(info);
    }

    return result;
  }

  /**
   * Get a single agent by ID. Returns undefined if the agent is not registered
   * in this domain.
   */
  get(agentId: string): AgentInfo | undefined {
    const entry = getAgentConfig(agentId, this.domain);
    if (!entry) return undefined;
    return toAgentInfo(agentId, this.domain);
  }

  /**
   * Get the resolved capability set for an agent.
   * Includes preset capabilities and any capabilities implied by
   * coordination.enabled.
   */
  capabilities(agentId: string): AgentCapability[] {
    const entry = getAgentConfig(agentId, this.domain);
    if (!entry) return [];
    const { config } = entry;
    return getAgentCapabilities({
      extends: config.extends,
      coordination: config.coordination,
    });
  }

  /**
   * Check whether an agent has a specific capability.
   * Returns false for unknown agents.
   */
  hasCapability(agentId: string, cap: AgentCapability): boolean {
    const entry = getAgentConfig(agentId, this.domain);
    if (!entry) return false;
    const { config } = entry;
    return capabilityCheck(
      {
        extends: config.extends,
        coordination: config.coordination,
      },
      cap,
    );
  }

  /**
   * Get the org-chart position for an agent: who they report to and who
   * reports to them.
   *
   * `reportsTo` is derived from the internal `reports_to` field (excluding
   * the sentinel value "parent").
   */
  hierarchy(agentId: string): { reportsTo?: string; directReports: string[] } {
    const entry = getAgentConfig(agentId, this.domain);
    if (!entry) {
      return { reportsTo: undefined, directReports: [] };
    }

    const rawReportsTo = entry.config.reports_to;
    const reportsTo =
      rawReportsTo && rawReportsTo !== "parent" ? rawReportsTo : undefined;

    const directReports = getDirectReports(this.domain, agentId);

    return { reportsTo, directReports };
  }

  /**
   * Get all agents in a group (maps to the internal `department` field).
   */
  group(groupName: string): AgentInfo[] {
    const ids = getDepartmentAgents(this.domain, groupName);
    const result: AgentInfo[] = [];
    for (const id of ids) {
      const info = toAgentInfo(id, this.domain);
      if (info) result.push(info);
    }
    return result;
  }
}
