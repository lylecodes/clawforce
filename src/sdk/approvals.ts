/**
 * Clawforce SDK — Approvals Namespace
 *
 * Provides human-in-the-loop governance: agents propose actions, humans
 * approve or reject them. Wraps internal approval functions with a clean
 * public API surface.
 *
 * Two layers are exposed:
 *   1. Proposals — the high-level human approval request (approve/reject/pending)
 *   2. Intents   — the low-level tool call intent tied to a proposal
 *
 * When a `db` override is passed to any method it is used instead of the
 * default on-disk database. This is intended for testing only.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import {
  listPendingProposals,
  approveProposal,
  rejectProposal,
  getProposal,
} from "../approval/resolve.js";
import {
  getApprovedIntentsForTask,
  getIntentByProposalForProject,
} from "../approval/intent-store.js";
import type { Proposal } from "../approval/resolve.js";
import type { ToolCallIntent } from "../approval/intent-store.js";

// Re-export types for consumers
export type { Proposal, ToolCallIntent };

export type ResolveDecision = "approved" | "rejected";

export type ResolvedFilters = {
  status?: ResolveDecision;
  limit?: number;
};

export class ApprovalsNamespace {
  constructor(readonly domain: string) {}

  /**
   * List all pending proposals awaiting human approval.
   *
   * When `db` is provided it is used directly (test path). Otherwise
   * the internal production DB for this domain is used.
   */
  pending(opts?: { db?: DatabaseSync }): Proposal[] {
    if (opts?.db) {
      return (opts.db
        .prepare(
          "SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC",
        )
        .all(this.domain) as Proposal[]);
    }
    return listPendingProposals(this.domain);
  }

  /**
   * List resolved proposals (approved or rejected).
   *
   * @param filters.status - Filter by resolution status (approved/rejected)
   * @param filters.limit  - Max results to return
   * @param filters.db     - Optional DB override for testing
   */
  resolved(filters?: ResolvedFilters & { db?: DatabaseSync }): Proposal[] {
    const db: DatabaseSync = filters?.db ?? getDb(this.domain);
    const statusClause = filters?.status
      ? `AND status = '${filters.status}'`
      : `AND status IN ('approved', 'rejected')`;
    const limitClause =
      typeof filters?.limit === "number" ? `LIMIT ${filters.limit}` : "";
    const sql = `SELECT * FROM proposals WHERE project_id = ? ${statusClause} ORDER BY resolved_at DESC ${limitClause}`;
    return db.prepare(sql).all(this.domain) as Proposal[];
  }

  /**
   * Resolve a proposal: approve or reject it, optionally with feedback.
   *
   * When `db` is provided the update is applied directly (test path,
   * no audit log or Telegram side-effects). Otherwise the full internal
   * approve/reject path runs (audit log, notification edit, event emission).
   *
   * Returns the updated Proposal, or null if the proposal was not found
   * or was not in pending state.
   */
  resolve(
    proposalId: string,
    decision: ResolveDecision,
    feedback?: string,
    opts?: { db?: DatabaseSync },
  ): Proposal | null {
    if (opts?.db) {
      const db = opts.db;
      const now = Date.now();
      const result = db
        .prepare(
          "UPDATE proposals SET status = ?, user_feedback = ?, resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
        )
        .run(decision, feedback ?? null, now, proposalId, this.domain) as {
        changes: number;
      };
      if (result.changes === 0) return null;
      return db
        .prepare("SELECT * FROM proposals WHERE id = ? AND project_id = ?")
        .get(proposalId, this.domain) as Proposal | null;
    }

    return decision === "approved"
      ? approveProposal(this.domain, proposalId, feedback)
      : rejectProposal(this.domain, proposalId, feedback);
  }

  /**
   * Get a single proposal by ID.
   *
   * Returns undefined if no proposal with the given ID exists for this domain.
   *
   * When `db` is provided it is queried directly.
   */
  get(proposalId: string, opts?: { db?: DatabaseSync }): Proposal | undefined {
    if (opts?.db) {
      return (
        (opts.db
          .prepare(
            "SELECT * FROM proposals WHERE id = ? AND project_id = ?",
          )
          .get(proposalId, this.domain) as Proposal | undefined) ?? undefined
      );
    }
    return getProposal(this.domain, proposalId) ?? undefined;
  }

  /**
   * Get all approved tool call intents for a task.
   *
   * Used by agents to check which previously-blocked tool calls were
   * approved so the task can be re-dispatched with pre-approvals.
   *
   * When `db` is provided it is queried directly.
   */
  approvedForTask(
    taskId: string,
    opts?: { db?: DatabaseSync },
  ): ToolCallIntent[] {
    if (opts?.db) {
      return (opts.db
        .prepare(
          "SELECT * FROM tool_call_intents WHERE project_id = ? AND task_id = ? AND status = 'approved' ORDER BY created_at DESC",
        )
        .all(this.domain, taskId) as Record<string, unknown>[]).map(mapIntentRow);
    }
    return getApprovedIntentsForTask(this.domain, taskId);
  }

  /**
   * Get a tool call intent by its proposal ID.
   *
   * Returns undefined if not found.
   *
   * When `db` is provided it is queried directly.
   */
  intentForProposal(
    proposalId: string,
    opts?: { db?: DatabaseSync },
  ): ToolCallIntent | undefined {
    if (opts?.db) {
      const row = opts.db
        .prepare(
          "SELECT * FROM tool_call_intents WHERE proposal_id = ? AND project_id = ? LIMIT 1",
        )
        .get(proposalId, this.domain) as Record<string, unknown> | undefined;
      return row ? mapIntentRow(row) : undefined;
    }
    return getIntentByProposalForProject(this.domain, proposalId) ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapIntentRow(row: Record<string, unknown>): ToolCallIntent {
  return {
    id: row.id as string,
    proposalId: row.proposal_id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    taskId: (row.task_id as string) ?? undefined,
    toolName: row.tool_name as string,
    toolParams: row.tool_params ? JSON.parse(row.tool_params as string) : {},
    category: row.category as string,
    riskTier: row.risk_tier as string,
    status: row.status as ToolCallIntent["status"],
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number) ?? undefined,
  };
}
