/**
 * Clawforce — Skill topic registry
 *
 * Central registry of generated-from-source domain knowledge topics.
 * Each topic has a role filter so agents only see relevant knowledge.
 */

import type { AgentRole } from "../types.js";

import { generate as generateRoles } from "./topics/roles.js";
import { generate as generateTasks } from "./topics/tasks.js";
import { generate as generateAccountability } from "./topics/accountability.js";
import { generate as generateContextSources } from "./topics/context-sources.js";
import { generate as generateWorkflows } from "./topics/workflows.js";
import { generate as generateOrg } from "./topics/org.js";
import { generate as generatePolicies } from "./topics/policies.js";
import { generate as generateBudgets } from "./topics/budgets.js";
import { generate as generateRisk } from "./topics/risk.js";
import { generate as generateApproval } from "./topics/approval.js";
import { generate as generateConfig } from "./topics/config.js";
import { generate as generateTools } from "./topics/tools.js";
import { generate as generateMemory } from "./topics/memory.js";

export type SkillTopic = {
  id: string;
  title: string;
  description: string;
  /** Which roles this topic is relevant for. Empty = all roles. */
  roles: AgentRole[];
  generate: () => string;
};

/**
 * All registered skill topics.
 * Order determines display order in the table of contents.
 */
export const SKILL_TOPICS: SkillTopic[] = [
  {
    id: "roles",
    title: "Agent Roles",
    description: "Role definitions, default profiles, and inheritance",
    roles: [],
    generate: generateRoles,
  },
  {
    id: "tasks",
    title: "Task Lifecycle",
    description: "Task states, transitions, evidence, and verification gates",
    roles: ["manager", "employee"],
    generate: generateTasks,
  },
  {
    id: "accountability",
    title: "Accountability",
    description: "Expectations, performance policies, and compliance enforcement",
    roles: [],
    generate: generateAccountability,
  },
  {
    id: "context_sources",
    title: "Context Sources",
    description: "All context sources available for agent briefing",
    roles: [],
    generate: generateContextSources,
  },
  {
    id: "memory",
    title: "Shared Memory",
    description: "Save and recall learnings across sessions and agents",
    roles: [],
    generate: generateMemory,
  },
  {
    id: "tools",
    title: "Tools Reference",
    description: "All tools and their actions",
    roles: [],
    generate: generateTools,
  },
  {
    id: "workflows",
    title: "Workflows",
    description: "Multi-phase workflow execution and gating",
    roles: ["manager"],
    generate: generateWorkflows,
  },
  {
    id: "org",
    title: "Org Hierarchy",
    description: "Reporting chains, departments, teams, and escalation",
    roles: ["manager"],
    generate: generateOrg,
  },
  {
    id: "policies",
    title: "Policies",
    description: "Action scopes, transition gates, and spend limits",
    roles: ["manager"],
    generate: generatePolicies,
  },
  {
    id: "budgets",
    title: "Budgets",
    description: "Cost tracking and budget enforcement",
    roles: ["manager"],
    generate: generateBudgets,
  },
  {
    id: "risk",
    title: "Risk Tiers",
    description: "Risk classification and approval gates",
    roles: ["manager"],
    generate: generateRisk,
  },
  {
    id: "approval",
    title: "Approval Flow",
    description: "Proposals, approvals, and rejection workflow",
    roles: ["manager"],
    generate: generateApproval,
  },
  {
    id: "config",
    title: "Configuration Reference",
    description: "Full project.yaml format and all options",
    roles: ["manager"],
    generate: generateConfig,
  },
];

/**
 * Get the list of topics available for a given role.
 * Empty roles array means the topic is available to all roles.
 */
export function getTopicList(role: AgentRole): Array<{ id: string; title: string; description: string }> {
  return SKILL_TOPICS
    .filter((t) => t.roles.length === 0 || t.roles.includes(role))
    .map((t) => ({ id: t.id, title: t.title, description: t.description }));
}

/**
 * Resolve skill content for an agent.
 *
 * - Without a topic: returns a table of contents of available topics.
 * - With a topic ID: returns the full generated content for that topic.
 */
export function resolveSkillSource(role: AgentRole, topic?: string): string | null {
  if (topic) {
    const entry = SKILL_TOPICS.find((t) => t.id === topic);
    if (!entry) {
      return `Unknown skill topic: "${topic}". Available topics: ${SKILL_TOPICS.map((t) => t.id).join(", ")}`;
    }
    if (entry.roles.length > 0 && !entry.roles.includes(role)) {
      return `Topic "${topic}" is not available for role "${role}".`;
    }
    return entry.generate();
  }

  // Table of contents
  const available = getTopicList(role);
  const lines = [
    "## System Knowledge\n",
    "Domain knowledge is available on the following topics. Use `clawforce_setup explain` with a `topic` parameter to query a specific topic.\n",
  ];

  for (const t of available) {
    lines.push(`- **${t.id}** — ${t.description}`);
  }

  return lines.join("\n");
}
