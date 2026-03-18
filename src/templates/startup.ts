/**
 * Clawforce — Startup Template
 *
 * The lean, dogfood-first template. Ships with:
 * - lead (manager) with dispatch/reflect/ops jobs
 * - dev-1 (employee)
 * - agent-builder (employee) for self-adaptation
 */

import type { AgentConfig, JobDefinition } from "../types.js";

export type TemplateDefinition = {
  name: string;
  description: string;
  agents: Record<string, Partial<AgentConfig> & { extends: string }>;
  budgets?: {
    project?: { daily: { cents: number } };
  };
};

export const STARTUP_TEMPLATE: TemplateDefinition = {
  name: "startup",
  description: "Lean team: manager + dev(s) + agent-builder. Self-adapts as needed.",
  agents: {
    lead: {
      extends: "manager",
      title: "Team Lead",
      jobs: {
        dispatch: {
          cron: "*/5 * * * *",
          tools: ["task_assign", "task_create", "budget_check", "message_send"],
          briefing: [
            { source: "instructions" },
            { source: "task_board" },
            { source: "pending_messages" },
          ],
        },
        reflect: {
          cron: "0 9 * * MON",
          tools: ["org_modify", "skill_create", "budget_reallocate", "agent_hire"],
          briefing: [
            { source: "instructions" },
            { source: "velocity" },
            { source: "trust_scores" },
            { source: "cost_summary" },
            { source: "cost_forecast" },
            { source: "team_performance" },
          ],
        },
        ops: {
          cron: "0 * * * *",
          tools: ["health_check", "message_send"],
          briefing: [
            { source: "instructions" },
            { source: "health_status" },
          ],
        },
      },
    },
    "dev-1": {
      extends: "employee",
      title: "Developer",
      reports_to: "lead",
    },
    "agent-builder": {
      extends: "employee",
      title: "Agent Builder",
      reports_to: "lead",
    },
  },
  budgets: {
    project: { daily: { cents: 3000 } },
  },
};

const TEMPLATES: Record<string, TemplateDefinition> = {
  startup: STARTUP_TEMPLATE,
};

export function getTemplate(name: string): TemplateDefinition | null {
  return TEMPLATES[name] ?? null;
}
