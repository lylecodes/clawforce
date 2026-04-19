import { writeAuditEntry } from "../../audit.js";
import {
  createConfigService,
  reloadDomainRuntime as reloadDomainRuntimeViaService,
  upsertGlobalAgents,
  writeDomainConfig,
} from "../../config/api-service.js";
import type { DomainConfig, GlobalAgentDef, GlobalConfig } from "../../config/schema.js";
import type { InitDomainOpts } from "../../config/wizard.js";
import { getDb } from "../../db.js";
import { createGoal } from "../../goals/ops.js";
import {
  buildStarterWorkflowScaffold,
  normalizeStarterWorkflow,
} from "../../setup/workflows.js";

export type DemoConfig = {
  global: Partial<GlobalConfig>;
  domain: InitDomainOpts;
  domainExtras: Record<string, unknown>;
};

type CommandError = {
  ok: false;
  status: number;
  error: string;
};

export type CreateDemoDomainCommandResult =
  | {
      ok: true;
      status: 201;
      domainId: string;
      message: string;
      reloadErrors: string[];
    }
  | CommandError;

export type CreateStarterDomainCommandResult =
  | {
      ok: true;
      status: 201;
      domainId: string;
      mode: StarterDomainMode;
      createdAgentIds: string[];
      reusedAgentIds: string[];
      message: string;
      reloadErrors: string[];
    }
  | CommandError;

type StarterDomainCommandOptions = {
  baseDir?: string;
};

export function runCreateDemoDomainCommand(
  actor = "demo-setup",
): CreateDemoDomainCommandResult {
  try {
    const { global, domain, domainExtras } = createDemoConfig();

    if (global.agents) {
      const agentResult = upsertGlobalAgents(global.agents, actor);
      if (!agentResult.ok) {
        return { ok: false, status: 500, error: `Failed to write demo agents: ${agentResult.error}` };
      }
    }

    const domainConfig: Record<string, unknown> = {
      domain: domain.name,
      agents: domain.agents,
    };
    if (domain.managerAgentId) {
      domainConfig.manager = {
        enabled: true,
        agentId: domain.managerAgentId,
      };
    }
    if (domain.operational_profile) domainConfig.operational_profile = domain.operational_profile;
    Object.assign(domainConfig, domainExtras);

    const domainResult = writeDomainConfig(domain.name, domainConfig as DomainConfig);
    if (!domainResult.ok) {
      return { ok: false, status: 500, error: `Failed to write demo domain: ${domainResult.error}` };
    }

    const reloadResult = reloadDomainRuntimeViaService(domain.name);
    const loadedOk = reloadResult.domains.includes(domain.name);

    if (loadedOk && domainExtras.goals) {
      syncDemoGoals(domain.name, domainExtras.goals, actor);
    }

    return {
      ok: true,
      status: 201,
      domainId: domain.name,
      message: `Demo domain "${domain.name}" created with ${domain.agents.length} agents.${loadedOk ? "" : " Warning: domain written but not loaded into runtime."}`,
      reloadErrors: reloadResult.errors,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runCreateStarterDomainCommand(
  body: Record<string, unknown>,
  actor = "dashboard",
  options: StarterDomainCommandOptions = {},
): CreateStarterDomainCommandResult {
  const planned = buildStarterDomainPlan(body, options);
  if (!planned.ok) {
    return planned;
  }

  const { plan } = planned;
  const configService = createConfigService({ baseDir: options.baseDir });

  try {
    if (plan.createdAgentIds.length > 0) {
      const agentResult = configService.upsertGlobalAgents(plan.agentsToCreate, actor);
      if (!agentResult.ok) {
        return { ok: false, status: 500, error: `Failed to create starter agents: ${agentResult.error}` };
      }
    }

    const domainResult = configService.writeDomainConfig(plan.domainId, plan.domainConfig);
    if (!domainResult.ok) {
      return { ok: false, status: 500, error: `Failed to write starter domain: ${domainResult.error}` };
    }

    const reloadResult = configService.reloadDomainRuntime(plan.domainId);
    const loadedOk = reloadResult.domains.includes(plan.domainId);

    try {
      writeAuditEntry({
        projectId: plan.domainId,
        actor,
        action: "create_domain",
        targetType: "domain",
        targetId: plan.domainId,
        detail: JSON.stringify({
          mode: plan.mode,
          createdAgentIds: plan.createdAgentIds,
          reusedAgentIds: plan.reusedAgentIds,
        }),
      });
    } catch {
      // non-fatal
    }

    return {
      ok: true,
      status: 201,
      domainId: plan.domainId,
      mode: plan.mode,
      createdAgentIds: plan.createdAgentIds,
      reusedAgentIds: plan.reusedAgentIds,
      message: loadedOk
        ? `Domain "${plan.domainId}" created and loaded in dry-run mode.`
        : `Domain "${plan.domainId}" created, but runtime reload reported errors.`,
      reloadErrors: reloadResult.errors,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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
    managerAgentId: "ceo",
    operational_profile: "medium",
    agentPresets: Object.fromEntries(
      agentNames.map((name) => [name, agents[name]!.extends ?? "employee"]),
    ),
  };

  const domainExtras: Record<string, unknown> = {
    budget: {
      project: {
        daily: { cents: 15000, tokens: 10_000_000 },
        hourly: { cents: 3000 },
        monthly: { cents: 300_000 },
      },
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
    },
  };

  return { global, domain, domainExtras };
}

type StarterDomainMode = "new" | "governance";

type StarterDomainPlan = {
  domainId: string;
  mode: StarterDomainMode;
  domainConfig: DomainConfig;
  agentsToCreate: Record<string, GlobalAgentDef>;
  createdAgentIds: string[];
  reusedAgentIds: string[];
};

function applyWorkspacePathsToAgents(
  agents: Record<string, GlobalAgentDef>,
  paths?: string[],
): Record<string, GlobalAgentDef> {
  if (!paths || paths.length === 0) {
    return agents;
  }

  return Object.fromEntries(
    Object.entries(agents).map(([agentId, agentDef]) => [
      agentId,
      {
        ...agentDef,
        workspace_paths: paths,
      },
    ]),
  );
}

function syncDemoGoals(
  domainId: string,
  rawGoals: unknown,
  actor: string,
): void {
  try {
    const db = getDb(domainId);
    db.prepare("DELETE FROM goals WHERE project_id = ? AND created_by = 'demo-setup'").run(domainId);
  } catch {
    // table may not exist yet
  }

  try {
    const goals = rawGoals as Record<string, { allocation?: number; description?: string; department?: string }>;
    for (const [goalId, goalDef] of Object.entries(goals)) {
      createGoal({
        projectId: domainId,
        title: goalId.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
        description: goalDef.description,
        department: goalDef.department,
        allocation: goalDef.allocation,
        createdBy: actor,
      });
    }
  } catch {
    // demo goals are non-fatal
  }
}

function buildStarterDomainPlan(
  body: Record<string, unknown>,
  options: StarterDomainCommandOptions = {},
): { ok: true; plan: StarterDomainPlan } | CommandError {
  const configService = createConfigService({ baseDir: options.baseDir });
  const rawDomainId = typeof body.domainId === "string"
    ? body.domainId
    : typeof body.domain === "string"
      ? body.domain
      : "";
  const domainId = normalizeStarterDomainId(rawDomainId);
  if (!domainId) {
    return { ok: false, status: 400, error: "domainId is required" };
  }

  const mode = body.mode === "governance" ? "governance" : body.mode === "new" ? "new" : null;
  if (!mode) {
    return { ok: false, status: 400, error: "mode must be one of: new, governance" };
  }

  if (configService.readDomainConfig(domainId)) {
    return { ok: false, status: 409, error: `Domain "${domainId}" already exists.` };
  }

  const globalConfig = configService.readGlobalConfig();
  const existingGlobalAgents = globalConfig.agents ?? {};
  const mission = typeof body.mission === "string" && body.mission.trim()
    ? body.mission.trim()
    : undefined;
  const workflow = normalizeStarterWorkflow(
    typeof body.workflow === "string"
      ? body.workflow
      : Array.isArray(body.workflows)
        ? body.workflows[0]
        : undefined,
  );
  const paths = normalizePathList(body.paths);
  const operationalProfile = typeof body.operationalProfile === "string" && body.operationalProfile.trim()
    ? body.operationalProfile.trim()
    : typeof body.operational_profile === "string" && body.operational_profile.trim()
      ? body.operational_profile.trim()
      : "medium";

  if (mode === "new") {
    if (workflow) {
      const workflowScaffold = buildStarterWorkflowScaffold(
        workflow,
        domainId,
        existingGlobalAgents,
        mission,
      );
      if (workflowScaffold.collisions.length > 0) {
        return {
          ok: false,
          status: 409,
          error: `Starter agent IDs already exist in global config: ${workflowScaffold.collisions.join(", ")}`,
        };
      }

      return {
        ok: true,
        plan: {
          domainId,
          mode,
          agentsToCreate: applyWorkspacePathsToAgents(workflowScaffold.agentsToCreate, paths),
          createdAgentIds: workflowScaffold.createdAgentIds,
          reusedAgentIds: workflowScaffold.reusedAgentIds,
          domainConfig: {
            domain: domainId,
            template: workflowScaffold.template,
            workflows: [workflow],
            agents: workflowScaffold.agentIds,
            manager: { enabled: true, agentId: workflowScaffold.managerAgentId },
            ...(paths ? { paths } : {}),
            operational_profile: operationalProfile as DomainConfig["operational_profile"],
            budget: budgetTemplateForProfile(operationalProfile),
            execution: {
              mode: "dry_run",
              default_mutation_policy: "simulate",
            },
            ...(workflowScaffold.domainConfigPatch ?? {}),
          },
        },
      };
    }

    const leadAgentId = `${domainId}-lead`;
    const builderAgentId = `${domainId}-builder`;
    const collisions = [leadAgentId, builderAgentId].filter((agentId) => existingGlobalAgents[agentId]);
    if (collisions.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Starter agent IDs already exist in global config: ${collisions.join(", ")}`,
      };
    }

    const agentsToCreate: Record<string, GlobalAgentDef> = {
      [leadAgentId]: {
        extends: "manager",
        title: "Business Lead",
        persona: mission
          ? `You lead this business. Focus the team on: ${mission}`
          : "You lead this business. Set direction, coordinate work, and keep the team within budget.",
      },
      [builderAgentId]: {
        extends: "employee",
        title: "Builder",
        reports_to: leadAgentId,
        team: "build",
        persona: mission
          ? `You execute the lead's plan for this business. Focus on: ${mission}`
          : "You execute the lead's plan for this business and report results clearly.",
      },
    };

    return {
      ok: true,
      plan: {
        domainId,
        mode,
        agentsToCreate: applyWorkspacePathsToAgents(agentsToCreate, paths),
        createdAgentIds: Object.keys(agentsToCreate),
        reusedAgentIds: [],
        domainConfig: {
          domain: domainId,
          template: "startup",
          agents: Object.keys(agentsToCreate),
          manager: { enabled: true, agentId: leadAgentId },
          ...(paths ? { paths } : {}),
          operational_profile: operationalProfile as DomainConfig["operational_profile"],
          budget: budgetTemplateForProfile(operationalProfile),
          execution: {
            mode: "dry_run",
            default_mutation_policy: "simulate",
          },
        },
      },
    };
  }

  const existingAgents = normalizeExistingAgentIds(body.existingAgents);
  if (existingAgents.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "existingAgents is required for governance mode",
    };
  }

  const requestedLeadAgentId = typeof body.leadAgentId === "string" && body.leadAgentId.trim()
    ? body.leadAgentId.trim()
    : undefined;
  const leadAgentId = requestedLeadAgentId ?? existingAgents[0]!;
  if (!existingAgents.includes(leadAgentId)) {
    return {
      ok: false,
      status: 400,
      error: `leadAgentId "${leadAgentId}" must be included in existingAgents`,
    };
  }

  const agentsToCreate: Record<string, GlobalAgentDef> = {};
  const reusedAgentIds: string[] = [];

  for (const agentId of existingAgents) {
    if (existingGlobalAgents[agentId]) {
      reusedAgentIds.push(agentId);
      continue;
    }

    agentsToCreate[agentId] = {
      extends: agentId === leadAgentId ? "manager" : "employee",
      title: humanizeIdentifier(agentId),
      ...(agentId === leadAgentId ? {} : { reports_to: leadAgentId }),
    };
  }

  return {
    ok: true,
    plan: {
      domainId,
      mode,
      agentsToCreate: applyWorkspacePathsToAgents(agentsToCreate, paths),
      createdAgentIds: Object.keys(agentsToCreate),
      reusedAgentIds,
      domainConfig: {
        domain: domainId,
        agents: existingAgents,
        manager: { enabled: true, agentId: leadAgentId },
        ...(workflow ? { workflows: [workflow] } : {}),
        ...(paths ? { paths } : {}),
        operational_profile: operationalProfile as DomainConfig["operational_profile"],
        budget: budgetTemplateForProfile(operationalProfile),
        execution: {
          mode: "dry_run",
          default_mutation_policy: "simulate",
        },
      },
    },
  };
}

function normalizeStarterDomainId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[:._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePathList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const paths = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return paths.length > 0 ? Array.from(new Set(paths)) : undefined;
}

function normalizeExistingAgentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function budgetTemplateForProfile(profile: string): DomainConfig["budget"] {
  const dailyByProfile: Record<string, number> = {
    low: 1_000,
    medium: 3_000,
    high: 7_500,
    ultra: 15_000,
  };
  const daily = dailyByProfile[profile] ?? dailyByProfile.medium;
  return {
    project: {
      hourly: { cents: Math.max(250, Math.round(daily / 10)) },
      daily: { cents: daily },
      monthly: { cents: daily * 22 },
    },
  };
}
