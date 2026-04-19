import type { AttentionAutomationState } from "../attention/types.js";
import { getDefaultMutationEffect } from "../execution/policy.js";
import type {
  DomainExecutionConfig,
  DomainExecutionEffect,
  EntityIssueStateSignalConfig,
  EntityIssueTaskConfig,
  EntityIssueTypeConfig,
  EntityKindConfig,
  ReviewConfig,
  ReviewReasonCode,
} from "../types.js";
import type { SetupDomainSummary } from "./report.js";
import { getSetupWorkflowDefinition } from "./workflows.js";

export type SetupPreflightScenarioStatus = "ready" | "planned" | "attention";

export type SetupPreflightScenarioCategory =
  | "workflow"
  | "issue"
  | "approval"
  | "execution"
  | "mutation";

export type SetupPreflightArtifactKind =
  | "feed"
  | "decision"
  | "task"
  | "issue"
  | "proposal"
  | "simulated_action"
  | "runtime";

export type SetupPreflightArtifact = {
  id: string;
  kind: SetupPreflightArtifactKind;
  label: string;
  detail: string;
  surface: string;
};

export type SetupPreflightScenario = {
  id: string;
  category: SetupPreflightScenarioCategory;
  title: string;
  when: string;
  outcome: string;
  operatorSurface: string;
  automationState: AttentionAutomationState;
  status: SetupPreflightScenarioStatus;
  statusDetail: string;
  currentMutationEffect?: DomainExecutionEffect;
  workflowId?: string;
  agentId?: string;
  jobId?: string;
  entityKind?: string;
  signalId?: string;
  fromState?: string;
  toState?: string;
  predictedArtifacts: SetupPreflightArtifact[];
};

export type SetupPreflight = {
  summary: string;
  counts: {
    ready: number;
    planned: number;
    attention: number;
  };
  scenarios: SetupPreflightScenario[];
};

export type BuildSetupPreflightArgs = {
  domainId: string;
  domainSummary: SetupDomainSummary | null;
  entities?: Record<string, EntityKindConfig>;
  execution?: DomainExecutionConfig;
  review?: ReviewConfig;
  configuredAgentIds?: string[];
};

type WorkflowStewardResolution = {
  agentId: string;
  autoProposalThreshold: number;
  autoProposalReasonCodes: ReviewReasonCode[];
  proposalCooldownHours: number;
};

type WorkflowCoverage = {
  status: SetupPreflightScenarioStatus;
  detail: string;
  agentId?: string;
};

function createPredictedArtifact(
  scenarioId: string,
  kind: SetupPreflightArtifactKind,
  label: string,
  detail: string,
  surface: string,
): SetupPreflightArtifact {
  return {
    id: `${scenarioId}:${kind}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    kind,
    label,
    detail,
    surface,
  };
}

function buildIssueSignalArtifacts(args: {
  scenarioId: string;
  kind: string;
  issueLabel: string;
  taskEnabled: boolean;
  approvalRequired: boolean;
  signal: EntityIssueStateSignalConfig;
}): SetupPreflightArtifact[] {
  const artifacts: SetupPreflightArtifact[] = [
    createPredictedArtifact(
      args.scenarioId,
      "issue",
      `${args.issueLabel} issue record`,
      `Creates or refreshes the governed ${args.issueLabel} issue on the ${humanize(args.kind)} entity.`,
      "Workspace / Entity detail",
    ),
    createPredictedArtifact(
      args.scenarioId,
      "feed",
      args.approvalRequired ? "Feed action-needed item" : "Feed watching item",
      args.approvalRequired
        ? `Surfaces the ${args.issueLabel} issue as action-needed until a human clears the approval boundary.`
        : `Keeps the ${args.issueLabel} issue visible in the feed until the governed follow-up is complete.`,
      "Overview / Feed",
    ),
  ];

  if (args.taskEnabled) {
    artifacts.push(
      createPredictedArtifact(
        args.scenarioId,
        "task",
        "Remediation task",
        args.signal.recommendedAction
          ? `Opens or refreshes a remediation task that follows the configured action: ${args.signal.recommendedAction}`
          : `Opens or refreshes a remediation task for the ${args.issueLabel} issue.`,
        "Tasks",
      ),
    );
  }

  if (args.approvalRequired) {
    artifacts.push(
      createPredictedArtifact(
        args.scenarioId,
        "decision",
        "Decision inbox item",
        `Routes the ${args.issueLabel} follow-up into the decision inbox before live handling can continue.`,
        "Approvals / Decision inbox",
      ),
    );
  }

  return artifacts;
}

function buildTransitionArtifacts(args: {
  scenarioId: string;
  kind: string;
  fromState: string;
  toState: string;
  approvalRequired: boolean;
  blockedByOpenIssues: boolean;
}): SetupPreflightArtifact[] {
  const artifacts: SetupPreflightArtifact[] = [
    createPredictedArtifact(
      args.scenarioId,
      "proposal",
      "Transition proposal",
      `Records the attempted ${args.fromState} -> ${args.toState} move as a governed proposal instead of silently changing entity state.`,
      "Workspace / Entity detail",
    ),
  ];

  if (args.approvalRequired) {
    artifacts.push(
      createPredictedArtifact(
        args.scenarioId,
        "decision",
        "Decision inbox item",
        `Opens an explicit approval for the ${humanize(args.kind)} transition before the state can move live.`,
        "Approvals / Decision inbox",
      ),
    );
  }

  artifacts.push(
    createPredictedArtifact(
      args.scenarioId,
      "feed",
      args.blockedByOpenIssues ? "Feed blocker" : "Feed approval item",
      args.blockedByOpenIssues
        ? `Keeps the transition visible as blocked until open issues are cleared.`
        : `Keeps the pending transition approval visible in the normal operator loop.`,
      "Overview / Feed",
    ),
  );

  return artifacts;
}

function buildExecutionArtifacts(args: {
  scenarioId: string;
  mutationEffect: DomainExecutionEffect;
}): SetupPreflightArtifact[] {
  if (args.mutationEffect === "allow") {
    return [
      createPredictedArtifact(
        args.scenarioId,
        "runtime",
        "Live mutation path",
        "Runs the mutation on the normal runtime path unless a narrower execution override intercepts it first.",
        "Runtime / Normal operator loop",
      ),
    ];
  }

  const artifacts: SetupPreflightArtifact[] = [
    createPredictedArtifact(
      args.scenarioId,
      "simulated_action",
      args.mutationEffect === "simulate"
        ? "Simulated action record"
        : args.mutationEffect === "require_approval"
          ? "Intercepted action record"
          : "Blocked action record",
      args.mutationEffect === "simulate"
        ? "Records the side effect as a simulated action instead of executing it live."
        : args.mutationEffect === "require_approval"
          ? "Intercepts the side effect and stores it as a replayable governed action pending approval."
          : "Records the blocked mutation attempt so the operator can see exactly what was denied.",
      "Overview / Feed",
    ),
  ];

  if (args.mutationEffect === "require_approval") {
    artifacts.push(
      createPredictedArtifact(
        args.scenarioId,
        "decision",
        "Decision inbox approval",
        "Creates an approval item before any replay can happen live.",
        "Approvals / Decision inbox",
      ),
    );
  } else if (args.mutationEffect === "block") {
    artifacts.push(
      createPredictedArtifact(
        args.scenarioId,
        "feed",
        "Feed action-needed item",
        "Surfaces the blocked mutation as action-needed so the operator understands why the runtime refused it.",
        "Overview / Feed",
      ),
    );
  }

  return artifacts;
}

function buildWorkflowMutationArtifacts(args: {
  scenarioId: string;
  steward: WorkflowStewardResolution | null;
}): SetupPreflightArtifact[] {
  if (!args.steward) {
    return [
      createPredictedArtifact(
        args.scenarioId,
        "feed",
        "Feed-only escalation gap",
        "Repeated review failures will surface in the feed, but no governed workflow-mutation proposal is raised yet.",
        "Overview / Feed",
      ),
    ];
  }

  return [
    createPredictedArtifact(
      args.scenarioId,
      "proposal",
      "Workflow-mutation proposal",
      `Raises a governed workflow-mutation proposal for ${args.steward.agentId} instead of repeating manual operator steering.`,
      "Approvals / Decision inbox",
    ),
    createPredictedArtifact(
      args.scenarioId,
      "task",
      "Workflow steward task",
      `Creates or refreshes steward-owned follow-up so the proposed workflow change gets implemented and verified.`,
      "Tasks",
    ),
  ];
}

function humanize(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function classifyRecurringJobState(
  job: SetupDomainSummary["jobs"][number],
):
  | "running"
  | "dispatching"
  | "queued"
  | "blocked"
  | "stalled"
  | "orphaned"
  | "completed"
  | "failed"
  | "never" {
  if (job.activeTaskId) {
    if (job.activeTaskState === "BLOCKED") return "blocked";
    if (job.activeSessionState === "live" || job.activeSessionState === "quiet") return "running";
    if (
      (job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched")
      && job.activeSessionState === "stale"
    ) {
      return "stalled";
    }
    if (job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched") return "dispatching";
    if (job.activeQueueStatus === "queued") return "queued";
    return "orphaned";
  }
  if (job.lastStatus === "completed") return "completed";
  if (job.lastStatus === "failed") return "failed";
  return "never";
}

function describeWorkflowCoverage(
  domainSummary: SetupDomainSummary | null,
  jobId: string,
): WorkflowCoverage {
  if (!domainSummary?.loaded) {
    return {
      status: "attention",
      detail: "The target domain is not currently loaded, so this workflow path cannot be certified yet.",
    };
  }

  const job = domainSummary.jobs.find((candidate) => candidate.jobId === jobId);
  if (!job) {
    return {
      status: "attention",
      detail: `Required recurring job "${jobId}" is not configured in this domain.`,
    };
  }

  const state = classifyRecurringJobState(job);
  if (state === "running") {
    return {
      status: "ready",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is actively running under the live controller.`,
      agentId: job.agentId,
    };
  }
  if (state === "dispatching" || state === "queued" || state === "completed") {
    return {
      status: "ready",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is configured and has already entered the normal runtime loop.`,
      agentId: job.agentId,
    };
  }
  if (state === "blocked") {
    return {
      status: "attention",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is blocked by task ${job.activeTaskId?.slice(0, 8)}${job.activeTaskBlockedReason ? ` (${job.activeTaskBlockedReason})` : ""}.`,
      agentId: job.agentId,
    };
  }
  if (state === "stalled") {
    return {
      status: "attention",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is leased to a stale worker session and will not make progress without operator recovery.`,
      agentId: job.agentId,
    };
  }
  if (state === "orphaned" || state === "failed") {
    return {
      status: "attention",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is configured, but the most recent run is stranded or failed.`,
      agentId: job.agentId,
    };
  }
  if (domainSummary.controller.state === "live") {
    return {
      status: "planned",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is configured, but it has not completed a live run yet.`,
      agentId: job.agentId,
    };
  }
  if (domainSummary.controller.state === "stale") {
    return {
      status: "attention",
      detail: `Recurring job "${job.agentId}.${job.jobId}" is configured, but the controller lease is stale.`,
      agentId: job.agentId,
    };
  }
  return {
    status: "planned",
    detail: `Recurring job "${job.agentId}.${job.jobId}" is configured, but the controller is not live yet.`,
    agentId: job.agentId,
  };
}

function resolveIssueTaskEnabled(
  issueTypeConfig: EntityIssueTypeConfig | undefined,
  signal: EntityIssueStateSignalConfig,
): boolean {
  const taskConfig = issueTypeConfig?.task;
  if (taskConfig === false) return false;
  if (taskConfig === true) return true;
  if (taskConfig && typeof taskConfig === "object") {
    return (taskConfig as EntityIssueTaskConfig).enabled
      ?? Boolean(signal.playbook || signal.recommendedAction || issueTypeConfig?.playbook);
  }
  return Boolean(signal.playbook || signal.recommendedAction || issueTypeConfig?.playbook);
}

function renderIssueLabel(
  issueType: string,
  issueTypeConfig: EntityIssueTypeConfig | undefined,
): string {
  return issueTypeConfig?.title?.trim() || humanize(issueType);
}

function describeSignalTrigger(kind: string, signal: EntityIssueStateSignalConfig): string {
  const stateLabel = signal.whenStates?.length
    ? signal.whenStates.join(" or ")
    : "any lifecycle state";
  const ownerLabel = signal.ownerPresence === "missing"
    ? " with no owner assigned"
    : signal.ownerPresence === "present"
      ? " with an owner already assigned"
      : "";
  return `A ${humanize(kind)} entity is in ${stateLabel}${ownerLabel}.`;
}

function resolveWorkflowSteward(
  review: ReviewConfig | undefined,
  configuredAgentIds: string[],
): WorkflowStewardResolution | null {
  if (review?.workflowSteward?.agentId) {
    return {
      agentId: review.workflowSteward.agentId,
      autoProposalThreshold: review.workflowSteward.autoProposalThreshold ?? 2,
      autoProposalReasonCodes: review.workflowSteward.autoProposalReasonCodes?.length
        ? review.workflowSteward.autoProposalReasonCodes
        : ["verification_environment_blocked"],
      proposalCooldownHours: review.workflowSteward.proposalCooldownHours ?? 24,
    };
  }

  if (configuredAgentIds.includes("workflow-steward")) {
    return {
      agentId: "workflow-steward",
      autoProposalThreshold: 2,
      autoProposalReasonCodes: ["verification_environment_blocked"],
      proposalCooldownHours: 24,
    };
  }

  return null;
}

function buildWorkflowMutationStatusDetail(steward: WorkflowStewardResolution): string {
  const standardReasonCodes = steward.autoProposalReasonCodes.filter(
    (reasonCode) => reasonCode !== "verification_environment_blocked",
  );
  const detail = [
    steward.autoProposalReasonCodes.includes("verification_environment_blocked")
      ? "verification_environment_blocked escalates after 1 rejected review."
      : null,
    standardReasonCodes.length > 0
      ? `${standardReasonCodes.join(", ")} escalate after ${steward.autoProposalThreshold} matching rejected review(s).`
      : null,
    `Proposal cooldown: ${steward.proposalCooldownHours}h.`,
  ].filter(Boolean);
  return detail.join(" ");
}

export function buildSetupPreflight(args: BuildSetupPreflightArgs): SetupPreflight {
  const scenarios: SetupPreflightScenario[] = [];
  const workflowIds = args.domainSummary?.workflows ?? [];

  for (const workflowId of workflowIds) {
    const definition = getSetupWorkflowDefinition(workflowId);
    if (!definition) continue;
    for (const scenario of definition.preflightScenarios ?? []) {
      const coverage = scenario.jobId
        ? describeWorkflowCoverage(args.domainSummary, scenario.jobId)
        : {
          status: args.domainSummary?.loaded ? "ready" : "planned",
          detail: definition.summary,
          agentId: undefined,
        } satisfies WorkflowCoverage;
      scenarios.push({
        id: `workflow:${workflowId}:${scenario.id}`,
        category: "workflow",
        title: scenario.title,
        when: scenario.trigger,
        outcome: scenario.outcome,
        operatorSurface: scenario.operatorSurface,
        automationState: scenario.automationState,
        status: coverage.status,
        statusDetail: coverage.detail,
        workflowId,
        agentId: coverage.agentId,
        jobId: scenario.jobId,
        predictedArtifacts: (scenario.predictedArtifacts ?? []).map((artifact) => createPredictedArtifact(
          `workflow:${workflowId}:${scenario.id}`,
          artifact.kind,
          artifact.label,
          artifact.detail,
          artifact.surface,
        )),
      });
    }
  }

  for (const [kind, kindConfig] of Object.entries(args.entities ?? {})) {
    for (const signal of kindConfig.issues?.stateSignals ?? []) {
      const issueTypeConfig = kindConfig.issues?.types?.[signal.issueType];
      const issueLabel = renderIssueLabel(signal.issueType, issueTypeConfig);
      const taskEnabled = resolveIssueTaskEnabled(issueTypeConfig, signal);
      const approvalRequired = signal.approvalRequired ?? issueTypeConfig?.approvalRequired ?? false;
      scenarios.push({
        id: `state-signal:${kind}:${signal.id ?? signal.issueType}`,
        category: "issue",
        title: `${humanize(kind)} state signal opens governed follow-up`,
        when: describeSignalTrigger(kind, signal),
        outcome: taskEnabled
          ? `ClawForce opens or refreshes the ${issueLabel} issue and a governed remediation task instead of leaving the operator to triage it manually.`
          : `ClawForce opens or refreshes the ${issueLabel} issue and keeps the next step explicit in the feed.`,
        operatorSurface: approvalRequired
          ? "Decision inbox + entity issue"
          : taskEnabled
            ? "Feed + entity issue + remediation task"
            : "Feed + entity issue",
        automationState: approvalRequired
          ? "needs_human"
          : taskEnabled
            ? "auto_handling"
            : "blocked_for_agent",
        status: args.domainSummary?.loaded ? "ready" : "attention",
        statusDetail: signal.recommendedAction
          ? `Configured recommended action: ${signal.recommendedAction}`
          : `Configured in entities.${kind}.issues.stateSignals.`,
        entityKind: kind,
        signalId: signal.id ?? signal.issueType,
        predictedArtifacts: buildIssueSignalArtifacts({
          scenarioId: `state-signal:${kind}:${signal.id ?? signal.issueType}`,
          kind,
          issueLabel,
          taskEnabled,
          approvalRequired,
          signal,
        }),
      });
    }

    for (const transition of kindConfig.transitions ?? []) {
      if (!transition.approvalRequired && !transition.blockedByOpenIssues) continue;
      const approvalRequired = Boolean(transition.approvalRequired);
      scenarios.push({
        id: `transition:${kind}:${transition.from}:${transition.to}`,
        category: "approval",
        title: `${humanize(kind)} transition gate: ${transition.from} -> ${transition.to}`,
        when: `A ${humanize(kind)} entity is moved from ${transition.from} to ${transition.to}.`,
        outcome: approvalRequired && transition.blockedByOpenIssues
          ? "ClawForce routes the transition into approval and keeps it blocked while open blocking issues remain."
          : approvalRequired
            ? "ClawForce creates a transition approval before the state can change."
            : "ClawForce blocks the transition until open issues are cleared.",
        operatorSurface: approvalRequired
          ? "Decision inbox + entity transition proposal"
          : "Entity detail + feed blockers",
        automationState: approvalRequired ? "needs_human" : "blocked_for_agent",
        status: args.domainSummary?.loaded ? "ready" : "attention",
        statusDetail: transition.blockedByOpenIssues
          ? "Open blocking issues must be cleared before this transition can complete."
          : "This transition is configured to require an explicit approval step.",
        entityKind: kind,
        fromState: transition.from,
        toState: transition.to,
        predictedArtifacts: buildTransitionArtifacts({
          scenarioId: `transition:${kind}:${transition.from}:${transition.to}`,
          kind,
          fromState: transition.from,
          toState: transition.to,
          approvalRequired,
          blockedByOpenIssues: Boolean(transition.blockedByOpenIssues),
        }),
      });
    }
  }

  const mutationEffect = getDefaultMutationEffect(args.execution);
  const explicitPolicyCount = Object.keys(args.execution?.policies?.tools ?? {}).length
    + (args.execution?.policies?.commands?.length ?? 0);
  scenarios.push({
    id: "execution:default-mutation-policy",
    category: "execution",
    title: "Sensitive mutations follow domain execution policy",
    when: "An agent tries to run a config, setup, ops, or other live side effect.",
    outcome: mutationEffect === "allow"
      ? "ClawForce lets the mutation run live unless a more specific execution policy overrides it."
      : mutationEffect === "simulate"
        ? "ClawForce records a simulated action instead of running the side effect live."
        : mutationEffect === "require_approval"
          ? "ClawForce intercepts the mutation, records it, and opens an approval before any live replay."
          : "ClawForce blocks the mutation outright under the current execution policy.",
    operatorSurface: mutationEffect === "allow"
      ? "Normal runtime surfaces"
      : mutationEffect === "simulate"
        ? "Feed watching + simulated actions"
        : mutationEffect === "require_approval"
          ? "Decision inbox + simulated actions"
          : "Feed action-needed + simulated actions",
    automationState: mutationEffect === "allow"
      ? "auto_handling"
      : mutationEffect === "simulate"
        ? "auto_handling"
        : mutationEffect === "require_approval"
          ? "needs_human"
          : "blocked_for_agent",
    status: args.domainSummary?.loaded ? "ready" : "attention",
    statusDetail: explicitPolicyCount > 0
      ? `${explicitPolicyCount} explicit execution override(s) are configured on top of the default ${mutationEffect} policy.`
      : `No explicit execution overrides are configured; the default ${mutationEffect} policy applies.`,
    currentMutationEffect: mutationEffect,
    predictedArtifacts: buildExecutionArtifacts({
      scenarioId: "execution:default-mutation-policy",
      mutationEffect,
    }),
  });

  const steward = resolveWorkflowSteward(args.review, args.configuredAgentIds ?? []);
  scenarios.push({
    id: "mutation:workflow-steward",
    category: "mutation",
    title: "Repeated review failures escalate into workflow mutation",
    when: "Rejected review loops keep hitting the same governed path.",
    outcome: steward
      ? `ClawForce raises a workflow-mutation proposal for ${steward.agentId} instead of repeating blind operator steering.`
      : "ClawForce does not currently auto-propose workflow mutations from repeated review failures because no workflow steward is configured.",
    operatorSurface: steward
      ? "Decision inbox + workflow steward task"
      : "Feed only until a workflow steward is configured",
    automationState: steward ? "needs_human" : "blocked_for_agent",
    status: steward ? "ready" : "attention",
    statusDetail: steward
      ? buildWorkflowMutationStatusDetail(steward)
      : 'Add review.workflowSteward.agentId or a conventional "workflow-steward" agent to close repeated review gaps through the governed proposal loop.',
    agentId: steward?.agentId,
    predictedArtifacts: buildWorkflowMutationArtifacts({
      scenarioId: "mutation:workflow-steward",
      steward,
    }),
  });

  const counts = {
    ready: scenarios.filter((scenario) => scenario.status === "ready").length,
    planned: scenarios.filter((scenario) => scenario.status === "planned").length,
    attention: scenarios.filter((scenario) => scenario.status === "attention").length,
  };

  const summary = scenarios.length === 0
    ? "No predictive setup scenarios are modeled for this domain yet."
    : counts.attention > 0
      ? `Preflight covers ${scenarios.length} modeled behavior(s); ${counts.attention} still need setup attention before the operator can trust them end to end.`
      : counts.planned > 0
        ? `Preflight covers ${scenarios.length} modeled behavior(s); ${counts.planned} are configured but waiting on a live controller or first successful run.`
        : `Preflight covers ${scenarios.length} modeled behavior(s), and they are ready to route through the normal operator loop.`;

  return {
    summary,
    counts,
    scenarios,
  };
}
