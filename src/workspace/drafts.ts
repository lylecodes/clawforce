/**
 * Clawforce — Workflow draft sessions
 *
 * Phase B framework object for workflow mutation. A draft session stores both
 * the live workflow structure at creation time and the proposed draft
 * structure. Workspace queries diff those snapshots into truthful overlays.
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { getWorkflow } from "../workflow.js";
import type { WorkflowPhase } from "../types.js";
import {
  deriveDraftStageKey,
  deriveStageKey,
  type WorkflowDraftChangeSummary,
  type WorkflowDraftOverlayVisibility,
  type WorkflowDraftSession,
  type WorkflowDraftSessionStatus,
  type WorkflowDraftSessionSummary,
  type WorkflowDraftStage,
  type WorkflowDraftStageOverlay,
} from "./types.js";

type StoredWorkflowSnapshot = {
  name: string;
  phases: WorkflowPhase[];
};

type WorkflowDraftSessionRow = {
  id: string;
  project_id: string;
  workflow_id: string;
  title: string;
  description: string | null;
  created_by: string;
  status: WorkflowDraftSessionStatus;
  overlay_visibility: WorkflowDraftOverlayVisibility;
  base_workflow_snapshot: string;
  draft_workflow_snapshot: string;
  created_at: number;
  updated_at: number;
};

export type WorkflowDraftSessionRecord = {
  id: string;
  projectId: string;
  workflowId: string;
  title: string;
  description?: string;
  createdBy: string;
  status: WorkflowDraftSessionStatus;
  overlayVisibility: WorkflowDraftOverlayVisibility;
  baseWorkflow: StoredWorkflowSnapshot;
  draftWorkflow: StoredWorkflowSnapshot;
  createdAt: number;
  updatedAt: number;
};

export type CreateWorkflowDraftSessionParams = {
  projectId: string;
  workflowId: string;
  title: string;
  description?: string;
  createdBy: string;
  draftWorkflow?: Partial<StoredWorkflowSnapshot> & { phases?: WorkflowPhase[] };
  status?: WorkflowDraftSessionStatus;
  overlayVisibility?: WorkflowDraftOverlayVisibility;
};

export function createWorkflowDraftSession(
  params: CreateWorkflowDraftSessionParams,
  dbOverride?: DatabaseSync,
): WorkflowDraftSessionRecord {
  const db = dbOverride ?? getDb(params.projectId);
  const workflow = getWorkflow(params.projectId, params.workflowId, db);
  if (!workflow) {
    throw new Error(`Workflow "${params.workflowId}" not found in project "${params.projectId}"`);
  }

  const baseWorkflow: StoredWorkflowSnapshot = {
    name: workflow.name,
    phases: workflow.phases.map(clonePhase),
  };
  const draftWorkflow: StoredWorkflowSnapshot = {
    name: params.draftWorkflow?.name ?? workflow.name,
    phases: (params.draftWorkflow?.phases ?? workflow.phases).map(clonePhase),
  };

  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO workflow_draft_sessions (
      id, project_id, workflow_id, title, description, created_by, status,
      overlay_visibility, base_workflow_snapshot, draft_workflow_snapshot,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.workflowId,
    params.title,
    params.description ?? null,
    params.createdBy,
    params.status ?? "draft",
    params.overlayVisibility ?? "visible",
    JSON.stringify(baseWorkflow),
    JSON.stringify(draftWorkflow),
    now,
    now,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.createdBy,
    action: "workflow_draft.create",
    targetType: "workflow_draft_session",
    targetId: id,
    detail: params.title,
  }, db);

  const created = getWorkflowDraftSessionRecord(params.projectId, id, db);
  if (!created) {
    throw new Error(`Failed to create workflow draft session "${id}"`);
  }
  return created;
}

export function setWorkflowDraftSessionVisibility(
  projectId: string,
  draftSessionId: string,
  overlayVisibility: WorkflowDraftOverlayVisibility,
  actor: string,
  dbOverride?: DatabaseSync,
): WorkflowDraftSessionRecord | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const result = db.prepare(`
    UPDATE workflow_draft_sessions
       SET overlay_visibility = ?, updated_at = ?
     WHERE id = ? AND project_id = ?
  `).run(overlayVisibility, now, draftSessionId, projectId) as { changes: number };
  if (result.changes === 0) return null;

  writeAuditEntry({
    projectId,
    actor,
    action: "workflow_draft.set_visibility",
    targetType: "workflow_draft_session",
    targetId: draftSessionId,
    detail: overlayVisibility,
  }, db);

  return getWorkflowDraftSessionRecord(projectId, draftSessionId, db);
}

export function getWorkflowDraftSessionRecord(
  projectId: string,
  draftSessionId: string,
  dbOverride?: DatabaseSync,
): WorkflowDraftSessionRecord | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT * FROM workflow_draft_sessions
     WHERE id = ? AND project_id = ?
  `).get(draftSessionId, projectId) as WorkflowDraftSessionRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listWorkflowDraftSessionRecords(
  projectId: string,
  params: { workflowId?: string; includeStatuses?: WorkflowDraftSessionStatus[] } = {},
  dbOverride?: DatabaseSync,
): WorkflowDraftSessionRecord[] {
  const db = dbOverride ?? getDb(projectId);
  const clauses = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (params.workflowId) {
    clauses.push("workflow_id = ?");
    values.push(params.workflowId);
  }

  const includeStatuses = params.includeStatuses ?? ["draft", "review_pending"];
  if (includeStatuses.length > 0) {
    clauses.push(`status IN (${includeStatuses.map(() => "?").join(", ")})`);
    values.push(...includeStatuses);
  }

  const rows = db.prepare(`
    SELECT * FROM workflow_draft_sessions
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC, created_at DESC
  `).all(...values) as WorkflowDraftSessionRow[];

  return rows.map(rowToRecord);
}

export function toWorkflowDraftSessionSummary(
  projectId: string,
  record: WorkflowDraftSessionRecord,
): WorkflowDraftSessionSummary {
  const overlays = diffDraftWorkflow(record);
  return {
    scope: {
      kind: "draft",
      domainId: projectId,
      workflowId: record.workflowId,
      draftSessionId: record.id,
    },
    id: record.id,
    workflowId: record.workflowId,
    workflowName: record.draftWorkflow.name,
    title: record.title,
    description: record.description,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    overlayVisibility: record.overlayVisibility,
    changeSummary: summarizeOverlays(overlays),
    affectedStageCount: overlays.length,
  };
}

export function toWorkflowDraftSessionDetail(
  projectId: string,
  record: WorkflowDraftSessionRecord,
): WorkflowDraftSession {
  const overlays = diffDraftWorkflow(record);
  const draftStages = record.draftWorkflow.phases.map((phase, phaseIndex): WorkflowDraftStage => ({
    draftStageKey: deriveDraftStageKey(record.id, phaseIndex),
    phaseIndex,
    label: phase.name,
    description: phase.description,
    gateCondition: phase.gateCondition ?? "all_done",
  }));
  return {
    ...toWorkflowDraftSessionSummary(projectId, record),
    overlays,
    baseStageCount: record.baseWorkflow.phases.length,
    draftStageCount: record.draftWorkflow.phases.length,
    draftStages,
  };
}

export function diffDraftWorkflow(
  record: Pick<WorkflowDraftSessionRecord, "id" | "workflowId" | "baseWorkflow" | "draftWorkflow">,
): WorkflowDraftStageOverlay[] {
  const live = record.baseWorkflow.phases.map(normalizePhase);
  const draft = record.draftWorkflow.phases.map(normalizePhase);
  const overlays: WorkflowDraftStageOverlay[] = [];
  const matchedLive = new Set<number>();
  const matchedDraft = new Set<number>();

  const sameLength = Math.min(live.length, draft.length);
  for (let i = 0; i < sameLength; i++) {
    if (phaseSignature(live[i]!) === phaseSignature(draft[i]!)) {
      matchedLive.add(i);
      matchedDraft.add(i);
    }
  }

  const unmatchedDraftBySignature = new Map<string, number[]>();
  for (let i = 0; i < draft.length; i++) {
    if (matchedDraft.has(i)) continue;
    const signature = phaseSignature(draft[i]!);
    const queue = unmatchedDraftBySignature.get(signature) ?? [];
    queue.push(i);
    unmatchedDraftBySignature.set(signature, queue);
  }

  for (let i = 0; i < live.length; i++) {
    if (matchedLive.has(i)) continue;
    const queue = unmatchedDraftBySignature.get(phaseSignature(live[i]!));
    const draftIndex = queue?.shift();
    if (draftIndex == null) continue;
    matchedLive.add(i);
    matchedDraft.add(draftIndex);
    overlays.push({
      draftSessionId: record.id,
      workflowId: record.workflowId,
      kind: "moved",
      liveStageKey: deriveStageKey(record.workflowId, i),
      draftStageKey: deriveDraftStageKey(record.id, draftIndex),
      livePhaseIndex: i,
      draftPhaseIndex: draftIndex,
      label: draft[draftIndex]!.name,
      description: draft[draftIndex]!.description,
    });
  }

  for (let i = 0; i < Math.max(live.length, draft.length); i++) {
    const hasLive = i < live.length;
    const hasDraft = i < draft.length;
    if (!hasLive || !hasDraft) continue;
    if (matchedLive.has(i) || matchedDraft.has(i)) continue;
    matchedLive.add(i);
    matchedDraft.add(i);
    overlays.push({
      draftSessionId: record.id,
      workflowId: record.workflowId,
      kind: "modified",
      liveStageKey: deriveStageKey(record.workflowId, i),
      draftStageKey: deriveDraftStageKey(record.id, i),
      livePhaseIndex: i,
      draftPhaseIndex: i,
      label: draft[i]!.name,
      description: draft[i]!.description,
    });
  }

  for (let i = 0; i < live.length; i++) {
    if (matchedLive.has(i)) continue;
    overlays.push({
      draftSessionId: record.id,
      workflowId: record.workflowId,
      kind: "removed",
      liveStageKey: deriveStageKey(record.workflowId, i),
      livePhaseIndex: i,
      label: live[i]!.name,
      description: live[i]!.description,
    });
  }

  for (let i = 0; i < draft.length; i++) {
    if (matchedDraft.has(i)) continue;
    overlays.push({
      draftSessionId: record.id,
      workflowId: record.workflowId,
      kind: "added",
      draftStageKey: deriveDraftStageKey(record.id, i),
      draftPhaseIndex: i,
      label: draft[i]!.name,
      description: draft[i]!.description,
    });
  }

  return overlays.sort((a, b) => {
    const aOrder = a.draftPhaseIndex ?? a.livePhaseIndex ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.draftPhaseIndex ?? b.livePhaseIndex ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}

export function summarizeOverlays(
  overlays: WorkflowDraftStageOverlay[],
): WorkflowDraftChangeSummary {
  const summary: WorkflowDraftChangeSummary = {
    addedStages: 0,
    removedStages: 0,
    modifiedStages: 0,
    movedStages: 0,
    totalChanges: overlays.length,
  };
  for (const overlay of overlays) {
    if (overlay.kind === "added") summary.addedStages++;
    else if (overlay.kind === "removed") summary.removedStages++;
    else if (overlay.kind === "modified") summary.modifiedStages++;
    else if (overlay.kind === "moved") summary.movedStages++;
  }
  return summary;
}

function rowToRecord(row: WorkflowDraftSessionRow): WorkflowDraftSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    title: row.title,
    description: row.description ?? undefined,
    createdBy: row.created_by,
    status: row.status,
    overlayVisibility: row.overlay_visibility,
    baseWorkflow: JSON.parse(row.base_workflow_snapshot) as StoredWorkflowSnapshot,
    draftWorkflow: JSON.parse(row.draft_workflow_snapshot) as StoredWorkflowSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clonePhase(phase: WorkflowPhase): WorkflowPhase {
  return {
    name: phase.name,
    description: phase.description,
    taskIds: [...phase.taskIds],
    gateCondition: phase.gateCondition ?? "all_done",
  };
}

function normalizePhase(phase: WorkflowPhase): WorkflowPhase {
  return {
    name: phase.name,
    description: phase.description,
    taskIds: phase.taskIds ?? [],
    gateCondition: phase.gateCondition ?? "all_done",
  };
}

function phaseSignature(phase: WorkflowPhase): string {
  return JSON.stringify({
    name: phase.name,
    description: phase.description ?? null,
    gateCondition: phase.gateCondition ?? "all_done",
  });
}
