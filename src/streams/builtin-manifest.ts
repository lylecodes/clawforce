/**
 * Clawforce — Built-in Stream Manifest
 *
 * Registers all existing context sources in the stream catalog.
 * Resolution logic stays in the assembler; this provides metadata only.
 */

import { registerStream } from "./catalog.js";

export function registerBuiltinStreams(): void {
  registerStream({ name: "instructions", description: "Auto-generated instructions from agent expectations", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "custom", description: "Raw markdown content injected directly", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "project_md", description: "PROJECT.md charter file content", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "task_board", description: "Current task board with status, priority, and assignee", builtIn: true, outputTargets: ["briefing", "webhook"],
    params: [
      { name: "status", type: "string[]", description: "Filter by task status", default: undefined },
      { name: "limit", type: "number", description: "Max tasks to show", default: 50 },
    ],
  });
  registerStream({ name: "assigned_task", description: "The specific task assigned to this agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "knowledge", description: "Searchable knowledge base entries", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "file", description: "Raw file content from a path", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "skill", description: "Agent skill pack documentation", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "memory", description: "Memory search instructions for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "escalations", description: "Pending and recent escalation events", builtIn: true, outputTargets: ["briefing", "telegram"] });
  registerStream({ name: "workflows", description: "Active workflow phases and progress", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "activity", description: "Recent agent activity log", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "sweep_status", description: "Automated sweep findings and status", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "proposals", description: "Pending approval proposals", builtIn: true, outputTargets: ["briefing", "telegram"] });
  registerStream({ name: "agent_status", description: "Status of all agents in the team", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "cost_summary", description: "Cost tracking summary for the project", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "policy_status", description: "Compliance policy enforcement status", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "health_status", description: "System health indicators", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "team_status", description: "Team member availability and workload", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "team_performance", description: "Performance metrics per team member", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "soul", description: "Agent SOUL.md identity document", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "tools_reference", description: "Available tools documentation for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "pending_messages", description: "Unread messages for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "goal_hierarchy", description: "Goal tree with completion status", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "channel_messages", description: "Recent messages in agent channels", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "planning_delta", description: "Changes since last planning cycle", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "velocity", description: "Task completion velocity and trends", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "preferences", description: "User preference store entries", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "trust_scores", description: "Trust evolution scores per action category", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "resources", description: "Model rate limits and capacity information", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "initiative_status", description: "Initiative allocation vs spend breakdown", builtIn: true, outputTargets: ["briefing", "webhook"],
    params: [
      { name: "granularity", type: "string", description: "Detail level: summary or detailed", default: "summary" },
    ],
  });
  registerStream({ name: "cost_forecast", description: "Budget exhaustion projection", builtIn: true, outputTargets: ["briefing", "telegram", "webhook"],
    params: [
      { name: "horizon", type: "string", description: "Forecast time horizon", default: "24h" },
      { name: "granularity", type: "string", description: "per_initiative or aggregate", default: "aggregate" },
    ],
  });
  registerStream({ name: "available_capacity", description: "Current rate limit headroom and concurrent slot availability", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "knowledge_candidates", description: "Memory entries flagged for promotion to structured knowledge", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "budget_guidance", description: "Budget utilization, remaining sessions, and exhaustion forecast", builtIn: true, outputTargets: ["briefing", "telegram"] });
}
