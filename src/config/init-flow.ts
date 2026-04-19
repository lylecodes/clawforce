/**
 * Clawforce — Interactive Init Flow
 *
 * Structured question sequence and config builder for agent-driven setup.
 * The agent asks questions, collects answers, then calls buildConfigFromAnswers()
 * to generate config objects that feed into the existing wizard API.
 */

import type { GlobalAgentDef, GlobalConfig } from "./schema.js";
import type { InitDomainOpts } from "./wizard.js";
import { estimateBudget, formatBudgetSummary } from "./budget-guide.js";
import type { Direction, Autonomy } from "../direction.js";

export type QuestionType = "text" | "choice" | "number" | "structured";

export type InitQuestion = {
  id: string;
  type: QuestionType;
  prompt: string;
  description?: string;
  default?: unknown;
  choices?: string[];
  skip?: (answers: Partial<InitAnswers>) => boolean;
};

export type AgentAnswer = {
  name: string;
  title: string;
  model?: string;
};

export type InitAnswers = {
  domain_name: string;
  mission: string;
  agents: AgentAnswer[];
  reporting: Record<string, string>;
  budget_cents: number;
  model_preference?: string;
  operational_profile?: "low" | "medium" | "high" | "ultra";
  vision?: string;
  autonomy?: Autonomy;
  template?: string;
};

export function getInitQuestions(): InitQuestion[] {
  return [
    {
      id: "template",
      type: "choice",
      prompt: "Pick a team template",
      description:
        "Templates provide pre-configured team structures. 'startup' is lean (just a lead + devs). 'custom' lets you define everything.",
      choices: ["startup", "custom"],
      default: "startup",
    },
    {
      id: "vision",
      type: "text",
      prompt: "What's the vision? Describe what you want to build.",
      description:
        "This becomes the DIRECTION.md that guides the team. Can be a sentence or a paragraph.",
    },
    {
      id: "autonomy",
      type: "choice",
      prompt: "How much autonomy should the team have?",
      description:
        "Low = all adaptations need your approval. Medium = routine changes auto-approved. High = team self-manages within budget.",
      choices: ["low", "medium", "high"],
      default: "low",
    },
    {
      id: "domain_name",
      type: "text",
      prompt: "What should this domain be called?",
      description: "A short identifier like 'rentright' or 'sales-team'.",
      default: "my-project",
    },
    {
      id: "mission",
      type: "text",
      prompt: "What's the mission? One sentence.",
      description: "This becomes the project charter that guides all agents.",
    },
    {
      id: "agents",
      type: "structured",
      prompt: "Who's on the team? Give me names and titles.",
      description:
        "List each agent with a short ID and job title. Example: lead (Engineering Lead), frontend (Frontend Dev), backend (Backend Dev).",
    },
    {
      id: "reporting",
      type: "structured",
      prompt: "Who reports to whom?",
      description:
        "For each agent, specify their manager. Agents without a manager are standalone. Roles are auto-detected from this structure.",
      skip: (answers) => (answers.agents?.length ?? 0) <= 1,
    },
    {
      id: "budget_cents",
      type: "number",
      prompt: "Daily budget in dollars?",
      description:
        "How much to spend per day across all agents. We'll show a recommendation based on your team size.",
    },
    {
      id: "operational_profile",
      type: "choice",
      prompt: "Pick an operational level",
      description: "Controls how intensively your agents coordinate, remember, and communicate.",
      choices: ["low", "medium", "high", "ultra"],
    },
    {
      id: "model_preference",
      type: "choice",
      prompt:
        "Use recommended models (GPT-5.4 for managers, GPT-5.4 mini for workers) or override?",
      choices: ["recommended", "override"],
      default: "recommended",
    },
  ];
}

export function getBudgetGuidance(answers: Partial<InitAnswers>): string | null {
  if (!answers.agents || answers.agents.length === 0) return null;

  const agentInputs = answers.agents.map((a) => {
    const isManager = Object.values(answers.reporting ?? {}).includes(a.name);
    return {
      agentId: a.name,
      model: a.model ?? (isManager ? "gpt-5.4" : "gpt-5.4-mini"),
      role: isManager ? ("manager" as const) : ("employee" as const),
    };
  });

  const estimate = estimateBudget(agentInputs);
  return formatBudgetSummary(estimate);
}

export function buildConfigFromAnswers(answers: InitAnswers): {
  global: Partial<GlobalConfig>;
  domain: InitDomainOpts;
  direction?: Partial<Direction>;
} {
  const agents: Record<string, GlobalAgentDef> = {};
  const agentNames: string[] = [];

  for (const agent of answers.agents) {
    const def: GlobalAgentDef = { title: agent.title };
    if (agent.model) {
      def.codex = { model: agent.model };
    }
    if (answers.reporting[agent.name]) {
      def.reports_to = answers.reporting[agent.name];
    }
    agents[agent.name] = def;
    agentNames.push(agent.name);
  }

  const global: Partial<GlobalConfig> = { agents };
  const domain: InitDomainOpts = {
    name: answers.domain_name,
    agents: agentNames,
  };

  if (answers.operational_profile) {
    domain.operational_profile = answers.operational_profile;
  }

  if (answers.template) {
    domain.template = answers.template;
  }

  const direction = answers.vision
    ? {
        vision: answers.vision,
        autonomy: (answers.autonomy ?? "low") as Autonomy,
      }
    : undefined;

  return { global, domain, direction };
}
