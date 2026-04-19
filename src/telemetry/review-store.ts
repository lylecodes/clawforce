/**
 * Clawforce — Manager review store
 *
 * Records manager review outcomes for tasks.
 * Provides retrieval and aggregate stats.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import type { ReviewReasonCode } from "../types.js";

// --- Types ---

export type ReviewParams = {
  projectId: string;
  taskId: string;
  reviewerAgentId: string;
  sessionKey?: string;
  verdict: "approved" | "rejected" | "revision_needed" | "deferred";
  reasonCode?: ReviewReasonCode;
  reasoning?: string;
  criteriaChecked?: string[];
  followUpTaskId?: string;
  revisionNotes?: string;
  reviewDurationMs?: number;
};

export type ManagerReview = ReviewParams & {
  id: string;
  createdAt: number;
};

export type ReviewStats = {
  total: number;
  approved: number;
  rejected: number;
  revisionNeeded: number;
  deferred: number;
  approvalRate: number;
};

// --- Core functions ---

/**
 * Record a manager review for a task.
 */
export function recordReview(
  params: ReviewParams,
  dbOverride?: DatabaseSync,
): ManagerReview {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO manager_reviews (
      id, project_id, task_id, reviewer_agent_id, session_key,
      verdict, reason_code, reasoning, criteria_checked,
      follow_up_task_id, revision_notes, review_duration_ms,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.projectId, params.taskId, params.reviewerAgentId,
    params.sessionKey ?? null,
    params.verdict, params.reasonCode ?? null, params.reasoning ?? null,
    params.criteriaChecked ? JSON.stringify(params.criteriaChecked) : null,
    params.followUpTaskId ?? null, params.revisionNotes ?? null,
    params.reviewDurationMs ?? null,
    now,
  );

  return { ...params, id, createdAt: now };
}

/**
 * Get all reviews for a specific task.
 */
export function getReviewsForTask(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): ManagerReview[] {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(`
    SELECT * FROM manager_reviews
    WHERE project_id = ? AND task_id = ?
    ORDER BY created_at DESC
  `).all(projectId, taskId) as Record<string, unknown>[];

  return rows.map(mapReviewRow);
}

/**
 * Get aggregate review statistics for a project.
 */
export function getReviewStats(
  projectId: string,
  dbOverride?: DatabaseSync,
): ReviewStats {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(`
    SELECT verdict, COUNT(*) as cnt
    FROM manager_reviews
    WHERE project_id = ?
    GROUP BY verdict
  `).all(projectId) as { verdict: string; cnt: number }[];

  let approved = 0;
  let rejected = 0;
  let revisionNeeded = 0;
  let deferred = 0;

  for (const row of rows) {
    switch (row.verdict) {
      case "approved": approved = row.cnt; break;
      case "rejected": rejected = row.cnt; break;
      case "revision_needed": revisionNeeded = row.cnt; break;
      case "deferred": deferred = row.cnt; break;
    }
  }

  const total = approved + rejected + revisionNeeded + deferred;
  return {
    total,
    approved,
    rejected,
    revisionNeeded,
    deferred,
    approvalRate: total > 0 ? approved / total : 0,
  };
}

// --- Helpers ---

function mapReviewRow(row: Record<string, unknown>): ManagerReview {
  let criteriaChecked: string[] | undefined;
  if (row.criteria_checked) {
    try {
      criteriaChecked = JSON.parse(row.criteria_checked as string);
    } catch { /* empty */ }
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    taskId: row.task_id as string,
    reviewerAgentId: row.reviewer_agent_id as string,
    sessionKey: (row.session_key as string) ?? undefined,
    verdict: row.verdict as ManagerReview["verdict"],
    reasonCode: (row.reason_code as ReviewReasonCode) ?? undefined,
    reasoning: (row.reasoning as string) ?? undefined,
    criteriaChecked,
    followUpTaskId: (row.follow_up_task_id as string) ?? undefined,
    revisionNotes: (row.revision_notes as string) ?? undefined,
    reviewDurationMs: (row.review_duration_ms as number) ?? undefined,
    createdAt: row.created_at as number,
  };
}
