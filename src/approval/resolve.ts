/**
 * Clawforce — Approval resolution
 *
 * Handles approve/reject actions on proposals.
 * Called from messaging callbacks (Telegram inline buttons, text replies).
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import {
  clearControllerGenerationRequest,
  getCurrentControllerGeneration,
  requestControllerGeneration,
} from "../runtime/controller-leases.js";
import { getApprovalNotifier } from "./notify.js";

export type ProposalStatus = "pending" | "approved" | "rejected";
export type ProposalExecutionStatus = "pending" | "applied" | "failed";

export type Proposal = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  proposed_by: string;
  session_key: string | null;
  status: ProposalStatus;
  approval_policy_snapshot: string | null;
  user_feedback: string | null;
  risk_tier: string | null;
  entity_type: string | null;
  entity_id: string | null;
  origin: string | null;
  reasoning: string | null;
  related_goal_id: string | null;
  created_at: number;
  resolved_at: number | null;
  execution_status: ProposalExecutionStatus | null;
  execution_requested_at: number | null;
  execution_updated_at: number | null;
  execution_error: string | null;
  execution_task_id: string | null;
  execution_required_generation: string | null;
};

export type CreateProposalParams = {
  projectId: string;
  title: string;
  description?: string;
  proposedBy: string;
  sessionKey?: string;
  approvalPolicySnapshot?: string;
  riskTier?: string;
  entityType?: string;
  entityId?: string;
  origin?: string;
  reasoning?: string;
  relatedGoalId?: string;
};

export function createProposal(params: CreateProposalParams, dbOverride?: DatabaseSync): Proposal {
  const db = dbOverride ?? getDb(params.projectId);
  const proposalId = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO proposals (
      id, project_id, title, description, proposed_by, session_key, status,
      approval_policy_snapshot, risk_tier, created_at, entity_type, entity_id,
      origin, reasoning, related_goal_id
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    params.projectId,
    params.title,
    params.description ?? null,
    params.proposedBy,
    params.sessionKey ?? null,
    params.approvalPolicySnapshot ?? null,
    params.riskTier ?? null,
    now,
    params.entityType ?? null,
    params.entityId ?? null,
    params.origin ?? "risk_gate",
    params.reasoning ?? null,
    params.relatedGoalId ?? null,
  );

  const proposal = getProposal(params.projectId, proposalId, db);
  if (!proposal) {
    throw new Error(`Failed to create proposal ${proposalId}`);
  }

  return proposal;
}

export function markProposalExecutionPending(
  projectId: string,
  proposalId: string,
  params: {
    requiredGeneration?: string | null;
    taskId?: string | null;
  } = {},
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  db.prepare(`
    UPDATE proposals
    SET execution_status = 'pending',
        execution_requested_at = COALESCE(execution_requested_at, ?),
        execution_updated_at = ?,
        execution_error = NULL,
        execution_task_id = ?,
        execution_required_generation = COALESCE(?, execution_required_generation)
    WHERE id = ? AND project_id = ?
  `).run(
    now,
    now,
    params.taskId ?? null,
    params.requiredGeneration ?? null,
    proposalId,
    projectId,
  );
}

export function markProposalExecutionApplied(
  projectId: string,
  proposalId: string,
  params: {
    taskId?: string | null;
  } = {},
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const current = getProposal(projectId, proposalId, db);
  db.prepare(`
    UPDATE proposals
    SET execution_status = 'applied',
        execution_updated_at = ?,
        execution_error = NULL,
        execution_task_id = COALESCE(?, execution_task_id)
    WHERE id = ? AND project_id = ?
  `).run(now, params.taskId ?? null, proposalId, projectId);
  clearControllerGenerationRequest(projectId, {
    generation: current?.execution_required_generation ?? null,
  }, db);
}

export function markProposalExecutionFailed(
  projectId: string,
  proposalId: string,
  error: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const current = getProposal(projectId, proposalId, db);
  db.prepare(`
    UPDATE proposals
    SET execution_status = 'failed',
        execution_updated_at = ?,
        execution_error = ?
    WHERE id = ? AND project_id = ?
  `).run(now, error, proposalId, projectId);
  clearControllerGenerationRequest(projectId, {
    generation: current?.execution_required_generation ?? null,
  }, db);
}

/**
 * Get a proposal by ID.
 */
export function getProposal(projectId: string, proposalId: string, dbOverride?: DatabaseSync): Proposal | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM proposals WHERE id = ? AND project_id = ?",
  ).get(proposalId, projectId) as Proposal | undefined;
  return row ?? null;
}

/**
 * List pending proposals for a project.
 */
export function listPendingProposals(projectId: string, dbOverride?: DatabaseSync): Proposal[] {
  const db = dbOverride ?? getDb(projectId);
  return db.prepare(
    "SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC",
  ).all(projectId) as Proposal[];
}

/**
 * Approve a proposal.
 */
export function approveProposal(projectId: string, proposalId: string, feedback?: string, dbOverride?: DatabaseSync): Proposal | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const requiredGeneration = getCurrentControllerGeneration();

  const result = db.prepare(
    `UPDATE proposals
       SET status = 'approved',
           user_feedback = ?,
           resolved_at = ?,
           execution_status = 'pending',
           execution_requested_at = ?,
           execution_updated_at = ?,
           execution_error = NULL,
           execution_task_id = NULL,
           execution_required_generation = ?
     WHERE id = ? AND project_id = ? AND status = 'pending'`,
  ).run(feedback ?? null, now, now, now, requiredGeneration, proposalId, projectId);

  if ((result as { changes: number }).changes === 0) return null;

  try {
    writeAuditEntry({
      projectId,
      actor: "user",
      action: "proposal.approve",
      targetType: "proposal",
      targetId: proposalId,
      detail: feedback,
    });
  } catch (err) {
    safeLog("approval.approve.audit", err);
  }

  // Edit Telegram notification to show resolution
  const approveNotifier = getApprovalNotifier();
  if (approveNotifier) {
    approveNotifier.editProposalMessage(proposalId, projectId, "approved", feedback)
      .catch(err => safeLog("approval.approve.editMessage", err));
  }

  // Emit event so the router can re-attempt the gated action
  try {
    const proposal = getProposal(projectId, proposalId, db);
    if (proposal) {
      requestControllerGeneration(projectId, {
        generation: requiredGeneration,
        requestedBy: "user",
        reason: `proposal_approved:${proposalId}`,
        metadata: {
          proposalId,
          origin: proposal.origin ?? undefined,
        },
      }, db);
      ingestEvent(projectId, "proposal_approved", "internal", {
        proposalId,
        proposedBy: proposal.proposed_by,
        riskTier: proposal.risk_tier,
        policySnapshot: proposal.approval_policy_snapshot,
        requiredGeneration,
      }, `proposal-approved:${proposalId}`, db);
    }
  } catch (err) {
    safeLog("approval.approve.event", err);
  }

  return getProposal(projectId, proposalId, db);
}

/**
 * Reject a proposal.
 */
export function rejectProposal(projectId: string, proposalId: string, feedback?: string, dbOverride?: DatabaseSync): Proposal | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const result = db.prepare(
    "UPDATE proposals SET status = 'rejected', user_feedback = ?, resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
  ).run(feedback ?? null, now, proposalId, projectId);

  if ((result as { changes: number }).changes === 0) return null;

  try {
    writeAuditEntry({
      projectId,
      actor: "user",
      action: "proposal.reject",
      targetType: "proposal",
      targetId: proposalId,
      detail: feedback,
    });
  } catch (err) {
    safeLog("approval.reject.audit", err);
  }

  // Edit Telegram notification to show rejection
  const rejectNotifier = getApprovalNotifier();
  if (rejectNotifier) {
    rejectNotifier.editProposalMessage(proposalId, projectId, "rejected", feedback)
      .catch(err => safeLog("approval.reject.editMessage", err));
  }

  // Emit proposal_rejected event
  try {
    ingestEvent(projectId, "proposal_rejected", "internal", {
      proposalId,
      feedback,
    }, `proposal-rejected:${proposalId}`, db);
  } catch (err) {
    safeLog("approval.reject.event", err);
  }

  return getProposal(projectId, proposalId, db);
}
