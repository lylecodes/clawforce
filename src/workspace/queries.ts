/**
 * Clawforce — Dashboard V2 Workspace Queries
 *
 * Phase A read-only queries backing the v2 workspace shell. Every query
 * reuses existing framework sources of truth (workflow, tasks, attention)
 * rather than introducing parallel state.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { getWorkflow, getPhaseStatus, listWorkflows } from "../workflow.js";
import { isEmergencyStopActive } from "../safety.js";
import { buildAttentionSummary } from "../attention/builder.js";
import { queryDomainHealth } from "../app/queries/domain-monitoring.js";
import { getAgentConfig } from "../project.js";
import type { AttentionItem } from "../attention/types.js";
import type { Task, Workflow, WorkflowPhase } from "../types.js";
import {
  deriveStageKey,
  parseStageKey,
  type ProjectOperatorSummary,
  type ProjectWorkspace,
  type ScopedFeedItem,
  type ScopedWorkspaceFeed,
  type StageLiveState,
  type WorkflowLiveState,
  type WorkflowMiniTopology,
  type WorkflowStageEdge,
  type WorkflowStageInspector,
  type WorkflowStageInspectorTask,
  type WorkflowStageSummary,
  type WorkflowTopology,
  type WorkspaceScope,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type WorkflowScope = Extract<WorkspaceScope, { kind: "workflow" }>;

function resolveDb(projectId: string, dbOverride?: DatabaseSync): DatabaseSync | null {
  try {
    return dbOverride ?? getDb(projectId);
  } catch {
    return null;
  }
}

/**
 * Truthful, framework-owned count of tasks that are not in a terminal state.
 * Implemented as a pure SQL `COUNT(*)` so the workspace summary never silently
 * undercounts at scale. Using `listTasks(..., limit: N)` here was unsafe
 * because `listTasks` caps at 1000 regardless of the requested limit.
 */
function countOpenTasks(db: DatabaseSync, projectId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE project_id = ? AND state NOT IN ('DONE','CANCELLED','FAILED')",
    )
    .get(projectId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function chooseLiveState(
  phaseIndex: number,
  _phase: WorkflowPhase,
  phaseTasks: Task[],
  workflow: Workflow,
  gateReady: boolean,
): StageLiveState {
  if (workflow.state === "completed") return "done";
  if (phaseIndex > workflow.currentPhase) return "upcoming";
  if (phaseIndex < workflow.currentPhase) {
    return gateReady ? "done" : "skipped";
  }
  // phaseIndex === currentPhase
  if (gateReady) return "done";
  const hasBlocker = phaseTasks.some((t) => t.state === "BLOCKED" || t.state === "FAILED");
  if (hasBlocker) return "blocked";
  const hasActivity = phaseTasks.some((t) => t.state === "ASSIGNED" || t.state === "IN_PROGRESS" || t.state === "REVIEW");
  if (hasActivity) return "running";
  return "idle";
}

function pickPrimaryAgent(tasks: Task[]): { agentId: string; label: string } | undefined {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.assignedTo) continue;
    counts.set(task.assignedTo, (counts.get(task.assignedTo) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let topAgent: string | undefined;
  let topCount = -1;
  for (const [agent, count] of counts) {
    if (count > topCount) {
      topAgent = agent;
      topCount = count;
    }
  }
  if (!topAgent) return undefined;
  const entry = getAgentConfig(topAgent);
  const label = entry?.config.title || entry?.config.persona || topAgent;
  return { agentId: topAgent, label };
}

function buildStageSummary(
  workflow: Workflow,
  phaseIndex: number,
  phase: WorkflowPhase,
  phaseTasks: Task[],
  gateReady: boolean,
): WorkflowStageSummary {
  const gateCondition = phase.gateCondition ?? "all_done";
  return {
    stageKey: deriveStageKey(workflow.id, phaseIndex),
    workflowId: workflow.id,
    phaseIndex,
    label: phase.name,
    description: phase.description,
    liveState: chooseLiveState(phaseIndex, phase, phaseTasks, workflow, gateReady),
    typeTags: [],
    primaryAgent: pickPrimaryAgent(phaseTasks),
    taskCount: phaseTasks.length,
    gateCondition,
    isCurrent: phaseIndex === workflow.currentPhase,
  };
}

function buildEdges(workflow: Workflow): WorkflowStageEdge[] {
  const stageKeys = workflow.phases.map((_, i) => deriveStageKey(workflow.id, i));
  const edges: WorkflowStageEdge[] = [];
  if (stageKeys.length === 0) {
    edges.push({ fromStageKey: null, toStageKey: null });
    return edges;
  }
  edges.push({ fromStageKey: null, toStageKey: stageKeys[0]! });
  for (let i = 0; i < stageKeys.length - 1; i++) {
    edges.push({ fromStageKey: stageKeys[i]!, toStageKey: stageKeys[i + 1]! });
  }
  edges.push({ fromStageKey: stageKeys[stageKeys.length - 1]!, toStageKey: null });
  return edges;
}

function workflowLiveState(state: Workflow["state"]): WorkflowLiveState {
  return state;
}

/**
 * Per-phase task data used by both the project grid and the focused topology.
 *
 * Intentionally drives off `getPhaseStatus`, which resolves tasks through
 * `workflow.phases[i].taskIds` → `getTasksByIds`. That path is unbounded —
 * task count per stage is limited only by how many were added via
 * `addTaskToPhase`, never by an arbitrary SQL limit.
 */
function buildMiniTopologyInternal(
  projectId: string,
  workflow: Workflow,
  db: DatabaseSync,
): WorkflowMiniTopology {
  const stages: WorkflowStageSummary[] = workflow.phases.map((phase, phaseIndex) => {
    const gateStatus = getPhaseStatus(projectId, workflow.id, phaseIndex, db);
    const phaseTasks = gateStatus?.tasks ?? [];
    return buildStageSummary(workflow, phaseIndex, phase, phaseTasks, gateStatus?.ready ?? false);
  });

  const scope: WorkflowScope = {
    kind: "workflow",
    domainId: projectId,
    workflowId: workflow.id,
  };

  return {
    scope,
    workflowId: workflow.id,
    name: workflow.name,
    liveState: workflowLiveState(workflow.state),
    currentPhase: workflow.currentPhase,
    stages,
    edges: buildEdges(workflow),
    hasDraftOverlays: false,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Shared scope-matching predicates (used by both the scoped feed and the
// stage inspector so they can never diverge).
// ---------------------------------------------------------------------------

/** Framework fact about where a task lives inside a workflow. */
type TaskLinkage = { workflowId: string | null; workflowPhase: number | null };

/**
 * Resolve workflow linkage for a bounded set of task ids in a single SQL
 * round-trip. The input is driven by attention items, not by a "list all
 * tasks in a workflow" scan — so it avoids the 1000-row truncation in
 * `listTasks` and stays cheap even on large domains.
 */
function lookupTaskLinkage(
  db: DatabaseSync,
  projectId: string,
  taskIds: string[],
): Map<string, TaskLinkage> {
  const out = new Map<string, TaskLinkage>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, workflow_id, workflow_phase FROM tasks WHERE project_id = ? AND id IN (${placeholders})`,
    )
    .all(projectId, ...taskIds) as Array<{
      id: string;
      workflow_id: string | null;
      workflow_phase: number | null;
    }>;
  for (const row of rows) {
    out.set(row.id, {
      workflowId: row.workflow_id,
      workflowPhase: row.workflow_phase,
    });
  }
  return out;
}

function itemMetadataWorkflowId(item: AttentionItem): string | undefined {
  return typeof item.metadata?.workflowId === "string" ? item.metadata.workflowId : undefined;
}

function itemMetadataStageKey(item: AttentionItem): string | undefined {
  return typeof item.metadata?.stageKey === "string" ? item.metadata.stageKey : undefined;
}

/**
 * True when this attention item belongs to the given workflow. Matches via:
 *   - the item's linked `taskId` whose `workflow_id` equals `workflowId`, or
 *   - `metadata.workflowId` set to this workflow, or
 *   - `metadata.stageKey` belonging to this workflow (`workflowId:phase:*`).
 */
function itemMatchesWorkflow(
  item: AttentionItem,
  workflowId: string,
  taskLinkage: Map<string, TaskLinkage>,
): boolean {
  if (item.taskId) {
    const linkage = taskLinkage.get(item.taskId);
    if (linkage?.workflowId === workflowId) return true;
  }
  if (itemMetadataWorkflowId(item) === workflowId) return true;
  const metadataStageKey = itemMetadataStageKey(item);
  if (metadataStageKey?.startsWith(`${workflowId}:phase:`) === true) return true;
  return false;
}

/**
 * True when this attention item belongs to the given stage. Matches via:
 *   - the item's linked `taskId` whose `workflow_id` + `workflow_phase`
 *     match the stage, or
 *   - `metadata.stageKey` set to the exact derived stage key.
 *
 * `metadata.workflowId` alone is deliberately not enough — an item may be
 * workflow-wide without being stage-local.
 */
function itemMatchesStage(
  item: AttentionItem,
  workflowId: string,
  stagePhaseIndex: number,
  taskLinkage: Map<string, TaskLinkage>,
): boolean {
  if (item.taskId) {
    const linkage = taskLinkage.get(item.taskId);
    if (linkage?.workflowId === workflowId && linkage.workflowPhase === stagePhaseIndex) return true;
  }
  if (itemMetadataStageKey(item) === deriveStageKey(workflowId, stagePhaseIndex)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// queryProjectWorkspace
// ---------------------------------------------------------------------------

function emptyOperatorSummary(emergencyStop: boolean, healthTier: string): ProjectOperatorSummary {
  return {
    workflowCount: 0,
    activeWorkflowCount: 0,
    openTaskCount: 0,
    actionNeededCount: 0,
    healthTier,
    emergencyStop,
    generatedAt: Date.now(),
  };
}

function safeEmergencyStop(projectId: string): boolean {
  try {
    return isEmergencyStopActive(projectId);
  } catch {
    return false;
  }
}

function safeHealthTier(projectId: string): string {
  try {
    return queryDomainHealth(projectId).tier;
  } catch {
    return "unknown";
  }
}

/**
 * Workspace view of a single domain. Used to populate the project-scope shell:
 * top bar summary, left rail workflow list, and the center-canvas project grid.
 */
export function queryProjectWorkspace(
  domainId: string,
  dbOverride?: DatabaseSync,
): ProjectWorkspace {
  const db = resolveDb(domainId, dbOverride);
  const healthTier = safeHealthTier(domainId);
  const emergencyStop = safeEmergencyStop(domainId);

  if (!db) {
    return {
      scope: { kind: "project", domainId },
      domainId,
      operator: emptyOperatorSummary(emergencyStop, healthTier),
      workflows: [],
      draftSessions: [],
    };
  }

  const workflows = listWorkflows(domainId, db);
  const miniTopologies = workflows.map((wf) => buildMiniTopologyInternal(domainId, wf, db));

  let openTaskCount = 0;
  try {
    openTaskCount = countOpenTasks(db, domainId);
  } catch { /* leave zero */ }

  let actionNeededCount = 0;
  try {
    const attention = buildAttentionSummary(domainId, db);
    actionNeededCount = attention.counts.actionNeeded;
  } catch { /* leave zero */ }

  const operator: ProjectOperatorSummary = {
    workflowCount: workflows.length,
    activeWorkflowCount: workflows.filter((wf) => wf.state === "active").length,
    openTaskCount,
    actionNeededCount,
    healthTier,
    emergencyStop,
    generatedAt: Date.now(),
  };

  return {
    scope: { kind: "project", domainId },
    domainId,
    operator,
    workflows: miniTopologies,
    draftSessions: [],
  };
}

// ---------------------------------------------------------------------------
// queryWorkflowTopology
// ---------------------------------------------------------------------------

/**
 * Full topology for the focused workflow canvas. Returns null when the
 * workflow does not exist in this domain.
 */
export function queryWorkflowTopology(
  domainId: string,
  workflowId: string,
  dbOverride?: DatabaseSync,
): WorkflowTopology | null {
  const db = resolveDb(domainId, dbOverride);
  if (!db) return null;
  const workflow = getWorkflow(domainId, workflowId, db);
  if (!workflow) return null;
  if (workflow.projectId !== domainId) return null;

  const mini = buildMiniTopologyInternal(domainId, workflow, db);
  return {
    ...mini,
    description: workflow.phases[0]?.description,
    createdBy: workflow.createdBy,
    draftOverlays: [],
  };
}

// ---------------------------------------------------------------------------
// queryWorkflowStageInspector
// ---------------------------------------------------------------------------

const INSPECTOR_FEED_LIMIT = 20;
const STAGE_INSPECTOR_TASK_LIMIT = 100;

function toInspectorTask(task: Task): WorkflowStageInspectorTask {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    priority: task.priority,
    assignedTo: task.assignedTo,
    updatedAt: task.updatedAt,
  };
}

function positionFor(currentPhase: number, phaseIndex: number): "upcoming" | "current" | "past" {
  if (phaseIndex === currentPhase) return "current";
  return phaseIndex > currentPhase ? "upcoming" : "past";
}

/**
 * Resolve a `stageKey` to an in-bounds phase index for the given workflow.
 *
 * This is the single source of truth for what counts as a valid stage scope.
 * Both the stage inspector and the scoped feed use it, so a key that 404s
 * the inspector cannot still produce feed items for a scope that does not
 * exist.
 *
 * Returns `null` when the stageKey cannot be mapped to a real stage:
 * - malformed key (not `workflowId:phase:N`, not a bare phase-index string)
 * - parsed workflowId belongs to a different workflow
 * - phase index is out of range for this workflow
 */
function resolveStagePhaseIndex(
  workflow: Workflow,
  stageKey: string,
): number | null {
  const parsed = parseStageKey(stageKey);
  let candidate: number;
  if (parsed) {
    if (parsed.workflowId !== workflow.id) return null;
    candidate = parsed.phaseIndex;
  } else {
    const direct = Number.parseInt(stageKey, 10);
    if (!Number.isFinite(direct) || direct < 0) return null;
    candidate = direct;
  }
  if (candidate >= workflow.phases.length) return null;
  return candidate;
}

/**
 * Detail payload for the right-rail stage inspector. `stageKey` accepts either
 * the derived `${workflowId}:phase:${index}` form, or a bare phase-index
 * string for convenience (e.g. "0") — the latter is resolved against the
 * given `workflowId`.
 */
export function queryWorkflowStageInspector(
  domainId: string,
  workflowId: string,
  stageKey: string,
  dbOverride?: DatabaseSync,
): WorkflowStageInspector | null {
  const db = resolveDb(domainId, dbOverride);
  if (!db) return null;

  const workflow = getWorkflow(domainId, workflowId, db);
  if (!workflow || workflow.projectId !== domainId) return null;

  const phaseIndex = resolveStagePhaseIndex(workflow, stageKey);
  if (phaseIndex === null) return null;
  const phase = workflow.phases[phaseIndex]!;

  const gateStatus = getPhaseStatus(domainId, workflowId, phaseIndex, db);
  const phaseTasks = gateStatus?.tasks ?? [];
  const stage = buildStageSummary(workflow, phaseIndex, phase, phaseTasks, gateStatus?.ready ?? false);

  const scope: Extract<WorkspaceScope, { kind: "stage" }> = {
    kind: "stage",
    domainId,
    workflowId,
    stageKey: stage.stageKey,
  };

  // Delegate feed scoping to `queryScopedWorkspaceFeed` so the inspector's
  // `recentFeed` and the workspace feed can never drift. This also picks up
  // metadata-linked items (workflowId / stageKey without a taskId) and the
  // cross-scope critical signals a focused operator must still see.
  let recentFeed: ScopedFeedItem[] = [];
  try {
    const scopedFeed = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId,
      workflowId,
      stageKey: stage.stageKey,
    }, db);
    recentFeed = scopedFeed.items.slice(0, INSPECTOR_FEED_LIMIT);
  } catch { /* leave empty */ }

  // Rank phase tasks by recency so the UI shows activity-ordered rows, then
  // cap. `totalTaskCount`/`tasksTruncated` keep the response honest at scale.
  const sortedTasks = [...phaseTasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const displayTasks = sortedTasks.slice(0, STAGE_INSPECTOR_TASK_LIMIT);
  const tasksTruncated = sortedTasks.length > displayTasks.length;

  return {
    scope,
    stage,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      liveState: workflowLiveState(workflow.state),
      currentPhase: workflow.currentPhase,
      totalPhases: workflow.phases.length,
    },
    position: positionFor(workflow.currentPhase, phaseIndex),
    gate: {
      condition: phase.gateCondition ?? "all_done",
      ready: gateStatus?.ready ?? false,
      completed: gateStatus?.completed ?? 0,
      failed: gateStatus?.failed ?? 0,
      resolved: gateStatus?.resolved ?? 0,
      total: gateStatus?.total ?? 0,
    },
    tasks: displayTasks.map(toInspectorTask),
    totalTaskCount: sortedTasks.length,
    tasksTruncated,
    recentFeed,
  };
}

// ---------------------------------------------------------------------------
// queryScopedWorkspaceFeed
// ---------------------------------------------------------------------------

/**
 * Category list for items that are always surfaced as `crossScope: true`
 * when viewed at workflow or stage scope and the urgency is `action-needed`.
 * These are project-universe critical signals the operator must still see.
 */
const CROSS_SCOPE_CATEGORIES = new Set(["budget", "health", "compliance"]);

function isCrossScopeCritical(item: AttentionItem): boolean {
  if (item.urgency !== "action-needed") return false;
  if (CROSS_SCOPE_CATEGORIES.has(item.category)) return true;
  return false;
}

function countsFor(items: AttentionItem[]): { actionNeeded: number; watching: number; fyi: number } {
  let actionNeeded = 0;
  let watching = 0;
  let fyi = 0;
  for (const item of items) {
    if (item.urgency === "action-needed") actionNeeded++;
    else if (item.urgency === "watching") watching++;
    else if (item.urgency === "fyi") fyi++;
  }
  return { actionNeeded, watching, fyi };
}

export type ScopedFeedParams =
  | { kind: "project"; domainId: string }
  | { kind: "workflow"; domainId: string; workflowId: string }
  | { kind: "stage"; domainId: string; workflowId: string; stageKey: string };

/**
 * Scoped feed slice. Always derives from `buildAttentionSummary` so the
 * workspace feed shares the same event universe as every other operator
 * surface. Never invents a parallel event source.
 */
export function queryScopedWorkspaceFeed(
  params: ScopedFeedParams,
  dbOverride?: DatabaseSync,
): ScopedWorkspaceFeed {
  const { domainId } = params;
  const db = resolveDb(domainId, dbOverride);
  const scope: WorkspaceScope = params.kind === "project"
    ? { kind: "project", domainId }
    : params.kind === "workflow"
      ? { kind: "workflow", domainId, workflowId: params.workflowId }
      : { kind: "stage", domainId, workflowId: params.workflowId, stageKey: params.stageKey };

  const emptyResult: ScopedWorkspaceFeed = {
    scope,
    items: [],
    counts: { actionNeeded: 0, watching: 0, fyi: 0 },
    crossScopeCount: 0,
    generatedAt: Date.now(),
  };

  if (!db) return emptyResult;

  let summary;
  try {
    summary = buildAttentionSummary(domainId, db);
  } catch {
    return emptyResult;
  }

  if (params.kind === "project") {
    return {
      scope,
      items: summary.items,
      counts: summary.counts,
      crossScopeCount: 0,
      generatedAt: summary.generatedAt,
    };
  }

  // workflow / stage scope — narrow via task→workflow linkage + metadata hints.
  const workflow = getWorkflow(domainId, params.workflowId, db);
  if (!workflow || workflow.projectId !== domainId) {
    return {
      scope,
      items: [],
      counts: { actionNeeded: 0, watching: 0, fyi: 0 },
      crossScopeCount: 0,
      generatedAt: summary.generatedAt,
    };
  }

  // Bounded by the feed size, not by "all tasks in the workflow" — we only
  // need linkage for the items that actually reference a task. This avoids
  // the 1000-row silent truncation that would occur with listTasks().
  const referencedTaskIds = Array.from(
    new Set(summary.items.map((i) => i.taskId).filter((v): v is string => typeof v === "string" && v.length > 0)),
  );
  const taskLinkage = lookupTaskLinkage(db, domainId, referencedTaskIds);

  // Stage scope is only valid when the key resolves to a real phase of this
  // workflow. If it doesn't, the scope is a lie — the same input that 404s
  // `queryWorkflowStageInspector()` — so we refuse to emit cross-scope items
  // into a scope that has no bounds.
  let stagePhaseIndex: number | null = null;
  if (params.kind === "stage") {
    const resolved = resolveStagePhaseIndex(workflow, params.stageKey);
    if (resolved === null) {
      return {
        scope,
        items: [],
        counts: { actionNeeded: 0, watching: 0, fyi: 0 },
        crossScopeCount: 0,
        generatedAt: summary.generatedAt,
      };
    }
    stagePhaseIndex = resolved;
  }

  const scopedItems: ScopedFeedItem[] = [];
  for (const item of summary.items) {
    if (params.kind === "workflow") {
      if (itemMatchesWorkflow(item, workflow.id, taskLinkage)) {
        scopedItems.push(item);
      } else if (isCrossScopeCritical(item)) {
        scopedItems.push({ ...item, crossScope: true });
      }
      continue;
    }

    // stage scope — stagePhaseIndex is guaranteed non-null here because the
    // invalid-key branch above returned early.
    if (itemMatchesStage(item, workflow.id, stagePhaseIndex!, taskLinkage)) {
      scopedItems.push(item);
    } else if (isCrossScopeCritical(item)) {
      scopedItems.push({ ...item, crossScope: true });
    }
  }

  const crossScopeCount = scopedItems.filter((i) => i.crossScope === true).length;

  return {
    scope,
    items: scopedItems,
    counts: countsFor(scopedItems),
    crossScopeCount,
    generatedAt: summary.generatedAt,
  };
}
