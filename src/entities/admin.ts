import type { DatabaseSync } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { buildAttentionSummary, buildDecisionInboxSummary } from "../attention/builder.js";
import type { AttentionItem } from "../attention/types.js";
import { getProposal, markProposalExecutionPending } from "../approval/resolve.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import type {
  ClawforceEvent,
  Entity,
  EntityCheckRun,
  EntityIssue,
  EntityIssueSummary,
  EventStatus,
  SimulatedAction,
  Task,
  TaskState,
  WorkflowMutationProposalSnapshot,
} from "../types.js";
import { recordChange } from "../history/store.js";
import { listEntityCheckRuns } from "./checks.js";
import {
  getEntity,
  getEntityIssue,
  getEntityTransitions,
  listEntityIssues,
  summarizeEntityIssues,
  syncEntityHealthFromIssues,
} from "./ops.js";
import { ensureIssueRemediationTask } from "./remediation.js";
import { createTask, getTask, listTasks, transitionTask } from "../tasks/ops.js";
import { listSimulatedActions } from "../execution/simulated-actions.js";
import { listEvents as listProjectEvents, countEvents as countProjectEvents } from "../events/store.js";
import { maybeNormalizeWorkflowMutationImplementationTask } from "../workflow-mutation/implementation.js";

const TERMINAL_TASK_STATES = new Set<TaskState>(["DONE", "FAILED", "CANCELLED"]);
const REPLAYABLE_WORKFLOW_MUTATION_TASK_STATES = new Set<TaskState>(["DONE", "FAILED", "CANCELLED", "BLOCKED"]);
const EVENT_STATUSES: EventStatus[] = ["pending", "processing", "handled", "failed", "ignored"];

export type EntityExperimentSnapshot = {
  projectId: string;
  entityId: string;
  generatedAt: number;
  entity: Entity;
  issueSummary: EntityIssueSummary;
  issues: EntityIssue[];
  transitions: ReturnType<typeof getEntityTransitions>;
  tasks: Task[];
  reactiveTasks: Task[];
  checkRuns: EntityCheckRun[];
  simulatedActions: SimulatedAction[];
  feedItems: AttentionItem[];
  decisionItems: AttentionItem[];
  events: {
    counts: Record<EventStatus, number>;
    items: ClawforceEvent[];
  };
};

export type EntityExperimentSnapshotView = {
  projectId: string;
  entityId: string;
  generatedAt: number;
  entity: Entity;
  issueSummary: EntityIssueSummary & {
    resolvedCount?: number;
  };
  issues: Array<{
    id: string;
    issueType: string;
    checkId?: string;
    severity: EntityIssue["severity"];
    status: EntityIssue["status"];
    title: string;
    description?: string;
    fieldName?: string;
    blocking: boolean;
    approvalRequired: boolean;
    playbook?: string;
    ownerAgentId?: string;
    recommendedAction?: string;
    evidenceSummary?: string;
    evidence?: Record<string, unknown>;
    firstSeenAt: number;
    lastSeenAt: number;
    resolvedAt?: number;
  }>;
  transitions: ReturnType<typeof getEntityTransitions>;
  tasks: Array<{
    id: string;
    title: string;
    state: TaskState;
    assignedTo?: string;
    priority: Task["priority"];
    updatedAt: number;
    origin?: Task["origin"];
    originId?: string;
    stale?: boolean;
    metadata?: Record<string, unknown>;
  }>;
  reactiveTasks: Array<{
    id: string;
    title: string;
    state: TaskState;
    assignedTo?: string;
    priority: Task["priority"];
    updatedAt: number;
    stale?: boolean;
    issueId?: string;
    issueType?: string;
    playbook?: string;
    rerunCheckIds?: string[];
  }>;
  checkRuns: Array<{
    id: string;
    checkId: string;
    status: EntityCheckRun["status"];
    issueCount: number;
    exitCode: number;
    durationMs: number;
    createdAt: number;
    stderrSummary?: string;
    stdoutSummary?: string;
    stderr?: string;
    stdout?: string;
  }>;
  simulatedActions: Array<{
    id: string;
    actionType: string;
    status: SimulatedAction["status"];
    policyDecision: SimulatedAction["policyDecision"];
    summary: string;
    createdAt: number;
    targetType?: string;
    targetId?: string;
    payload?: Record<string, unknown>;
  }>;
  feedItems: Array<AttentionItem & { evidenceSummary?: string }>;
  decisionItems: Array<AttentionItem & { evidenceSummary?: string }>;
  events: {
    counts: Record<EventStatus, number>;
    items: Array<{
      id: string;
      type: string;
      status: EventStatus;
      source: ClawforceEvent["source"];
      createdAt: number;
      processedAt?: number;
      handledBy?: string;
      error?: string;
      payloadSummary?: string;
      payload?: Record<string, unknown>;
    }>;
  };
};

export type EventQueueSnapshot = {
  projectId: string;
  counts: Record<EventStatus, number>;
  items: ClawforceEvent[];
  generatedAt: number;
  focus: EventQueueFocus;
};

export type EventQueueFocus = "all" | "actionable" | "entity" | "dispatch" | "budget" | "task" | "simulation";

export type EventQueueSnapshotView = {
  projectId: string;
  generatedAt: number;
  counts: Record<EventStatus, number>;
  focus: EventQueueFocus;
  items: Array<{
    id: string;
    type: string;
    status: EventStatus;
    source: ClawforceEvent["source"];
    createdAt: number;
    processedAt?: number;
    handledBy?: string;
    error?: string;
    payloadSummary?: string;
    payload?: Record<string, unknown>;
  }>;
};

function truncate(value: string, max = 180): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function summarizeUnknown(value: unknown, max = 180): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return undefined;
  }
}

function summarizeIssueEvidence(issue: EntityIssue): string | undefined {
  const evidence = issue.evidence;
  if (!evidence) return undefined;
  const issueRecord = typeof evidence.issue === "object" && evidence.issue !== null && !Array.isArray(evidence.issue)
    ? evidence.issue as Record<string, unknown>
    : null;
  const record = typeof evidence.record === "object" && evidence.record !== null && !Array.isArray(evidence.record)
    ? evidence.record as Record<string, unknown>
    : null;
  const message = typeof issueRecord?.message === "string" ? issueRecord.message : undefined;
  const verdict = typeof record?.verdict === "string" ? record.verdict : undefined;
  const field = issue.fieldName || (typeof issueRecord?.field === "string" ? issueRecord.field : undefined);
  const bits = [
    message,
    field ? `field=${field}` : undefined,
    verdict ? `verdict=${verdict}` : undefined,
  ].filter(Boolean);
  return bits.length > 0 ? truncate(bits.join(" | ")) : summarizeUnknown(evidence);
}

function summarizeEventPayload(event: ClawforceEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const candidates = [
    typeof payload.message === "string" ? payload.message : undefined,
    typeof payload.reason === "string" ? payload.reason : undefined,
    typeof payload.error === "string" ? payload.error : undefined,
    typeof payload.issueType === "string" ? `issue=${payload.issueType}` : undefined,
    typeof payload.taskId === "string" ? `task=${payload.taskId}` : undefined,
    typeof payload.entityId === "string" ? `entity=${payload.entityId}` : undefined,
  ].filter(Boolean);
  return candidates.length > 0 ? truncate(candidates.join(" | ")) : summarizeUnknown(payload);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function parseWorkflowMutationSnapshot(raw: string | null | undefined): WorkflowMutationProposalSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkflowMutationProposalSnapshot;
  } catch {
    return null;
  }
}

function getWorkflowMutationAffectedIssueIds(
  snapshot: WorkflowMutationProposalSnapshot | null | undefined,
  metadata?: Record<string, unknown> | null,
): string[] {
  const stewardTask = asRecord(snapshot?.stewardTask);
  const stewardMetadata = asRecord(stewardTask?.metadata);
  return Array.from(new Set([
    typeof snapshot?.sourceIssueId === "string" ? snapshot.sourceIssueId : null,
    typeof metadata?.sourceIssueId === "string" ? metadata.sourceIssueId : null,
    ...asStringArray(snapshot?.affectedIssueIds),
    ...asStringArray(stewardMetadata?.affectedIssueIds),
    ...asStringArray(metadata?.affectedIssueIds),
  ].filter((issueId): issueId is string => Boolean(issueId))));
}

function inferEventFocuses(event: ClawforceEvent): Set<EventQueueFocus> {
  const focuses = new Set<EventQueueFocus>(["all"]);
  const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const type = event.type;

  if (type.startsWith("entity_") || typeof payload.entityId === "string" || typeof payload.issueId === "string") {
    focuses.add("entity");
  }
  if (type.startsWith("dispatch_")) {
    focuses.add("dispatch");
  }
  if (type.startsWith("task_") || typeof payload.taskId === "string") {
    focuses.add("task");
  }
  if (type.startsWith("budget_")) {
    focuses.add("budget");
  }
  if (type.startsWith("simulated_") || typeof payload.simulatedActionId === "string") {
    focuses.add("simulation");
  }

  const lowSignal = focuses.has("budget") && !focuses.has("entity") && !focuses.has("dispatch") && !focuses.has("task");
  if (!lowSignal || event.status === "failed") {
    focuses.add("actionable");
  }

  return focuses;
}

function matchesEventFocus(event: ClawforceEvent, focus: EventQueueFocus): boolean {
  if (focus === "all") return true;
  return inferEventFocuses(event).has(focus);
}

function eventTypePriority(event: ClawforceEvent): number {
  const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  if (event.type === "dispatch_failed") return 0;
  if (event.type.startsWith("entity_issue_")) return 10;
  if (event.type.startsWith("entity_")) return 20;
  if (event.type.startsWith("dispatch_")) return 30;
  if (event.type.startsWith("proposal_")) return 40;
  if (event.type.startsWith("simulated_") || typeof payload.simulatedActionId === "string") return 50;
  if (event.type.startsWith("task_")) return 60;
  if (event.type.startsWith("budget_")) return 200;
  return 100;
}

function eventStatusPriority(event: ClawforceEvent): number {
  switch (event.status) {
    case "failed":
      return 0;
    case "processing":
      return 1;
    case "pending":
      return 2;
    case "handled":
      return 3;
    case "ignored":
      return 4;
    default:
      return 9;
  }
}

function compareEventsForOperatorView(a: ClawforceEvent, b: ClawforceEvent): number {
  const aFocuses = inferEventFocuses(a);
  const bFocuses = inferEventFocuses(b);
  const aLowSignal = aFocuses.has("budget") && !aFocuses.has("entity") && !aFocuses.has("dispatch") && !aFocuses.has("task");
  const bLowSignal = bFocuses.has("budget") && !bFocuses.has("entity") && !bFocuses.has("dispatch") && !bFocuses.has("task");
  if (aLowSignal !== bLowSignal) {
    return aLowSignal ? 1 : -1;
  }

  const statusDelta = eventStatusPriority(a) - eventStatusPriority(b);
  if (statusDelta !== 0) return statusDelta;

  const typeDelta = eventTypePriority(a) - eventTypePriority(b);
  if (typeDelta !== 0) return typeDelta;

  return b.createdAt - a.createdAt;
}

function compactAttentionItem(item: AttentionItem, full: boolean): AttentionItem & { evidenceSummary?: string } {
  const evidenceSummary = summarizeUnknown(item.evidence);
  return {
    ...item,
    evidence: full ? item.evidence : undefined,
    evidenceSummary: full ? undefined : evidenceSummary,
  };
}

export function shapeEventQueueSnapshot(
  snapshot: EventQueueSnapshot,
  options?: { full?: boolean },
): EventQueueSnapshotView {
  const full = options?.full === true;
  return {
    projectId: snapshot.projectId,
    generatedAt: snapshot.generatedAt,
    counts: snapshot.counts,
    focus: snapshot.focus,
    items: snapshot.items.map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      source: event.source,
      createdAt: event.createdAt,
      processedAt: event.processedAt,
      handledBy: event.handledBy,
      error: event.error,
      payloadSummary: full ? undefined : summarizeEventPayload(event),
      payload: full ? event.payload : undefined,
    })),
  };
}

export function shapeEntityExperimentSnapshot(
  snapshot: EntityExperimentSnapshot,
  options?: {
    full?: boolean;
    includeResolvedIssues?: boolean;
  },
): EntityExperimentSnapshotView {
  const full = options?.full === true;
  const includeResolvedIssues = options?.includeResolvedIssues === true;
  const visibleIssues = includeResolvedIssues
    ? snapshot.issues
    : snapshot.issues.filter((issue) => issue.status === "open");
  const resolvedCount = snapshot.issues.filter((issue) => issue.status !== "open").length;

  return {
    projectId: snapshot.projectId,
    entityId: snapshot.entityId,
    generatedAt: snapshot.generatedAt,
    entity: snapshot.entity,
    issueSummary: {
      ...snapshot.issueSummary,
      resolvedCount,
    },
    issues: visibleIssues.map((issue) => ({
      id: issue.id,
      issueType: issue.issueType,
      checkId: issue.checkId,
      severity: issue.severity,
      status: issue.status,
      title: issue.title,
      description: issue.description,
      fieldName: issue.fieldName,
      blocking: issue.blocking,
      approvalRequired: issue.approvalRequired,
      playbook: issue.playbook,
      ownerAgentId: issue.ownerAgentId,
      recommendedAction: issue.recommendedAction,
      evidenceSummary: full ? undefined : summarizeIssueEvidence(issue),
      evidence: full ? issue.evidence : undefined,
      firstSeenAt: issue.firstSeenAt,
      lastSeenAt: issue.lastSeenAt,
      resolvedAt: issue.resolvedAt,
    })),
    transitions: snapshot.transitions,
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      assignedTo: task.assignedTo,
      priority: task.priority,
      updatedAt: task.updatedAt,
      origin: task.origin,
      originId: task.originId,
      stale: Boolean((task.metadata as Record<string, unknown> | undefined)?.stale),
      metadata: full ? task.metadata : undefined,
    })),
    reactiveTasks: snapshot.reactiveTasks.map((task) => {
      const issueMeta = typeof task.metadata === "object" && task.metadata !== null && !Array.isArray(task.metadata)
        ? (task.metadata as Record<string, unknown>).entityIssue as Record<string, unknown> | undefined
        : undefined;
      return {
        id: task.id,
        title: task.title,
        state: task.state,
        assignedTo: task.assignedTo,
        priority: task.priority,
        updatedAt: task.updatedAt,
        stale: Boolean((task.metadata as Record<string, unknown> | undefined)?.stale),
        issueId: typeof issueMeta?.issueId === "string" ? issueMeta.issueId : undefined,
        issueType: typeof issueMeta?.issueType === "string" ? issueMeta.issueType : undefined,
        playbook: typeof issueMeta?.playbook === "string" ? issueMeta.playbook : undefined,
        rerunCheckIds: Array.isArray(issueMeta?.rerunCheckIds)
          ? issueMeta!.rerunCheckIds!.filter((value): value is string => typeof value === "string")
          : undefined,
      };
    }),
    checkRuns: snapshot.checkRuns.map((run) => ({
      id: run.id,
      checkId: run.checkId,
      status: run.status,
      issueCount: run.issueCount,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      createdAt: run.createdAt,
      stderrSummary: full ? undefined : summarizeUnknown(run.stderr),
      stdoutSummary: full ? undefined : summarizeUnknown(run.stdout),
      stderr: full ? run.stderr : undefined,
      stdout: full ? run.stdout : undefined,
    })),
    simulatedActions: snapshot.simulatedActions.map((action) => ({
      id: action.id,
      actionType: action.actionType,
      status: action.status,
      policyDecision: action.policyDecision,
      summary: action.summary,
      createdAt: action.createdAt,
      targetType: action.targetType,
      targetId: action.targetId,
      payload: full ? action.payload : undefined,
    })),
    feedItems: snapshot.feedItems.map((item) => compactAttentionItem(item, full)),
    decisionItems: snapshot.decisionItems.map((item) => compactAttentionItem(item, full)),
    events: shapeEventQueueSnapshot({
      projectId: snapshot.projectId,
      generatedAt: snapshot.generatedAt,
      counts: snapshot.events.counts,
      items: snapshot.events.items,
      focus: "all",
    }, { full }),
  };
}

function relatesToEntity(
  event: ClawforceEvent,
  entityId: string,
  issueIds: Set<string>,
  taskIds: Set<string>,
): boolean {
  const payload = event.payload as Record<string, unknown>;
  const payloadEntityId = typeof payload.entityId === "string"
    ? payload.entityId
    : typeof payload.entity_id === "string"
      ? payload.entity_id
      : undefined;
  if (payloadEntityId === entityId) return true;

  const payloadIssueId = typeof payload.issueId === "string"
    ? payload.issueId
    : typeof payload.issue_id === "string"
      ? payload.issue_id
      : undefined;
  if (payloadIssueId && issueIds.has(payloadIssueId)) return true;

  const payloadTaskId = typeof payload.taskId === "string"
    ? payload.taskId
    : typeof payload.task_id === "string"
      ? payload.task_id
      : undefined;
  if (payloadTaskId && taskIds.has(payloadTaskId)) return true;

  return false;
}

export function collectProjectEventQueueSnapshot(
  projectId: string,
  options?: {
    status?: EventStatus;
    type?: string;
    limit?: number;
    focus?: EventQueueFocus;
  },
  dbOverride?: DatabaseSync,
): EventQueueSnapshot {
  const db = dbOverride ?? getDb(projectId);
  const requestedLimit = Number.isFinite(options?.limit) ? Math.max(1, options!.limit!) : 50;
  const focus = options?.focus ?? "all";
  const counts = Object.fromEntries(
    EVENT_STATUSES.map((status) => [status, countProjectEvents(projectId, { status }, db)]),
  ) as Record<EventStatus, number>;
  const items = listProjectEvents(projectId, {
    status: options?.status,
    type: options?.type,
    limit: Math.min(Math.max(requestedLimit * 5, 100), 500),
  }, db)
    .filter((event) => matchesEventFocus(event, focus))
    .sort(compareEventsForOperatorView)
    .slice(0, requestedLimit);

  return {
    projectId,
    counts,
    items,
    generatedAt: Date.now(),
    focus,
  };
}

export function collectEntityExperimentSnapshot(
  projectId: string,
  entityId: string,
  options?: {
    issueLimit?: number;
    taskLimit?: number;
    checkRunLimit?: number;
    eventLimit?: number;
    simulatedActionLimit?: number;
  },
  dbOverride?: DatabaseSync,
): EntityExperimentSnapshot {
  const db = dbOverride ?? getDb(projectId);
  const entity = getEntity(projectId, entityId, db);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  const issues = listEntityIssues(projectId, {
    entityId,
    limit: options?.issueLimit ?? 100,
  }, db);
  const issueSummary = summarizeEntityIssues(projectId, entityId, db);
  const tasks = listTasks(projectId, {
    entityId,
    limit: options?.taskLimit ?? 200,
  }, db);
  const reactiveTasks = tasks.filter((task) => task.origin === "reactive");
  const taskIds = new Set(tasks.map((task) => task.id));
  const issueIds = new Set(issues.map((issue) => issue.id));
  const checkRuns = listEntityCheckRuns(projectId, entityId, options?.checkRunLimit ?? 20, db);
  const simulatedActions = listSimulatedActions(projectId, {
    entityType: entity.kind,
    entityId,
    limit: options?.simulatedActionLimit ?? 50,
  }, db);
  const transitions = getEntityTransitions(projectId, entityId, db).slice(-20);

  const feedItems = buildAttentionSummary(projectId, db).items.filter((item) =>
    item.entityId === entityId
      || (item.issueId ? issueIds.has(item.issueId) : false)
      || (item.taskId ? taskIds.has(item.taskId) : false)
      || (item.simulatedActionId ? simulatedActions.some((action) => action.id === item.simulatedActionId) : false));
  const decisionItems = buildDecisionInboxSummary(projectId, db).items.filter((item) =>
    item.entityId === entityId
      || (item.issueId ? issueIds.has(item.issueId) : false)
      || (item.taskId ? taskIds.has(item.taskId) : false)
      || (item.simulatedActionId ? simulatedActions.some((action) => action.id === item.simulatedActionId) : false));

  const eventQueue = collectProjectEventQueueSnapshot(projectId, {
    limit: Math.max(options?.eventLimit ?? 50, 100),
  }, db);
  const relatedEvents = eventQueue.items
    .filter((event) => relatesToEntity(event, entityId, issueIds, taskIds))
    .slice(0, options?.eventLimit ?? 25);

  return {
    projectId,
    entityId,
    generatedAt: Date.now(),
    entity,
    issueSummary,
    issues,
    transitions,
    tasks,
    reactiveTasks,
    checkRuns,
    simulatedActions,
    feedItems,
    decisionItems,
    events: {
      counts: eventQueue.counts,
      items: relatedEvents,
    },
  };
}

export function reopenEntityIssue(
  params: {
    projectId: string;
    issueId: string;
    actor: string;
    reason?: string;
  },
  dbOverride?: DatabaseSync,
): EntityIssue {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getEntityIssue(params.projectId, params.issueId, db);
  if (!current) throw new Error(`Entity issue not found: ${params.issueId}`);
  if (current.status === "open") return current;

  const now = Date.now();
  db.prepare(`
    UPDATE entity_issues
    SET status = 'open', proposal_id = NULL, resolved_at = NULL, last_seen_at = ?
    WHERE id = ? AND project_id = ?
  `).run(now, params.issueId, params.projectId);

  const issue = getEntityIssue(params.projectId, params.issueId, db)!;
  syncEntityHealthFromIssues(params.projectId, issue.entityId, db);

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "entity.issue.reopen",
      targetType: "entity_issue",
      targetId: issue.id,
      detail: params.reason ?? `${current.status} -> open`,
    }, db);
  } catch (err) {
    safeLog("entity.issue.reopen.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity_issue",
      resourceId: issue.id,
      action: "reopen",
      provenance: "human",
      actor: params.actor,
      before: current,
      after: issue,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.issue.reopen.history", err);
  }

  return issue;
}

export function clearEntityCheckRuns(
  params: {
    projectId: string;
    entityId: string;
    actor: string;
  },
  dbOverride?: DatabaseSync,
): { cleared: number } {
  const db = dbOverride ?? getDb(params.projectId);
  const entity = getEntity(params.projectId, params.entityId, db);
  if (!entity) throw new Error(`Entity not found: ${params.entityId}`);

  const row = db.prepare(`
    SELECT COUNT(*) AS total, MAX(created_at) AS latest_created_at
    FROM entity_check_runs
    WHERE project_id = ? AND entity_id = ?
  `).get(params.projectId, params.entityId) as Record<string, unknown> | undefined;
  const total = Number(row?.total ?? 0);
  if (total === 0) return { cleared: 0 };

  db.prepare(`
    DELETE FROM entity_check_runs
    WHERE project_id = ? AND entity_id = ?
  `).run(params.projectId, params.entityId);

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "entity.check_runs.clear",
      targetType: "entity",
      targetId: params.entityId,
      detail: `${total} run(s) cleared`,
    }, db);
  } catch (err) {
    safeLog("entity.checkRuns.clear.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity_check_runs",
      resourceId: params.entityId,
      action: "delete",
      provenance: "human",
      actor: params.actor,
      before: {
        count: total,
        latestCreatedAt: row?.latest_created_at ?? null,
      },
      after: { count: 0 },
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.checkRuns.clear.history", err);
  }

  return { cleared: total };
}

export function replayWorkflowMutationImplementationTask(
  params: {
    projectId: string;
    taskId: string;
    actor: string;
    reason?: string;
  },
  dbOverride?: DatabaseSync,
): {
  replayedTaskId: string;
  previousTaskId: string;
  proposalId: string;
  sourceTaskId: string;
  sourceIssueId?: string;
  created: boolean;
  relinkedIssue: boolean;
  relinkedSourceTask: boolean;
} {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getTask(params.projectId, params.taskId, db);
  if (!current) throw new Error(`Task not found: ${params.taskId}`);
  if (current.origin !== "lead_proposal" || !current.originId) {
    throw new Error(`Task ${params.taskId} is not a workflow-mutation proposal task`);
  }
  const currentMetadata = asRecord(current.metadata) ?? {};
  if (currentMetadata.workflowMutationStage !== "implementation") {
    throw new Error(`Task ${params.taskId} is not a workflow-mutation implementation task`);
  }
  if (!REPLAYABLE_WORKFLOW_MUTATION_TASK_STATES.has(current.state)) {
    throw new Error(`Task ${params.taskId} is still ${current.state}; replay only applies to blocked or terminal implementation tasks`);
  }
  const normalizedCurrent = maybeNormalizeWorkflowMutationImplementationTask(params.projectId, current, db);

  const proposal = getProposal(params.projectId, current.originId, db);
  if (!proposal || proposal.origin !== "workflow_mutation") {
    throw new Error(`Workflow-mutation proposal not found for task ${params.taskId}`);
  }
  if (proposal.status !== "approved") {
    throw new Error(`Workflow-mutation proposal ${proposal.id} is ${proposal.status}; only approved proposals can be replayed`);
  }

  const snapshot = parseWorkflowMutationSnapshot(proposal.approval_policy_snapshot);
  const sourceTaskId = typeof currentMetadata.sourceTaskId === "string"
    ? currentMetadata.sourceTaskId
    : (typeof snapshot?.sourceTaskId === "string" ? snapshot.sourceTaskId : undefined);
  if (!sourceTaskId) {
    throw new Error(`Workflow-mutation task ${params.taskId} is missing sourceTaskId`);
  }
  const sourceTask = getTask(params.projectId, sourceTaskId, db);
  if (!sourceTask) {
    throw new Error(`Workflow-mutation source task not found: ${sourceTaskId}`);
  }
  const sourceIssueId = typeof currentMetadata.sourceIssueId === "string"
    ? currentMetadata.sourceIssueId
    : (typeof snapshot?.sourceIssueId === "string" ? snapshot.sourceIssueId : undefined);
  const affectedIssueIds = getWorkflowMutationAffectedIssueIds(snapshot, currentMetadata);
  const reviewTaskId = typeof currentMetadata.reviewTaskId === "string"
    ? currentMetadata.reviewTaskId
    : undefined;
  const reasonCode = typeof currentMetadata.reasonCode === "string"
    ? currentMetadata.reasonCode
    : (typeof snapshot?.reasonCode === "string" ? snapshot.reasonCode : undefined);
  const mutationCategory = typeof currentMetadata.mutationCategory === "string"
    ? currentMetadata.mutationCategory
    : (typeof snapshot?.mutationCategory === "string" ? snapshot.mutationCategory : undefined);

  const existing = db.prepare(`
    SELECT id
    FROM tasks
    WHERE project_id = ?
      AND origin = 'lead_proposal'
      AND origin_id = ?
      AND json_extract(metadata, '$.workflowMutationStage') = 'implementation'
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED', 'BLOCKED')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(params.projectId, proposal.id) as { id?: string } | undefined;

  let replayTask = existing?.id ? getTask(params.projectId, existing.id, db) : null;
  let created = false;
  if (!replayTask) {
    const replayMetadata = { ...currentMetadata };
    delete replayMetadata.workflowMutationPostCondition;
    delete replayMetadata.stale;
    delete replayMetadata.dispatch_dead_letter;
    delete replayMetadata.dispatch_dead_letter_at;
    delete replayMetadata["$.dispatch_dead_letter"];
    delete replayMetadata["$.dispatch_dead_letter_at"];
    replayMetadata.workflowMutationStage = "implementation";
    replayMetadata.workflowMutationReplayOfTaskId = normalizedCurrent.id;
    replayMetadata.workflowMutationReplayRequestedAt = Date.now();
    replayMetadata.workflowMutationReplayReason = params.reason ?? "Admin replay of terminal workflow-mutation task";

    replayTask = createTask({
      projectId: params.projectId,
      title: normalizedCurrent.title,
      description: normalizedCurrent.description,
      priority: normalizedCurrent.priority,
      assignedTo: normalizedCurrent.assignedTo,
      createdBy: params.actor,
      deadline: normalizedCurrent.deadline,
      maxRetries: normalizedCurrent.maxRetries,
      tags: normalizedCurrent.tags,
      workflowId: normalizedCurrent.workflowId,
      workflowPhase: normalizedCurrent.workflowPhase,
      parentTaskId: normalizedCurrent.parentTaskId,
      department: normalizedCurrent.department,
      team: normalizedCurrent.team,
      goalId: normalizedCurrent.goalId,
      entityType: normalizedCurrent.entityType,
      entityId: normalizedCurrent.entityId,
      kind: normalizedCurrent.kind,
      origin: normalizedCurrent.origin,
      originId: normalizedCurrent.originId,
      metadata: replayMetadata,
    }, db);
    created = true;
  }

  markProposalExecutionPending(params.projectId, proposal.id, {
    taskId: replayTask.id,
  }, db);

  let relinkedIssue = false;
  const relinkIssueStatement = db.prepare(`
    UPDATE entity_issues
    SET proposal_id = ?, last_seen_at = ?
    WHERE project_id = ? AND id = ?
  `);
  for (const issueId of affectedIssueIds) {
    const issue = getEntityIssue(params.projectId, issueId, db);
    if (!issue) continue;
    relinkIssueStatement.run(proposal.id, Date.now(), params.projectId, issueId);
    relinkedIssue = true;
  }

  const sourceTaskMetadata = asRecord(sourceTask.metadata) ?? {};
  sourceTaskMetadata.workflowMutation = {
    status: "implementation_in_progress",
    followUpTaskId: replayTask.id,
    reviewTaskId: reviewTaskId ?? null,
    proposalId: proposal.id,
    reasonCode: reasonCode ?? null,
    mutationCategory: mutationCategory ?? null,
  };
  db.prepare(`
    UPDATE tasks
    SET metadata = ?, updated_at = ?
    WHERE project_id = ? AND id = ?
  `).run(JSON.stringify(sourceTaskMetadata), Date.now(), params.projectId, sourceTask.id);

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "workflow_mutation.replay",
      targetType: "task",
      targetId: replayTask.id,
      detail: `${current.id} -> ${replayTask.id}${params.reason ? ` | ${params.reason}` : ""}`,
    }, db);
  } catch (err) {
    safeLog("workflowMutation.replay.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "task",
      resourceId: replayTask.id,
      action: created ? "create" : "update",
      provenance: "human",
      actor: params.actor,
      before: created ? current : getTask(params.projectId, replayTask.id, db),
      after: replayTask,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("workflowMutation.replay.history", err);
  }

  return {
    replayedTaskId: replayTask.id,
    previousTaskId: current.id,
    proposalId: proposal.id,
    sourceTaskId: sourceTask.id,
    sourceIssueId,
    created,
    relinkedIssue,
    relinkedSourceTask: true,
  };
}

export function resetIssueRemediationTasks(
  params: {
    projectId: string;
    actor: string;
    entityId?: string;
    issueId?: string;
    reason?: string;
  },
  dbOverride?: DatabaseSync,
): {
  scope: "entity" | "issue";
  issueIds: string[];
  cancelledTaskIds: string[];
  recreatedTaskIds: string[];
} {
  const db = dbOverride ?? getDb(params.projectId);
  if (!params.entityId && !params.issueId) {
    throw new Error("resetIssueRemediationTasks requires entityId or issueId");
  }

  const issues = params.issueId
    ? [getEntityIssue(params.projectId, params.issueId, db)].filter((issue): issue is EntityIssue => Boolean(issue))
    : listEntityIssues(params.projectId, {
      entityId: params.entityId!,
      status: "open",
      limit: 1000,
    }, db);

  const issueIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const recreatedTaskIds: string[] = [];
  const reason = params.reason ?? "Admin reset of reactive remediation workflow";

  for (const issue of issues) {
    if (issue.status !== "open") continue;
    issueIds.push(issue.id);
    const tasks = listTasks(params.projectId, {
      origin: "reactive",
      originId: issue.id,
      limit: 1000,
    }, db);
    for (const task of tasks) {
      if (TERMINAL_TASK_STATES.has(task.state)) continue;
      const result = transitionTask({
        projectId: params.projectId,
        taskId: task.id,
        toState: "CANCELLED",
        actor: params.actor,
        reason,
      }, db);
      if (!result.ok) {
        throw new Error(`Failed to cancel remediation task ${task.id}: ${result.reason}`);
      }
      cancelledTaskIds.push(task.id);
    }

    const recreated = ensureIssueRemediationTask(params.projectId, issue.id, params.actor, db);
    if (recreated) {
      recreatedTaskIds.push(recreated.id);
    }
  }

  return {
    scope: params.issueId ? "issue" : "entity",
    issueIds,
    cancelledTaskIds,
    recreatedTaskIds,
  };
}
