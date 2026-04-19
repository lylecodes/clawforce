/**
 * Clawforce — Verification
 *
 * Enqueues a verifier session to check task output via the dispatch queue.
 * Enforces different-actor requirement for the verifier gate.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { attachEvidence, getTask, getTaskEvidence, transitionTask } from "./ops.js";
import { enqueue } from "../dispatch/queue.js";
import { recordReview } from "../telemetry/review-store.js";
import { safeLog } from "../diagnostics.js";
import { getAgentConfig, getExtendedProjectConfig, getRegisteredAgentIds } from "../project.js";
import { createProposal } from "../approval/resolve.js";
import { getApprovalNotifier } from "../approval/notify.js";
import { ingestEvent } from "../events/store.js";
import { getEntity, getEntityIssue } from "../entities/ops.js";
import { maybeRerunIssueChecksForTask } from "../entities/remediation.js";
import type {
  ReviewReasonCode,
  ReviewWorkflowStewardConfig,
  TransitionResult,
  WorkflowMutationCategory,
  WorkflowMutationProposalSnapshot,
  WorkflowMutationTaskSpec,
} from "../types.js";

const TERMINAL_TASK_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
const ACTIVE_REMEDIATION_TASK_STATES = new Set(["ASSIGNED", "IN_PROGRESS", "REVIEW"]);

export type VerificationRequest = {
  projectId: string;
  taskId: string;
  projectDir: string;
  verifierAgentId?: string;
  verifierProfile?: string;
  verifierModel?: string;
  verificationPrompt?: string;
  timeoutMs?: number;
};

export type VerificationResult = {
  ok: boolean;
  queued: boolean;
  reason: string;
  queueItemId?: string;
};

/**
 * Enqueue a verification request through the dispatch queue.
 * Returns immediately — verification runs asynchronously via the dispatch loop.
 */
export function requestVerification(request: VerificationRequest): VerificationResult {
  const { projectId, taskId, projectDir, verifierAgentId, verifierProfile, verifierModel, timeoutMs } = request;

  const task = getTask(projectId, taskId);
  if (!task) {
    return { ok: false, queued: false, reason: "Task not found" };
  }

  if (task.state !== "REVIEW") {
    return { ok: false, queued: false, reason: `Task is in ${task.state}, expected REVIEW` };
  }

  const evidence = getTaskEvidence(projectId, taskId);
  const evidenceSummary = evidence
    .map((e) => `[${e.type}] ${e.content.slice(0, 500)}${e.content.length > 500 ? "..." : ""}`)
    .join("\n\n---\n\n");

  const prompt = request.verificationPrompt ?? buildVerificationPrompt(task.title, task.description, evidenceSummary);

  const payload: Record<string, unknown> = { prompt, projectDir };
  if (verifierAgentId) payload.agentId = verifierAgentId;
  else if (verifierProfile) payload.agentId = verifierProfile;
  if (verifierProfile) payload.profile = verifierProfile;
  if (verifierModel) payload.model = verifierModel;
  if (timeoutMs) payload.timeoutMs = timeoutMs;

  // skipStateCheck=true: REVIEW tasks are normally blocked from dispatch,
  // but verification dispatches are the intended consumer of REVIEW tasks.
  const queueItem = enqueue(projectId, taskId, payload, undefined, undefined, undefined, true);
  if (!queueItem) {
    return { ok: true, queued: false, reason: "Verification already queued (dedup)" };
  }

  return { ok: true, queued: true, reason: "Verification enqueued", queueItemId: queueItem.id };
}

/**
 * Submit a verification verdict and transition the task.
 */
export function submitVerdict(params: {
  projectId: string;
  taskId: string;
  verifier: string;
  passed: boolean;
  reason?: string;
  reasonCode?: ReviewReasonCode;
  sessionKey?: string;
}, dbOverride?: DatabaseSync): TransitionResult {
  const { projectId, taskId, verifier, passed, reason, reasonCode, sessionKey } = params;
  const task = getTask(projectId, taskId, dbOverride);
  const shouldBlockForReason = !passed && reasonCode ? shouldBlockTaskAfterFailedReview(reasonCode) : false;

  // Record the manager review for telemetry (P2 data flow)
  try {
    recordReview({
      projectId,
      taskId,
      reviewerAgentId: verifier,
      sessionKey,
      verdict: passed ? "approved" : "rejected",
      reasonCode,
      reasoning: reason,
    }, dbOverride);
  } catch (err) {
    safeLog("verify.recordReview", err);
  }

  const implementationOutcome = passed && task
    ? verifyWorkflowMutationImplementationOutcome(projectId, task, verifier, dbOverride)
    : null;

  const result = implementationOutcome
    ? implementationOutcome.transition
    : passed
      ? transitionTask({
        projectId,
        taskId,
        toState: "DONE",
        actor: verifier,
        reason: reason ?? "Verification passed",
      }, dbOverride)
      : transitionTask({
        projectId,
        taskId,
        toState: shouldBlockForReason ? "BLOCKED" : "IN_PROGRESS",
        actor: verifier,
        reason: reason ?? "Verification failed — rework needed",
        verificationRequired: shouldBlockForReason ? false : undefined,
      }, dbOverride);

  if (!passed && task && reasonCode && result.ok) {
    try {
      maybeCreateWorkflowMutationProposal({
        projectId,
        task,
        verifier,
        reason,
        reasonCode,
        sessionKey,
      }, dbOverride);
    } catch (err) {
      safeLog("verify.workflowMutationProposal", err);
    }
  }

  return result;
}

function verifyWorkflowMutationImplementationOutcome(
  projectId: string,
  task: NonNullable<ReturnType<typeof getTask>>,
  verifier: string,
  dbOverride?: DatabaseSync,
): {
  transition: TransitionResult;
  verified: boolean;
} | null {
  const db = dbOverride ?? getDb(projectId);
  const metadata = asRecord(task.metadata);
  if (metadata?.workflowMutationStage !== "implementation") return null;

  const sourceTaskId = typeof metadata.sourceTaskId === "string"
    ? metadata.sourceTaskId
    : null;
  if (!sourceTaskId) return null;

  const sourceTaskBefore = getTask(projectId, sourceTaskId, db);
  const sourceIssueId = getLinkedSourceIssueId(sourceTaskBefore);
  const rerunTriggered = maybeRerunIssueChecksForTask(
    projectId,
    sourceTaskId,
    "DONE",
    "system:workflow-mutation",
    db,
  );

  let sourceTaskAfter = getTask(projectId, sourceTaskId, db);
  const sourceIssueAfter = sourceIssueId ? getEntityIssue(projectId, sourceIssueId, db) : null;

  let sourceResumed = false;
  if (rerunTriggered && sourceTaskAfter && sourceTaskAfter.state === "BLOCKED" && sourceIssueAfter?.status === "open") {
    const resumed = transitionTask({
      projectId,
      taskId: sourceTaskAfter.id,
      toState: "ASSIGNED",
      actor: "system:workflow-mutation",
      reason: `Workflow mutation task ${task.id} restored the verification path; rerunning source remediation from fresh evidence.`,
      verificationRequired: false,
    }, db);
    sourceResumed = resumed.ok;
    if (resumed.ok) {
      sourceTaskAfter = resumed.task;
    }
  }

  const sourceIssueResolved = !!sourceIssueAfter && sourceIssueAfter.status !== "open";
  const activeIssueTask = sourceIssueId
    ? findActiveIssueRemediationTask(projectId, sourceIssueId, db)
    : null;
  const sourceTaskActive = !!sourceTaskAfter && ACTIVE_REMEDIATION_TASK_STATES.has(sourceTaskAfter.state);
  const sourcePathRestored = sourceIssueId
    ? sourceResumed || Boolean(activeIssueTask) || sourceTaskActive
    : !!sourceTaskAfter && sourceTaskAfter.state !== "BLOCKED";
  const verified = rerunTriggered && (sourceIssueResolved || sourcePathRestored);
  const summary = [
    `Workflow mutation post-condition rerun: ${verified ? "passed" : "failed"}`,
    `Source task: ${sourceTaskId}`,
    `Rerun triggered: ${rerunTriggered ? "yes" : "no"}`,
    `Source issue status: ${sourceIssueAfter?.status ?? "unknown"}`,
    `Source task state after rerun: ${sourceTaskAfter?.state ?? "missing"}`,
    sourceResumed ? "Source remediation resumed from BLOCKED after fresh rerun evidence." : undefined,
    !sourceResumed && sourceTaskActive
      ? `Source task itself reopened and is now ${sourceTaskAfter?.state}.`
      : undefined,
    activeIssueTask
      ? `Active remediation task after rerun: ${activeIssueTask.id} [${activeIssueTask.state}]`
      : undefined,
    !verified
      ? "Mutation is not complete until the rerun either resolves the linked issue or restores an active remediation path from fresh evidence."
      : undefined,
  ].filter(Boolean).join("\n");

  const evidence = attachEvidence({
    projectId,
    taskId: task.id,
    type: "output",
    content: summary,
    attachedBy: "system:workflow-mutation",
    metadata: {
      workflowMutationPostCondition: {
        sourceTaskId,
        rerunTriggered,
        sourceIssueId,
        sourceIssueStatus: sourceIssueAfter?.status ?? null,
        sourceTaskState: sourceTaskAfter?.state ?? null,
        sourceResumed,
        activeIssueTaskId: activeIssueTask?.id ?? null,
        sourceTaskActive,
        sourcePathRestored,
        verified,
      },
    },
  }, db);

  if (!verified) {
    return {
      verified,
      transition: transitionTask({
        projectId,
        taskId: task.id,
        toState: "IN_PROGRESS",
        actor: verifier,
        reason: "Workflow mutation post-condition rerun did not restore the blocked source path",
        evidenceId: evidence.id,
      }, db),
    };
  }

  persistWorkflowMutationVerificationMetadata(projectId, task.id, metadata ?? {}, {
    sourceTaskId,
    sourceIssueId,
    sourceIssueStatus: sourceIssueAfter?.status ?? null,
    sourceTaskState: sourceTaskAfter?.state ?? null,
    sourceResumed,
    activeIssueTaskId: activeIssueTask?.id ?? null,
    sourceTaskActive,
    sourcePathRestored,
    verifiedAt: Date.now(),
  }, db);

  return {
    verified,
    transition: transitionTask({
      projectId,
      taskId: task.id,
      toState: "DONE",
      actor: verifier,
      reason: "Verification passed and workflow mutation post-condition rerun succeeded",
      evidenceId: evidence.id,
    }, db),
  };
}

function findActiveIssueRemediationTask(
  projectId: string,
  issueId: string,
  db: DatabaseSync,
): { id: string; state: string } | null {
  const row = db.prepare(`
    SELECT id, state
    FROM tasks
    WHERE project_id = ?
      AND origin = 'reactive'
      AND origin_id = ?
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(projectId, issueId) as { id?: string; state?: string } | undefined;

  if (!row?.id || !row.state || TERMINAL_TASK_STATES.has(row.state)) {
    return null;
  }
  return { id: row.id, state: row.state };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getLinkedSourceIssueId(task: ReturnType<typeof getTask>): string | null {
  const metadata = asRecord(task?.metadata);
  const issueMeta = asRecord(metadata?.entityIssue);
  return typeof issueMeta?.issueId === "string" ? issueMeta.issueId : null;
}

function persistWorkflowMutationVerificationMetadata(
  projectId: string,
  taskId: string,
  taskMetadata: Record<string, unknown>,
  verification: Record<string, unknown>,
  db: DatabaseSync,
): void {
  taskMetadata.workflowMutationPostCondition = verification;
  db.prepare(
    "UPDATE tasks SET metadata = ?, updated_at = ? WHERE project_id = ? AND id = ?",
  ).run(JSON.stringify(taskMetadata), Date.now(), projectId, taskId);
}

function buildVerificationPrompt(title: string, description: string | undefined, evidenceSummary: string): string {
  return [
    `# Verification Task`,
    ``,
    `You are verifying the output of another agent's work.`,
    ``,
    `## Task: ${title}`,
    description ? `\n## Description\n${description}` : "",
    ``,
    `## Evidence/Output`,
    evidenceSummary,
    ``,
    `## Instructions`,
    `Review the evidence above. Determine if the work meets the task requirements.`,
    ``,
    `Respond with one of:`,
    `- VERDICT: PASS — if the work is acceptable`,
    `- VERDICT: FAIL — if the work needs revision`,
    ``,
    `Include a brief explanation of your reasoning.`,
  ].join("\n");
}

function maybeCreateWorkflowMutationProposal(params: {
  projectId: string;
  task: NonNullable<ReturnType<typeof getTask>>;
  verifier: string;
  reason?: string;
  reasonCode: ReviewReasonCode;
  sessionKey?: string;
}, dbOverride?: DatabaseSync): void {
  const steward = resolveWorkflowStewardConfig(params.projectId);
  if (!steward?.agentId) return;

  const threshold = getWorkflowMutationProposalThreshold(steward, params.reasonCode);
  const cooldownMs = (steward.proposalCooldownHours ?? 24) * 60 * 60 * 1000;
  const eligibleReasonCodes = steward.autoProposalReasonCodes?.length
    ? steward.autoProposalReasonCodes
    : ["verification_environment_blocked"];
  if (!eligibleReasonCodes.includes(params.reasonCode)) return;

  const db = dbOverride;
  const failureCount = countRecentStructuredReviewFailures(
    params.projectId,
    params.task,
    params.reasonCode,
    db,
  );
  if (failureCount < threshold) return;

  const reasoningPayload = JSON.stringify({
    source: "review_loop",
    reasonCode: params.reasonCode,
    taskId: params.task.id,
    entityType: params.task.entityType ?? null,
    entityId: params.task.entityId ?? null,
  });
  if (hasRecentWorkflowMutationProposal(params.projectId, params.task, reasoningPayload, cooldownMs, db)) {
    return;
  }

  const entity = params.task.entityId
    ? getEntity(params.projectId, params.task.entityId, db)
    : null;
  const subject = entity?.title ?? params.task.title;
  const reasonLabel = formatReviewReasonCode(params.reasonCode);
  const mutationCategory = classifyWorkflowMutationCategory(params.reasonCode);
  const recommendedChanges = buildWorkflowMutationRecommendations(params.reasonCode);
  const stewardTask = buildWorkflowMutationTaskSpec({
    task: params.task,
    subject,
    reasonCode: params.reasonCode,
    mutationCategory,
    failureCount,
    latestReason: params.reason,
    recommendedChanges,
  });
  const approvalPolicySnapshot = JSON.stringify({
    replayType: "workflow_mutation",
    stewardAgentId: steward.agentId,
    sourceTaskId: params.task.id,
    sourceTaskTitle: params.task.title,
    reasonCode: params.reasonCode,
    mutationCategory,
    failureCount,
    entityType: params.task.entityType ?? null,
    entityId: params.task.entityId ?? null,
    entityTitle: entity?.title ?? null,
    latestReason: params.reason ?? null,
    recommendedChanges,
    stewardTask,
  } satisfies WorkflowMutationProposalSnapshot);
  const title = `Workflow mutation review: repeated ${reasonLabel} for ${subject}`;
  const description = [
    `Repeated rejected review verdicts are leaving the operator without a clean verification path.`,
    ``,
    `Reason code: ${params.reasonCode}`,
    `Failure count observed: ${failureCount}`,
    `Verifier: ${params.verifier}`,
    `Task: ${params.task.title} (${params.task.id})`,
    params.reason ? `Latest rejection: ${params.reason}` : undefined,
    ``,
    `Expected steward action: propose or implement a workflow mutation so the operator does not have to manually steer this loop.`,
    `Suggested mutation category: ${mutationCategory}`,
    ``,
    `Recommended changes:`,
    ...recommendedChanges.map((item) => `- ${item}`),
    `Rerun trigger: repeat the same review path after the approved workflow change lands.`,
    ``,
    `If approved, ClawForce should create a steward-owned follow-up task and pause the current remediation loop until that workflow task is resolved.`,
  ].filter(Boolean).join("\n");

  const proposal = createProposal({
    projectId: params.projectId,
    title,
    description,
    proposedBy: steward.agentId,
    sessionKey: params.sessionKey,
    approvalPolicySnapshot,
    riskTier: "medium",
    entityType: params.task.entityType,
    entityId: params.task.entityId,
    origin: "workflow_mutation",
    reasoning: reasoningPayload,
    relatedGoalId: params.task.goalId,
  }, db);

  getApprovalNotifier()?.sendProposalNotification({
    proposalId: proposal.id,
    projectId: params.projectId,
    title: proposal.title,
    description: proposal.description ?? undefined,
    proposedBy: steward.agentId,
    riskTier: proposal.risk_tier ?? undefined,
    toolContext: {
      toolName: "clawforce_verify",
      category: "workflow_mutation",
      taskId: params.task.id,
    },
  }).catch((err) => safeLog("verify.workflowMutationNotify", err));

  try {
    ingestEvent(params.projectId, "proposal_created", "internal", {
      proposalId: proposal.id,
      proposedBy: steward.agentId,
      riskTier: proposal.risk_tier,
      title: proposal.title,
      entityId: params.task.entityId,
      entityType: params.task.entityType,
      taskId: params.task.id,
      origin: "workflow_mutation",
      reasonCode: params.reasonCode,
    }, `proposal-created:${proposal.id}`, db);
  } catch (err) {
    safeLog("verify.workflowMutationEvent", err);
  }
}

function shouldBlockTaskAfterFailedReview(reasonCode: ReviewReasonCode): boolean {
  switch (reasonCode) {
    case "verification_environment_blocked":
      return true;
    default:
      return false;
  }
}

function getWorkflowMutationProposalThreshold(
  steward: ReviewWorkflowStewardConfig,
  reasonCode: ReviewReasonCode,
): number {
  switch (reasonCode) {
    case "verification_environment_blocked":
      return 1;
    default:
      return steward.autoProposalThreshold ?? 2;
  }
}

function resolveWorkflowStewardConfig(projectId: string): ReviewWorkflowStewardConfig | null {
  const extConfig = getExtendedProjectConfig(projectId);
  if (extConfig?.review?.workflowSteward?.agentId) {
    return extConfig.review.workflowSteward;
  }

  const hasConventionalSteward = getRegisteredAgentIds(projectId).includes("workflow-steward")
    && getAgentConfig("workflow-steward", projectId);
  if (!hasConventionalSteward) return null;

  return {
    agentId: "workflow-steward",
    autoProposalThreshold: 2,
    autoProposalReasonCodes: ["verification_environment_blocked"],
    proposalCooldownHours: 24,
  };
}

function countRecentStructuredReviewFailures(
  projectId: string,
  task: NonNullable<ReturnType<typeof getTask>>,
  reasonCode: ReviewReasonCode,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  if (task.entityId) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM manager_reviews mr
      JOIN tasks t
        ON t.id = mr.task_id
       AND t.project_id = mr.project_id
      WHERE mr.project_id = ?
        AND mr.verdict = 'rejected'
        AND mr.reason_code = ?
        AND t.entity_id = ?
    `).get(projectId, reasonCode, task.entityId) as { cnt?: number } | undefined;
    return row?.cnt ?? 0;
  }

  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM manager_reviews
    WHERE project_id = ?
      AND task_id = ?
      AND verdict = 'rejected'
      AND reason_code = ?
  `).get(projectId, task.id, reasonCode) as { cnt?: number } | undefined;
  return row?.cnt ?? 0;
}

function hasRecentWorkflowMutationProposal(
  projectId: string,
  task: NonNullable<ReturnType<typeof getTask>>,
  reasoningPayload: string,
  cooldownMs: number,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - cooldownMs;

  if (task.entityId && task.entityType) {
    const row = db.prepare(`
      SELECT id
      FROM proposals
      WHERE project_id = ?
        AND origin = 'workflow_mutation'
        AND entity_type = ?
        AND entity_id = ?
        AND reasoning = ?
        AND created_at >= ?
        AND status IN ('pending', 'approved')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(projectId, task.entityType, task.entityId, reasoningPayload, since) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  const row = db.prepare(`
    SELECT id
    FROM proposals
    WHERE project_id = ?
      AND origin = 'workflow_mutation'
      AND entity_type IS NULL
      AND entity_id IS NULL
      AND reasoning = ?
      AND created_at >= ?
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, reasoningPayload, since) as { id?: string } | undefined;
  return Boolean(row?.id);
}

function formatReviewReasonCode(reasonCode: ReviewReasonCode): string {
  return reasonCode.replace(/_/g, " ");
}

function classifyWorkflowMutationCategory(reasonCode: ReviewReasonCode): WorkflowMutationCategory {
  switch (reasonCode) {
    case "verification_environment_blocked":
      return "verification_path";
    case "evidence_insufficient":
      return "review_policy";
    case "workflow_gap":
      return "workflow_routing";
    case "app_gap":
      return "app_workflow";
    default:
      return "workflow_routing";
  }
}

function buildWorkflowMutationRecommendations(reasonCode: ReviewReasonCode): string[] {
  switch (reasonCode) {
    case "verification_environment_blocked":
      return [
        "Provide a verifier execution path that can run the decisive check without the current environment restriction.",
        "If that environment cannot be made available, reroute this review class into a setup mutation instead of repeating agent rework.",
        "Ensure the blocked review path can be rerun automatically once the workflow change lands.",
      ];
    case "evidence_insufficient":
      return [
        "Tighten the remediation playbook so the task produces the evidence the reviewer actually needs.",
        "Adjust review guidance so missing evidence is classified and routed before the operator has to interpret it manually.",
      ];
    case "workflow_gap":
      return [
        "Adjust routing, playbooks, or task generation so this failure class enters a governed remediation path automatically.",
        "Make the next-step mutation explicit in the feed so the operator is choosing, not diagnosing.",
      ];
    case "app_gap":
      return [
        "Split app-domain failures from workflow failures so the correct owner and playbook trigger automatically.",
        "Document the app-side gap in the workflow so repeated occurrences generate the right approval or proposal without operator steering.",
      ];
    default:
      return [
        "Clarify the workflow mutation needed so the operator is not forced to manually drive the next step.",
      ];
  }
}

function buildWorkflowMutationTaskSpec(params: {
  task: NonNullable<ReturnType<typeof getTask>>;
  subject: string;
  reasonCode: ReviewReasonCode;
  mutationCategory: WorkflowMutationCategory;
  failureCount: number;
  latestReason?: string;
  recommendedChanges: string[];
}): WorkflowMutationTaskSpec {
  const priority = params.task.priority === "P0" ? "P0" : "P1";
  const title = `Restructure workflow for ${params.subject}: ${formatReviewReasonCode(params.reasonCode)}`;
  const description = [
    `The configured workflow is not closing the loop for ${params.subject}.`,
    ``,
    `Source task: ${params.task.title} (${params.task.id})`,
    `Reason code: ${params.reasonCode}`,
    `Mutation category: ${params.mutationCategory}`,
    `Repeated failures observed: ${params.failureCount}`,
    params.latestReason ? `Latest rejection: ${params.latestReason}` : undefined,
    ``,
    `Recommended changes:`,
    ...params.recommendedChanges.map((item) => `- ${item}`),
    ``,
    `Acceptance criteria:`,
    `- Identify whether the gap belongs to ClawForce, onboarding, or the app workflow and record that classification explicitly.`,
    `- Propose or implement the minimal workflow mutation needed so this failure class no longer requires manual operator steering.`,
    `- Define the governed rerun path after the mutation lands, including which checks or reviews should repeat automatically.`,
    `- Leave a clear operator-facing summary of the change or recommended approval path.`,
  ].filter(Boolean).join("\n");

  return {
    title,
    description,
    priority,
    kind: "infra",
    tags: ["workflow-mutation", `review:${params.reasonCode}`, `category:${params.mutationCategory}`],
    metadata: {
      sourceTaskId: params.task.id,
      sourceTaskTitle: params.task.title,
      reasonCode: params.reasonCode,
      mutationCategory: params.mutationCategory,
      failureCount: params.failureCount,
    },
  };
}
