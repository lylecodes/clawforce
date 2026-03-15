/**
 * Clawforce — Demo Domain Creator
 *
 * Generates a full demo config based on the full-org example:
 * 10 agents, 3 departments, CEO -> VPs -> employees.
 * Budget: $150/day, initiatives: Product Launch 40%, Pipeline 30%, Reserve 30%.
 */

import type { GlobalConfig, GlobalAgentDef } from "../config/schema.js";
import type { InitDomainOpts } from "../config/wizard.js";

export type DemoConfig = {
  global: Partial<GlobalConfig>;
  domain: InitDomainOpts;
  /** Extra domain-level config fields written directly into the YAML */
  domainExtras: Record<string, unknown>;
};

/**
 * Build the full-org demo config objects.
 * These can be passed directly to scaffoldConfigDir() and initDomain().
 */
export function createDemoConfig(): DemoConfig {
  const agents: Record<string, GlobalAgentDef> = {
    ceo: {
      extends: "manager",
      title: "CEO",
      persona:
        "You lead the company. Set strategic direction, allocate resources across departments, review weekly performance.",
    },
    "vp-eng": {
      extends: "manager",
      title: "VP of Engineering",
      reports_to: "ceo",
      department: "engineering",
      persona:
        "You lead engineering. Prioritize technical work, manage sprint cycles, review PRs.",
    },
    frontend: {
      extends: "employee",
      title: "Frontend Developer",
      reports_to: "vp-eng",
      department: "engineering",
      team: "ui",
    },
    backend: {
      extends: "employee",
      title: "Backend Developer",
      reports_to: "vp-eng",
      department: "engineering",
      team: "api",
    },
    devops: {
      extends: "employee",
      title: "DevOps Engineer",
      reports_to: "vp-eng",
      department: "engineering",
      team: "infra",
    },
    "vp-sales": {
      extends: "manager",
      title: "VP of Sales",
      reports_to: "ceo",
      department: "sales",
      persona:
        "You manage the sales pipeline. Daily outreach, follow-ups, close deals.",
    },
    "lead-gen": {
      extends: "employee",
      title: "Lead Generation Specialist",
      reports_to: "vp-sales",
      department: "sales",
      team: "outreach",
    },
    closer: {
      extends: "employee",
      title: "Account Executive",
      reports_to: "vp-sales",
      department: "sales",
      team: "closing",
    },
    "ops-lead": {
      extends: "manager",
      title: "Operations Lead",
      reports_to: "ceo",
      department: "operations",
      persona:
        "You handle admin, compliance, and internal processes.",
    },
    analyst: {
      extends: "employee",
      title: "Data Analyst",
      reports_to: "ops-lead",
      department: "operations",
    },
  };

  const agentNames = Object.keys(agents);

  const global: Partial<GlobalConfig> = { agents };

  const domain: InitDomainOpts = {
    name: "demo-company",
    agents: agentNames,
    orchestrator: "ceo",
    operational_profile: "medium",
    agentPresets: Object.fromEntries(
      agentNames.map((name) => [name, agents[name]!.extends ?? "employee"]),
    ),
  };

  const domainExtras: Record<string, unknown> = {
    budget: {
      daily: { cents: 15000, tokens: 10_000_000 },
      hourly: { cents: 3000 },
      monthly: { cents: 300_000 },
    },
    safety: {
      max_spawn_depth: 3,
      cost_circuit_breaker: 1.5,
      loop_detection_threshold: 3,
    },
    goals: {
      "product-launch": {
        allocation: 40,
        description: "Ship v2.0 by end of month",
        department: "engineering",
      },
      "pipeline-growth": {
        allocation: 30,
        description: "Grow sales pipeline to 50 qualified leads",
        department: "sales",
      },
      // 30% unallocated = reserve for ad-hoc work
    },
  };

  return { global, domain, domainExtras };
}
