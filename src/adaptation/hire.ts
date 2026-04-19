/**
 * Clawforce — Agent Hiring
 *
 * Registers a new agent into the running domain config at runtime.
 * Used by managers during self-adaptation to spin up specialists.
 */

import type { AgentConfig, ContextSource, JobDefinition } from "../types.js";
import { getAgentConfig, registerAgentInProject } from "../project.js";
import { applyProfile } from "../profiles.js";

export type HireSpec = {
  agentId: string;
  extends?: string;
  title: string;
  reports_to?: string;
  observe?: string[];
  tools?: string[];
  briefing?: ContextSource[];
  jobs?: Record<string, JobDefinition>;
};

export type HireResult = {
  success: boolean;
  agentId: string;
  error?: string;
};

export function hireAgent(projectId: string, spec: HireSpec): HireResult {
  if (!spec.reports_to) {
    return {
      success: false,
      agentId: spec.agentId,
      error: "reports_to is required — every hired agent must report to a manager",
    };
  }

  const existing = getAgentConfig(spec.agentId, projectId);
  if (existing && existing.projectId === projectId) {
    return {
      success: false,
      agentId: spec.agentId,
      error: `Agent "${spec.agentId}" already exists in this domain`,
    };
  }

  const preset = spec.extends ?? "employee";

  // applyProfile only handles briefing/expectations/performance_policy merge
  const profileResult = applyProfile(preset, {
    briefing: spec.briefing ?? [],
    exclude_briefing: [],
    expectations: null,
    performance_policy: null,
  });

  const config: AgentConfig = {
    extends: preset,
    title: spec.title,
    reports_to: spec.reports_to,
    observe: spec.observe,
    tools: spec.tools,
    briefing: profileResult.briefing,
    expectations: profileResult.expectations,
    performance_policy: profileResult.performance_policy,
    jobs: spec.jobs,
  };

  registerAgentInProject(projectId, spec.agentId, config);

  return { success: true, agentId: spec.agentId };
}
