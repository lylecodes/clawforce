/**
 * Clawforce — Attention Item Builder
 *
 * Scans current domain state and builds a prioritized list of attention items.
 * Designed to be cheap — reuses existing query functions, never throws.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { listPendingProposals } from "../approval/resolve.js";
import { getBudgetStatus } from "../budget-windows.js";
import { isEmergencyStopActive } from "../safety.js";
import { listTasks } from "../tasks/ops.js";
import { listRecentChanges } from "../history/store.js";
import { getEntity, listEntityIssues } from "../entities/ops.js";
import { listSimulatedActions } from "../execution/simulated-actions.js";
import type { EntityIssue } from "../types.js";
import type {
  AttentionAutomationState,
  AttentionItem,
  AttentionKind,
  AttentionSeverity,
  AttentionSummary,
  AttentionUrgency,
  DecisionInboxSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${_idCounter++}`;
}

const ACTIONABILITY_ORDER: AttentionUrgency[] = ["action-needed", "watching", "fyi"];
const SEVERITY_ORDER: AttentionSeverity[] = ["critical", "high", "normal", "low"];

function severityRank(severity: AttentionSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function urgencyRank(urgency: AttentionUrgency): number {
  return ACTIONABILITY_ORDER.indexOf(urgency);
}

function urgencyToSeverity(urgency: AttentionUrgency): AttentionSeverity {
  switch (urgency) {
    case "action-needed": return "high";
    case "watching": return "normal";
    case "fyi": return "low";
  }
}

function proposalRiskToSeverity(riskTier: string | null | undefined): AttentionSeverity {
  switch (riskTier) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium": return "normal";
    case "low": return "low";
    default: return "high";
  }
}

function issueSeverityToFeedSeverity(severity: EntityIssue["severity"]): AttentionSeverity {
  switch (severity) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium": return "normal";
    case "low": return "low";
  }
}

function buildPreview(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function summarizeWorkflowMutationQueueError(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;

  const raw = value.trim();
  const normalized = buildPreview(raw);
  const looksLikeLaunchTranscript = /Reading additional input from stdin|OpenAI Codex v\d|<system_context>|tokens used/i.test(raw);

  if (/Task remained in IN_PROGRESS after inline dispatch/i.test(raw) && /Inline dispatch returned no summary/i.test(raw)) {
    return looksLikeLaunchTranscript
      ? "Task remained in IN_PROGRESS after inline dispatch; the captured queue error also included a raw Codex launch transcript."
      : "Task remained in IN_PROGRESS after inline dispatch: Inline dispatch returned no summary.";
  }

  if (/Inline dispatch returned no summary/i.test(raw)) {
    return looksLikeLaunchTranscript
      ? "Inline dispatch returned no summary; the captured queue error also included a raw Codex launch transcript."
      : "Inline dispatch returned no summary.";
  }

  if (/Dispatch retries exhausted/i.test(raw)) {
    return "Dispatch retries exhausted.";
  }

  if (looksLikeLaunchTranscript) {
    return "Captured queue error is a raw Codex launch transcript rather than a concise dispatch failure. Inspect session archives for full details.";
  }

  return normalized;
}

type ProposalAttentionLike = {
  id: string;
  title: string;
  description: string | null;
  proposed_by: string;
  status?: string | null;
  risk_tier: string | null;
  origin?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  reasoning?: string | null;
  created_at?: number;
  execution_status?: string | null;
  execution_task_id?: string | null;
  execution_task_title?: string | null;
  execution_task_state?: string | null;
};

function classifyProposalAttention(proposal: ProposalAttentionLike): {
  kind: AttentionKind;
  urgency: AttentionUrgency;
  severity: AttentionSeverity;
  automationState: AttentionAutomationState;
  recommendedAction: string;
  requiresDecision: boolean;
} {
  const origin = proposal.origin?.toLowerCase() ?? "risk_gate";
  const severity = proposalRiskToSeverity(proposal.risk_tier);
  const highRisk = severity === "critical" || severity === "high";

  if (origin === "lead_proposal" && !highRisk) {
    return {
      kind: "proposal",
      urgency: "watching",
      severity,
      automationState: "needs_human",
      requiresDecision: false,
      recommendedAction: "Review the recommendation and decide whether to schedule or approve the next step.",
    };
  }

  if (origin === "entity_transition") {
    return {
      kind: "approval",
      urgency: "action-needed",
      severity,
      automationState: "needs_human",
      requiresDecision: true,
      recommendedAction: "Review the entity evidence and approve or reject the requested transition.",
    };
  }

  return {
    kind: "approval",
    urgency: "action-needed",
    severity,
    automationState: "needs_human",
    requiresDecision: true,
    recommendedAction: "Review the proposal evidence and either approve or reject it.",
  };
}

function getProposalForAttention(
  projectId: string,
  proposalId: string,
  db: DatabaseSync,
): ProposalAttentionLike | null {
  try {
    const row = db.prepare(
      `SELECT p.id, p.title, p.description, p.proposed_by, p.status, p.risk_tier, p.origin, p.entity_type, p.entity_id, p.reasoning, p.created_at,
              p.execution_status, p.execution_task_id, t.title as execution_task_title, t.state as execution_task_state
       FROM proposals p
       LEFT JOIN tasks t
         ON t.project_id = p.project_id
        AND t.id = p.execution_task_id
       WHERE p.project_id = ? AND p.id = ?
       LIMIT 1`,
    ).get(projectId, proposalId) as ProposalAttentionLike | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function getWorkflowMutationProposalForIssue(
  projectId: string,
  issueId: string,
  sourceTaskId: string | undefined,
  db: DatabaseSync,
): ProposalAttentionLike | null {
  try {
    const row = db.prepare(
      `SELECT p.id, p.title, p.description, p.proposed_by, p.status, p.risk_tier, p.origin, p.entity_type, p.entity_id, p.reasoning, p.created_at,
              p.execution_status, p.execution_task_id, t.title as execution_task_title, t.state as execution_task_state
       FROM proposals p
       LEFT JOIN tasks t
         ON t.project_id = p.project_id
        AND t.id = p.execution_task_id
       WHERE p.project_id = ?
         AND p.origin = 'workflow_mutation'
         AND p.status IN ('pending', 'approved')
         AND (
           json_extract(p.approval_policy_snapshot, '$.sourceIssueId') = ?
           OR (? IS NOT NULL AND json_extract(p.approval_policy_snapshot, '$.sourceTaskId') = ?)
         )
       ORDER BY COALESCE(p.execution_updated_at, p.resolved_at, p.created_at) DESC
       LIMIT 1`,
    ).get(projectId, issueId, sourceTaskId ?? null, sourceTaskId ?? null) as ProposalAttentionLike | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

type IssueRemediationTaskStatus = {
  id: string;
  title: string;
  state: string;
  assignedTo?: string;
  stale: boolean;
  dispatchDeadLetter: boolean;
  recentlyCompleted?: boolean;
  completedFollowUpNeeded?: boolean;
  workflowMutationFollowUpTaskId?: string;
  workflowMutationFollowUpTitle?: string;
  workflowMutationFollowUpState?: string;
};

const RECENT_COMPLETED_REMEDIATION_WINDOW_MS = 15 * 60 * 1000;
const COMPLETED_REMEDIATION_FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

function getIssueRemediationTaskStatus(
  projectId: string,
  issueId: string,
  db: DatabaseSync,
): IssueRemediationTaskStatus | null {
  try {
    const row = db.prepare(
      `SELECT id, title, state, assigned_to, metadata
       FROM tasks
       WHERE project_id = ?
         AND origin = 'reactive'
         AND origin_id = ?
         AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(projectId, issueId) as Record<string, unknown> | undefined;
    if (row) {
      const metadata = row.metadata && typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : {};
      const stale = typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).stale === 1;
      const dispatchDeadLetter = typeof metadata === "object"
        && metadata !== null
        && (
          (metadata as Record<string, unknown>).dispatch_dead_letter === true
          || (metadata as Record<string, unknown>)["$.dispatch_dead_letter"] === true
        );
      const followUp = getActiveWorkflowMutationFollowUp(projectId, metadata, db);
      return {
        id: String(row.id),
        title: String(row.title),
        state: String(row.state),
        assignedTo: typeof row.assigned_to === "string" ? row.assigned_to : undefined,
        stale,
        dispatchDeadLetter,
        workflowMutationFollowUpTaskId: followUp?.id,
        workflowMutationFollowUpTitle: followUp?.title,
        workflowMutationFollowUpState: followUp?.state,
      };
    }
  } catch {
    // Fall through to the recent-completion fallback below.
  }

  try {
    const now = Date.now();
    const row = db.prepare(
      `SELECT id, title, state, assigned_to, metadata, updated_at
       FROM tasks
       WHERE project_id = ?
         AND origin = 'reactive'
         AND origin_id = ?
         AND state = 'DONE'
         AND updated_at >= ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(projectId, issueId, now - COMPLETED_REMEDIATION_FOLLOW_UP_WINDOW_MS) as Record<string, unknown> | undefined;
    if (!row) return null;
    const updatedAt = typeof row.updated_at === "number" ? row.updated_at : null;
    const recentlyCompleted = updatedAt != null && updatedAt >= now - RECENT_COMPLETED_REMEDIATION_WINDOW_MS;
    return {
      id: String(row.id),
      title: String(row.title),
      state: String(row.state),
      assignedTo: typeof row.assigned_to === "string" ? row.assigned_to : undefined,
      stale: false,
      dispatchDeadLetter: false,
      recentlyCompleted,
      completedFollowUpNeeded: !recentlyCompleted,
    };
  } catch {
    return null;
  }
}

function getEntityActivityTaskStatus(
  projectId: string,
  entityId: string,
  issueId: string,
  db: DatabaseSync,
): IssueRemediationTaskStatus | null {
  try {
    const row = db.prepare(
      `SELECT id, title, state, assigned_to, metadata
       FROM tasks
       WHERE project_id = ?
         AND entity_id = ?
         AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
         AND (origin IS NULL OR origin != 'reactive' OR origin_id != ?)
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(projectId, entityId, issueId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === "string"
      ? JSON.parse(row.metadata)
      : {};
    const stale = typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).stale === 1;
    const dispatchDeadLetter = typeof metadata === "object"
      && metadata !== null
      && (
        (metadata as Record<string, unknown>).dispatch_dead_letter === true
        || (metadata as Record<string, unknown>)["$.dispatch_dead_letter"] === true
      );
    return {
      id: String(row.id),
      title: String(row.title),
      state: String(row.state),
      assignedTo: typeof row.assigned_to === "string" ? row.assigned_to : undefined,
      stale,
      dispatchDeadLetter,
    };
  } catch {
    return null;
  }
}

type ActiveWorkflowMutationFollowUp = {
  id: string;
  title: string;
  state: string;
};

type WorkflowMutationExecutionStatus = {
  taskId: string;
  title: string;
  state: string;
  hasActiveSession: boolean;
  latestQueueStatus?: string;
  latestQueueError?: string;
};

function getActiveWorkflowMutationFollowUp(
  projectId: string,
  metadata: unknown,
  db: DatabaseSync,
): ActiveWorkflowMutationFollowUp | null {
  const parsed = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : (metadata && typeof metadata === "string"
      ? JSON.parse(metadata) as Record<string, unknown>
      : null);
  if (!parsed || typeof parsed !== "object") return null;
  const workflowMutation = parsed.workflowMutation;
  if (!workflowMutation || typeof workflowMutation !== "object" || Array.isArray(workflowMutation)) {
    return null;
  }
  const followUpTaskId = (workflowMutation as Record<string, unknown>).followUpTaskId;
  if (typeof followUpTaskId !== "string" || !followUpTaskId.trim()) return null;
  const row = db.prepare(`
    SELECT id, title, state
    FROM tasks
    WHERE project_id = ?
      AND id = ?
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
    LIMIT 1
  `).get(projectId, followUpTaskId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    state: String(row.state),
  };
}

function getWorkflowMutationExecutionStatus(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): WorkflowMutationExecutionStatus | null {
  try {
    const row = db.prepare(`
      SELECT
        t.id,
        t.title,
        t.state,
        EXISTS(
          SELECT 1
          FROM tracked_sessions ts
          WHERE ts.project_id = ?
            AND json_extract(ts.dispatch_context, '$.taskId') = t.id
          LIMIT 1
        ) AS has_active_session,
        (
          SELECT dq.status
          FROM dispatch_queue dq
          WHERE dq.project_id = ?
            AND dq.task_id = t.id
          ORDER BY COALESCE(dq.completed_at, dq.created_at) DESC, dq.created_at DESC
          LIMIT 1
        ) AS latest_queue_status,
        (
          SELECT dq.last_error
          FROM dispatch_queue dq
          WHERE dq.project_id = ?
            AND dq.task_id = t.id
          ORDER BY COALESCE(dq.completed_at, dq.created_at) DESC, dq.created_at DESC
          LIMIT 1
        ) AS latest_queue_error
      FROM tasks t
      WHERE t.project_id = ?
        AND t.id = ?
      LIMIT 1
    `).get(projectId, projectId, projectId, projectId, taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: String(row.id),
      title: String(row.title),
      state: String(row.state),
      hasActiveSession: Number(row.has_active_session ?? 0) === 1,
      latestQueueStatus: typeof row.latest_queue_status === "string" ? row.latest_queue_status : undefined,
      latestQueueError: typeof row.latest_queue_error === "string" ? row.latest_queue_error : undefined,
    };
  } catch {
    return null;
  }
}

function getWorkflowMutationFollowUpExecutionStatus(
  projectId: string,
  sourceTaskId: string,
  db: DatabaseSync,
): WorkflowMutationExecutionStatus | null {
  try {
    const row = db.prepare(`
      SELECT
        t.id,
        t.title,
        t.state,
        EXISTS(
          SELECT 1
          FROM tracked_sessions ts
          WHERE ts.project_id = ?
            AND json_extract(ts.dispatch_context, '$.taskId') = t.id
          LIMIT 1
        ) AS has_active_session,
        (
          SELECT dq.status
          FROM dispatch_queue dq
          WHERE dq.project_id = ?
            AND dq.task_id = t.id
          ORDER BY COALESCE(dq.completed_at, dq.created_at) DESC, dq.created_at DESC
          LIMIT 1
        ) AS latest_queue_status,
        (
          SELECT dq.last_error
          FROM dispatch_queue dq
          WHERE dq.project_id = ?
            AND dq.task_id = t.id
          ORDER BY COALESCE(dq.completed_at, dq.created_at) DESC, dq.created_at DESC
          LIMIT 1
        ) AS latest_queue_error
      FROM tasks t
      WHERE t.project_id = ?
        AND t.id != ?
        AND t.state NOT IN ('DONE', 'FAILED', 'CANCELLED')
        AND json_extract(t.metadata, '$.sourceTaskId') = ?
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT 1
    `).get(projectId, projectId, projectId, projectId, sourceTaskId, sourceTaskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: String(row.id),
      title: String(row.title),
      state: String(row.state),
      hasActiveSession: Number(row.has_active_session ?? 0) === 1,
      latestQueueStatus: typeof row.latest_queue_status === "string" ? row.latest_queue_status : undefined,
      latestQueueError: typeof row.latest_queue_error === "string" ? row.latest_queue_error : undefined,
    };
  } catch {
    return null;
  }
}

function isWorkflowMutationExecutionBlocked(
  execution: WorkflowMutationExecutionStatus | null,
): boolean {
  if (!execution) return false;
  if (execution.hasActiveSession) return false;
  if (execution.latestQueueStatus === "failed") return true;
  return execution.state === "BLOCKED" || execution.state === "FAILED";
}

function sortItems(items: AttentionItem[]): AttentionItem[] {
  return items.sort((a, b) => {
    const urgencyDiff = urgencyRank(a.urgency) - urgencyRank(b.urgency);
    if (urgencyDiff !== 0) return urgencyDiff;
    const severityDiff = severityRank(a.severity) - severityRank(b.severity);
    if (severityDiff !== 0) return severityDiff;
    return b.updatedAt - a.updatedAt;
  });
}

function item(
  projectId: string,
  urgency: AttentionUrgency,
  category: string,
  title: string,
  summary: string,
  destination: string,
  focusContext?: Record<string, string>,
  metadata?: Record<string, unknown>,
  extras?: Partial<AttentionItem>,
): AttentionItem {
  const now = Date.now();
  return {
    id: extras?.id ?? makeId(category),
    projectId,
    urgency,
    actionability: extras?.actionability ?? urgency,
    kind: extras?.kind ?? "info",
    severity: extras?.severity ?? urgencyToSeverity(urgency),
    automationState: extras?.automationState ?? "auto_handling",
    category,
    title,
    summary,
    destination,
    focusContext,
    detectedAt: extras?.detectedAt ?? now,
    updatedAt: extras?.updatedAt ?? extras?.detectedAt ?? now,
    entityType: extras?.entityType,
    entityId: extras?.entityId,
    taskId: extras?.taskId,
    proposalId: extras?.proposalId,
    issueId: extras?.issueId,
    simulatedActionId: extras?.simulatedActionId,
    sourceType: extras?.sourceType,
    sourceId: extras?.sourceId,
    recommendedAction: extras?.recommendedAction,
    evidence: extras?.evidence,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectApprovals(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const proposals = listPendingProposals(projectId);
    for (const p of proposals) {
      const classification = classifyProposalAttention(p);
      items.push(item(
        projectId,
        classification.urgency,
        classification.kind === "proposal" ? "proposal" : "approval",
        classification.kind === "proposal" ? `Proposal: ${p.title}` : `Approval required: ${p.title}`,
        p.description ?? `Proposed by ${p.proposed_by}`,
        "/approvals",
        { proposalId: p.id },
        {
          proposalId: p.id,
          riskTier: p.risk_tier ?? undefined,
          origin: p.origin ?? undefined,
          proposedBy: p.proposed_by,
          agentId: p.proposed_by,
          requiresDecision: classification.requiresDecision,
        },
        {
          kind: classification.kind,
          severity: classification.severity,
          automationState: classification.automationState,
          proposalId: p.id,
          entityType: p.entity_type ?? undefined,
          entityId: p.entity_id ?? undefined,
          sourceType: "proposal",
          sourceId: p.id,
          updatedAt: p.created_at,
          detectedAt: p.created_at,
          recommendedAction: classification.recommendedAction,
          evidence: p.reasoning ? { reasoning: p.reasoning } : undefined,
        },
      ));
    }
  } catch { /* DB may not exist */ }
}

function detectApprovedPendingExecution(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const rows = db.prepare(`
      SELECT
        p.id,
        p.title,
        p.description,
        p.proposed_by,
        p.risk_tier,
        p.origin,
        p.entity_type,
        p.entity_id,
        p.reasoning,
        p.created_at,
        p.resolved_at,
        p.execution_status,
        p.execution_updated_at,
        p.execution_error,
        p.execution_task_id,
        p.execution_required_generation,
        (
          SELECT e.status
          FROM events e
          WHERE e.project_id = p.project_id
            AND e.type = 'proposal_approved'
            AND json_extract(e.payload, '$.proposalId') = p.id
          ORDER BY e.created_at DESC
          LIMIT 1
        ) AS event_status,
        (
          SELECT e.created_at
          FROM events e
          WHERE e.project_id = p.project_id
            AND e.type = 'proposal_approved'
            AND json_extract(e.payload, '$.proposalId') = p.id
          ORDER BY e.created_at DESC
          LIMIT 1
        ) AS event_created_at,
        lead.id AS lead_task_id,
        lead.state AS lead_task_state,
        source.id AS source_task_id,
        source.state AS source_task_state,
        cl.owner_id AS controller_owner_id,
        cl.owner_label AS controller_owner_label,
        cl.generation AS controller_generation,
        cl.required_generation AS controller_required_generation,
        cl.generation_request_reason AS controller_generation_request_reason
      FROM proposals p
      LEFT JOIN tasks lead
        ON lead.id = (
          SELECT t.id
          FROM tasks t
          WHERE t.project_id = p.project_id
            AND t.origin = 'lead_proposal'
            AND t.origin_id = p.id
          ORDER BY t.created_at DESC
          LIMIT 1
        )
      LEFT JOIN tasks source
        ON source.project_id = p.project_id
       AND source.id = json_extract(p.approval_policy_snapshot, '$.sourceTaskId')
      LEFT JOIN controller_leases cl
        ON cl.project_id = p.project_id
      WHERE p.project_id = ?
        AND p.status = 'approved'
        AND (p.approval_policy_snapshot IS NOT NULL OR p.origin = 'workflow_mutation')
      ORDER BY COALESCE(p.execution_updated_at, p.resolved_at, p.created_at) DESC
      LIMIT 20
    `).all(projectId) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const proposal = {
        id: String(row.id),
        title: String(row.title),
        description: typeof row.description === "string" ? row.description : null,
        proposed_by: String(row.proposed_by),
        risk_tier: typeof row.risk_tier === "string" ? row.risk_tier : null,
        origin: typeof row.origin === "string" ? row.origin : null,
        entity_type: typeof row.entity_type === "string" ? row.entity_type : null,
        entity_id: typeof row.entity_id === "string" ? row.entity_id : null,
        reasoning: typeof row.reasoning === "string" ? row.reasoning : null,
        created_at: typeof row.created_at === "number" ? row.created_at : Date.now(),
        resolved_at: typeof row.resolved_at === "number" ? row.resolved_at : undefined,
        execution_status: typeof row.execution_status === "string" ? row.execution_status : null,
        execution_updated_at: typeof row.execution_updated_at === "number" ? row.execution_updated_at : undefined,
        execution_error: typeof row.execution_error === "string" ? row.execution_error : null,
        execution_task_id: typeof row.execution_task_id === "string" ? row.execution_task_id : null,
        execution_required_generation: typeof row.execution_required_generation === "string"
          ? row.execution_required_generation
          : null,
      };
      const leadTaskId = typeof row.lead_task_id === "string" ? row.lead_task_id : undefined;
      const leadTaskState = typeof row.lead_task_state === "string" ? row.lead_task_state : undefined;
      const sourceTaskState = typeof row.source_task_state === "string" ? row.source_task_state : undefined;
      const legacyWorkflowMutationApplied = proposal.origin === "workflow_mutation"
        && !!leadTaskId
        && (!sourceTaskState || !["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW"].includes(sourceTaskState));
      if (proposal.execution_status === "applied" || legacyWorkflowMutationApplied) {
        continue;
      }

      const effectiveExecutionStatus = proposal.execution_status ?? "pending";
      const controllerGeneration = typeof row.controller_generation === "string"
        ? row.controller_generation
        : undefined;
      const controllerRequiredGeneration = proposal.execution_required_generation
        ?? (typeof row.controller_required_generation === "string" ? row.controller_required_generation : undefined);
      const generationMismatch = !!controllerRequiredGeneration
        && !!controllerGeneration
        && controllerGeneration !== controllerRequiredGeneration;
      const executionFailed = effectiveExecutionStatus === "failed";

      items.push(item(
        projectId,
        executionFailed || generationMismatch ? "action-needed" : "watching",
        "approval",
        executionFailed
          ? `Approved, execution failed: ${proposal.title}`
          : generationMismatch
          ? `Approved, awaiting controller handoff: ${proposal.title}`
          : `Approved, awaiting execution: ${proposal.title}`,
        executionFailed
          ? `Proposal was approved, but the follow-on action did not apply: ${proposal.execution_error ?? "unknown execution failure"}.`
          : generationMismatch
          ? `Proposal was approved, but ${String(row.controller_owner_label ?? "the current controller")} is still on ${controllerGeneration} while ${controllerRequiredGeneration} is required.`
          : "Proposal was approved, but the follow-on workflow action has not landed yet.",
        "/approvals",
        { proposalId: proposal.id },
        {
          proposalId: proposal.id,
          origin: proposal.origin ?? undefined,
          executionStatus: effectiveExecutionStatus,
          executionError: proposal.execution_error ?? undefined,
          executionTaskId: proposal.execution_task_id ?? undefined,
          eventStatus: typeof row.event_status === "string" ? row.event_status : undefined,
          leadTaskId,
          leadTaskState,
          sourceTaskId: typeof row.source_task_id === "string" ? row.source_task_id : undefined,
          sourceTaskState,
          controllerOwnerId: typeof row.controller_owner_id === "string" ? row.controller_owner_id : undefined,
          controllerOwnerLabel: typeof row.controller_owner_label === "string" ? row.controller_owner_label : undefined,
          controllerGeneration,
          controllerRequiredGeneration,
          controllerGenerationRequestReason: typeof row.controller_generation_request_reason === "string"
            ? row.controller_generation_request_reason
            : undefined,
        },
        {
          kind: executionFailed || generationMismatch ? "alert" : "info",
          severity: executionFailed || generationMismatch ? "high" : "normal",
          automationState: executionFailed || generationMismatch ? "blocked_for_agent" : "auto_handling",
          proposalId: proposal.id,
          entityType: proposal.entity_type ?? undefined,
          entityId: proposal.entity_id ?? undefined,
          sourceType: "proposal",
          sourceId: proposal.id,
          detectedAt: typeof row.event_created_at === "number" ? row.event_created_at : proposal.created_at,
          updatedAt: proposal.execution_updated_at ?? proposal.resolved_at ?? proposal.created_at,
          recommendedAction: executionFailed
            ? "Replay or recover the approved proposal so the workflow mutation actually lands, then verify the source task is paused behind the steward task."
            : generationMismatch
            ? "Start or restart a controller on the current generation so the approved mutation can execute."
            : "Wait for the controller to apply the approved action.",
          evidence: proposal.reasoning ? { reasoning: proposal.reasoning } : undefined,
        },
      ));
    }
  } catch { /* DB may not exist */ }
}

function detectReviewTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const reviewTasks = listTasks(projectId, { state: "REVIEW" });
    for (const t of reviewTasks) {
      items.push(item(
        projectId,
        "action-needed",
        "task",
        `Task awaiting review: ${t.title ?? t.id}`,
        "Task is in REVIEW state and needs a human decision",
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, assignedTo: t.assignedTo ?? undefined },
        {
          kind: "approval",
          severity: "normal",
          automationState: "needs_human",
          taskId: t.id,
          sourceType: "task",
          sourceId: t.id,
          recommendedAction: "Review the task and either accept the work or send it back.",
        },
      ));
    }
  } catch { /* tasks table may not exist */ }
}

function detectBudget(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const status = getBudgetStatus(projectId, undefined, db);
    for (const window of ["hourly", "daily", "monthly"] as const) {
      const w = status[window];
      if (!w) continue;
      if (w.usedPercent >= 90) {
        items.push(item(
          projectId,
          "action-needed",
          "budget",
          `${window.charAt(0).toUpperCase() + window.slice(1)} budget critical (${w.usedPercent}%)`,
          `${w.spentCents} of ${w.limitCents} cents used in ${window} window`,
          "/config",
          { section: "budget" },
          { window, usedPercent: w.usedPercent, spentCents: w.spentCents, limitCents: w.limitCents },
          {
            kind: "issue",
            severity: "high",
            automationState: "blocked_for_agent",
            sourceType: "budget_window",
            sourceId: window,
            recommendedAction: "Review budget limits and active high-cost work before the window closes.",
          },
        ));
      } else if (w.usedPercent >= 70) {
        items.push(item(
          projectId,
          "watching",
          "budget",
          `${window.charAt(0).toUpperCase() + window.slice(1)} budget elevated (${w.usedPercent}%)`,
          `${w.spentCents} of ${w.limitCents} cents used in ${window} window`,
          "/config",
          { section: "budget" },
          { window, usedPercent: w.usedPercent, spentCents: w.spentCents, limitCents: w.limitCents },
          {
            kind: "issue",
            severity: "normal",
            automationState: "auto_handling",
            sourceType: "budget_window",
            sourceId: window,
            recommendedAction: "Watch spend pacing and confirm active work is still worth the cost.",
          },
        ));
      }
    }
  } catch { /* budget table may not exist */ }
}

function detectKillSwitch(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    if (isEmergencyStopActive(projectId, db)) {
      items.push(item(
        projectId,
        "action-needed",
        "health",
        "Emergency stop is active",
        "All agent tool calls are blocked. Resume when safe.",
        "/ops",
        undefined,
        undefined,
        {
          kind: "alert",
          severity: "critical",
          automationState: "needs_human",
          sourceType: "safety",
          sourceId: "emergency-stop",
          recommendedAction: "Inspect the current incident and explicitly resume only when the system is safe.",
        },
      ));
    }
  } catch { /* ignore */ }
}

function detectUnreadMessages(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const rows = db.prepare(
      `SELECT id, from_agent, to_agent, type, priority, content, created_at, metadata
       FROM messages
       WHERE project_id = ? AND to_agent = 'user' AND status = 'delivered'
       ORDER BY created_at DESC
       LIMIT 5`,
    ).all(projectId) as Array<{
      id: string;
      from_agent: string;
      to_agent: string;
      type: string;
      priority: string;
      content: string;
      created_at: number;
      metadata?: string | null;
    }>;

    if (rows.length === 0) return;

    for (const row of rows) {
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined;
      } catch { /* ignore malformed metadata */ }

      const proposalId = typeof metadata?.proposalId === "string" ? metadata.proposalId : undefined;
      const linkedProposal = proposalId ? getProposalForAttention(projectId, proposalId, db) : null;
      const priority = row.priority.toLowerCase();
      const isUrgent = priority === "urgent";
      const isHigh = priority === "high" || isUrgent;
      const proposalClassification = linkedProposal ? classifyProposalAttention(linkedProposal) : null;
      const kind: AttentionKind = proposalClassification
        ? proposalClassification.kind
        : proposalId
          ? "approval"
          : (isUrgent ? "alert" : "info");
      const urgency: AttentionUrgency = proposalClassification
        ? proposalClassification.urgency
        : proposalId || isHigh
          ? "action-needed"
          : "watching";
      const severity: AttentionSeverity = proposalClassification
        ? proposalClassification.severity
        : proposalId
          ? "high"
        : isUrgent
          ? "critical"
          : isHigh
            ? "normal"
            : "low";

      items.push(item(
        projectId,
        urgency,
        "comms",
        `Message from ${row.from_agent}`,
        row.content,
        "/comms",
        { messageId: row.id, agentId: row.from_agent, ...(proposalId ? { proposalId } : {}) },
        {
          count: rows.length,
          fromAgent: row.from_agent,
          type: row.type,
          priority: row.priority,
        },
        {
          kind,
          severity,
          automationState: proposalClassification?.automationState ?? "needs_human",
          proposalId,
          sourceType: "message",
          sourceId: row.id,
          updatedAt: row.created_at,
          detectedAt: row.created_at,
          recommendedAction: proposalClassification
            ? proposalClassification.recommendedAction
            : proposalId
              ? "Review the linked proposal and respond in context."
            : "Open comms and review the message.",
          evidence: {
            ...(metadata ?? {}),
            ...(proposalClassification ? { requiresDecision: proposalClassification.requiresDecision } : {}),
          },
        },
      ));
    }

    if (rows.length > 1) {
      items.push(item(
        projectId,
        "watching",
        "comms",
        `${rows.length} unread messages from agents`,
        "Open comms to review the full unread queue.",
        "/comms",
        undefined,
        { count: rows.length },
        {
          kind: "info",
          severity: rows.length > 3 ? "normal" : "low",
          automationState: "needs_human",
          sourceType: "messages",
          sourceId: "user-inbox",
          recommendedAction: "Review the unread queue and clear any blocking conversations.",
        },
      ));
    }
  } catch { /* messaging table may not exist */ }
}

function detectStaleTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const now = Date.now();
    const rows = db.prepare(
      `SELECT id, title, deadline FROM tasks
       WHERE project_id = ? AND deadline IS NOT NULL AND deadline < ?
         AND state NOT IN ('DONE','CANCELLED')`,
    ).all(projectId, now) as Array<{ id: string; title: string | null; deadline: number }>;

    for (const t of rows) {
      items.push(item(
        projectId,
        "action-needed",
        "task",
        `Overdue task: ${t.title ?? t.id}`,
        `Deadline passed ${Math.round((now - t.deadline) / 3_600_000)}h ago`,
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, deadline: t.deadline },
        {
          kind: "issue",
          severity: "high",
          automationState: "blocked_for_agent",
          taskId: t.id,
          sourceType: "task",
          sourceId: t.id,
          recommendedAction: "Reprioritize, reassign, or explicitly unblock the overdue task.",
        },
      ));
    }
  } catch { /* tasks table may not exist */ }
}

function detectHighCostRunningTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    // Tasks in active states with associated cost records summing to >$1 (100 cents)
    const THRESHOLD_CENTS = 100;
    const rows = db.prepare(
      `SELECT t.id, t.title, COALESCE(SUM(c.cost_cents), 0) as total_cost
       FROM tasks t
       LEFT JOIN cost_records c ON c.project_id = t.project_id AND c.task_id = t.id
       WHERE t.project_id = ? AND t.state IN ('OPEN','IN_PROGRESS')
       GROUP BY t.id
       HAVING total_cost > ?`,
    ).all(projectId, THRESHOLD_CENTS) as Array<{ id: string; title: string | null; total_cost: number }>;

    for (const t of rows) {
      items.push(item(
        projectId,
        "watching",
        "task",
        `High-cost running task: ${t.title ?? t.id}`,
        `$${(t.total_cost / 100).toFixed(2)} spent on active task`,
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, totalCostCents: t.total_cost },
        {
          kind: "issue",
          severity: "normal",
          automationState: "auto_handling",
          taskId: t.id,
          sourceType: "task",
          sourceId: t.id,
          recommendedAction: "Check whether the task is progressing fast enough for its current spend.",
        },
      ));
    }
  } catch { /* ignore */ }
}

function detectRecentFailedTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const rows = db.prepare(
      `SELECT id, title, updated_at FROM tasks
       WHERE project_id = ? AND state = 'FAILED' AND updated_at >= ?
       ORDER BY updated_at DESC`,
    ).all(projectId, since) as Array<{ id: string; title: string | null; updated_at: number }>;

    for (const t of rows) {
      items.push(item(
        projectId,
        "watching",
        "task",
        `Task failed recently: ${t.title ?? t.id}`,
        "Task was cancelled or failed in the last 24 hours",
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, failedAt: t.updated_at },
        {
          kind: "issue",
          severity: "normal",
          automationState: "blocked_for_agent",
          taskId: t.id,
          sourceType: "task",
          sourceId: t.id,
          updatedAt: t.updated_at,
          detectedAt: t.updated_at,
          recommendedAction: "Inspect the failure and decide whether to retry, re-scope, or close it out.",
        },
      ));
    }
  } catch { /* ignore */ }
}

function detectCompletedTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const rows = db.prepare(
      `SELECT id, title, updated_at FROM tasks
       WHERE project_id = ? AND state = 'DONE' AND updated_at >= ?
       ORDER BY updated_at DESC
       LIMIT 10`,
    ).all(projectId, since) as Array<{ id: string; title: string | null; updated_at: number }>;

    if (rows.length > 0) {
      items.push(item(
        projectId,
        "fyi",
        "task",
        `${rows.length} task${rows.length === 1 ? "" : "s"} completed in the last 24h`,
        rows.map((t) => t.title ?? t.id).join(", "),
        "/tasks",
        { state: "DONE" },
        { count: rows.length, taskIds: rows.map((t) => t.id) },
        {
          kind: "info",
          severity: "low",
          automationState: "auto_handled",
          sourceType: "task",
          sourceId: "done-24h",
        },
      ));
    }
  } catch { /* ignore */ }
}

function detectRecentAgentConfigChanges(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const changes = listRecentChanges(projectId, {
      provenance: "agent",
      limit: 20,
    }, db);
    const recent = changes.filter((c) => c.createdAt >= since);
    if (recent.length > 0) {
      items.push(item(
        projectId,
        "fyi",
        "compliance",
        `${recent.length} config change${recent.length === 1 ? "" : "s"} by agents in the last 24h`,
        recent.slice(0, 3).map((c) => `${c.action} ${c.resourceType}/${c.resourceId}`).join("; "),
        "/config",
        undefined,
        { count: recent.length },
        {
          kind: "info",
          severity: "low",
          automationState: "auto_handling",
          sourceType: "history",
          sourceId: "agent-config-change",
        },
      ));
    }
  } catch { /* history table may not exist */ }
}

function detectHealthChanges(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    // Emit FYI if there are fired alerts (health changes worth noting)
    const alertRows = db.prepare(
      `SELECT COUNT(*) as cnt FROM metrics
       WHERE project_id = ? AND type = 'alert' AND created_at >= ?`,
    ).get(projectId, Date.now() - 24 * 3_600_000) as { cnt: number } | undefined;

    if (alertRows && alertRows.cnt > 0) {
      items.push(item(
        projectId,
        "fyi",
        "health",
        `${alertRows.cnt} health alert${alertRows.cnt === 1 ? "" : "s"} in the last 24h`,
        "Review health and SLO status for details",
        "/ops",
        undefined,
        { alertCount: alertRows.cnt },
        {
          kind: "info",
          severity: "normal",
          automationState: "auto_handling",
          sourceType: "metrics",
          sourceId: "health-alerts",
        },
      ));
    }
  } catch { /* metrics table may not exist */ }
}

function classifyIssue(
  issue: EntityIssue,
  remediationTask: IssueRemediationTaskStatus | null,
  linkedProposal: ProposalAttentionLike | null,
  workflowMutationExecution: WorkflowMutationExecutionStatus | null,
  workflowMutationFollowUpExecution: WorkflowMutationExecutionStatus | null,
): {
  kind: AttentionKind;
  urgency: AttentionUrgency;
  severity: AttentionSeverity;
  automationState: AttentionAutomationState;
} {
  if (linkedProposal?.origin === "workflow_mutation") {
    if (linkedProposal.status === "pending") {
      return {
        kind: "issue",
        urgency: "watching",
        severity: issueSeverityToFeedSeverity(issue.severity),
        automationState: "needs_human",
      };
    }
    if (linkedProposal.status === "approved") {
      if (workflowMutationFollowUpExecution) {
        if (isWorkflowMutationExecutionBlocked(workflowMutationFollowUpExecution)) {
          return {
            kind: "alert",
            urgency: "action-needed",
            severity: issueSeverityToFeedSeverity(issue.severity),
            automationState: "blocked_for_agent",
          };
        }
        return {
          kind: "issue",
          urgency: "watching",
          severity: issueSeverityToFeedSeverity(issue.severity),
          automationState: "auto_handling",
        };
      }
      if (isWorkflowMutationExecutionBlocked(workflowMutationExecution)) {
        return {
          kind: "alert",
          urgency: "action-needed",
          severity: issueSeverityToFeedSeverity(issue.severity),
          automationState: "blocked_for_agent",
        };
      }
      return {
        kind: "issue",
        urgency: "watching",
        severity: issueSeverityToFeedSeverity(issue.severity),
        automationState: "auto_handling",
      };
    }
  }

  if (issue.approvalRequired || issue.proposalId) {
    return {
      kind: "approval",
      urgency: "action-needed",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "needs_human",
    };
  }

  if (issue.blocking && issue.severity === "critical") {
    return {
      kind: "alert",
      urgency: "action-needed",
      severity: "critical",
      automationState: remediationTask
        ? (remediationTask.state === "BLOCKED" || remediationTask.stale || remediationTask.dispatchDeadLetter ? "blocked_for_agent" : "auto_handling")
        : (issue.playbook ? "blocked_for_agent" : "needs_human"),
    };
  }

  if (remediationTask?.workflowMutationFollowUpTaskId) {
    return {
      kind: "issue",
      urgency: "watching",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "auto_handling",
    };
  }

  if (remediationTask && (remediationTask.state === "BLOCKED" || remediationTask.stale || remediationTask.dispatchDeadLetter)) {
    return {
      kind: "alert",
      urgency: "action-needed",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "blocked_for_agent",
    };
  }

  if (remediationTask?.state === "REVIEW") {
    return {
      kind: "issue",
      urgency: issue.blocking || issue.severity === "high" ? "action-needed" : "watching",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "needs_human",
    };
  }

  if (remediationTask?.recentlyCompleted) {
    return {
      kind: "issue",
      urgency: "watching",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "auto_handling",
    };
  }

  if (remediationTask?.completedFollowUpNeeded) {
    return {
      kind: "issue",
      urgency: issue.blocking || issue.severity === "high" ? "action-needed" : "watching",
      severity: issueSeverityToFeedSeverity(issue.severity),
      automationState: "needs_human",
    };
  }

  return {
    kind: "issue",
    urgency: issue.blocking || issue.severity === "high" ? "action-needed" : "watching",
    severity: issueSeverityToFeedSeverity(issue.severity),
    automationState: remediationTask
      ? "auto_handling"
      : (issue.playbook ? "blocked_for_agent" : "blocked_for_agent"),
  };
}

function detectEntityIssues(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const issues = listEntityIssues(projectId, { status: "open", limit: 100 }, db);
    for (const issue of issues) {
      const entity = getEntity(projectId, issue.entityId, db);
      const remediationTask = getIssueRemediationTaskStatus(projectId, issue.id, db);
      const entityActivityTask = remediationTask
        ? null
        : getEntityActivityTaskStatus(projectId, issue.entityId, issue.id, db);
      const taskActivity = remediationTask ?? entityActivityTask;
      const linkedProposal = issue.proposalId
        ? getProposalForAttention(projectId, issue.proposalId, db)
        : getWorkflowMutationProposalForIssue(projectId, issue.id, taskActivity?.id, db);
      const workflowMutationExecution = linkedProposal?.origin === "workflow_mutation"
        && linkedProposal.status === "approved"
        && linkedProposal.execution_task_id
        ? getWorkflowMutationExecutionStatus(projectId, linkedProposal.execution_task_id, db)
        : null;
      const workflowMutationFollowUpExecution = workflowMutationExecution
        ? getWorkflowMutationFollowUpExecutionStatus(projectId, workflowMutationExecution.taskId, db)
        : null;
      const activeWorkflowMutationExecution = workflowMutationFollowUpExecution ?? workflowMutationExecution;
      const workflowMutationQueueErrorSummary = summarizeWorkflowMutationQueueError(activeWorkflowMutationExecution?.latestQueueError);
      const classification = classifyIssue(
        issue,
        taskActivity,
        linkedProposal,
        workflowMutationExecution,
        workflowMutationFollowUpExecution,
      );
      const entityLabel = entity ? `${entity.kind} ${entity.title}` : issue.entityKind;
      const linkedTaskId = activeWorkflowMutationExecution?.taskId
        ?? (linkedProposal?.origin === "workflow_mutation"
          && linkedProposal.status === "approved"
          && linkedProposal.execution_task_id
          ? linkedProposal.execution_task_id
          : taskActivity?.id);
      items.push(item(
        projectId,
        classification.urgency,
        "entity",
        `${entityLabel}: ${issue.title}`,
        issue.description ?? `${issue.issueType} detected for ${entityLabel}`,
        "/entities",
        {
          entityId: issue.entityId,
          issueId: issue.id,
          ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
        },
        {
          issueType: issue.issueType,
          blocking: issue.blocking,
          fieldName: issue.fieldName ?? undefined,
          ownerAgentId: issue.ownerAgentId ?? undefined,
          remediationTaskId: remediationTask?.id,
          remediationTaskState: remediationTask?.state,
          remediationTaskStale: remediationTask?.stale,
          remediationTaskDeadLetter: remediationTask?.dispatchDeadLetter,
          entityTaskId: entityActivityTask?.id,
          entityTaskState: entityActivityTask?.state,
          entityTaskAssignedTo: entityActivityTask?.assignedTo,
          workflowMutationFollowUpTaskId: remediationTask?.workflowMutationFollowUpTaskId,
          workflowMutationFollowUpTaskState: remediationTask?.workflowMutationFollowUpState,
          workflowMutationExecutionTaskId: workflowMutationExecution?.taskId,
          workflowMutationExecutionTaskState: workflowMutationExecution?.state,
          workflowMutationExecutionQueueStatus: workflowMutationExecution?.latestQueueStatus,
          workflowMutationExecutionQueueError: summarizeWorkflowMutationQueueError(workflowMutationExecution?.latestQueueError),
          workflowMutationFollowUpExecutionTaskId: workflowMutationFollowUpExecution?.taskId,
          workflowMutationFollowUpExecutionTaskState: workflowMutationFollowUpExecution?.state,
          workflowMutationFollowUpExecutionQueueStatus: workflowMutationFollowUpExecution?.latestQueueStatus,
          workflowMutationFollowUpExecutionQueueError: workflowMutationQueueErrorSummary,
        },
        {
          kind: classification.kind,
          severity: classification.severity,
          automationState: classification.automationState,
          entityType: issue.entityKind,
          entityId: issue.entityId,
          taskId: linkedTaskId,
          issueId: issue.id,
          proposalId: linkedProposal?.id ?? issue.proposalId,
          sourceType: "entity_issue",
          sourceId: issue.id,
          updatedAt: issue.lastSeenAt,
          detectedAt: issue.firstSeenAt,
          recommendedAction: linkedProposal?.origin === "workflow_mutation" && linkedProposal.status === "pending"
            ? `Review workflow mutation proposal "${linkedProposal.title}" and either approve or reject it.`
            : workflowMutationFollowUpExecution
              && isWorkflowMutationExecutionBlocked(workflowMutationFollowUpExecution)
            ? `Recover workflow mutation task "${workflowMutationFollowUpExecution.title}" before replaying remediation. Latest dispatch failure: ${workflowMutationQueueErrorSummary ?? "unknown failure"}`
            : workflowMutationFollowUpExecution
            ? `Track workflow mutation task "${workflowMutationFollowUpExecution.title}" while ClawForce restores the verifier path before replaying remediation.`
            : linkedProposal?.origin === "workflow_mutation"
              && linkedProposal.status === "approved"
              && workflowMutationExecution
              && isWorkflowMutationExecutionBlocked(workflowMutationExecution)
            ? `Recover workflow mutation task "${workflowMutationExecution.title}" before replaying remediation. Latest dispatch failure: ${workflowMutationQueueErrorSummary ?? "unknown failure"}`
            : linkedProposal?.origin === "workflow_mutation" && linkedProposal.status === "approved" && linkedProposal.execution_task_id
            ? `Track workflow mutation task "${linkedProposal.execution_task_title ?? linkedProposal.execution_task_id}" while ClawForce restores the loop before reopening remediation.`
            : linkedProposal?.origin === "workflow_mutation" && linkedProposal.status === "approved"
            ? `ClawForce is applying approved workflow mutation "${linkedProposal.title}". No manual remediation review is needed unless execution stalls.`
            : remediationTask?.workflowMutationFollowUpTaskId
            ? `Track workflow mutation task "${remediationTask.workflowMutationFollowUpTitle ?? remediationTask.workflowMutationFollowUpTaskId}" while ClawForce restores the verifier path before replaying remediation.`
            : taskActivity && (taskActivity.state === "BLOCKED" || taskActivity.stale || taskActivity.dispatchDeadLetter)
            ? remediationTask
              ? `Review blocked remediation task "${taskActivity.title}" before rerunning automation.`
              : `Review blocked task "${taskActivity.title}" before rerunning automation.`
            : taskActivity?.state === "REVIEW"
              ? remediationTask
                ? `Review remediation task "${taskActivity.title}" and either accept the work or send it back.`
                : `Review task "${taskActivity.title}" and either accept the work or send it back.`
            : remediationTask?.recentlyCompleted
              ? `Latest remediation task "${remediationTask.title}" already reran verification and completed. ClawForce is leaving the issue open without reopening identical remediation immediately.`
            : remediationTask?.completedFollowUpNeeded
              ? `Latest remediation task "${remediationTask.title}" reran verification and completed, but the issue is still open. Decide whether to reopen owner remediation, reduce severity, or keep it as a promotion blocker.`
            : issue.recommendedAction
              ?? (taskActivity
                ? `Track active task "${taskActivity.title}" and rerun verification when it completes.`
                : issue.playbook
                  ? `Automation playbook ${issue.playbook} is configured, but no active remediation task exists. Review issue routing.`
                  : "Inspect the linked entity issue and decide the next remediation step."),
          evidence: issue.evidence,
        },
      ));
    }
  } catch { /* entity issue tables may not exist */ }
}

function detectSimulatedActions(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const actions = listSimulatedActions(projectId, {
      status: ["simulated", "blocked"],
      limit: 20,
    }, db);
    for (const action of actions) {
      const linkedProposal = action.proposalId
        ? getProposalForAttention(projectId, action.proposalId, db)
        : null;
      const pendingApproval = action.policyDecision === "require_approval"
        && linkedProposal?.status === "pending";
      if (pendingApproval) {
        continue;
      }
      const isApproval = action.policyDecision === "require_approval" && !linkedProposal;
      const isBlocked = action.status === "blocked" && !isApproval;
      const kind: AttentionKind = isApproval
        ? "approval"
        : isBlocked
          ? "alert"
          : "info";
      const urgency: AttentionUrgency = isApproval || isBlocked ? "action-needed" : "watching";
      const severity: AttentionSeverity = isApproval || isBlocked ? "high" : "normal";
      const automationState: AttentionAutomationState = isApproval
        ? "needs_human"
        : isBlocked
          ? "blocked_for_agent"
          : "auto_handling";
      const destination = action.entityId
        ? "/entities"
        : action.taskId
          ? "/tasks"
          : "/config";

      items.push(item(
        projectId,
        urgency,
        "dry_run",
        isApproval
          ? `Approval required: ${action.summary}`
          : isBlocked
            ? `Blocked in dry run: ${action.summary}`
            : `Simulated: ${action.summary}`,
        action.policyDecision === "simulate"
          ? "Action was intercepted and recorded instead of running live."
          : action.policyDecision === "require_approval"
            ? linkedProposal?.status === "approved"
              ? "Action was approved but could not yet be replayed live."
              : "Action was intercepted and now needs an operator decision before it can run live."
            : "Action was blocked by domain execution policy.",
        destination,
        {
          ...(action.entityId ? { entityId: action.entityId } : {}),
          ...(action.taskId ? { taskId: action.taskId } : {}),
          simulatedActionId: action.id,
          ...(action.proposalId ? { proposalId: action.proposalId } : {}),
        },
        {
          policyDecision: action.policyDecision,
          actionType: action.actionType,
          status: action.status,
          requiresDecision: isApproval,
        },
        {
          kind,
          severity,
          automationState,
          simulatedActionId: action.id,
          proposalId: action.proposalId,
          entityType: action.entityType,
          entityId: action.entityId,
          taskId: action.taskId,
          sourceType: "simulated_action",
          sourceId: action.id,
          updatedAt: action.createdAt,
          detectedAt: action.createdAt,
          recommendedAction: isApproval
            ? "Review the simulated action and decide whether it should be approved for live execution."
            : isBlocked
              ? linkedProposal?.status === "approved"
                ? "Inspect the failed live replay and either retry manually or adjust the underlying workflow."
                : "Adjust execution policy or keep the action blocked during setup verification."
              : "Inspect the simulated action to confirm routing and side effects look correct.",
          evidence: action.payload,
        },
      ));
    }
  } catch { /* simulated_actions table may not exist */ }
}

function recalculateCounts(items: AttentionItem[]) {
  return {
    actionNeeded: items.filter((i) => i.urgency === "action-needed").length,
    watching: items.filter((i) => i.urgency === "watching").length,
    fyi: items.filter((i) => i.urgency === "fyi").length,
  };
}

export function isDecisionInboxItem(item: AttentionItem): boolean {
  return item.kind === "approval"
    || (item.kind === "alert" && item.automationState === "needs_human")
    || (item.kind === "proposal" && item.metadata?.requiresDecision === true);
}

export function buildDecisionInboxFromSummary(summary: AttentionSummary): DecisionInboxSummary {
  const seenProposalIds = new Set<string>();
  const items = summary.items.filter((item) => {
    if (!isDecisionInboxItem(item)) return false;
    if (item.proposalId) {
      if (seenProposalIds.has(item.proposalId)) {
        return false;
      }
      seenProposalIds.add(item.proposalId);
    }
    return true;
  });

  return {
    ...summary,
    items,
    counts: recalculateCounts(items),
  };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Scan current domain state and return a prioritized attention summary.
 * Never throws — DB errors are silently suppressed per item.
 */
export function buildAttentionSummary(projectId: string, dbOverride?: DatabaseSync): AttentionSummary {
  let db: DatabaseSync;
  try {
    db = dbOverride ?? getDb(projectId);
  } catch {
    // If we can't get a DB at all, return empty summary
    return {
      projectId,
      items: [],
      counts: { actionNeeded: 0, watching: 0, fyi: 0 },
      generatedAt: Date.now(),
    };
  }

  const items: AttentionItem[] = [];

  // --- Action-needed ---
  detectApprovals(projectId, db, items);
  detectApprovedPendingExecution(projectId, db, items);
  detectReviewTasks(projectId, db, items);
  detectBudget(projectId, db, items);
  detectKillSwitch(projectId, db, items);
  detectUnreadMessages(projectId, db, items);
  detectStaleTasks(projectId, db, items);
  detectEntityIssues(projectId, db, items);
  detectSimulatedActions(projectId, db, items);

  // --- Watching ---
  detectHighCostRunningTasks(projectId, db, items);
  detectRecentFailedTasks(projectId, db, items);

  // --- FYI ---
  detectCompletedTasks(projectId, db, items);
  detectRecentAgentConfigChanges(projectId, db, items);
  detectHealthChanges(projectId, db, items);

  const sortedItems = sortItems(items);
  const counts = recalculateCounts(sortedItems);

  return {
    projectId,
    items: sortedItems,
    counts,
    generatedAt: Date.now(),
  };
}

export function buildDecisionInboxSummary(projectId: string, dbOverride?: DatabaseSync): DecisionInboxSummary {
  return buildDecisionInboxFromSummary(buildAttentionSummary(projectId, dbOverride));
}
