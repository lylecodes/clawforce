/**
 * Clawforce — Workflow reviews (Phase C)
 *
 * A workflow review is the framework-backed, auditable ratification step for
 * a Phase B draft session. Confirming a draft creates exactly one review row
 * and transitions the draft to `review_pending`. Approving the review
 * transitions the draft to `applied` (i.e. ratified); rejecting transitions
 * it to `discarded`. Reviews flow into the canonical operator feed via the
 * existing `approval` category — no second event system.
 *
 * Approve does NOT materialize the draft onto the live workflow today.
 * That step is deferred; the only write that would do it is marked with an
 * explicit in-code TODO so a later phase can find it.
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import {
  diffDraftWorkflow,
  getWorkflowDraftSessionRecord,
  setWorkflowDraftSessionStatus,
  summarizeOverlays,
  toWorkflowDraftSessionSummary,
  type WorkflowDraftSessionRecord,
} from "./drafts.js";
import type {
  WorkflowDraftChangeSummary,
  WorkflowDraftSessionStatus,
  WorkflowDraftStageOverlay,
  WorkflowReview,
  WorkflowReviewStatus,
  WorkflowReviewSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Storage model
// ---------------------------------------------------------------------------

type WorkflowReviewRow = {
  id: string;
  project_id: string;
  draft_session_id: string;
  workflow_id: string;
  title: string;
  summary: string | null;
  status: WorkflowReviewStatus;
  confirmed_by: string;
  resolved_by: string | null;
  decision_notes: string | null;
  change_summary: string;
  overlays_snapshot: string;
  affected_stage_count: number;
  created_at: number;
  resolved_at: number | null;
};

export type WorkflowReviewRecord = {
  id: string;
  projectId: string;
  draftSessionId: string;
  workflowId: string;
  title: string;
  summary?: string;
  status: WorkflowReviewStatus;
  confirmedBy: string;
  resolvedBy?: string;
  decisionNotes?: string;
  changeSummary: WorkflowDraftChangeSummary;
  overlays: WorkflowDraftStageOverlay[];
  affectedStageCount: number;
  createdAt: number;
  resolvedAt?: number;
};

// ---------------------------------------------------------------------------
// Confirm — create a review from a draft session
// ---------------------------------------------------------------------------

export type ConfirmDraftIntoReviewParams = {
  projectId: string;
  draftSessionId: string;
  confirmedBy: string;
  title?: string;
  summary?: string;
};

export type ConfirmDraftResult =
  | { ok: true; created: boolean; record: WorkflowReviewRecord }
  | { ok: false; reason: "draft_not_found" }
  | {
      ok: false;
      reason: "draft_terminal";
      currentStatus: WorkflowDraftSessionStatus;
    };

/**
 * Confirm a draft session into a review.
 *
 * Idempotent: calling confirm twice on the same draft while a pending review
 * already exists returns that existing review (with `created: false`) instead
 * of creating a second row or erroring. This matches the operator reality
 * where the "confirm" button may be clicked twice under network latency.
 *
 * Terminal guard: once a draft has been ratified (`status === "applied"`),
 * it is terminal for the review lifecycle. Confirming an applied draft
 * returns `{ ok: false, reason: "draft_terminal" }` — creating a second
 * review would reopen ratified governance state and regress the draft from
 * `applied` back to `review_pending`, which the Phase C model disallows.
 *
 * Discarded drafts are intentionally *not* terminal here: an operator who
 * rejected a draft may want to reconsider the same change set by running
 * the review loop again. That behavior is covered by existing tests and
 * is preserved.
 *
 * Returns `{ ok: false, reason: "draft_not_found" }` when the referenced
 * draft session does not exist.
 */
export function createWorkflowReviewFromDraft(
  params: ConfirmDraftIntoReviewParams,
  dbOverride?: DatabaseSync,
): ConfirmDraftResult {
  const db = dbOverride ?? getDb(params.projectId);
  const draft = getWorkflowDraftSessionRecord(params.projectId, params.draftSessionId, db);
  if (!draft) return { ok: false, reason: "draft_not_found" };

  if (draft.status === "applied") {
    return { ok: false, reason: "draft_terminal", currentStatus: draft.status };
  }

  // Idempotency: if a pending review already exists for this draft, return it.
  const existingPending = db.prepare(`
    SELECT * FROM workflow_reviews
     WHERE project_id = ? AND draft_session_id = ? AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1
  `).get(params.projectId, params.draftSessionId) as WorkflowReviewRow | undefined;
  if (existingPending) {
    return { ok: true, created: false, record: rowToRecord(existingPending) };
  }

  const overlays = diffDraftWorkflow(draft);
  const changeSummary = summarizeOverlays(overlays);
  const id = crypto.randomUUID();
  const now = Date.now();
  const title = params.title?.trim() || draft.title;
  const summary = params.summary?.trim() || draft.description;

  db.prepare(`
    INSERT INTO workflow_reviews (
      id, project_id, draft_session_id, workflow_id, title, summary, status,
      confirmed_by, resolved_by, decision_notes, change_summary, overlays_snapshot,
      affected_stage_count, created_at, resolved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, ?, NULL)
  `).run(
    id,
    params.projectId,
    params.draftSessionId,
    draft.workflowId,
    title,
    summary ?? null,
    params.confirmedBy,
    JSON.stringify(changeSummary),
    JSON.stringify(overlays),
    overlays.length,
    now,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.confirmedBy,
    action: "workflow_review.confirm",
    targetType: "workflow_review",
    targetId: id,
    detail: title,
  }, db);

  // Transition the draft session to `review_pending` if it isn't already.
  if (draft.status !== "review_pending") {
    setWorkflowDraftSessionStatus(
      params.projectId,
      params.draftSessionId,
      "review_pending",
      params.confirmedBy,
      db,
    );
  }

  const row = db.prepare(
    "SELECT * FROM workflow_reviews WHERE id = ? AND project_id = ?",
  ).get(id, params.projectId) as WorkflowReviewRow;
  return { ok: true, created: true, record: rowToRecord(row) };
}

// ---------------------------------------------------------------------------
// Approve / reject — resolve a review
// ---------------------------------------------------------------------------

export type ResolveWorkflowReviewParams = {
  projectId: string;
  reviewId: string;
  actor: string;
  decisionNotes?: string;
};

export type ResolveWorkflowReviewResult =
  | { ok: true; record: WorkflowReviewRecord }
  | { ok: false; reason: "not_found" | "not_pending"; currentStatus?: WorkflowReviewStatus };

export function approveWorkflowReview(
  params: ResolveWorkflowReviewParams,
  dbOverride?: DatabaseSync,
): ResolveWorkflowReviewResult {
  return resolveReviewInternal(params, "approved", dbOverride);
}

export function rejectWorkflowReview(
  params: ResolveWorkflowReviewParams,
  dbOverride?: DatabaseSync,
): ResolveWorkflowReviewResult {
  return resolveReviewInternal(params, "rejected", dbOverride);
}

function resolveReviewInternal(
  params: ResolveWorkflowReviewParams,
  decision: Exclude<WorkflowReviewStatus, "pending">,
  dbOverride?: DatabaseSync,
): ResolveWorkflowReviewResult {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getWorkflowReviewRecord(params.projectId, params.reviewId, db);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status !== "pending") {
    return { ok: false, reason: "not_pending", currentStatus: current.status };
  }

  const now = Date.now();
  db.prepare(`
    UPDATE workflow_reviews
       SET status = ?, resolved_by = ?, decision_notes = ?, resolved_at = ?
     WHERE id = ? AND project_id = ? AND status = 'pending'
  `).run(
    decision,
    params.actor,
    params.decisionNotes ?? null,
    now,
    params.reviewId,
    params.projectId,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.actor,
    action: decision === "approved" ? "workflow_review.approve" : "workflow_review.reject",
    targetType: "workflow_review",
    targetId: params.reviewId,
    detail: params.decisionNotes,
  }, db);

  // Move the linked draft session into its resolved terminal state.
  // NOTE: on "approved" we mark the draft as `applied` meaning ratified, not
  // materialized. The actual rewrite of the live workflow from the draft
  // snapshot is deferred — a later phase should hook into the approve path
  // here and perform the materialization under its own audit/lock rules.
  // TODO(Phase D/E): apply approved draft onto the live workflow.
  const draftTargetStatus = decision === "approved" ? "applied" : "discarded";
  setWorkflowDraftSessionStatus(
    params.projectId,
    current.draftSessionId,
    draftTargetStatus,
    params.actor,
    db,
  );

  const updated = getWorkflowReviewRecord(params.projectId, params.reviewId, db);
  if (!updated) return { ok: false, reason: "not_found" };
  return { ok: true, record: updated };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getWorkflowReviewRecord(
  projectId: string,
  reviewId: string,
  dbOverride?: DatabaseSync,
): WorkflowReviewRecord | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM workflow_reviews WHERE id = ? AND project_id = ?",
  ).get(reviewId, projectId) as WorkflowReviewRow | undefined;
  return row ? rowToRecord(row) : null;
}

export type ListWorkflowReviewParams = {
  workflowId?: string;
  draftSessionId?: string;
  includeStatuses?: WorkflowReviewStatus[];
};

export function listWorkflowReviewRecords(
  projectId: string,
  params: ListWorkflowReviewParams = {},
  dbOverride?: DatabaseSync,
): WorkflowReviewRecord[] {
  const db = dbOverride ?? getDb(projectId);
  const clauses: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (params.workflowId) {
    clauses.push("workflow_id = ?");
    values.push(params.workflowId);
  }
  if (params.draftSessionId) {
    clauses.push("draft_session_id = ?");
    values.push(params.draftSessionId);
  }

  const includeStatuses = params.includeStatuses ?? ["pending"];
  if (includeStatuses.length > 0) {
    clauses.push(`status IN (${includeStatuses.map(() => "?").join(", ")})`);
    values.push(...includeStatuses);
  }

  const rows = db.prepare(`
    SELECT * FROM workflow_reviews
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
  `).all(...values) as WorkflowReviewRow[];

  return rows.map(rowToRecord);
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

export function toWorkflowReviewSummary(
  projectId: string,
  record: WorkflowReviewRecord,
  workflowName: string,
): WorkflowReviewSummary {
  return {
    scope: {
      kind: "review",
      domainId: projectId,
      workflowId: record.workflowId,
      reviewId: record.id,
    },
    id: record.id,
    workflowId: record.workflowId,
    workflowName,
    draftSessionId: record.draftSessionId,
    title: record.title,
    summary: record.summary,
    status: record.status,
    changeSummary: record.changeSummary,
    affectedStageCount: record.affectedStageCount,
    confirmedBy: record.confirmedBy,
    resolvedBy: record.resolvedBy,
    decisionNotes: record.decisionNotes,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
  };
}

export function toWorkflowReviewDetail(
  projectId: string,
  record: WorkflowReviewRecord,
  draft: WorkflowDraftSessionRecord,
): WorkflowReview {
  const draftSummary = toWorkflowDraftSessionSummary(projectId, draft);
  return {
    ...toWorkflowReviewSummary(projectId, record, draft.draftWorkflow.name),
    overlays: record.overlays,
    draftSession: draftSummary,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function rowToRecord(row: WorkflowReviewRow): WorkflowReviewRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    draftSessionId: row.draft_session_id,
    workflowId: row.workflow_id,
    title: row.title,
    summary: row.summary ?? undefined,
    status: row.status,
    confirmedBy: row.confirmed_by,
    resolvedBy: row.resolved_by ?? undefined,
    decisionNotes: row.decision_notes ?? undefined,
    changeSummary: JSON.parse(row.change_summary) as WorkflowDraftChangeSummary,
    overlays: JSON.parse(row.overlays_snapshot) as WorkflowDraftStageOverlay[],
    affectedStageCount: row.affected_stage_count,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
