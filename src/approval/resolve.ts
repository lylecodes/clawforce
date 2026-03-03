/**
 * Clawforce — Approval resolution
 *
 * Handles approve/reject actions on proposals.
 * Called from messaging callbacks (Telegram inline buttons, text replies).
 */

import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";

export type ProposalStatus = "pending" | "approved" | "rejected";

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
  created_at: number;
  resolved_at: number | null;
};

/**
 * Get a proposal by ID.
 */
export function getProposal(projectId: string, proposalId: string): Proposal | null {
  const db = getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM proposals WHERE id = ? AND project_id = ?",
  ).get(proposalId, projectId) as Proposal | undefined;
  return row ?? null;
}

/**
 * List pending proposals for a project.
 */
export function listPendingProposals(projectId: string): Proposal[] {
  const db = getDb(projectId);
  return db.prepare(
    "SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC",
  ).all(projectId) as Proposal[];
}

/**
 * Approve a proposal.
 */
export function approveProposal(projectId: string, proposalId: string, feedback?: string): Proposal | null {
  const db = getDb(projectId);
  const now = Date.now();

  const result = db.prepare(
    "UPDATE proposals SET status = 'approved', user_feedback = ?, resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
  ).run(feedback ?? null, now, proposalId, projectId);

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

  // Emit event so the router can re-attempt the gated action
  try {
    const proposal = getProposal(projectId, proposalId);
    if (proposal) {
      ingestEvent(projectId, "proposal_approved" as Parameters<typeof ingestEvent>[1], "internal", {
        proposalId,
        proposedBy: proposal.proposed_by,
        riskTier: proposal.risk_tier,
        policySnapshot: proposal.approval_policy_snapshot,
      }, `proposal-approved:${proposalId}`);
    }
  } catch (err) {
    safeLog("approval.approve.event", err);
  }

  return getProposal(projectId, proposalId);
}

/**
 * Reject a proposal.
 */
export function rejectProposal(projectId: string, proposalId: string, feedback?: string): Proposal | null {
  const db = getDb(projectId);
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

  return getProposal(projectId, proposalId);
}
