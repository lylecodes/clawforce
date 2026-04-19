/**
 * Clawforce — Dashboard V2 Workspace Contract Types
 *
 * Phase A of the v2 workspace shell (docs/plans/2026-04-19-dashboard-v2-
 * implementation-brief.md). Read-only framework contracts the dashboard
 * renders against.
 *
 * The types are shaped so Phase B (drafts/overlays), Phase C (review), and
 * Phase D (helper) extend them without breaking changes — that is why
 * `draftSessions` and `draftOverlays` exist as present-but-empty arrays, and
 * `liveState` / `hasDraftOverlays` are explicit.
 */

import type { AttentionItem } from "../attention/types.js";
import type { TaskPriority, TaskState } from "../types.js";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Every workspace response includes an explicit scope. The UI must never
 * infer scope from context alone — if a response is project-scoped it says
 * so; if it is narrowed to a workflow or stage it says so.
 */
export type WorkspaceScope =
  | { kind: "project"; domainId: string }
  | { kind: "workflow"; domainId: string; workflowId: string }
  | { kind: "stage"; domainId: string; workflowId: string; stageKey: string };

export type WorkspaceScopeKind = WorkspaceScope["kind"];

export const WORKSPACE_SCOPE_KINDS: readonly WorkspaceScopeKind[] = [
  "project",
  "workflow",
  "stage",
] as const;

// ---------------------------------------------------------------------------
// Stable stage key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable stage key from the workflow id and phase index.
 *
 * `WorkflowPhase` has no stored id today. This key is stable across reads as
 * long as the workflow's phases are not restructured. When Phase B draft
 * sessions restructure phases, the overlay carries both `liveStageKey` and
 * `draftStageKey` so truth stays explicit.
 */
export function deriveStageKey(workflowId: string, phaseIndex: number): string {
  return `${workflowId}:phase:${phaseIndex}`;
}

export type ParsedStageKey = {
  workflowId: string;
  phaseIndex: number;
};

/** Parse a stage key produced by `deriveStageKey`. Returns null if malformed. */
export function parseStageKey(stageKey: string): ParsedStageKey | null {
  const match = /^(.+):phase:(\d+)$/.exec(stageKey);
  if (!match) return null;
  const phaseIndex = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(phaseIndex) || phaseIndex < 0) return null;
  return { workflowId: match[1]!, phaseIndex };
}

// ---------------------------------------------------------------------------
// Shared live-state shapes
// ---------------------------------------------------------------------------

/** Coarse live state of a stage, used for the stage box badge on the canvas. */
export type StageLiveState =
  | "idle" // no tasks, or all tasks OPEN with no activity yet
  | "running" // at least one task in ASSIGNED or IN_PROGRESS
  | "blocked" // at least one task BLOCKED or FAILED, and phase is current
  | "done" // gate is satisfied (ready === true)
  | "upcoming" // phase index is after workflow.currentPhase
  | "skipped"; // phase is behind currentPhase and workflow advanced without it completing

/** Workflow-level live state mirrors `Workflow.state` 1:1 today. */
export type WorkflowLiveState = "active" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/**
 * Small, display-oriented summary of a stage — the canvas uses this for every
 * stage box. Never expands into agent or task detail; inspectors do that.
 */
export type WorkflowStageSummary = {
  /** Stable derived key — `${workflowId}:phase:${phaseIndex}`. */
  stageKey: string;
  /**
   * Optional promoted stage id. Reserved for Phase B / future schema evolution.
   * Not populated today — present so consumers can branch on its existence
   * without a breaking type change later.
   */
  stageId?: string;
  workflowId: string;
  phaseIndex: number;
  /** Display label — today equals `WorkflowPhase.name`. */
  label: string;
  description?: string;
  /** Live badge for the canvas. */
  liveState: StageLiveState;
  /** Small always-visible type tags. Empty in Phase A; reserved for future. */
  typeTags: string[];
  /** Primary agent assignment shown on the stage box, if any. */
  primaryAgent?: {
    agentId: string;
    label: string;
  };
  /** Total tasks currently attached to this stage. */
  taskCount: number;
  /** Gate condition inherited from the underlying `WorkflowPhase`. */
  gateCondition: "all_done" | "any_done" | "all_resolved" | "any_resolved";
  /** True when this phase index equals `Workflow.currentPhase`. */
  isCurrent: boolean;
};

/** Directed edge between two stages. Linear today; branching slots reserved. */
export type WorkflowStageEdge = {
  /** Upstream stage — `null` indicates the virtual `Start` node. */
  fromStageKey: string | null;
  /** Downstream stage — `null` indicates the virtual `End` node. */
  toStageKey: string | null;
  /**
   * Optional branch label, e.g. "on_pass" / "on_fail". Phase A never emits
   * branch labels (workflow phases are strictly linear), but the field is
   * reserved so Phase B can populate it without a breaking type change.
   */
  branchLabel?: string;
};

// ---------------------------------------------------------------------------
// Workflow topology
// ---------------------------------------------------------------------------

/**
 * A workflow in the project-grid preview. Small, grid-friendly shape with
 * explicit virtual Start/End so the grid never has to fabricate endpoints.
 */
export type WorkflowMiniTopology = {
  scope: Extract<WorkspaceScope, { kind: "workflow" }>;
  workflowId: string;
  name: string;
  liveState: WorkflowLiveState;
  currentPhase: number;
  stages: WorkflowStageSummary[];
  /** Ordered adjacency list including virtual Start and End. */
  edges: WorkflowStageEdge[];
  /** True when at least one draft overlay would apply. Always `false` in Phase A. */
  hasDraftOverlays: boolean;
  createdAt: number;
  updatedAt: number;
};

/**
 * Full workflow topology for the focused workflow canvas. Today it is a
 * superset of `WorkflowMiniTopology`; the split exists so we can enrich the
 * focused view without bloating the project grid payload.
 */
export type WorkflowTopology = WorkflowMiniTopology & {
  description?: string;
  createdBy: string;
  /**
   * Active draft overlays for this workflow. Empty in Phase A — Phase B
   * populates this from the draft-session model and it is widened then.
   */
  draftOverlays: never[];
};

// ---------------------------------------------------------------------------
// Project workspace
// ---------------------------------------------------------------------------

/** Quiet one-line project operator summary for the project-scope left rail. */
export type ProjectOperatorSummary = {
  workflowCount: number;
  activeWorkflowCount: number;
  openTaskCount: number;
  /** Count of attention items with actionNeeded urgency. */
  actionNeededCount: number;
  /** Health tier from `queryHealth` — mirrored here so the rail does not issue a second call. */
  healthTier: string;
  emergencyStop: boolean;
  generatedAt: number;
};

/**
 * Placeholder inventory slot for Phase B. Always `[]` in Phase A.
 *
 * Typed as `never[]` rather than `WorkflowDraftSession[]` on purpose: the
 * dashboard shouldn't be tempted to render fake draft rows. Phase B will
 * widen this type and add real entries.
 */
export type WorkflowDraftSessionStub = never;

export type ProjectWorkspace = {
  scope: Extract<WorkspaceScope, { kind: "project" }>;
  domainId: string;
  operator: ProjectOperatorSummary;
  workflows: WorkflowMiniTopology[];
  draftSessions: WorkflowDraftSessionStub[];
};

// ---------------------------------------------------------------------------
// Stage inspector
// ---------------------------------------------------------------------------

export type WorkflowStageInspectorTask = {
  id: string;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  assignedTo?: string;
  updatedAt: number;
};

/**
 * Detail payload for the right-rail stage inspector. Carries enough metadata
 * for the UI to explain why the stage exists without re-querying the world.
 */
export type WorkflowStageInspector = {
  scope: Extract<WorkspaceScope, { kind: "stage" }>;
  stage: WorkflowStageSummary;
  workflow: {
    id: string;
    name: string;
    liveState: WorkflowLiveState;
    currentPhase: number;
    totalPhases: number;
  };
  /**
   * Whether the current workflow position is ahead, at, or behind this stage.
   * Phase A derives this purely from `currentPhase` vs `phaseIndex`.
   */
  position: "upcoming" | "current" | "past";
  /**
   * Gate readiness — mirrors `getPhaseStatus(...).ready`. Helps the inspector
   * explain "why is this stage still running / blocked".
   */
  gate: {
    condition: "all_done" | "any_done" | "all_resolved" | "any_resolved";
    ready: boolean;
    completed: number;
    failed: number;
    resolved: number;
    total: number;
  };
  tasks: WorkflowStageInspectorTask[];
  /**
   * Total number of tasks attached to this stage in the framework. Always
   * truthful — may exceed `tasks.length` when the inspector cap kicks in.
   */
  totalTaskCount: number;
  /**
   * True when `tasks.length < totalTaskCount`. The UI must not present a
   * silently capped list as the full set — use this flag to disclose.
   */
  tasksTruncated: boolean;
  /**
   * Recent attention items narrowed to this stage. Uses the same matching
   * rules as `queryScopedWorkspaceFeed({ kind: "stage" })` so the workspace
   * feed and the inspector can never diverge — including project-universe
   * critical signals surfaced as `crossScope: true`.
   */
  recentFeed: ScopedFeedItem[];
};

// ---------------------------------------------------------------------------
// Scoped feed
// ---------------------------------------------------------------------------

/**
 * Scoped feed slice. Always derives from the canonical attention builder so
 * workflow/stage events never spawn a second event stream.
 *
 * When `scope.kind` is `workflow` or `stage`, items whose `crossScope: true`
 * are surfaced despite not belonging to the scope — these are
 * project-universe critical signals (emergency stop, budget, health) the
 * operator must always see.
 */
export type ScopedFeedItem = AttentionItem & {
  /**
   * True when the item was kept because it is a project-universe critical
   * signal rather than a direct scope match.
   */
  crossScope?: boolean;
};

export type ScopedWorkspaceFeed = {
  scope: WorkspaceScope;
  items: ScopedFeedItem[];
  counts: {
    actionNeeded: number;
    watching: number;
    fyi: number;
  };
  /** Count of items that matched `crossScope`. Zero at project scope. */
  crossScopeCount: number;
  generatedAt: number;
};
