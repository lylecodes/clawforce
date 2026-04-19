import fs from "node:fs";
import path from "node:path";
import {
  mergeAgentRuntimeConfig,
  normalizeConfiguredAgentRuntime,
} from "../agent-runtime-config.js";
import { DatabaseSync } from "../sqlite-driver.js";
import { loadAllDomains, loadGlobalConfig } from "../config/loader.js";
import type { DomainConfig, GlobalConfig } from "../config/schema.js";
import { type ValidationIssue, validateAllConfigs } from "../config/validate.js";
import { getSessionHeartbeatStatus, type SessionHeartbeatState } from "../enforcement/tracker.js";
import { getAgentConfig, parseWorkforceConfigContent } from "../project.js";
import { normalizeDomainProfile } from "../profiles/operational.js";
import { getControllerLease } from "../runtime/controller-leases.js";
import { readRecurringJobRuntime } from "../scheduling/recurring-jobs.js";
import { getSetupWorkflowDefinition } from "./workflows.js";
import { assessAgentRuntimeScope } from "../dispatch/runtime-scope.js";
import type { AgentConfig, DispatchExecutorName } from "../types.js";
import { computeDomainConfigFingerprint } from "../telemetry/config-tracker.js";

export type SetupCheckStatus = "ok" | "warn" | "error";

export type SetupCheck = {
  id: string;
  status: SetupCheckStatus;
  summary: string;
  detail?: string;
  fix?: string;
  domainId?: string;
};

export type SetupDomainSummary = {
  id: string;
  file: string;
  exists: boolean;
  loaded: boolean;
  enabled: boolean;
  workflows: string[];
  agentCount: number;
  jobCount: number;
  jobs: Array<{
    agentId: string;
    jobId: string;
    cron: string | null;
    frequency: string | null;
    lastScheduledAt: number | null;
    lastFinishedAt: number | null;
    lastStatus: string | null;
    activeTaskId: string | null;
    activeTaskState: string | null;
    activeTaskTitle: string | null;
    activeTaskBlockedReason: string | null;
    activeQueueStatus: string | null;
    activeSessionState: SessionHeartbeatState | "none";
    nextRunAt: number | null;
  }>;
  controller: {
    state: "live" | "stale" | "none";
    ownerLabel: string | null;
    heartbeatAgeMs: number | null;
    activeSessionCount: number;
    activeDispatchCount: number;
    currentConfigHash: string | null;
    appliedConfigHash: string | null;
    appliedConfigVersionId: string | null;
    appliedConfigAppliedAt: number | null;
    configStatus: "current" | "stale" | "unknown" | "not-applicable";
  };
  managerAgentId: string | null;
  pathCount: number;
  issueCounts: {
    errors: number;
    warnings: number;
    suggestions: number;
  };
};

export type SetupReport = {
  root: string;
  targetDomainId: string | null;
  valid: boolean;
  hasGlobalConfig: boolean;
  domainFileIds: string[];
  domains: SetupDomainSummary[];
  issueCounts: {
    errors: number;
    warnings: number;
    suggestions: number;
  };
  checks: SetupCheck[];
  issues: ValidationIssue[];
  nextSteps: string[];
};

export type SetupExplanation = {
  summary: string;
  targetDomainId: string | null;
  immediateActions: Array<{
    id: string;
    status: SetupCheckStatus;
    summary: string;
    why: string | null;
    fix: string | null;
    domainId?: string;
  }>;
  domains: Array<{
    id: string;
    diagnosis: "healthy" | "attention-needed" | "ready-but-idle";
    controllerState: SetupDomainSummary["controller"]["state"];
    managerAgentId: string | null;
    counts: {
      running: number;
      dispatching: number;
      queued: number;
      blocked: number;
      stalled: number;
      orphaned: number;
      completed: number;
      failed: number;
      never: number;
    };
    highlights: string[];
  }>;
};

function compareSetupJobs(
  left: SetupDomainSummary["jobs"][number],
  right: SetupDomainSummary["jobs"][number],
): number {
  const rank = (job: SetupDomainSummary["jobs"][number]): number => {
    if (job.activeTaskId && (job.activeSessionState === "live" || job.activeSessionState === "quiet")) return 0;
    if (job.activeTaskId && (job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched")) return 1;
    if (job.activeTaskId && job.activeQueueStatus === "queued") return 2;
    if (job.activeTaskId && job.activeTaskState === "BLOCKED") return 3;
    if (job.activeTaskId) return 4;
    if (job.lastStatus === "failed") return 5;
    if (job.lastFinishedAt != null || job.lastScheduledAt != null) return 6;
    return 7;
  };

  const rankDelta = rank(left) - rank(right);
  if (rankDelta !== 0) return rankDelta;

  const leftActivity = left.lastFinishedAt ?? left.lastScheduledAt ?? 0;
  const rightActivity = right.lastFinishedAt ?? right.lastScheduledAt ?? 0;
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  const leftNext = left.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  const rightNext = right.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  if (leftNext !== rightNext) return leftNext - rightNext;

  return `${left.agentId}.${left.jobId}`.localeCompare(`${right.agentId}.${right.jobId}`);
}

function countIssues(issues: ValidationIssue[]) {
  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warn").length,
    suggestions: issues.filter((issue) => issue.severity === "suggest").length,
  };
}

function countChecks(checks: SetupCheck[], domainId?: string | null) {
  const filtered = domainId
    ? checks.filter((check) => check.domainId === domainId)
    : checks;
  return {
    errors: filtered.filter((check) => check.status === "error").length,
    warnings: filtered.filter((check) => check.status === "warn").length,
  };
}

function classifyRecurringJobState(job: SetupDomainSummary["jobs"][number]):
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
    if (isStalledRecurringJob(job)) return "stalled";
    if (job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched") return "dispatching";
    if (job.activeQueueStatus === "queued") return "queued";
    return "orphaned";
  }
  if (job.lastStatus === "completed") return "completed";
  if (job.lastStatus === "failed") return "failed";
  return "never";
}

function isDomainIssue(issue: ValidationIssue, domainId: string): boolean {
  return issue.file === `domains/${domainId}.yaml`;
}

function isIssueRelevantToTargetDomain(
  issue: ValidationIssue,
  domainId: string,
  domain: DomainConfig | null | undefined,
): boolean {
  if (isDomainIssue(issue, domainId)) return true;
  if (issue.file !== "config.yaml") return false;
  if (!issue.agentId) return true;
  return Array.isArray(domain?.agents) && domain.agents.includes(issue.agentId);
}

function issueSummary(issues: ValidationIssue[]): string | null {
  const top = issues.find((issue) => issue.severity === "error")
    ?? issues.find((issue) => issue.severity === "warn")
    ?? issues[0];
  return top ? `${top.code}: ${top.message}` : null;
}

function isStalledRecurringJob(job: SetupDomainSummary["jobs"][number]): boolean {
  return Boolean(
    job.activeTaskId
      && (job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched")
      && job.activeSessionState === "stale",
  );
}

function resolveSetupAgentJobs(
  domainId: string,
  agentId: string,
  rawAgentDef: Record<string, unknown> | undefined,
  domain: DomainConfig,
): Record<string, unknown> {
  const runtimeEntry = getAgentConfig(agentId, domainId);
  const runtimeJobs = runtimeEntry?.config.jobs;
  const mergedJobs: Record<string, unknown> = {};

  if (runtimeJobs && typeof runtimeJobs === "object" && !Array.isArray(runtimeJobs)) {
    Object.assign(mergedJobs, runtimeJobs as Record<string, unknown>);
  }

  const rawJobs = rawAgentDef?.jobs;
  if (rawJobs && typeof rawJobs === "object" && !Array.isArray(rawJobs)) {
    Object.assign(mergedJobs, rawJobs as Record<string, unknown>);
  }

  const managerOverrides = (domain as Record<string, unknown>).manager_overrides;
  const overrideJobs = managerOverrides
    && typeof managerOverrides === "object"
    && !Array.isArray(managerOverrides)
    ? (managerOverrides as Record<string, Record<string, unknown>>)[agentId]?.jobs
    : undefined;
  if (overrideJobs && typeof overrideJobs === "object" && !Array.isArray(overrideJobs)) {
    Object.assign(mergedJobs, overrideJobs as Record<string, unknown>);
  }

  return mergedJobs;
}

function resolveSetupScopeAgentConfig(
  domain: DomainConfig,
  agentId: string,
  normalizedAgents: Record<string, AgentConfig>,
): AgentConfig | null {
  const baseConfig = normalizedAgents[agentId]
    ?? getAgentConfig(agentId, domain.domain)?.config
    ?? null;
  if (!baseConfig) return null;

  const managerOverrides = (domain as Record<string, unknown>).manager_overrides;
  const rawOverride = managerOverrides
    && typeof managerOverrides === "object"
    && !Array.isArray(managerOverrides)
    ? (managerOverrides as Record<string, Record<string, unknown>>)[agentId]
    : undefined;
  if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
    return baseConfig;
  }

  const overrideRuntime = mergeAgentRuntimeConfig(
    normalizeConfiguredAgentRuntime(rawOverride),
  );

  return {
    ...baseConfig,
    runtime: mergeAgentRuntimeConfig(baseConfig.runtime, overrideRuntime),
  };
}

function resolveSetupConfiguredExecutor(
  domain: DomainConfig,
  globalConfig: GlobalConfig,
): {
  configuredExecutor: DispatchExecutorName;
  explicitExecutorConfigured: boolean;
} {
  const domainDispatch = domain.dispatch;
  const domainExecutor = domainDispatch
    && typeof domainDispatch === "object"
    && !Array.isArray(domainDispatch)
    && typeof (domainDispatch as Record<string, unknown>).executor === "string"
    ? (domainDispatch as Record<string, unknown>).executor as DispatchExecutorName
    : null;
  if (domainExecutor) {
    return {
      configuredExecutor: domainExecutor,
      explicitExecutorConfigured: true,
    };
  }

  if (globalConfig.adapter === "openclaw") {
    return {
      configuredExecutor: "openclaw",
      explicitExecutorConfigured: false,
    };
  }
  if (globalConfig.adapter === "claude-code") {
    return {
      configuredExecutor: "claude-code",
      explicitExecutorConfigured: false,
    };
  }
  return {
    configuredExecutor: "codex",
    explicitExecutorConfigured: false,
  };
}

function buildDomainChecks(
  domain: DomainConfig,
  domainSummary: SetupDomainSummary | undefined,
  controller: SetupDomainSummary["controller"],
  domainIssues: ValidationIssue[],
  normalizedAgents: Record<string, AgentConfig>,
  globalConfig: GlobalConfig,
): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const hasWorkerActivityWithoutLease = controller.state === "none"
    && (controller.activeSessionCount > 0 || controller.activeDispatchCount > 0);
  const managerEnabled = domain.manager?.enabled !== false;
  const managerAgentId = managerEnabled && typeof domain.manager?.agentId === "string" && domain.manager.agentId.trim()
    ? domain.manager.agentId.trim()
    : null;

  checks.push({
    id: `domain:${domain.domain}:agents`,
    domainId: domain.domain,
    status: domain.agents.length > 0 ? "ok" : "error",
    summary: domain.agents.length > 0
      ? `Domain "${domain.domain}" has ${domain.agents.length} configured agent(s).`
      : `Domain "${domain.domain}" has no configured agents.`,
    fix: domain.agents.length > 0 ? undefined : `Add at least one agent to domains/${domain.domain}.yaml under agents.`,
  });

  checks.push({
    id: `domain:${domain.domain}:manager`,
    domainId: domain.domain,
    status: managerAgentId ? "ok" : "warn",
    summary: managerAgentId
      ? `Domain "${domain.domain}" routes manager decisions to "${managerAgentId}".`
      : `Domain "${domain.domain}" has no manager.agentId configured.`,
    detail: managerAgentId ? undefined : "The domain can still load, but approval routing and ownership are less explicit.",
    fix: managerAgentId ? undefined : `Set manager.agentId in domains/${domain.domain}.yaml to a domain agent.`,
  });

  checks.push({
    id: `domain:${domain.domain}:paths`,
    domainId: domain.domain,
    status: Array.isArray(domain.paths) && domain.paths.length > 0 ? "ok" : "warn",
    summary: Array.isArray(domain.paths) && domain.paths.length > 0
      ? `Domain "${domain.domain}" has ${domain.paths.length} project path(s) configured.`
      : `Domain "${domain.domain}" has no project paths configured.`,
    detail: Array.isArray(domain.paths) && domain.paths.length > 0
      ? undefined
      : "Without paths, domain-scoped skills and repository context are limited.",
    fix: Array.isArray(domain.paths) && domain.paths.length > 0
      ? undefined
      : `Add at least one path in domains/${domain.domain}.yaml so the domain can resolve repo-local context.`,
  });

  const scopedAgentIds = new Set<string>(domain.agents);
  if (managerAgentId) {
    scopedAgentIds.add(managerAgentId);
  }
  const executorConfig = resolveSetupConfiguredExecutor(domain, globalConfig);
  const runtimeScopeAssessments = [...scopedAgentIds]
    .map((agentId) =>
      assessAgentRuntimeScope(
        domain.domain,
        agentId,
        resolveSetupScopeAgentConfig(domain, agentId, normalizedAgents),
        executorConfig,
      ))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const partialAgents = runtimeScopeAssessments.filter((assessment) => assessment.enforcementGrade === "partially-scoped");
  const hardScopedAgents = runtimeScopeAssessments.filter((assessment) => assessment.enforcementGrade === "hard-scoped");
  checks.push({
    id: `domain:${domain.domain}:runtime-scope`,
    domainId: domain.domain,
    status: partialAgents.length > 0 ? "warn" : "ok",
    summary: partialAgents.length > 0
      ? `Domain "${domain.domain}" has ${partialAgents.length} partially-scoped agent runtime envelope(s).`
      : hardScopedAgents.length > 0
        ? `Domain "${domain.domain}" has ${hardScopedAgents.length} hard-scoped agent runtime envelope(s).`
        : `Domain "${domain.domain}" currently relies on policy-only agent runtime scoping.`,
    detail: partialAgents.length > 0
      ? partialAgents.map((assessment) => `${assessment.agentId} -> ${assessment.executor}: ${assessment.notes[0] ?? "Best-effort tool filtering only."}`).join(" ")
      : hardScopedAgents.length > 0
        ? hardScopedAgents.map((assessment) => `${assessment.agentId} -> ${assessment.executor}`).join(", ")
        : "No agent in this domain currently requests explicit runtime scoping via allowedTools or workspacePaths.",
    fix: partialAgents.length > 0
      ? `Use OpenClaw for agents that require strict tool filtering, or remove explicit codex executor pinning so ClawForce can auto-route them safely.`
      : undefined,
  });

  const declaredWorkflows = Array.isArray(domain.workflows)
    ? domain.workflows.filter((workflow): workflow is string => typeof workflow === "string" && workflow.trim().length > 0)
    : [];
  for (const workflow of declaredWorkflows) {
    const definition = getSetupWorkflowDefinition(workflow);
    if (!definition) {
      checks.push({
        id: `domain:${domain.domain}:workflow:${workflow}`,
        domainId: domain.domain,
        status: "warn",
        summary: `Domain "${domain.domain}" declares unknown workflow "${workflow}".`,
        detail: "Setup can load the domain, but it cannot certify or scaffold this workflow as a first-class capability yet.",
      });
      continue;
    }

    const presentJobIds = new Set((domainSummary?.jobs ?? []).map((job) => job.jobId));
    const missingJobs = definition.recurringJobs.filter((job) => !presentJobIds.has(job.jobId));
    checks.push({
      id: `domain:${domain.domain}:workflow:${workflow}`,
      domainId: domain.domain,
      status: missingJobs.length === 0 ? "ok" : "warn",
      summary: missingJobs.length === 0
        ? `Domain "${domain.domain}" declares ${workflow} and includes the recurring jobs needed to drive it.`
        : `Domain "${domain.domain}" declares ${workflow} but is missing ${missingJobs.length} required recurring workflow(s).`,
      detail: missingJobs.length === 0
        ? `${definition.summary} Present jobs: ${definition.recurringJobs.map((job) => job.jobId).join(", ")}.`
        : `Missing jobs: ${missingJobs.map((job) => `${job.jobId} (${job.label})`).join(", ")}.`,
      fix: missingJobs.length === 0
        ? undefined
        : `Re-scaffold this domain with cf setup scaffold --domain=${domain.domain} --mode=new --workflow=${workflow} --path=<repo>, or add recurring jobs for ${missingJobs.map((job) => job.jobId).join(", ")}.`,
    });
  }

  checks.push({
    id: `domain:${domain.domain}:controller`,
    domainId: domain.domain,
    status: controller.state === "live" ? "ok" : "warn",
    summary: controller.state === "live"
      ? `Domain "${domain.domain}" has a live controller lease.`
      : controller.state === "stale"
        ? `Domain "${domain.domain}" has a stale controller lease.`
        : hasWorkerActivityWithoutLease
          ? `Domain "${domain.domain}" has active worker activity under a shared or lease-less controller path.`
          : `Domain "${domain.domain}" has no live controller lease.`,
    detail: controller.ownerLabel
      ? `owner=${controller.ownerLabel}${controller.heartbeatAgeMs != null ? ` heartbeat=${Math.round(controller.heartbeatAgeMs / 1000)}s ago` : ""}`
      : hasWorkerActivityWithoutLease
        ? `active_sessions=${controller.activeSessionCount} active_dispatches=${controller.activeDispatchCount}. This usually means work is running under a shared controller, a gateway-managed lease, or a controller that lost local lease visibility.`
        : undefined,
    fix: controller.state === "live"
      ? undefined
      : hasWorkerActivityWithoutLease
        ? `Inspect cf running --domain=${domain.domain}. If this domain should be locally owned, restart cf controller --domain=${domain.domain} to re-establish an explicit lease.`
        : `Start or restart cf controller --domain=${domain.domain} so the setup can actually drive workflow execution.`,
  });

  if (controller.state === "live") {
    const currentHash = controller.currentConfigHash ? controller.currentConfigHash.slice(0, 8) : null;
    const appliedHash = controller.appliedConfigHash ? controller.appliedConfigHash.slice(0, 8) : null;
    checks.push({
      id: `domain:${domain.domain}:controller-config`,
      domainId: domain.domain,
      status: controller.configStatus === "current" ? "ok" : "warn",
      summary: controller.configStatus === "current"
        ? `Live controller for "${domain.domain}" has confirmed the current config revision.`
        : controller.configStatus === "stale"
          ? `Live controller for "${domain.domain}" is running an older config revision than the config currently on disk.`
          : `ClawForce cannot confirm that the live controller for "${domain.domain}" has applied the current config revision.`,
      detail: controller.configStatus === "current"
        ? [
          currentHash ? `Current config hash=${currentHash}.` : null,
          controller.appliedConfigAppliedAt != null ? `Last confirmed apply ${formatRelativeMs(controller.appliedConfigAppliedAt)}.` : null,
        ].filter(Boolean).join(" ")
        : controller.configStatus === "stale"
          ? [
            currentHash ? `Current config hash=${currentHash}.` : null,
            appliedHash ? `Live controller last confirmed hash=${appliedHash}.` : null,
            controller.appliedConfigAppliedAt != null ? `That apply happened ${formatRelativeMs(controller.appliedConfigAppliedAt)}.` : null,
            "Caller-side reload feedback is not enough to prove the live controller picked up the newer config.",
          ].filter(Boolean).join(" ")
          : [
            currentHash ? `Current config hash=${currentHash}.` : null,
            "The live controller lease does not have a durable applied-config marker yet, so setup cannot certify it as current.",
          ].filter(Boolean).join(" "),
      fix: controller.configStatus === "current"
        ? undefined
        : `Reload this domain through the live controller or restart cf controller --domain=${domain.domain} so the active lease records the current config revision.`,
    });
  }

  const orphanedRecurringJobs = domainSummary?.jobs.filter((job) =>
    job.activeTaskId
      && job.activeTaskState !== "BLOCKED"
      && !isStalledRecurringJob(job)
      && job.activeQueueStatus !== "queued"
      && job.activeQueueStatus !== "leased"
      && job.activeQueueStatus !== "dispatched"
      && job.activeSessionState !== "live"
      && job.activeSessionState !== "quiet"
  ) ?? [];
  for (const job of orphanedRecurringJobs) {
    checks.push({
      id: `domain:${domain.domain}:recurring:${job.agentId}:${job.jobId}:orphaned`,
      domainId: domain.domain,
      status: "warn",
      summary: `Recurring workflow "${job.agentId}.${job.jobId}" is stranded with task ${job.activeTaskId?.slice(0, 8)} in ${job.activeTaskState ?? "unknown"} and no live session.`,
      detail: [
        job.activeTaskTitle ? `Task "${job.activeTaskTitle}" is no longer attached to a live session.` : null,
        "The controller no longer has an active worker session for this recurring run, so the current task will not make progress on its own.",
      ].filter(Boolean).join(" "),
      fix: `Restart cf controller --domain=${domain.domain} or requeue the stranded task with cf queue retry --task-id=${job.activeTaskId} --process --domain=${domain.domain}.`,
    });
  }

  const stalledRecurringJobs = domainSummary?.jobs.filter((job) => isStalledRecurringJob(job)) ?? [];
  for (const job of stalledRecurringJobs) {
    checks.push({
      id: `domain:${domain.domain}:recurring:${job.agentId}:${job.jobId}:stalled`,
      domainId: domain.domain,
      status: "warn",
      summary: `Recurring workflow "${job.agentId}.${job.jobId}" is leased to a stale session on task ${job.activeTaskId?.slice(0, 8)}.`,
      detail: [
        job.activeTaskTitle ? `Task "${job.activeTaskTitle}" still has a leased dispatch row.` : null,
        "The last tracked heartbeat is stale, so the worker is no longer making progress even though the queue item still looks active.",
      ].filter(Boolean).join(" "),
      fix: `Release or retry task ${job.activeTaskId} with cf queue release --task-id=${job.activeTaskId} --process --domain=${domain.domain} or cf queue retry --task-id=${job.activeTaskId} --process --domain=${domain.domain}.`,
    });
  }

  const blockedRecurringJobs = domainSummary?.jobs.filter((job) =>
    job.activeTaskId && job.activeTaskState === "BLOCKED"
  ) ?? [];
  for (const job of blockedRecurringJobs) {
    checks.push({
      id: `domain:${domain.domain}:recurring:${job.agentId}:${job.jobId}:blocked`,
      domainId: domain.domain,
      status: "warn",
      summary: `Recurring workflow "${job.agentId}.${job.jobId}" is blocked on task ${job.activeTaskId?.slice(0, 8)}.`,
      detail: [
        job.activeTaskTitle ? `Task "${job.activeTaskTitle}" is currently BLOCKED.` : null,
        job.activeTaskBlockedReason ? `Latest reason: ${job.activeTaskBlockedReason}.` : null,
        "A blocked recurring run prevents future schedules from taking over until the task is resolved or replayed.",
      ].filter(Boolean).join(" "),
      fix: `Review task ${job.activeTaskId} and either resolve it or replay it before expecting the recurring workflow to run again.`,
    });
  }

  const counts = countIssues(domainIssues);
  checks.push({
    id: `domain:${domain.domain}:validation`,
    domainId: domain.domain,
    status: counts.errors > 0 ? "error" : counts.warnings > 0 ? "warn" : "ok",
    summary: counts.errors > 0
      ? `Domain "${domain.domain}" has ${counts.errors} validation error(s).`
      : counts.warnings > 0
        ? `Domain "${domain.domain}" has ${counts.warnings} validation warning(s).`
        : `Domain "${domain.domain}" passed current setup validation.`,
    detail: issueSummary(domainIssues) ?? undefined,
  });

  return checks;
}

function buildGlobalChecks(
  root: string,
  hasGlobalConfig: boolean,
  domainFileIds: string[],
  globalConfig: GlobalConfig,
  issues: ValidationIssue[],
  targetDomainId: string | null,
): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const issueCounts = countIssues(issues);

  checks.push({
    id: "global:config",
    status: hasGlobalConfig ? "ok" : "error",
    summary: hasGlobalConfig
      ? `Global config found at ${path.join(root, "config.yaml")}.`
      : `Global config is missing at ${path.join(root, "config.yaml")}.`,
    fix: hasGlobalConfig ? undefined : `Create ${path.join(root, "config.yaml")} with at least one agent definition.`,
  });

  checks.push({
    id: "global:domains",
    status: domainFileIds.length > 0 ? "ok" : "error",
    summary: domainFileIds.length > 0
      ? `Found ${domainFileIds.length} domain config file(s).`
      : "No domain configs found in domains/.",
    fix: domainFileIds.length > 0 ? undefined : `Create ${path.join(root, "domains")} and add at least one <domain>.yaml file.`,
  });

  const stewardConfigured = Boolean(globalConfig.agents?.["workflow-steward"]);
  checks.push({
    id: "global:workflow-steward",
    status: stewardConfigured ? "ok" : "warn",
    summary: stewardConfigured
      ? 'Global agent "workflow-steward" is configured.'
      : 'Global agent "workflow-steward" is not configured.',
    detail: stewardConfigured ? undefined : "Repeated workflow/setup gaps can still surface, but automatic setup evolution will be weaker.",
    fix: stewardConfigured ? undefined : 'Add a global "workflow-steward" agent if you want first-class workflow-mutation handling.',
  });

  if (targetDomainId) {
    checks.push({
      id: "global:target-domain",
      domainId: targetDomainId,
      status: domainFileIds.includes(targetDomainId) ? "ok" : "error",
      summary: domainFileIds.includes(targetDomainId)
        ? `Target domain "${targetDomainId}" exists on disk.`
        : `Target domain "${targetDomainId}" was not found in domains/.`,
      fix: domainFileIds.includes(targetDomainId)
        ? undefined
        : `Create ${path.join(root, "domains", `${targetDomainId}.yaml`)} or choose a different --domain value.`,
    });
  }

  checks.push({
    id: "global:validation",
    status: issueCounts.errors > 0 ? "error" : issueCounts.warnings > 0 ? "warn" : "ok",
    summary: issueCounts.errors > 0
      ? `Setup validation found ${issueCounts.errors} error(s).`
      : issueCounts.warnings > 0
        ? `Setup validation found ${issueCounts.warnings} warning(s).`
        : "Setup validation found no blocking issues.",
    detail: issueSummary(issues) ?? undefined,
  });

  return checks;
}

function buildNextSteps(report: SetupReport): string[] {
  const steps: string[] = [];
  const now = Date.now();

  for (const check of report.checks) {
    if ((check.status === "error" || check.status === "warn") && check.fix) {
      steps.push(check.fix);
    }
  }

  if (report.issueCounts.errors === 0 && report.targetDomainId) {
    const targetDomain = report.domains.find((domain) => domain.id === report.targetDomainId);
    if (targetDomain && targetDomain.controller.state !== "live" && (targetDomain.controller.activeSessionCount + targetDomain.controller.activeDispatchCount) === 0) {
      steps.push(`Run cf controller --domain=${report.targetDomainId} once setup is validated cleanly.`);
    }
    if (targetDomain?.jobCount) {
      const staleJobs = targetDomain.jobs.filter((job) =>
        !job.lastScheduledAt
          && !job.activeTaskId
          && (job.nextRunAt == null || job.nextRunAt <= now)
      );
      if (staleJobs.length > 0) {
        steps.push(`Use cf setup status --domain=${report.targetDomainId} to confirm recurring jobs move beyond "never run" after the controller starts.`);
      }
      const orphanedJobs = targetDomain.jobs.filter((job) =>
        job.activeTaskId
          && job.activeTaskState !== "BLOCKED"
          && !isStalledRecurringJob(job)
          && job.activeQueueStatus !== "queued"
          && job.activeQueueStatus !== "leased"
          && job.activeQueueStatus !== "dispatched"
          && job.activeSessionState !== "live"
          && job.activeSessionState !== "quiet"
      );
      if (orphanedJobs.length > 0) {
        steps.push(`Recover orphaned recurring runs in ${report.targetDomainId} by restarting cf controller or retrying the stranded task through cf queue retry --task-id=<task> --process.`);
      }
    }
    steps.push(`Use cf feed --domain=${report.targetDomainId} to verify the domain starts routing work through the normal workflow surfaces.`);
  }

  return [...new Set(steps)].slice(0, 6);
}

export function resolveSetupRoot(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) return null;

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    if (fs.existsSync(path.join(resolved, "config.yaml"))) {
      return resolved;
    }
    const nested = path.join(resolved, ".clawforce");
    if (fs.existsSync(path.join(nested, "config.yaml"))) {
      return nested;
    }
    return null;
  }

  if (path.basename(resolved) === "config.yaml") {
    return path.dirname(resolved);
  }

  if (path.basename(path.dirname(resolved)) === "domains") {
    return path.dirname(path.dirname(resolved));
  }

  return null;
}

function readControllerStatus(
  root: string,
  domainId: string,
  currentConfigHash: string | null,
): SetupDomainSummary["controller"] {
  const dbPath = path.join(root, domainId, "clawforce.db");
  if (!fs.existsSync(dbPath)) {
    return {
      state: "none",
      ownerLabel: null,
      heartbeatAgeMs: null,
      activeSessionCount: 0,
      activeDispatchCount: 0,
      currentConfigHash,
      appliedConfigHash: null,
      appliedConfigVersionId: null,
      appliedConfigAppliedAt: null,
      configStatus: "not-applicable",
    };
  }

  const db = new DatabaseSync(dbPath, { open: true });
  try {
    let activeSessionCount = 0;
    let activeDispatchCount = 0;
    try {
      const rows = db.prepare(
        "SELECT last_persisted_at FROM tracked_sessions WHERE project_id = ? AND dispatch_context IS NOT NULL",
      ).all(domainId) as Array<{ last_persisted_at?: number | null }>;
      activeSessionCount = rows.filter((row) => {
        const heartbeat = getSessionHeartbeatStatus(row.last_persisted_at ?? null);
        return heartbeat.state === "live" || heartbeat.state === "quiet";
      }).length;
    } catch {
      activeSessionCount = 0;
    }
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_queue WHERE project_id = ? AND status IN ('leased', 'dispatched')",
      ).get(domainId) as { count?: number } | undefined;
      activeDispatchCount = Number(row?.count ?? 0);
    } catch {
      activeDispatchCount = 0;
    }

    const lease = getControllerLease(domainId, db);
    if (!lease) {
      return {
        state: "none",
        ownerLabel: null,
        heartbeatAgeMs: null,
        activeSessionCount,
        activeDispatchCount,
        currentConfigHash,
        appliedConfigHash: null,
        appliedConfigVersionId: null,
        appliedConfigAppliedAt: null,
        configStatus: "not-applicable",
      };
    }
    const state = lease.expiresAt > Date.now() ? "live" : "stale";
    const configStatus: SetupDomainSummary["controller"]["configStatus"] = state !== "live"
      ? "not-applicable"
      : !currentConfigHash || !lease.appliedConfigHash
        ? "unknown"
        : currentConfigHash === lease.appliedConfigHash
          ? "current"
          : "stale";
    const heartbeatAgeMs = Math.max(0, Date.now() - lease.heartbeatAt);
    return {
      state,
      ownerLabel: lease.ownerLabel,
      heartbeatAgeMs,
      activeSessionCount,
      activeDispatchCount,
      currentConfigHash,
      appliedConfigHash: lease.appliedConfigHash ?? null,
      appliedConfigVersionId: lease.appliedConfigVersionId ?? null,
      appliedConfigAppliedAt: lease.appliedConfigAppliedAt ?? null,
      configStatus,
    };
  } finally {
    db.close();
  }
}

function readRecurringJobTaskState(
  projectId: string,
  taskId: string | null,
  db: DatabaseSync | null,
): string | null {
  if (!taskId || !db) return null;
  try {
    const row = db.prepare(
      "SELECT state FROM tasks WHERE project_id = ? AND id = ? LIMIT 1",
    ).get(projectId, taskId) as { state?: string } | undefined;
    return row?.state ?? null;
  } catch {
    return null;
  }
}

function readRecurringJobTaskDetails(
  projectId: string,
  taskId: string | null,
  db: DatabaseSync | null,
): {
  state: string | null;
  title: string | null;
  blockedReason: string | null;
} {
  if (!taskId || !db) {
    return { state: null, title: null, blockedReason: null };
  }

  let state: string | null = null;
  let title: string | null = null;
  try {
    const row = db.prepare(
      "SELECT state, title FROM tasks WHERE project_id = ? AND id = ? LIMIT 1",
    ).get(projectId, taskId) as { state?: string | null; title?: string | null } | undefined;
    state = row?.state ?? null;
    title = row?.title ?? null;
  } catch {
    state = readRecurringJobTaskState(projectId, taskId, db);
    title = null;
  }

  let blockedReason: string | null = null;
  if (state === "BLOCKED") {
    try {
      const row = db.prepare(`
        SELECT reason
        FROM transitions
        WHERE task_id = ? AND to_state = 'BLOCKED'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(taskId) as { reason?: string | null } | undefined;
      blockedReason = row?.reason ?? null;
    } catch {
      blockedReason = null;
    }
  }

  return { state, title, blockedReason };
}

function readRecurringJobSessionState(
  projectId: string,
  taskId: string | null,
  db: DatabaseSync | null,
): SessionHeartbeatState | "none" {
  if (!taskId || !db) return "none";
  try {
    const row = db.prepare(`
      SELECT last_persisted_at
      FROM tracked_sessions
      WHERE project_id = ?
        AND dispatch_context IS NOT NULL
        AND json_extract(dispatch_context, '$.taskId') = ?
      ORDER BY last_persisted_at DESC
      LIMIT 1
    `).get(projectId, taskId) as { last_persisted_at?: number | null } | undefined;
    if (!row) return "none";
    return getSessionHeartbeatStatus(row.last_persisted_at).state;
  } catch {
    return "none";
  }
}

function readRecurringJobQueueState(
  projectId: string,
  taskId: string | null,
  db: DatabaseSync | null,
): string | null {
  if (!taskId || !db) return null;
  try {
    const row = db.prepare(`
      SELECT status
      FROM dispatch_queue
      WHERE project_id = ?
        AND task_id = ?
        AND status IN ('queued', 'leased', 'dispatched')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(projectId, taskId) as { status?: string | null } | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  }
}

export function buildSetupReport(baseDir: string, targetDomainId?: string | null): SetupReport {
  const root = path.resolve(baseDir);
  const hasGlobalConfig = fs.existsSync(path.join(root, "config.yaml"));
  const domainsDir = path.join(root, "domains");
  const domainFileIds = fs.existsSync(domainsDir)
    ? fs.readdirSync(domainsDir)
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => path.basename(file, ".yaml"))
      .sort()
    : [];

  let globalConfig: GlobalConfig = { agents: {} };
  try {
    globalConfig = loadGlobalConfig(root);
  } catch {
    globalConfig = { agents: {} };
  }
  let normalizedAgents: Record<string, AgentConfig> = {};
  try {
    if (hasGlobalConfig) {
      const workforce = parseWorkforceConfigContent(fs.readFileSync(path.join(root, "config.yaml"), "utf-8"));
      normalizedAgents = workforce.agents;
    }
  } catch {
    normalizedAgents = {};
  }
  const loadedDomains = new Map(loadAllDomains(root).map((domain) => [
    domain.domain,
    normalizeDomainProfile(domain, globalConfig),
  ] as const));
  const allIssues = validateAllConfigs(root).issues;
  const targetDomain = targetDomainId ? loadedDomains.get(targetDomainId) ?? null : null;
  const issues = targetDomainId
    ? allIssues.filter((issue) => isIssueRelevantToTargetDomain(issue, targetDomainId, targetDomain))
    : allIssues;
  const domainIds = targetDomainId ? [targetDomainId] : domainFileIds;
  const domains: SetupDomainSummary[] = domainIds.map((domainId) => {
    const loaded = loadedDomains.get(domainId) ?? null;
    const domainIssues = issues.filter((issue) => isDomainIssue(issue, domainId));
    const dbPath = path.join(root, domainId, "clawforce.db");
    const db = fs.existsSync(dbPath)
      ? new DatabaseSync(dbPath, { open: true })
      : null;
    const jobs = loaded
      ? loaded.agents.flatMap((agentId) => {
        const agentDef = globalConfig.agents?.[agentId] as Record<string, unknown> | undefined;
        const agentJobs = resolveSetupAgentJobs(domainId, agentId, agentDef, loaded);
        if (Object.keys(agentJobs).length === 0) {
          return [];
        }
        return Object.entries(agentJobs).map(([jobId, jobDef]) => {
          const cron = typeof (jobDef as Record<string, unknown>)?.cron === "string"
            ? String((jobDef as Record<string, unknown>).cron)
            : null;
          const frequency = typeof (jobDef as Record<string, unknown>)?.frequency === "string"
            ? String((jobDef as Record<string, unknown>).frequency)
            : null;
          const runtime = db
            ? readRecurringJobRuntime(domainId, agentId, jobId, jobDef as Record<string, unknown>, db)
            : {
              lastScheduledAt: null,
              lastFinishedAt: null,
              lastStatus: null,
              lastTaskId: null,
              lastReason: null,
              activeTaskId: null,
              nextRunAt: null,
            };
          const taskDetails = readRecurringJobTaskDetails(domainId, runtime.activeTaskId, db);
          return {
            agentId,
            jobId,
            cron,
            frequency,
            lastScheduledAt: runtime.lastScheduledAt,
            lastFinishedAt: runtime.lastFinishedAt,
            lastStatus: runtime.lastStatus,
            activeTaskId: runtime.activeTaskId,
            activeTaskState: taskDetails.state,
            activeTaskTitle: taskDetails.title,
            activeTaskBlockedReason: taskDetails.blockedReason,
            activeQueueStatus: readRecurringJobQueueState(domainId, runtime.activeTaskId, db),
            activeSessionState: readRecurringJobSessionState(domainId, runtime.activeTaskId, db),
            nextRunAt: runtime.nextRunAt,
          };
        });
      })
      : [];
    jobs.sort(compareSetupJobs);
    const currentConfigHash = loaded
      ? computeDomainConfigFingerprint(globalConfig, loaded).contentHash
      : null;
    if (db) {
      db.close();
    }
    return {
      id: domainId,
      file: path.join("domains", `${domainId}.yaml`),
      exists: domainFileIds.includes(domainId),
      loaded: Boolean(loaded),
      enabled: loaded ? loaded.enabled !== false : false,
      workflows: Array.isArray(loaded?.workflows)
        ? loaded.workflows.filter((workflow): workflow is string => typeof workflow === "string" && workflow.trim().length > 0)
        : [],
      agentCount: Array.isArray(loaded?.agents) ? loaded!.agents.length : 0,
      jobCount: jobs.length,
      jobs,
      controller: readControllerStatus(root, domainId, currentConfigHash),
      managerAgentId: loaded?.manager?.enabled !== false && typeof loaded?.manager?.agentId === "string" && loaded.manager.agentId.trim()
        ? loaded.manager.agentId.trim()
        : null,
      pathCount: Array.isArray(loaded?.paths) ? loaded!.paths.length : 0,
      issueCounts: countIssues(domainIssues),
    };
  });

  const checks = buildGlobalChecks(root, hasGlobalConfig, domainFileIds, globalConfig, issues, targetDomainId ?? null);
  for (const domainId of domainIds) {
    const domain = loadedDomains.get(domainId);
    const domainSummary = domains.find((entry) => entry.id === domainId);
    if (!domain) {
      checks.push({
        id: `domain:${domainId}:load`,
        domainId,
        status: "error",
        summary: `Domain "${domainId}" could not be loaded.`,
        detail: issueSummary(issues.filter((issue) => isDomainIssue(issue, domainId))) ?? "The domain file is missing or invalid.",
        fix: `Fix validation errors in domains/${domainId}.yaml and rerun cf setup validate --domain=${domainId}.`,
      });
      continue;
    }
    checks.push(...buildDomainChecks(
      domain,
      domainSummary,
      domainSummary?.controller ?? {
        state: "none",
        ownerLabel: null,
        heartbeatAgeMs: null,
        activeSessionCount: 0,
        activeDispatchCount: 0,
        currentConfigHash: null,
        appliedConfigHash: null,
        appliedConfigVersionId: null,
        appliedConfigAppliedAt: null,
        configStatus: "not-applicable",
      },
      issues.filter((issue) => isDomainIssue(issue, domain.domain)),
      normalizedAgents,
      globalConfig,
    ));
  }

  const overallCheckCounts = countChecks(checks);
  const validationIssueCounts = countIssues(issues);

  const report: SetupReport = {
    root,
    targetDomainId: targetDomainId ?? null,
    valid: false,
    hasGlobalConfig,
    domainFileIds,
    domains,
    issueCounts: {
      errors: overallCheckCounts.errors,
      warnings: overallCheckCounts.warnings,
      suggestions: validationIssueCounts.suggestions,
    },
    checks,
    issues,
    nextSteps: [],
  };
  report.valid = !issues.some((issue) => issue.severity === "error")
    && !report.checks.some((check) => check.status === "error");
  report.nextSteps = buildNextSteps(report);
  return report;
}

function formatCheck(check: SetupCheck): string {
  const icon = check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "error";
  const lines = [`- [${icon}] ${check.summary}`];
  if (check.detail) lines.push(`  ${check.detail}`);
  if (check.fix) lines.push(`  fix: ${check.fix}`);
  return lines.join("\n");
}

function formatRelativeMs(value: number | null): string {
  if (value == null) return "never";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function formatFutureMs(value: number | null): string {
  if (value == null) return "n/a";
  const deltaSeconds = Math.round((value - Date.now()) / 1000);
  if (deltaSeconds <= 0) return "due now";
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d`;
}

function formatRecurringJobState(job: SetupDomainSummary["jobs"][number]): string {
  const state = classifyRecurringJobState(job);
  if (job.activeTaskId && ["running", "dispatching", "queued", "blocked", "stalled", "orphaned"].includes(state)) {
    return `${state} task=${job.activeTaskId.slice(0, 8)}`;
  }
  return state;
}

function formatRecurringJobDetail(job: SetupDomainSummary["jobs"][number]): string | null {
  const parts: string[] = [];
  if (job.activeTaskTitle) {
    parts.push(`title="${job.activeTaskTitle}"`);
  }
  if (job.activeTaskBlockedReason) {
    parts.push(`reason="${job.activeTaskBlockedReason}"`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function formatShortHash(value: string | null): string {
  return value ? value.slice(0, 8) : "unknown";
}

export function renderSetupStatus(report: SetupReport): string {
  const overallCheckCounts = countChecks(report.checks);
  const lines = [
    "## Setup Status",
    `root=${report.root}`,
    `target_domain=${report.targetDomainId ?? "(all)"}`,
    `valid=${report.valid}`,
    `domains=${report.domainFileIds.length}`,
    `errors=${overallCheckCounts.errors} warnings=${overallCheckCounts.warnings} suggestions=${report.issueCounts.suggestions}`,
    "",
    "Domains:",
  ];

  if (report.domains.length === 0) {
    lines.push("- none");
  } else {
    for (const domain of report.domains) {
      const domainCheckCounts = countChecks(report.checks, domain.id);
      lines.push(`- ${domain.id} loaded=${domain.loaded} enabled=${domain.enabled} agents=${domain.agentCount} jobs=${domain.jobCount} manager=${domain.managerAgentId ?? "(none)"} paths=${domain.pathCount} workflows=${domain.workflows.length > 0 ? domain.workflows.join(",") : "(none)"} errors=${domainCheckCounts.errors} warnings=${domainCheckCounts.warnings}`);
      lines.push(
        `  controller state=${domain.controller.state}`
        + `${domain.controller.ownerLabel ? ` owner=${domain.controller.ownerLabel}` : ""}`
        + `${domain.controller.heartbeatAgeMs != null ? ` heartbeat=${Math.round(domain.controller.heartbeatAgeMs / 1000)}s` : ""}`
        + `${domain.controller.activeSessionCount > 0 ? ` active_sessions=${domain.controller.activeSessionCount}` : ""}`
        + `${domain.controller.activeDispatchCount > 0 ? ` active_dispatches=${domain.controller.activeDispatchCount}` : ""}`
        + `${domain.controller.state === "live" ? ` config=${domain.controller.configStatus}` : ""}`
        + `${domain.controller.state === "live" && domain.controller.currentConfigHash ? ` current=${formatShortHash(domain.controller.currentConfigHash)}` : ""}`
        + `${domain.controller.state === "live" && domain.controller.appliedConfigHash ? ` applied=${formatShortHash(domain.controller.appliedConfigHash)}` : ""}`
        + `${domain.controller.state === "live" && domain.controller.appliedConfigAppliedAt != null ? ` applied_at=${formatRelativeMs(domain.controller.appliedConfigAppliedAt)}` : ""}`,
      );
      for (const job of domain.jobs.slice(0, 5)) {
        const schedule = job.cron ? `cron=${job.cron}` : job.frequency ? `frequency=${job.frequency}` : "manual";
        const state = formatRecurringJobState(job);
        lines.push(`  job ${job.agentId}.${job.jobId} ${schedule} state=${state} last=${formatRelativeMs(job.lastFinishedAt ?? job.lastScheduledAt)} next=${formatFutureMs(job.nextRunAt)}`);
        const detail = formatRecurringJobDetail(job);
        if (detail) {
          lines.push(`    ${detail}`);
        }
      }
      if (domain.jobs.length > 5) {
        lines.push(`  ... ${domain.jobs.length - 5} more job(s)`);
      }
    }
  }

  return lines.join("\n");
}

export function renderSetupValidate(report: SetupReport): string {
  const overallCheckCounts = countChecks(report.checks);
  const lines = [
    "## Setup Validate",
    `root=${report.root}`,
    `target_domain=${report.targetDomainId ?? "(all)"}`,
    `valid=${report.valid}`,
    `errors=${overallCheckCounts.errors} warnings=${overallCheckCounts.warnings} suggestions=${report.issueCounts.suggestions}`,
    "",
    "Readiness:",
  ];

  for (const check of report.checks) {
    lines.push(formatCheck(check));
  }

  lines.push("", "Issues:");
  if (report.issues.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of report.issues.slice(0, 20)) {
      const location = [issue.file, issue.path].filter(Boolean).join(":");
      lines.push(`- [${issue.severity}] ${issue.code}${location ? ` ${location}` : ""} — ${issue.message}`);
    }
    if (report.issues.length > 20) {
      lines.push(`- ... ${report.issues.length - 20} more issue(s)`);
    }
  }

  lines.push("", "Next Steps:");
  if (report.nextSteps.length === 0) {
    lines.push("- none");
  } else {
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function renderSetupExplain(report: SetupReport): string {
  const explanation = buildSetupExplanation(report);
  const lines = [
    "## Setup Explain",
    `Overall: ${explanation.summary}`,
    `Target domain: ${report.targetDomainId ?? "(all)"}`,
    "",
    "ClawForce setup has three layers:",
    "1. config.yaml — global agents, shared defaults, adapter/runtime policy.",
    "2. domains/<id>.yaml — one domain's agents, paths, lifecycle, entities, and workflow policy.",
    "3. runtime — controller, feed, review, and approval surfaces operating on the loaded domain.",
    "",
    "Normal user path:",
    "1. If you need a starter config, run `cf setup scaffold --domain=<id> --mode=new` or add `--workflow=data-source-onboarding` for a first-class onboarding loop.",
    "2. Define or refine global agents in config.yaml.",
    "3. Define or refine a domain with agents, manager.agentId, and project paths.",
    "4. Run `cf setup validate` until blocking issues are gone.",
    "5. Start the local controller with `cf controller --domain=<id>`.",
    "6. Use `cf feed`, `cf decisions`, and `cf review` as the normal operating surface.",
    "",
    "Current diagnosis:",
  ];

  if (explanation.domains.length === 0) {
    lines.push("- none");
  } else {
    for (const domain of explanation.domains) {
      const counts = domain.counts;
      lines.push(`- ${domain.id} diagnosis=${domain.diagnosis} controller=${domain.controllerState} manager=${domain.managerAgentId ?? "(none)"}`);
      lines.push(`  jobs running=${counts.running} dispatching=${counts.dispatching} queued=${counts.queued} blocked=${counts.blocked} stalled=${counts.stalled} orphaned=${counts.orphaned} completed=${counts.completed} failed=${counts.failed} never=${counts.never}`);
      for (const highlight of domain.highlights) {
        lines.push(`  ${highlight}`);
      }
    }
  }

  lines.push(
    "",
    "Immediate actions:",
  );

  if (explanation.immediateActions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of explanation.immediateActions) {
      lines.push(`- [${action.status}] ${action.summary}`);
      if (action.why) lines.push(`  why: ${action.why}`);
      if (action.fix) lines.push(`  do: ${action.fix}`);
    }
  }

  lines.push(
    "",
    renderSetupStatus(report),
    "",
    "Configured recurring workflows are listed in setup status so you can verify the domain shape before waiting on cron-driven execution.",
    "Setup status also shows whether each recurring workflow has actually started running under the live controller.",
    "Setup now distinguishes caller-local reload feedback from a live controller that has durably confirmed the current config revision.",
    "When a recurring workflow is blocked or orphaned, setup surfaces now include the concrete task title and latest block reason so you can go straight to cf review.",
    "",
    "Current next steps:",
  );

  if (report.nextSteps.length === 0) {
    lines.push("- The current setup surface is clean enough to start the controller and dogfood the workflow.");
  } else {
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function buildSetupExplanation(report: SetupReport): SetupExplanation {
  const immediateActions = report.checks
    .filter((check) => check.status === "error" || check.status === "warn")
    .map((check) => ({
      id: check.id,
      status: check.status,
      summary: check.summary,
      why: check.detail ?? null,
      fix: check.fix ?? null,
      domainId: check.domainId,
    }));

  const domains = report.domains.map((domain) => {
    const counts = {
      running: 0,
      dispatching: 0,
      queued: 0,
      blocked: 0,
      stalled: 0,
      orphaned: 0,
      completed: 0,
      failed: 0,
      never: 0,
    };
    for (const job of domain.jobs) {
      counts[classifyRecurringJobState(job)] += 1;
    }

    const domainChecks = report.checks.filter((check) => check.domainId === domain.id);
    const diagnosis: "healthy" | "attention-needed" | "ready-but-idle" =
      domainChecks.some((check) => check.status === "error" || check.status === "warn")
        ? "attention-needed"
        : domain.controller.state === "live"
          ? "healthy"
          : "ready-but-idle";

    const highlights = domain.jobs
      .filter((job) => {
        const state = classifyRecurringJobState(job);
        return state === "running"
          || state === "dispatching"
          || state === "queued"
          || state === "blocked"
          || state === "stalled"
          || state === "orphaned";
      })
      .slice(0, 4)
      .map((job) => {
        const schedule = job.cron ? `cron=${job.cron}` : job.frequency ? `frequency=${job.frequency}` : "manual";
        const detail = formatRecurringJobDetail(job);
        return `job ${job.agentId}.${job.jobId} ${schedule} state=${formatRecurringJobState(job)}${detail ? ` ${detail}` : ""}`;
      });
    if (domain.workflows.length > 0) {
      highlights.unshift(`declared workflows: ${domain.workflows.join(", ")}`);
    }

    return {
      id: domain.id,
      diagnosis,
      controllerState: domain.controller.state,
      managerAgentId: domain.managerAgentId,
      counts,
      highlights,
    };
  });

  const errorCount = immediateActions.filter((action) => action.status === "error").length;
  const warnCount = immediateActions.filter((action) => action.status === "warn").length;
  const summary = errorCount > 0
    ? `Setup has ${errorCount} blocking error(s) and ${warnCount} warning(s).`
    : warnCount > 0
      ? `Setup is valid, but ${warnCount} warning(s) still need operator attention.`
      : "Setup is clean and ready to drive through the normal controller/feed/review loop.";

  return {
    summary,
    targetDomainId: report.targetDomainId,
    immediateActions,
    domains,
  };
}
