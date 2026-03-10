/**
 * Clawforce — Skill topic registry
 *
 * Central registry of generated-from-source domain knowledge topics.
 * Each topic has a role filter so agents only see relevant knowledge.
 */

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
import { generate as generateGoals } from "./topics/goals.js";
import { generate as generateChannels } from "./topics/channels.js";

export type SkillTopic = {
  id: string;
  title: string;
  description: string;
  /** Which presets/roles this topic is relevant for. Empty = all. */
  roles: string[];
  generate: () => string;
};

/** A custom skill topic registered from project config. */
export type CustomSkillTopic = {
  id: string;
  title: string;
  description: string;
  /** Absolute path to the markdown file. */
  filePath: string;
  /** Which presets/roles this topic is relevant for. Empty = all. */
  roles: string[];
};

/** Per-project store of custom skill topics. */
const customTopicsStore = new Map<string, CustomSkillTopic[]>();

/**
 * Register custom skill topics from a project's config.
 * Called during project initialization when project.yaml has a `skills` section.
 */
export function registerCustomSkills(
  projectId: string,
  skills: Record<string, { title: string; description: string; path: string; roles?: string[] }>,
  projectDir: string,
): void {
  const topics: CustomSkillTopic[] = [];
  const { resolve, join } = require("node:path") as typeof import("node:path");
  const { existsSync } = require("node:fs") as typeof import("node:fs");

  for (const [id, skill] of Object.entries(skills)) {
    const resolved = resolve(projectDir, skill.path);
    // Path traversal guard
    if (!resolved.startsWith(projectDir)) continue;
    if (!existsSync(resolved)) continue;

    topics.push({
      id,
      title: skill.title,
      description: skill.description,
      filePath: resolved,
      roles: skill.roles ?? [],
    });
  }

  if (topics.length > 0) {
    customTopicsStore.set(projectId, topics);
  }
}

/** Get custom topics for a project. */
export function getCustomTopics(projectId: string): CustomSkillTopic[] {
  return customTopicsStore.get(projectId) ?? [];
}

/** Clear custom topics (for testing). */
export function resetCustomTopicsForTest(): void {
  customTopicsStore.clear();
}

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
    roles: ["manager", "employee", "assistant"],
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
  {
    id: "goals",
    title: "Goal Hierarchy",
    description: "Goal decomposition, cascade, and progress tracking",
    roles: ["manager"],
    generate: generateGoals,
  },
  {
    id: "channels",
    title: "Channels & Meetings",
    description: "Topic-based channels, meeting mode, Telegram mirroring",
    roles: ["manager", "employee", "assistant"],
    generate: generateChannels,
  },
];

/**
 * Get the list of topics available for a given role.
 * Empty roles array means the topic is available to all roles.
 * When projectId is provided, includes custom topics from that project.
 */
export function getTopicList(role: string, projectId?: string): Array<{ id: string; title: string; description: string }> {
  const builtIn = SKILL_TOPICS
    .filter((t) => t.roles.length === 0 || t.roles.includes(role))
    .map((t) => ({ id: t.id, title: t.title, description: t.description }));

  if (!projectId) return builtIn;

  const custom = getCustomTopics(projectId)
    .filter((t) => t.roles.length === 0 || t.roles.includes(role))
    .map((t) => ({ id: t.id, title: t.title, description: t.description }));

  return [...builtIn, ...custom];
}

/**
 * Resolve skill content for an agent.
 *
 * - Without a topic: returns a table of contents of available topics.
 * - With a topic ID: returns the full generated content for that topic.
 * - projectId enables custom topics from project config.
 */
export function resolveSkillSource(role: string, topic?: string, excludeTopics?: string[], projectId?: string): string | null {
  if (topic) {
    // Check built-in topics first
    const entry = SKILL_TOPICS.find((t) => t.id === topic);
    if (entry) {
      if (entry.roles.length > 0 && !entry.roles.includes(role)) {
        return `Topic "${topic}" is not available for role "${role}".`;
      }
      return entry.generate();
    }

    // Check custom topics if projectId provided
    if (projectId) {
      const customs = getCustomTopics(projectId);
      const custom = customs.find((t) => t.id === topic);
      if (custom) {
        if (custom.roles.length > 0 && !custom.roles.includes(role)) {
          return `Topic "${topic}" is not available for role "${role}".`;
        }
        try {
          const { readFileSync } = require("node:fs") as typeof import("node:fs");
          const content = readFileSync(custom.filePath, "utf-8").trim();
          if (!content) return `Topic "${topic}" is empty.`;
          // Cap at 10KB
          const capped = content.length > 10_240 ? content.slice(0, 10_240) + "\n…(truncated)" : content;
          return `## ${custom.title}\n\n${capped}`;
        } catch {
          return `Failed to read custom topic "${topic}".`;
        }
      }
    }

    const allIds = SKILL_TOPICS.map((t) => t.id);
    if (projectId) {
      allIds.push(...getCustomTopics(projectId).map((t) => t.id));
    }
    return `Unknown skill topic: "${topic}". Available topics: ${allIds.join(", ")}`;
  }

  // Table of contents
  let available = getTopicList(role, projectId);
  if (excludeTopics && excludeTopics.length > 0) {
    available = available.filter((t) => !excludeTopics.includes(t.id));
  }

  const lines = [
    "## System Knowledge\n",
    "Domain knowledge is available on the following topics. Use `clawforce_setup explain` with a `topic` parameter to query a specific topic.\n",
  ];

  for (const t of available) {
    lines.push(`- **${t.id}** — ${t.description}`);
  }

  return lines.join("\n");
}
