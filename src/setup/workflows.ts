import type { GlobalAgentDef } from "../config/schema.js";
import type { AttentionAutomationState } from "../attention/types.js";

export const STARTER_WORKFLOW_TYPES = ["data-source-onboarding"] as const;

export type StarterWorkflowType = (typeof STARTER_WORKFLOW_TYPES)[number];

export type SetupWorkflowJobRequirement = {
  jobId: string;
  label: string;
  fixHint: string;
};

export type SetupWorkflowPreflightArtifact = {
  kind: "feed" | "decision" | "task" | "issue" | "proposal" | "simulated_action" | "runtime";
  label: string;
  detail: string;
  surface: string;
};

export type SetupWorkflowPreflightScenario = {
  id: string;
  title: string;
  trigger: string;
  outcome: string;
  operatorSurface: string;
  automationState: AttentionAutomationState;
  jobId?: string;
  predictedArtifacts?: SetupWorkflowPreflightArtifact[];
};

export type SetupWorkflowDefinition = {
  id: StarterWorkflowType;
  title: string;
  summary: string;
  recurringJobs: SetupWorkflowJobRequirement[];
  preflightScenarios?: SetupWorkflowPreflightScenario[];
};

export type StarterWorkflowScaffold = {
  workflow: StarterWorkflowType;
  template: string;
  managerAgentId: string;
  agentIds: string[];
  domainConfigPatch?: Record<string, unknown>;
  agentsToCreate: Record<string, GlobalAgentDef>;
  createdAgentIds: string[];
  reusedAgentIds: string[];
  collisions: string[];
};

const DATA_SOURCE_ONBOARDING_JOBS: SetupWorkflowJobRequirement[] = [
  {
    jobId: "intake-triage",
    label: "manager intake triage",
    fixHint: "Add a manager-owned intake-triage recurring job so new onboarding requests and blocked work get routed quickly.",
  },
  {
    jobId: "onboarding-backlog-sweep",
    label: "source onboarding backlog sweep",
    fixHint: "Add a source-onboarding backlog sweep so proposed jurisdictions and stale onboarding requests are audited automatically.",
  },
  {
    jobId: "integrity-sweep",
    label: "integrity follow-up sweep",
    fixHint: "Add an integrity-sweep job so onboarding output is checked for blocked or flagged verification problems.",
  },
  {
    jobId: "production-watch",
    label: "production watch",
    fixHint: "Add a production-watch job so newly onboarded sources are observed for post-release drift and stale verification.",
  },
];

export const SETUP_WORKFLOW_DEFINITIONS: Record<StarterWorkflowType, SetupWorkflowDefinition> = {
  "data-source-onboarding": {
    id: "data-source-onboarding",
    title: "Data Source Onboarding",
    summary: "Route new source intake through triage, onboarding, integrity follow-up, and production observation.",
    recurringJobs: DATA_SOURCE_ONBOARDING_JOBS,
    preflightScenarios: [
      {
        id: "intake-triage",
        jobId: "intake-triage",
        title: "New intake routes into governed onboarding",
        trigger: "A new onboarding request arrives, or blocked verification work needs triage.",
        outcome: "The manager intake loop routes the work into governed onboarding tasks instead of leaving the operator to hand-steer the next move.",
        operatorSurface: "Feed + manager-owned task routing",
        automationState: "auto_handling",
        predictedArtifacts: [
          {
            kind: "feed",
            label: "Feed intake item",
            detail: "Surfaces the new onboarding request in the operator feed instead of letting intake vanish into an untracked inbox.",
            surface: "Overview / Feed",
          },
          {
            kind: "task",
            label: "Manager intake task",
            detail: "Creates or refreshes a manager-owned intake task so the next governed onboarding move has an explicit owner.",
            surface: "Tasks",
          },
        ],
      },
      {
        id: "onboarding-backlog-sweep",
        jobId: "onboarding-backlog-sweep",
        title: "Backlog sweep keeps onboarding requests from going stale",
        trigger: "Proposed or bootstrapping jurisdictions sit too long without owner coverage or fresh evidence.",
        outcome: "ClawForce reopens or updates onboarding work before the request silently falls out of the workflow.",
        operatorSurface: "Feed watching + onboarding remediation tasks",
        automationState: "auto_handling",
        predictedArtifacts: [
          {
            kind: "feed",
            label: "Feed stale-work watcher",
            detail: "Keeps stale onboarding requests visible in the operator loop before they silently age out.",
            surface: "Overview / Feed",
          },
          {
            kind: "task",
            label: "Onboarding remediation task",
            detail: "Reopens or refreshes governed onboarding work with the latest stale-work evidence attached.",
            surface: "Tasks",
          },
        ],
      },
      {
        id: "integrity-sweep",
        jobId: "integrity-sweep",
        title: "Integrity contradictions become governed remediation",
        trigger: "Blocked or flagged integrity verdicts appear during onboarding or verification.",
        outcome: "ClawForce opens or updates remediation work and surfaces release-safety contradictions in the operator loop.",
        operatorSurface: "Feed action-needed when integrity is blocked",
        automationState: "auto_handling",
        predictedArtifacts: [
          {
            kind: "issue",
            label: "Integrity contradiction issue",
            detail: "Records the blocked or flagged integrity contradiction on the governed entity instead of burying it in logs.",
            surface: "Workspace / Entity detail",
          },
          {
            kind: "feed",
            label: "Feed action-needed item",
            detail: "Escalates release-safety contradictions into the main operator loop when integrity is blocked.",
            surface: "Overview / Feed",
          },
          {
            kind: "task",
            label: "Integrity remediation task",
            detail: "Creates or refreshes governed follow-up so the contradiction has an accountable remediation path.",
            surface: "Tasks",
          },
        ],
      },
      {
        id: "production-watch",
        jobId: "production-watch",
        title: "Production drift is observed after rollout",
        trigger: "A shadow or active jurisdiction shows stale verification, release fallout, or production drift.",
        outcome: "ClawForce opens follow-up work before correctness silently degrades in production.",
        operatorSurface: "Feed watching or action-needed, depending on severity",
        automationState: "auto_handling",
        predictedArtifacts: [
          {
            kind: "feed",
            label: "Feed production drift alert",
            detail: "Surfaces post-rollout verification drift in the operator loop before correctness degrades silently.",
            surface: "Overview / Feed",
          },
          {
            kind: "task",
            label: "Production follow-up task",
            detail: "Creates or refreshes post-rollout follow-up so production drift is owned and resolved.",
            surface: "Tasks",
          },
        ],
      },
    ],
  },
};

function humanizeDomainId(domainId: string): string {
  return domainId
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeStarterWorkflow(value: unknown): StarterWorkflowType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return STARTER_WORKFLOW_TYPES.includes(normalized as StarterWorkflowType)
    ? normalized as StarterWorkflowType
    : null;
}

export function getSetupWorkflowDefinition(value: string): SetupWorkflowDefinition | null {
  return (SETUP_WORKFLOW_DEFINITIONS as Record<string, SetupWorkflowDefinition | undefined>)[value] ?? null;
}

export function buildStarterWorkflowScaffold(
  workflow: StarterWorkflowType,
  domainId: string,
  existingGlobalAgents: Record<string, GlobalAgentDef>,
  mission?: string,
): StarterWorkflowScaffold {
  if (workflow !== "data-source-onboarding") {
    return {
      workflow,
      template: workflow,
      managerAgentId: `${domainId}-lead`,
      agentIds: [],
      domainConfigPatch: undefined,
      agentsToCreate: {},
      createdAgentIds: [],
      reusedAgentIds: [],
      collisions: [],
    };
  }

  const domainLabel = humanizeDomainId(domainId);
  const directorId = `${domainId}-data-director`;
  const onboardingId = `${domainId}-source-onboarding-steward`;
  const integrityId = `${domainId}-integrity-gatekeeper`;
  const productionId = `${domainId}-production-sentinel`;
  const stewardId = "workflow-steward";
  const missionSuffix = mission ? ` Focus on: ${mission}` : "";

  const agentsToCreate: Record<string, GlobalAgentDef> = {};
  const createdAgentIds: string[] = [];
  const reusedAgentIds: string[] = [];
  const collisions: string[] = [];

  const ensureScopedAgent = (agentId: string, agent: GlobalAgentDef) => {
    if (existingGlobalAgents[agentId]) {
      collisions.push(agentId);
      return;
    }
    agentsToCreate[agentId] = agent;
    createdAgentIds.push(agentId);
  };

  ensureScopedAgent(directorId, {
    extends: "manager",
    title: `${domainLabel} Data Director`,
    department: "data-ops",
    team: "coordination",
    persona: `You own governed source onboarding for ${domainLabel}. Route intake, keep the workflow moving, and do not bypass the evidence pipeline.${missionSuffix}`,
    coordination: {
      enabled: true,
      schedule: "*/30 * * * *",
    },
    jobs: {
      "intake-triage": {
        cron: "*/20 * * * *",
        nudge: "Review new onboarding requests, blocked integrity work, stale source verification, and production drift. Route work without bypassing the data pipeline.",
      },
    },
  });
  ensureScopedAgent(onboardingId, {
    extends: "employee",
    title: `${domainLabel} Source Onboarding Steward`,
    reports_to: directorId,
    department: "onboarding",
    team: "sources",
    persona: `You onboard authoritative sources for ${domainLabel}. Stay DB-first, use official sources only, and leave evidence attached.${missionSuffix}`,
    jobs: {
      "onboarding-backlog-sweep": {
        cron: "*/5 * * * *",
        nudge: "Review proposed and bootstrapping jurisdictions, stale onboarding requests, and missing owner coverage. Open or update governed onboarding work instead of patching generated data by hand.",
      },
    },
  });
  ensureScopedAgent(integrityId, {
    extends: "employee",
    title: `${domainLabel} Integrity Gatekeeper`,
    reports_to: directorId,
    department: "integrity",
    team: "gate",
    persona: `You own blocked and flagged integrity verdicts for ${domainLabel}. Treat every block as real until the evidence says otherwise.${missionSuffix}`,
    jobs: {
      "integrity-sweep": {
        cron: "*/30 * * * *",
        nudge: "Review blocked and flagged integrity verdicts, create remediation work, and escalate contradictions that threaten release safety.",
      },
    },
  });
  ensureScopedAgent(productionId, {
    extends: "employee",
    title: `${domainLabel} Production Sentinel`,
    reports_to: directorId,
    department: "production",
    team: "monitoring",
    persona: `You watch post-onboarding production health for ${domainLabel}. Open evidence-backed follow-up quickly when verification or drift degrades.${missionSuffix}`,
    jobs: {
      "production-watch": {
        cron: "0 * * * *",
        nudge: "Check production drift, stale verification, recent release fallout, and expiring rates. Open or update tasks for anything that threatens correctness.",
      },
    },
  });

  if (existingGlobalAgents[stewardId]) {
    reusedAgentIds.push(stewardId);
  } else {
    agentsToCreate[stewardId] = {
      extends: "employee",
      title: "Workflow Steward",
      reports_to: directorId,
      department: "governance",
      team: "workflow",
      persona: `You evolve the governed workflow itself. Review repeated rollout pain, missing levers, and noisy approvals before proposing workflow mutations.${missionSuffix}`,
      jobs: {
        "workflow-gap-review": {
          cron: "15 */6 * * *",
          nudge: "Review repeated resets, blocked operator paths, and noisy workflow pain. Propose workflow mutations only when supported levers are insufficient.",
        },
      },
    };
    createdAgentIds.push(stewardId);
  }

  const domainConfigPatch: Record<string, unknown> = {
    entities: {
      jurisdiction: {
        title: "Jurisdiction",
        description: "A governed jurisdiction tracked through source onboarding and release readiness.",
        runtimeCreate: true,
        states: {
          proposed: {
            description: "Requested or identified but not yet staffed.",
            initial: true,
          },
          bootstrapping: {
            description: "Owner exists and onboarding is underway.",
          },
          shadow: {
            description: "Pipeline is running, but release authority is still gated.",
          },
          active: {
            description: "This jurisdiction is actively governed for release discipline.",
          },
          retired: {
            description: "No longer actively governed.",
            terminal: true,
          },
        },
        transitions: [
          { from: "proposed", to: "bootstrapping" },
          { from: "proposed", to: "retired", reasonRequired: true },
          { from: "bootstrapping", to: "shadow" },
          { from: "bootstrapping", to: "retired", reasonRequired: true },
          { from: "shadow", to: "active", reasonRequired: true, approvalRequired: true, blockedByOpenIssues: true },
          { from: "shadow", to: "bootstrapping", reasonRequired: true },
          { from: "shadow", to: "retired", reasonRequired: true },
          { from: "active", to: "shadow", reasonRequired: true },
          { from: "active", to: "retired", reasonRequired: true },
        ],
        health: {
          values: ["healthy", "warning", "degraded", "blocked"],
          default: "warning",
          clear: "healthy",
        },
        relationships: {
          parent: {
            enabled: true,
            allowedKinds: ["jurisdiction"],
          },
        },
        metadataSchema: {
          slug: {
            type: "string",
            required: true,
          },
          layer: {
            type: "string",
            required: true,
            enum: ["state", "county", "city"],
          },
          signed_off: {
            type: "boolean",
          },
          completeness_percent: {
            type: "number",
          },
          health_percent: {
            type: "number",
          },
          quality_percent: {
            type: "number",
          },
          rates_status: {
            type: "string",
          },
          activation_blockers: {
            type: "array",
          },
        },
        issues: {
          autoSyncHealth: true,
          defaultBlockingSeverities: ["high", "critical"],
          defaultHealthBySeverity: {
            medium: "warning",
            high: "degraded",
            critical: "blocked",
          },
          types: {
            onboarding_request: {
              title: "Onboarding Request",
              defaultSeverity: "medium",
              health: "warning",
              task: {
                enabled: true,
                titleTemplate: "Open onboarding for {{entity.title}}",
                descriptionTemplate: "Open governed onboarding work for {{entity.title}}. Confirm owner coverage, create the right child tasks instead of parallel sibling tasks, and attach authoritative source evidence before changing lifecycle state.",
                priority: "P2",
                kind: "feature",
                tags: ["onboarding", "source-intake"],
                closeTaskOnResolved: true,
              },
            },
          },
          stateSignals: [
            {
              id: "proposed-onboarding-request",
              whenStates: ["proposed"],
              ownerPresence: "missing",
              issueType: "onboarding_request",
              issueKey: "onboarding:requested",
              titleTemplate: "Onboarding required for {{entity.title}}",
              descriptionTemplate: "{{entity.title}} is still in proposed with no owner coverage. Open governed onboarding work, confirm authoritative sources, and move the jurisdiction into bootstrapping without hand-editing generated data.",
              recommendedAction: "Create or update governed onboarding work for this proposed jurisdiction, confirm owner coverage, and attach authoritative source evidence.",
              ownerAgentId: directorId,
            },
          ],
        },
      },
    },
  };

  return {
    workflow,
    template: "data-source-onboarding",
    managerAgentId: directorId,
    agentIds: [directorId, onboardingId, integrityId, productionId, stewardId],
    domainConfigPatch,
    agentsToCreate,
    createdAgentIds,
    reusedAgentIds,
    collisions,
  };
}
