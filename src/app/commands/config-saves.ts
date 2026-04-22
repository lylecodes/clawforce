import {
  previewDomainConfigSectionChange as previewDomainConfigSectionChangeViaService,
  previewGlobalConfigSectionChange as previewGlobalConfigSectionChangeViaService,
  readDomainConfig as readDomainConfigViaService,
  readGlobalConfig as readGlobalConfigViaService,
  reloadDomainRuntimes as reloadDomainRuntimesViaService,
  saveDomainConfigSection as saveDomainConfigSectionViaService,
  updateGlobalAgentConfig,
  upsertGlobalAgents,
} from "../../config/api-service.js";
import { getDomainRuntimeReloadStatus } from "../../config/init.js";
import {
  mergeAgentRuntimeConfig,
  normalizeConfiguredAgentRuntime,
} from "../../agent-runtime-config.js";
import { getAgentDomains } from "../../config/registry.js";
import { getAgentConfig, getRegisteredAgentIds } from "../../project.js";
import type { DomainConfig } from "../../config/schema.js";
import { safeLog } from "../../diagnostics.js";

export type SaveConfigCommandInput = {
  section: string;
  data: unknown;
  actor?: string;
};

export type SaveConfigCommandResult =
  | {
      ok: true;
      section: string;
      persistedSection: string;
      persistedData: unknown;
      warnings?: string[];
      reloadErrors?: string[];
      runtimeReload?: ReturnType<typeof getDomainRuntimeReloadStatus>;
      change?: {
        resourceId: string;
        before: unknown;
        after: unknown;
        reversible: boolean;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type PreviewSaveConfigCommandResult =
  | {
      ok: true;
      section: string;
      persistedSection: string;
      persistedData: unknown;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      valid: boolean;
      errors?: string[];
      changedPaths: string[];
      changedKeys: string[];
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type LogicalConfigChange = {
  before: unknown;
  after: unknown;
  changedKeys: string[];
};

type PreviewAggregate = {
  valid: boolean;
  errors?: string[];
  changedPaths: string[];
};

function diffConfigSectionKeys(before: unknown, after: unknown): string[] {
  if (Array.isArray(before) || Array.isArray(after)) {
    const beforeItems = Array.isArray(before) ? before : [];
    const afterItems = Array.isArray(after) ? after : [];
    const beforeMap = new Map<string, string>();
    const afterMap = new Map<string, string>();

    for (const item of beforeItems) {
      if (!isPlainObject(item) || typeof item.id !== "string") continue;
      beforeMap.set(item.id, JSON.stringify(item));
    }
    for (const item of afterItems) {
      if (!isPlainObject(item) || typeof item.id !== "string") continue;
      afterMap.set(item.id, JSON.stringify(item));
    }

    if (beforeMap.size > 0 || afterMap.size > 0) {
      const keys = new Set<string>([
        ...beforeMap.keys(),
        ...afterMap.keys(),
      ]);
      return [...keys].filter((key) => beforeMap.get(key) !== afterMap.get(key));
    }

    return JSON.stringify(beforeItems) === JSON.stringify(afterItems) ? [] : ["items"];
  }

  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};
  const keys = new Set<string>([
    ...Object.keys(beforeObj),
    ...Object.keys(afterObj),
  ]);
  return [...keys].filter((key) =>
    JSON.stringify(beforeObj[key]) !== JSON.stringify(afterObj[key]),
  );
}

function combinePreviewAggregates(parts: PreviewAggregate[]): PreviewAggregate {
  const changedPaths = [...new Set(parts.flatMap((part) => part.changedPaths))];
  const errors = parts.flatMap((part) => part.errors ?? []);
  return {
    valid: parts.every((part) => part.valid),
    ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
    changedPaths,
  };
}

function toDashboardAgentShape(
  agentId: string,
  rawAgent: unknown,
): Record<string, unknown> {
  const current = isPlainObject(rawAgent) ? rawAgent : {};
  const runtime = normalizeConfiguredAgentRuntime(current);
  return {
    id: agentId,
    ...(typeof current.extends === "string" ? { extends: current.extends } : {}),
    ...(typeof current.title === "string" ? { title: current.title } : {}),
    ...(typeof current.persona === "string" ? { persona: current.persona } : {}),
    ...(typeof current.reports_to === "string" ? { reports_to: current.reports_to } : {}),
    ...(typeof current.department === "string" ? { department: current.department } : {}),
    ...(typeof current.team === "string" ? { team: current.team } : {}),
    ...(typeof current.channel === "string" ? { channel: current.channel } : {}),
    ...(typeof current.runtime_ref === "string" ? { runtimeRef: current.runtime_ref } : {}),
    ...(runtime ? { runtime } : {}),
    ...(Array.isArray(current.briefing) ? { briefing: current.briefing } : {}),
    ...(Array.isArray(current.expectations) ? { expectations: current.expectations } : {}),
    ...(isPlainObject(current.performance_policy)
      ? { performance_policy: { ...current.performance_policy } }
      : {}),
  };
}

function buildLogicalAgentsSection(
  domainConfig: DomainConfig,
  globalConfig: ReturnType<typeof readGlobalConfigViaService>,
): Record<string, unknown>[] {
  const domainAgentIds = Array.isArray(domainConfig.agents)
    ? domainConfig.agents.filter((agentId): agentId is string =>
        typeof agentId === "string" && agentId.trim().length > 0,
      )
    : [];

  return domainAgentIds
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((agentId) => toDashboardAgentShape(agentId, globalConfig.agents?.[agentId]));
}

function buildLogicalBudgetInitiatives(
  goals: unknown,
): Record<string, number> {
  if (!isPlainObject(goals)) return {};
  const initiatives: Record<string, number> = {};
  for (const [goalId, goalDef] of Object.entries(goals)) {
    if (!isPlainObject(goalDef) || typeof goalDef.allocation !== "number") continue;
    initiatives[goalId] = goalDef.allocation;
  }
  return initiatives;
}

function buildLogicalBudgetSection(domainConfig: DomainConfig): Record<string, unknown> {
  const section: Record<string, unknown> = isPlainObject(domainConfig.budget)
    ? { ...domainConfig.budget }
    : {};

  if (typeof domainConfig.operational_profile === "string" && domainConfig.operational_profile.trim()) {
    section.operational_profile = domainConfig.operational_profile;
  }

  const initiatives = buildLogicalBudgetInitiatives(domainConfig.goals);
  if (Object.keys(initiatives).length > 0) {
    section.initiatives = initiatives;
  }

  return section;
}

function buildLogicalInitiativesSection(domainConfig: DomainConfig): Record<string, { allocation_pct: number; goal?: string }> {
  if (!isPlainObject(domainConfig.goals)) return {};
  return Object.entries(domainConfig.goals).reduce<Record<string, { allocation_pct: number; goal?: string }>>(
    (acc, [goalId, goalDef]) => {
      if (!isPlainObject(goalDef) || typeof goalDef.allocation !== "number") return acc;
      acc[goalId] = {
        allocation_pct: goalDef.allocation,
        goal: goalId,
      };
      return acc;
    },
    {},
  );
}

function buildLogicalDashboardAssistantSection(domainConfig: DomainConfig): Record<string, unknown> {
  const raw = isPlainObject(domainConfig.dashboard_assistant)
    ? domainConfig.dashboard_assistant
    : {};
  const section: Record<string, unknown> = {
    enabled: raw.enabled !== false,
  };
  if (typeof raw.agentId === "string" && raw.agentId.trim()) {
    section.agentId = raw.agentId.trim();
  }
  if (typeof raw.model === "string" && raw.model.trim()) {
    section.model = raw.model.trim();
  }
  return section;
}

function buildLogicalJobsSection(
  projectId: string,
  globalConfig: ReturnType<typeof readGlobalConfigViaService>,
  agentIds = getProjectAgentIds(projectId),
): Record<string, unknown>[] {
  return agentIds
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .flatMap((agentId) => {
      const rawAgent = isPlainObject(globalConfig.agents?.[agentId])
        ? globalConfig.agents?.[agentId] as Record<string, unknown>
        : {};
      const jobs = isPlainObject(rawAgent.jobs) ? rawAgent.jobs as Record<string, unknown> : {};
      return Object.entries(jobs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([jobName, jobDef]) => {
          const job = isPlainObject(jobDef) ? jobDef : {};
          return {
            id: `${agentId}:${jobName}`,
            agent: agentId,
            cron: typeof job.cron === "string" ? job.cron : "",
            enabled: job.enabled !== false,
            ...(typeof job.description === "string" ? { description: job.description } : {}),
          };
        });
    });
}

function buildLogicalConfigChange(
  projectId: string,
  section: string,
  data: unknown,
  existingDomain: DomainConfig,
  globalConfig: ReturnType<typeof readGlobalConfigViaService>,
): LogicalConfigChange {
  switch (section) {
    case "agents": {
      const before = buildLogicalAgentsSection(existingDomain, globalConfig);
      const agents = normalizeAgentConfigInput(data)
        .map((item) => {
          const agentId = readStringBody(item, "id");
          if (!agentId) return null;
          const nextRaw = canonicalizeDashboardAgentConfig(item, globalConfig.agents?.[agentId]);
          return toDashboardAgentShape(agentId, nextRaw);
        })
        .filter((item): item is Record<string, unknown> => item !== null);
      return {
        before,
        after: agents,
        changedKeys: diffConfigSectionKeys(before, agents),
      };
    }
    case "budget": {
      const before = buildLogicalBudgetSection(existingDomain);
      const inputObj = isPlainObject(data) ? data : {};
      const after: Record<string, unknown> = {
        ...Object.fromEntries(
          Object.entries(inputObj).filter(([key]) => key !== "operational_profile" && key !== "initiatives"),
        ),
        ...(Object.prototype.hasOwnProperty.call(inputObj, "operational_profile")
          ? { operational_profile: inputObj.operational_profile }
          : before.operational_profile !== undefined
            ? { operational_profile: before.operational_profile }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(inputObj, "initiatives")
          ? { initiatives: inputObj.initiatives }
          : before.initiatives !== undefined
            ? { initiatives: before.initiatives }
            : {}),
      };
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
    case "jobs": {
      const before = buildLogicalJobsSection(projectId, globalConfig);
      const after = Array.isArray(data) ? data : [];
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
    case "profile": {
      const before = typeof existingDomain.operational_profile === "string"
        ? { operational_profile: existingDomain.operational_profile }
        : {};
      const after = isPlainObject(data) ? data : {};
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
    case "initiatives": {
      const before = buildLogicalInitiativesSection(existingDomain);
      const afterGoals = canonicalizeInitiatives(data, existingDomain.goals);
      const after = Object.entries(afterGoals).reduce<Record<string, { allocation_pct: number; goal?: string }>>(
        (acc, [goalId, goalDef]) => {
          if (!isPlainObject(goalDef) || typeof goalDef.allocation !== "number") return acc;
          acc[goalId] = {
            allocation_pct: goalDef.allocation,
            goal: goalId,
          };
          return acc;
        },
        {},
      );
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
    case "dashboard_assistant": {
      const before = buildLogicalDashboardAssistantSection(existingDomain);
      const next = canonicalizeDashboardAssistantConfig(projectId, data);
      return {
        before,
        after: next.ok ? next.value : data,
        changedKeys: diffConfigSectionKeys(before, next.ok ? next.value : data),
      };
    }
    case "safety": {
      const before = canonicalizeSafetyConfig(existingDomain.safety);
      const after = canonicalizeSafetyConfig(data);
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
    default: {
      const before = existingDomain[section as keyof DomainConfig];
      const after = data;
      return {
        before,
        after,
        changedKeys: diffConfigSectionKeys(before, after),
      };
    }
  }
}

export function runSaveConfigCommand(
  projectId: string,
  input: SaveConfigCommandInput,
): SaveConfigCommandResult {
  const actor = input.actor ?? "dashboard";
  const existing = readDomainConfigViaService(projectId);
  if (!existing) {
    return { ok: false, status: 404, error: `Domain config file not found: ${projectId}.yaml` };
  }

  const result = (() => {
    switch (input.section) {
      case "agents":
        return saveAgentsConfig(projectId, input.data, actor);
      case "budget":
        return saveBudgetConfig(projectId, input.data, existing, actor);
      case "jobs":
        return saveJobsConfig(projectId, input.data, actor);
      default:
        return saveSingleConfigSection(projectId, existing, input, actor);
    }
  })();

  if (!result.ok) {
    return result;
  }

  const logicalChange = buildLogicalConfigChange(
    projectId,
    input.section,
    input.data,
    existing,
    readGlobalConfigViaService(),
  );

  return {
    ...result,
    change: {
      resourceId: input.section,
      before: logicalChange.before,
      after: logicalChange.after,
      reversible: true,
    },
  };
}

export function previewSaveConfigCommand(
  projectId: string,
  input: SaveConfigCommandInput,
): PreviewSaveConfigCommandResult {
  const existing = readDomainConfigViaService(projectId);
  if (!existing) {
    return { ok: false, status: 404, error: `Domain config file not found: ${projectId}.yaml` };
  }

  const logicalChange = buildLogicalConfigChange(
    projectId,
    input.section,
    input.data,
    existing,
    readGlobalConfigViaService(),
  );

  const specialPreview = previewSpecialConfigSave(projectId, input, existing, logicalChange.changedKeys);
  if (specialPreview) {
    return specialPreview;
  }

  const resolved = resolveConfigSavePayload(projectId, input.section, input.data, existing);
  if (!resolved.ok) {
    return resolved;
  }

  const preview = previewDomainConfigSectionChangeViaService(
    projectId,
    resolved.persistedSection,
    resolved.persistedData,
  );
  if (!preview.ok) {
    return { ok: false, status: 400, error: preview.error };
  }

  return {
    ok: true,
    section: input.section,
    persistedSection: resolved.persistedSection,
    persistedData: resolved.persistedData,
    ...preview.preview,
    changedKeys: logicalChange.changedKeys,
  };
}

function previewSpecialConfigSave(
  projectId: string,
  input: SaveConfigCommandInput,
  existingDomain: DomainConfig,
  changedKeys: string[],
): PreviewSaveConfigCommandResult | null {
  if (input.section === "agents") {
    const globalConfig = readGlobalConfigViaService();
    const agents = normalizeAgentConfigInput(input.data);
    const upserts: Record<string, Record<string, unknown>> = {};
    const domainAgentIds: string[] = [];

    for (const [index, item] of agents.entries()) {
      const agentId = readStringBody(item, "id");
      if (!agentId) {
        return { ok: false, status: 400, error: `agents[${index}].id must be a non-empty string` };
      }
      const existingRuntime = getAgentConfig(agentId);
      if (existingRuntime && existingRuntime.projectId !== projectId) {
        return {
          ok: false,
          status: 409,
          error: `Agent "${agentId}" belongs to project "${existingRuntime.projectId}", not "${projectId}"`,
        };
      }
      upserts[agentId] = canonicalizeDashboardAgentConfig(item, globalConfig.agents?.[agentId]);
      domainAgentIds.push(agentId);
    }

    const globalPreview = previewGlobalConfigSectionChangeViaService("agents", {
      ...(globalConfig.agents ?? {}),
      ...upserts,
    });
    const domainPreview = previewDomainConfigSectionChangeViaService(
      projectId,
      "agents",
      domainAgentIds,
    );
    if (!domainPreview.ok) {
      return { ok: false, status: 400, error: domainPreview.error };
    }

    const combined = combinePreviewAggregates([
      {
        valid: globalPreview.valid,
        errors: globalPreview.errors,
        changedPaths: globalPreview.changedPaths,
      },
      {
        valid: domainPreview.preview.valid,
        errors: domainPreview.preview.errors,
        changedPaths: domainPreview.preview.changedPaths,
      },
    ]);

    return {
      ok: true,
      section: input.section,
      persistedSection: "agents",
      persistedData: domainAgentIds,
      before: globalPreview.before,
      after: globalPreview.after,
      valid: combined.valid,
      ...(combined.errors ? { errors: combined.errors } : {}),
      changedPaths: combined.changedPaths,
      changedKeys,
    };
  }

  if (input.section === "budget") {
    if (!isPlainObject(input.data)) {
      return { ok: false, status: 400, error: "budget: data must be an object" };
    }

    const profile = typeof input.data.operational_profile === "string"
      ? input.data.operational_profile.trim() || undefined
      : undefined;
    const initiatives = isPlainObject(input.data.initiatives)
      ? input.data.initiatives as Record<string, unknown>
      : undefined;

    const budgetData = { ...input.data };
    delete budgetData.operational_profile;
    delete budgetData.initiatives;

    const previews: PreviewAggregate[] = [];
    const budgetPreview = previewDomainConfigSectionChangeViaService(projectId, "budget", budgetData);
    if (!budgetPreview.ok) {
      return { ok: false, status: 400, error: budgetPreview.error };
    }
    previews.push({
      valid: budgetPreview.preview.valid,
      errors: budgetPreview.preview.errors,
      changedPaths: budgetPreview.preview.changedPaths,
    });

    if (profile !== undefined) {
      const profilePreview = previewDomainConfigSectionChangeViaService(projectId, "operational_profile", profile);
      if (!profilePreview.ok) {
        return { ok: false, status: 400, error: profilePreview.error };
      }
      previews.push({
        valid: profilePreview.preview.valid,
        errors: profilePreview.preview.errors,
        changedPaths: profilePreview.preview.changedPaths,
      });
    }

    if (initiatives !== undefined) {
      const goals = canonicalizeBudgetInitiatives(initiatives, existingDomain.goals);
      const goalsPreview = previewDomainConfigSectionChangeViaService(projectId, "goals", goals);
      if (!goalsPreview.ok) {
        return { ok: false, status: 400, error: goalsPreview.error };
      }
      previews.push({
        valid: goalsPreview.preview.valid,
        errors: goalsPreview.preview.errors,
        changedPaths: goalsPreview.preview.changedPaths,
      });
    }

    const combined = combinePreviewAggregates(previews);
    return {
      ok: true,
      section: input.section,
      persistedSection: "budget",
      persistedData: budgetData,
      before: budgetPreview.preview.before,
      after: budgetPreview.preview.after,
      valid: combined.valid,
      ...(combined.errors ? { errors: combined.errors } : {}),
      changedPaths: combined.changedPaths,
      changedKeys,
    };
  }

  if (input.section === "jobs") {
    if (!Array.isArray(input.data)) {
      return { ok: false, status: 400, error: "jobs: data must be an array" };
    }

    const globalConfig = readGlobalConfigViaService();
    const grouped = new Map<string, Record<string, Record<string, unknown>>>();
    const payloadAgentIds = new Set<string>();
    const projectAgentIds = new Set(getProjectAgentIds(projectId));

    for (const [index, item] of input.data.entries()) {
      if (!isPlainObject(item)) {
        return { ok: false, status: 400, error: `jobs[${index}] must be an object` };
      }

      const agentId = readStringBody(item, "agent");
      const jobId = readStringBody(item, "id");
      if (!agentId || !jobId) {
        return { ok: false, status: 400, error: `jobs[${index}] must include id and agent` };
      }
      payloadAgentIds.add(agentId);

      const entry = getAgentConfig(agentId);
      if (!entry || entry.projectId !== projectId) {
        return { ok: false, status: 404, error: `Agent "${agentId}" is not registered in project "${projectId}"` };
      }

      const jobName = parseDashboardJobName(jobId);
      const globalAgent = globalConfig.agents?.[agentId] as Record<string, unknown> | undefined;
      const existingJobs = (globalAgent?.jobs && typeof globalAgent.jobs === "object")
        ? globalAgent.jobs as Record<string, unknown>
        : {};
      const existingJob = existingJobs[jobName];
      const nextJobs = grouped.get(agentId) ?? {};
      const current = isPlainObject(existingJob) ? existingJob as Record<string, unknown> : {};
      nextJobs[jobName] = {
        ...current,
        cron: typeof item.cron === "string" ? item.cron : (current.cron as string | undefined),
        enabled: typeof item.enabled === "boolean" ? item.enabled : current.enabled ?? true,
        ...(typeof item.description === "string"
          ? { description: item.description }
          : current.description !== undefined
            ? { description: current.description }
            : {}),
      };
      grouped.set(agentId, nextJobs);
    }

    const persistedAgentIds = new Set<string>([
      ...Array.from(projectAgentIds).filter((agentId) => !!globalConfig.agents?.[agentId]),
      ...payloadAgentIds,
    ]);

    const nextAgents = { ...(globalConfig.agents ?? {}) } as Record<string, unknown>;
    for (const agentId of persistedAgentIds) {
      const current = isPlainObject(nextAgents[agentId]) ? nextAgents[agentId] as Record<string, unknown> : {};
      nextAgents[agentId] = {
        ...current,
        jobs: grouped.get(agentId) ?? {},
      };
    }

    const globalPreview = previewGlobalConfigSectionChangeViaService("agents", nextAgents);
    return {
      ok: true,
      section: input.section,
      persistedSection: "jobs",
      persistedData: input.data,
      before: globalPreview.before,
      after: globalPreview.after,
      valid: globalPreview.valid,
      ...(globalPreview.errors ? { errors: globalPreview.errors } : {}),
      changedPaths: globalPreview.changedPaths,
      changedKeys,
    };
  }

  return null;
}

export function normalizeAgentConfigInput(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isPlainObject);
  }
  if (isPlainObject(data)) {
    return Object.entries(data).map(([id, value]) => {
      if (isPlainObject(value)) {
        return { id, ...value };
      }
      return { id };
    });
  }
  return [];
}

export function canonicalizeSafetyConfig(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) return {};
  const safety = data as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  const maxSpawnDepth = safety.maxSpawnDepth ?? safety.spawn_depth_limit;
  if (typeof maxSpawnDepth === "number") next.maxSpawnDepth = maxSpawnDepth;

  const costCircuitBreaker = safety.costCircuitBreaker ?? safety.circuit_breaker_multiplier;
  if (typeof costCircuitBreaker === "number") next.costCircuitBreaker = costCircuitBreaker;

  const loopDetectionThreshold = safety.loopDetectionThreshold ?? safety.loop_detection_threshold;
  if (typeof loopDetectionThreshold === "number") next.loopDetectionThreshold = loopDetectionThreshold;

  for (const [key, value] of Object.entries(safety)) {
    if (!(key in {
      maxSpawnDepth: true,
      spawn_depth_limit: true,
      costCircuitBreaker: true,
      circuit_breaker_multiplier: true,
      loopDetectionThreshold: true,
      loop_detection_threshold: true,
    })) {
      next[key] = value;
    }
  }

  return next;
}

function saveSingleConfigSection(
  projectId: string,
  existing: DomainConfig,
  input: SaveConfigCommandInput,
  actor: string,
): SaveConfigCommandResult {
  const resolved = resolveConfigSavePayload(projectId, input.section, input.data, existing);
  if (!resolved.ok) {
    return resolved;
  }

  const saveResult = saveDomainConfigSectionViaService(
    projectId,
    resolved.persistedSection,
    resolved.persistedData,
    actor,
  );
  if (!saveResult.ok) {
    return {
      ok: false,
      status: 400,
      error: saveResult.error ?? `Failed to update ${resolved.persistedSection}`,
    };
  }

  return {
    ok: true,
    section: input.section,
    persistedSection: resolved.persistedSection,
    persistedData: resolved.persistedData,
    ...shapeRuntimeReloadFeedback(projectId, saveResult),
    change: {
      resourceId: input.section,
      before: existing[resolved.persistedSection as keyof DomainConfig],
      after: resolved.persistedData,
      reversible: true,
    },
  };
}

function saveJobsConfig(
  projectId: string,
  data: unknown,
  actor: string,
): SaveConfigCommandResult {
  if (!Array.isArray(data)) {
    return { ok: false, status: 400, error: "jobs: data must be an array" };
  }

  const globalConfig = readGlobalConfigViaService();
  const grouped = new Map<string, Record<string, Record<string, unknown>>>();
  const payloadAgentIds = new Set<string>();
  const projectAgentIds = new Set(getProjectAgentIds(projectId));

  for (const [index, item] of data.entries()) {
    if (!isPlainObject(item)) {
      return { ok: false, status: 400, error: `jobs[${index}] must be an object` };
    }

    const agentId = readStringBody(item, "agent");
    const jobId = readStringBody(item, "id");
    if (!agentId || !jobId) {
      return { ok: false, status: 400, error: `jobs[${index}] must include id and agent` };
    }
    payloadAgentIds.add(agentId);

    const entry = getAgentConfig(agentId);
    if (!entry || entry.projectId !== projectId) {
      return { ok: false, status: 404, error: `Agent "${agentId}" is not registered in project "${projectId}"` };
    }

    const jobName = parseDashboardJobName(jobId);
    const globalAgent = globalConfig.agents?.[agentId] as Record<string, unknown> | undefined;
    const existingJobs = (globalAgent?.jobs && typeof globalAgent.jobs === "object")
      ? globalAgent.jobs as Record<string, unknown>
      : {};
    const existingJob = existingJobs[jobName];
    const nextJobs = grouped.get(agentId) ?? {};

    const current = isPlainObject(existingJob) ? existingJob as Record<string, unknown> : {};
    nextJobs[jobName] = {
      ...current,
      cron: typeof item.cron === "string" ? item.cron : (current.cron as string | undefined),
      enabled: typeof item.enabled === "boolean" ? item.enabled : current.enabled ?? true,
      ...(typeof item.description === "string"
        ? { description: item.description }
        : current.description !== undefined
          ? { description: current.description }
          : {}),
    };

    grouped.set(agentId, nextJobs);
  }

  const persistedAgentIds = new Set<string>([
    ...Array.from(projectAgentIds).filter((agentId) => !!globalConfig.agents?.[agentId]),
    ...payloadAgentIds,
  ]);

  for (const agentId of persistedAgentIds) {
    const jobs = grouped.get(agentId) ?? {};
    const result = updateGlobalAgentConfig(agentId, { jobs }, actor);
    if (!result.ok) {
      return { ok: false, status: 400, error: result.error ?? `Failed to update jobs for "${agentId}"` };
    }
  }

  const reloadResult = reloadDomainRuntimesViaService(collectImpactedProjectIds(projectId, persistedAgentIds));
  logReloadErrors("app.commands.configSave.jobs", reloadResult);

  return {
    ok: true,
    section: "jobs",
    persistedSection: "jobs",
    persistedData: data,
    ...shapeRuntimeReloadFeedback(projectId, reloadResult),
  };
}

function saveAgentsConfig(
  projectId: string,
  data: unknown,
  actor: string,
): SaveConfigCommandResult {
  const agents = normalizeAgentConfigInput(data);
  const rawGlobalConfig = readGlobalConfigViaService();
  const upserts: Record<string, Record<string, unknown>> = {};
  const domainAgentIds: string[] = [];

  for (const [index, item] of agents.entries()) {
    const agentId = readStringBody(item, "id");
    if (!agentId) {
      return { ok: false, status: 400, error: `agents[${index}].id must be a non-empty string` };
    }

    const existingRuntime = getAgentConfig(agentId);
    if (existingRuntime && existingRuntime.projectId !== projectId) {
      return {
        ok: false,
        status: 409,
        error: `Agent "${agentId}" belongs to project "${existingRuntime.projectId}", not "${projectId}"`,
      };
    }

    const existingRaw = rawGlobalConfig.agents?.[agentId];
    upserts[agentId] = canonicalizeDashboardAgentConfig(item, existingRaw);
    domainAgentIds.push(agentId);
  }

  const agentResult = upsertGlobalAgents(upserts, actor);
  if (!agentResult.ok) {
    return { ok: false, status: 400, error: agentResult.error ?? "Failed to update agent config" };
  }

  const domainResult = saveDomainConfigSectionViaService(
    projectId,
    "agents",
    domainAgentIds,
    actor,
    { reload: "none" },
  );
  if (!domainResult.ok) {
    return { ok: false, status: 400, error: domainResult.error ?? "Failed to update domain agents list" };
  }

  const reloadResult = reloadDomainRuntimesViaService(collectImpactedProjectIds(projectId, Object.keys(upserts)));
  logReloadErrors("app.commands.configSave.agents", reloadResult);

  return {
    ok: true,
    section: "agents",
    persistedSection: "agents",
    persistedData: domainAgentIds,
    ...shapeRuntimeReloadFeedback(projectId, reloadResult),
  };
}

function saveBudgetConfig(
  projectId: string,
  data: unknown,
  existingDomain: DomainConfig,
  actor: string,
): SaveConfigCommandResult {
  if (!isPlainObject(data)) {
    return { ok: false, status: 400, error: "budget: data must be an object" };
  }

  const profile = typeof data.operational_profile === "string"
    ? data.operational_profile.trim() || undefined
    : undefined;
  const initiatives = isPlainObject(data.initiatives)
    ? data.initiatives as Record<string, unknown>
    : undefined;

  const budgetData = { ...data };
  delete budgetData.operational_profile;
  delete budgetData.initiatives;

  const budgetResult = saveDomainConfigSectionViaService(
    projectId,
    "budget",
    budgetData,
    actor,
    { reload: "none" },
  );
  if (!budgetResult.ok) {
    return { ok: false, status: 400, error: budgetResult.error ?? "Failed to update budget config" };
  }

  if (profile !== undefined) {
    const profileResult = saveDomainConfigSectionViaService(
      projectId,
      "operational_profile",
      profile,
      actor,
      { reload: "none" },
    );
    if (!profileResult.ok) {
      return { ok: false, status: 400, error: profileResult.error ?? "Failed to update operational profile" };
    }
  }

  if (initiatives !== undefined) {
    const goals = canonicalizeBudgetInitiatives(initiatives, existingDomain.goals);
    const initiativesResult = saveDomainConfigSectionViaService(
      projectId,
      "goals",
      goals,
      actor,
      { reload: "none" },
    );
    if (!initiativesResult.ok) {
      return { ok: false, status: 400, error: initiativesResult.error ?? "Failed to update initiative allocations" };
    }
  }

  const reloadResult = reloadDomainRuntimesViaService([projectId]);
  logReloadErrors("app.commands.configSave.budget", reloadResult);

  return {
    ok: true,
    section: "budget",
    persistedSection: "budget",
    persistedData: budgetData,
    ...shapeRuntimeReloadFeedback(projectId, reloadResult),
  };
}

function resolveConfigSavePayload(
  projectId: string,
  section: string,
  data: unknown,
  existing: DomainConfig,
):
  | {
      ok: true;
      persistedSection: string;
      persistedData: unknown;
    }
  | {
      ok: false;
      status: number;
      error: string;
    } {
  if (section === "safety") {
    if (!isPlainObject(data)) return { ok: false, status: 400, error: "safety: data must be an object" };
    return {
      ok: true,
      persistedSection: "safety",
      persistedData: canonicalizeSafetyConfig(data),
    };
  }

  if (section === "profile") {
    if (!isPlainObject(data)) return { ok: false, status: 400, error: "profile: data must be an object" };
    const operationalProfile = data.operational_profile;
    if (operationalProfile !== undefined && typeof operationalProfile !== "string") {
      return { ok: false, status: 400, error: "profile.operational_profile must be a string" };
    }
    return {
      ok: true,
      persistedSection: "operational_profile",
      persistedData: operationalProfile,
    };
  }

  if (section === "initiatives") {
    if (!isPlainObject(data)) return { ok: false, status: 400, error: "initiatives: data must be an object" };
    return {
      ok: true,
      persistedSection: "goals",
      persistedData: canonicalizeInitiatives(data, existing.goals),
    };
  }

  if (section === "dashboard_assistant") {
    const assistantConfig = canonicalizeDashboardAssistantConfig(projectId, data);
    if (!assistantConfig.ok) {
      return { ok: false, status: 400, error: assistantConfig.error };
    }
    return {
      ok: true,
      persistedSection: "dashboard_assistant",
      persistedData: assistantConfig.value,
    };
  }

  return {
    ok: true,
    persistedSection: section,
    persistedData: data,
  };
}

function canonicalizeInitiatives(
  data: unknown,
  existingGoals: unknown,
): Record<string, unknown> {
  const initiatives = isPlainObject(data) ? data : {};
  const priorGoals = isPlainObject(existingGoals) ? existingGoals : {};
  const nextGoals: Record<string, unknown> = {};

  for (const [goalId, goalValue] of Object.entries(priorGoals)) {
    if (isPlainObject(goalValue)) {
      nextGoals[goalId] = { ...goalValue };
    } else {
      nextGoals[goalId] = goalValue;
    }
  }

  for (const [goalId, value] of Object.entries(initiatives)) {
    if (!isPlainObject(value)) continue;
    const allocation = (value as Record<string, unknown>).allocation_pct;
    const existing = isPlainObject(nextGoals[goalId]) ? nextGoals[goalId] as Record<string, unknown> : {};
    nextGoals[goalId] = {
      ...existing,
      ...(typeof allocation === "number" ? { allocation } : {}),
    };
  }

  for (const goalId of Object.keys(nextGoals)) {
    if (goalId in initiatives) continue;
    if (!isPlainObject(nextGoals[goalId])) continue;
    const current = { ...(nextGoals[goalId] as Record<string, unknown>) };
    if ("allocation" in current) {
      delete current.allocation;
      nextGoals[goalId] = current;
    }
  }

  return nextGoals;
}

function canonicalizeBudgetInitiatives(
  data: Record<string, unknown>,
  existingGoals: unknown,
): Record<string, unknown> {
  const shaped: Record<string, { allocation_pct: number }> = {};
  for (const [goalId, allocation] of Object.entries(data)) {
    if (typeof allocation !== "number") continue;
    shaped[goalId] = { allocation_pct: allocation };
  }
  return canonicalizeInitiatives(shaped, existingGoals);
}

function canonicalizeDashboardAssistantConfig(
  projectId: string,
  data: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainObject(data)) {
    return { ok: false, error: "dashboard_assistant: data must be an object" };
  }

  const config: Record<string, unknown> = {};

  if (data.enabled !== undefined) {
    if (typeof data.enabled !== "boolean") {
      return { ok: false, error: "dashboard_assistant.enabled must be a boolean" };
    }
    config.enabled = data.enabled;
  }

  if (data.model !== undefined) {
    if (typeof data.model !== "string") {
      return { ok: false, error: "dashboard_assistant.model must be a string" };
    }
    const model = data.model.trim();
    if (model) config.model = model;
  }

  if (data.agentId !== undefined) {
    if (typeof data.agentId !== "string") {
      return { ok: false, error: "dashboard_assistant.agentId must be a string" };
    }
    const agentId = data.agentId.trim();
    if (agentId) {
      const entry = getAgentConfig(agentId);
      if (!entry || entry.projectId !== projectId) {
        return { ok: false, error: "dashboard_assistant.agentId must reference an agent in this domain" };
      }
      config.agentId = agentId;
    }
  }

  return { ok: true, value: config };
}

function getProjectAgentIds(projectId: string): string[] {
  try {
    return getRegisteredAgentIds().filter((agentId) => {
      const entry = getAgentConfig(agentId);
      return entry?.projectId === projectId;
    });
  } catch {
    return [];
  }
}

function collectImpactedProjectIds(projectId: string, agentIds: Iterable<string>): string[] {
  const impacted = new Set<string>([projectId]);
  for (const agentId of agentIds) {
    for (const domainId of getAgentDomains(agentId)) {
      impacted.add(domainId);
    }
  }
  return [...impacted];
}

function logReloadErrors(scope: string, result: { errors: string[] }): void {
  if (result.errors.length > 0) {
    safeLog(scope, result.errors.join("; "));
  }
}

function shapeRuntimeReloadFeedback(
  projectId: string,
  result: { warnings?: string[]; errors?: string[] },
): {
  warnings?: string[];
  reloadErrors?: string[];
  runtimeReload?: ReturnType<typeof getDomainRuntimeReloadStatus>;
} {
  const runtimeReload = getDomainRuntimeReloadStatus(projectId);
  return {
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.errors && result.errors.length > 0 ? { reloadErrors: result.errors } : {}),
    ...(runtimeReload ? { runtimeReload } : {}),
  };
}

function canonicalizeDashboardAgentConfig(
  item: Record<string, unknown>,
  existingRaw: unknown,
): Record<string, unknown> {
  const current = isPlainObject(existingRaw) ? { ...existingRaw } : {};
  const next: Record<string, unknown> = { ...current };

  assignOptionalString(next, "extends", item.extends);
  assignOptionalString(next, "title", item.title);
  assignOptionalString(next, "persona", item.persona);
  assignOptionalString(next, "reports_to", item.reports_to);
  assignOptionalString(next, "department", item.department);
  assignOptionalString(next, "team", item.team);
  assignOptionalString(next, "channel", item.channel);
  assignOptionalString(next, "runtime_ref", item.runtimeRef ?? item.runtime_ref);

  if (hasDashboardRuntimeInput(item)) {
    const nextRuntime = mergeAgentRuntimeConfig(
      normalizeConfiguredAgentRuntime(current),
      normalizeConfiguredAgentRuntime(item),
    );
    clearDashboardRuntimeAliases(next);
    if (nextRuntime) {
      next.runtime = nextRuntime;
    } else {
      delete next.runtime;
    }
  }

  if (Array.isArray(item.briefing)) {
    next.briefing = reconcileDashboardBriefing(
      item.briefing as unknown[],
      Array.isArray(current.briefing) ? current.briefing : [],
    );
  }

  if (Array.isArray(item.expectations)) {
    next.expectations = reconcileDashboardExpectations(
      item.expectations as unknown[],
      Array.isArray(current.expectations) ? current.expectations : [],
    );
  }

  if (isPlainObject(item.performance_policy)) {
    next.performance_policy = { ...item.performance_policy };
  }

  return next;
}

function hasDashboardRuntimeInput(item: Record<string, unknown>): boolean {
  return [
    "runtime",
    "bootstrapConfig",
    "bootstrap_config",
    "bootstrapExcludeFiles",
    "bootstrap_exclude_files",
    "allowedTools",
    "allowed_tools",
    "workspacePaths",
    "workspace_paths",
  ].some((key) => Object.prototype.hasOwnProperty.call(item, key));
}

function clearDashboardRuntimeAliases(target: Record<string, unknown>): void {
  delete target.bootstrapConfig;
  delete target.bootstrap_config;
  delete target.bootstrapExcludeFiles;
  delete target.bootstrap_exclude_files;
  delete target.allowedTools;
  delete target.allowed_tools;
  delete target.workspacePaths;
  delete target.workspace_paths;
}

function assignOptionalString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      delete target[key];
      return;
    }
    target[key] = trimmed;
    return;
  }
  if (value === null) {
    delete target[key];
  }
}

function reconcileDashboardBriefing(
  input: unknown[],
  existing: unknown[],
): unknown[] {
  const pool = [...existing];
  return input
    .map((entry) => {
      if (typeof entry !== "string") return entry;
      const index = pool.findIndex((candidate) => renderContextSourceLabel(candidate) === entry);
      if (index !== -1) {
        return pool.splice(index, 1)[0]!;
      }
      return parseDashboardBriefingEntry(entry);
    })
    .filter((entry) => entry !== null);
}

function reconcileDashboardExpectations(
  input: unknown[],
  existing: unknown[],
): unknown[] {
  const pool = [...existing];
  return input
    .map((entry) => {
      if (typeof entry !== "string") return entry;
      const index = pool.findIndex((candidate) => renderExpectationLabel(candidate) === entry);
      if (index !== -1) {
        return pool.splice(index, 1)[0]!;
      }
      return parseDashboardExpectation(entry);
    })
    .filter((entry) => entry !== null);
}

function renderContextSourceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  const source = typeof value.source === "string" ? value.source : "";
  if (!source) return "";
  if (source === "file" && typeof value.path === "string" && value.path.trim()) {
    return `file: ${value.path.trim()}`;
  }
  if (source === "custom_stream" && typeof value.streamName === "string" && value.streamName.trim()) {
    return `custom_stream: ${value.streamName.trim()}`;
  }
  return source;
}

function parseDashboardBriefingEntry(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileMatch = trimmed.match(/^file:\s*(.+)$/i);
  if (fileMatch?.[1]?.trim()) {
    return { source: "file", path: fileMatch[1].trim() };
  }

  const streamMatch = trimmed.match(/^custom_stream:\s*(.+)$/i);
  if (streamMatch?.[1]?.trim()) {
    return { source: "custom_stream", streamName: streamMatch[1].trim() };
  }

  return { source: trimmed };
}

function renderExpectationLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  const tool = typeof value.tool === "string" ? value.tool : "";
  if (!tool) return "";
  const action = Array.isArray(value.action)
    ? value.action.map(String).join(", ")
    : typeof value.action === "string"
      ? value.action
      : "";
  const minCalls = typeof value.min_calls === "number" ? value.min_calls : 1;
  return `${tool}${action ? `: ${action}` : ""} (min: ${minCalls})`;
}

function parseDashboardExpectation(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withMin = trimmed.match(/^(.*?)(?:\s+\(min:\s*(\d+)\))$/);
  const body = withMin?.[1]?.trim() ?? trimmed;
  const minCalls = withMin?.[2] ? Number.parseInt(withMin[2], 10) : 1;

  const colonIndex = body.indexOf(":");
  const tool = (colonIndex === -1 ? body : body.slice(0, colonIndex)).trim();
  if (!tool) return null;

  const actionText = colonIndex === -1 ? "" : body.slice(colonIndex + 1).trim();
  let action: string | string[] = "";
  if (actionText.length > 0) {
    const actions = actionText.split(",").map((part) => part.trim()).filter(Boolean);
    action = actions.length > 1 ? actions : actions[0] ?? "";
  }

  return {
    tool,
    action,
    min_calls: Number.isFinite(minCalls) ? minCalls : 1,
  };
}

function readStringBody(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseDashboardJobName(id: string): string {
  const idx = id.lastIndexOf(":");
  return idx === -1 ? id : id.slice(idx + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
