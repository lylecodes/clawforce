import type { DatabaseSync } from "../sqlite-driver.js";
import type {
  Entity,
  EntityIssue,
  EntityIssueTaskConfig,
  ReviewWorkflowStewardConfig,
  Task,
  TaskPriority,
  TaskState,
  WorkflowMutationProposalSnapshot,
  WorkflowMutationTaskSpec,
} from "../types.js";
import { getAgentConfig, getExtendedProjectConfig, getRegisteredAgentIds } from "../project.js";
import { createTask, getTask, listTasks, transitionTask } from "../tasks/ops.js";
import { safeLog } from "../diagnostics.js";
import { createProposal, getProposal } from "../approval/resolve.js";
import { getApprovalNotifier } from "../approval/notify.js";
import { ingestEvent } from "../events/store.js";
import { runEntityChecks } from "./checks.js";
import { getEntity, getEntityIssue } from "./ops.js";

const TERMINAL_TASK_STATES = new Set<TaskState>(["DONE", "FAILED", "CANCELLED"]);

type ResolvedIssueTaskPolicy = {
  title: string;
  description: string;
  priority: TaskPriority;
  kind: "bug" | "feature" | "infra" | "research" | "exercise";
  tags: string[];
  rerunCheckIds?: string[];
  rerunOnStates: TaskState[];
  closeTaskOnResolved: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getPathValue(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  const parts = path.trim().split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, token) =>
    stringifyValue(getPathValue(context, String(token).trim())));
}

function mapSeverityToPriority(severity: EntityIssue["severity"]): TaskPriority {
  switch (severity) {
    case "critical": return "P0";
    case "high": return "P1";
    case "medium": return "P2";
    default: return "P3";
  }
}

function getLinkedIssueIdFromTask(task: Task): string | undefined {
  const metadata = asRecord(task.metadata);
  const issueMeta = asRecord(metadata?.entityIssue);
  return typeof issueMeta?.issueId === "string" ? issueMeta.issueId : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function parseWorkflowMutationSnapshot(raw: string | null | undefined): WorkflowMutationProposalSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkflowMutationProposalSnapshot;
  } catch {
    return null;
  }
}

function getWorkflowMutationAffectedIssueIds(
  snapshot: WorkflowMutationProposalSnapshot | null | undefined,
): string[] {
  if (!snapshot) return [];
  const stewardTask = asRecord(snapshot.stewardTask);
  const stewardMetadata = asRecord(stewardTask?.metadata);
  return Array.from(new Set([
    typeof snapshot.sourceIssueId === "string" ? snapshot.sourceIssueId : null,
    ...asStringArray(snapshot.affectedIssueIds),
    ...asStringArray(stewardMetadata?.affectedIssueIds),
  ].filter((issueId): issueId is string => Boolean(issueId))));
}

function buildDefaultDescription(entity: Entity, issue: EntityIssue): string {
  const lines = [
    `Resolve entity issue for ${entity.kind} ${entity.title}.`,
    "",
    `Issue type: ${issue.issueType}`,
    `Severity: ${issue.severity}`,
    issue.fieldName ? `Field: ${issue.fieldName}` : undefined,
    issue.description ? `Description: ${issue.description}` : undefined,
    issue.recommendedAction ? `Recommended action: ${issue.recommendedAction}` : undefined,
    issue.playbook ? `Playbook: ${issue.playbook}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

function ensureAcceptanceCriteria(
  description: string,
  entity: Entity,
  issue: EntityIssue,
  rerunCheckIds?: string[],
): string {
  const normalized = description.toLowerCase();
  const alreadyHasCriteria =
    /##?\s*acceptance(\s+criteria)?/.test(normalized) ||
    /acceptance(\s+criteria)?\s*:/.test(normalized) ||
    normalized.includes("output format") ||
    normalized.includes("expected output") ||
    normalized.includes("done when") ||
    normalized.includes("success criteria") ||
    normalized.includes("verify that") ||
    normalized.includes("must include") ||
    normalized.includes("required output");

  if (alreadyHasCriteria) return description;

  const criteria = [
    "Acceptance criteria:",
    `- The ${issue.issueType} issue for ${entity.title} is either resolved or narrowed with specific evidence.`,
    issue.recommendedAction
      ? `- Follow the recommended action: ${issue.recommendedAction}`
      : `- Update the remediation notes with the concrete action taken for ${issue.title}.`,
    rerunCheckIds && rerunCheckIds.length > 0
      ? `- Rerun and review: ${rerunCheckIds.join(", ")}.`
      : "- Rerun the relevant verification checks and review the result.",
    issue.blocking
      ? `- ${entity.title} should not be promoted while this blocking issue remains open.`
      : `- Leave clear evidence if the issue remains open after remediation.`,
  ];

  return `${description.trim()}\n\n${criteria.join("\n")}`;
}

function getIssueTaskConfig(projectId: string, entity: Entity, issue: EntityIssue): boolean | EntityIssueTaskConfig | undefined {
  return getExtendedProjectConfig(projectId)
    ?.entities?.[entity.kind]
    ?.issues?.types?.[issue.issueType]
    ?.task;
}

function resolveIssueTaskPolicy(projectId: string, entity: Entity, issue: EntityIssue): ResolvedIssueTaskPolicy | undefined {
  const taskConfig = getIssueTaskConfig(projectId, entity, issue);
  if (taskConfig === false) return undefined;

  const enabled = typeof taskConfig === "object"
    ? taskConfig.enabled ?? Boolean(issue.playbook || issue.recommendedAction)
    : Boolean(issue.playbook || issue.recommendedAction);
  if (!enabled) return undefined;

  const context = { entity, issue };
  const titleTemplate = typeof taskConfig === "object" && taskConfig.titleTemplate
    ? taskConfig.titleTemplate
    : "Remediate {{entity.title}}: {{issue.title}}";
  const descriptionTemplate = typeof taskConfig === "object" && taskConfig.descriptionTemplate
    ? taskConfig.descriptionTemplate
    : undefined;
  const rerunCheckIds = typeof taskConfig === "object" && taskConfig.rerunCheckIds && taskConfig.rerunCheckIds.length > 0
    ? taskConfig.rerunCheckIds
    : issue.checkId
      ? [issue.checkId]
      : undefined;
  const baseDescription = descriptionTemplate
    ? renderTemplate(descriptionTemplate, context)
    : buildDefaultDescription(entity, issue);

  return {
    title: renderTemplate(titleTemplate, context),
    description: ensureAcceptanceCriteria(baseDescription, entity, issue, rerunCheckIds),
    priority: typeof taskConfig === "object" && taskConfig.priority
      ? taskConfig.priority
      : mapSeverityToPriority(issue.severity),
    kind: typeof taskConfig === "object" && taskConfig.kind
      ? taskConfig.kind
      : "bug",
    tags: Array.from(new Set([
      "entity-issue",
      `entity:${entity.kind}`,
      `issue:${issue.issueType}`,
      ...(typeof taskConfig === "object" ? taskConfig.tags ?? [] : []),
    ])),
    rerunCheckIds,
    rerunOnStates: typeof taskConfig === "object" && taskConfig.rerunOnStates && taskConfig.rerunOnStates.length > 0
      ? taskConfig.rerunOnStates
      : ["DONE"],
    closeTaskOnResolved: typeof taskConfig === "object"
      ? taskConfig.closeTaskOnResolved ?? true
      : true,
  };
}

function listIssueTasks(projectId: string, issueId: string, db: DatabaseSync): Task[] {
  return listTasks(projectId, {
    origin: "reactive",
    originId: issueId,
    limit: 1000,
  }, db);
}

function findActiveIssueTask(projectId: string, issueId: string, db: DatabaseSync): Task | undefined {
  return listIssueTasks(projectId, issueId, db).find((task) => !TERMINAL_TASK_STATES.has(task.state));
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
    proposalCooldownHours: 24,
  };
}

function getLinkedWorkflowMutationProposalStatus(
  projectId: string,
  issue: EntityIssue,
  db: DatabaseSync,
): "pending" | "approved" | null {
  if (!issue.proposalId) return null;
  const proposal = getProposal(projectId, issue.proposalId, db);
  if (!proposal || proposal.origin !== "workflow_mutation") return null;
  return proposal.status === "pending" || proposal.status === "approved"
    ? proposal.status
    : null;
}

function findRecentWorkflowMutationProposalId(
  projectId: string,
  entityType: string,
  entityId: string,
  reasoningPayload: string,
  cooldownMs: number,
  db: DatabaseSync,
): string | null {
  const since = Date.now() - cooldownMs;
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
  `).get(projectId, entityType, entityId, reasoningPayload, since) as { id?: string } | undefined;
  return row?.id ?? null;
}

function findRecentWorkflowMutationProposalIdByReasoning(
  projectId: string,
  reasoningPayload: string,
  cooldownMs: number,
  db: DatabaseSync,
): string | null {
  const since = Date.now() - cooldownMs;
  const row = db.prepare(`
    SELECT id
    FROM proposals
    WHERE project_id = ?
      AND origin = 'workflow_mutation'
      AND reasoning = ?
      AND created_at >= ?
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, reasoningPayload, since) as { id?: string } | undefined;
  return row?.id ?? null;
}

function findWorkflowMutationProposalForIssue(
  projectId: string,
  issueId: string,
  db: DatabaseSync,
): string | null {
  const rows = db.prepare(`
    SELECT id, approval_policy_snapshot
    FROM proposals
    WHERE project_id = ?
      AND origin = 'workflow_mutation'
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
  `).all(projectId) as Array<{ id?: string; approval_policy_snapshot?: string | null }>;

  for (const row of rows) {
    if (!row.id) continue;
    const snapshot = parseWorkflowMutationSnapshot(row.approval_policy_snapshot);
    if (getWorkflowMutationAffectedIssueIds(snapshot).includes(issueId)) {
      return row.id;
    }
  }

  return null;
}

function linkIssueToProposal(
  projectId: string,
  issueId: string,
  proposalId: string,
  db: DatabaseSync,
): void {
  db.prepare(
    `UPDATE entity_issues SET proposal_id = ?, last_seen_at = ? WHERE project_id = ? AND id = ?`,
  ).run(proposalId, Date.now(), projectId, issueId);
}

function linkIssuesToProposal(
  projectId: string,
  issueIds: string[],
  proposalId: string,
  db: DatabaseSync,
): void {
  const stmt = db.prepare(
    `UPDATE entity_issues SET proposal_id = ?, last_seen_at = ? WHERE project_id = ? AND id = ?`,
  );
  const now = Date.now();
  for (const issueId of issueIds) {
    stmt.run(proposalId, now, projectId, issueId);
  }
}

function listMatchingOpenIssues(
  projectId: string,
  issue: EntityIssue,
  db: DatabaseSync,
): EntityIssue[] {
  const rows = db.prepare(`
    SELECT *
    FROM entity_issues
    WHERE project_id = ?
      AND status = 'open'
      AND entity_kind = ?
      AND issue_type = ?
      AND title = ?
    ORDER BY first_seen_at ASC, last_seen_at ASC
  `).all(projectId, issue.entityKind, issue.issueType, issue.title) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    issueKey: row.issue_key as string,
    projectId: row.project_id as string,
    entityId: row.entity_id as string,
    entityKind: row.entity_kind as string,
    checkId: row.check_id as string | null ?? undefined,
    issueType: row.issue_type as string,
    source: row.source as string,
    severity: row.severity as EntityIssue["severity"],
    status: row.status as EntityIssue["status"],
    title: row.title as string,
    description: row.description as string | null ?? undefined,
    fieldName: row.field_name as string | null ?? undefined,
    evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    recommendedAction: row.recommended_action as string | null ?? undefined,
    playbook: row.playbook as string | null ?? undefined,
    ownerAgentId: row.owner_agent_id as string | null ?? undefined,
    blocking: Boolean(row.blocking),
    approvalRequired: Boolean(row.approval_required),
    proposalId: row.proposal_id as string | null ?? undefined,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number,
    resolvedAt: row.resolved_at as number | null ?? undefined,
  }));
}

function pauseIssueTasksForWorkflowMutation(
  projectId: string,
  issueIds: string[],
  proposalId: string,
  actor: string,
  db: DatabaseSync,
): void {
  for (const issueId of issueIds) {
    for (const task of listIssueTasks(projectId, issueId, db)) {
      if (TERMINAL_TASK_STATES.has(task.state)) continue;
      try {
        transitionTask({
          projectId,
          taskId: task.id,
          toState: "BLOCKED",
          actor,
          reason: `Workflow mutation proposal ${proposalId} is pending; pausing duplicate remediation while the setup gap is reviewed.`,
          verificationRequired: false,
        }, db);
      } catch (err) {
        safeLog("entity.remediation.pauseIssueTask", err);
      }
    }
  }
}

function buildIssueLoopWorkflowMutationTaskSpec(params: {
  entity: Entity;
  issue: EntityIssue;
  latestTask: Task;
  completionCount: number;
}): WorkflowMutationTaskSpec {
  return {
    title: `Restructure workflow for ${params.entity.title}: repeated ${params.issue.issueType} remediation loop`,
    description: [
      `The configured remediation workflow is not closing the loop for ${params.entity.title}.`,
      ``,
      `Issue: ${params.issue.title}`,
      `Issue type: ${params.issue.issueType}`,
      `Repeated completed remediation tasks: ${params.completionCount}`,
      `Latest completed remediation task: ${params.latestTask.title} (${params.latestTask.id})`,
      params.issue.recommendedAction ? `Current recommended action: ${params.issue.recommendedAction}` : undefined,
      ``,
      `Acceptance criteria:`,
      `- Classify whether the repeated unresolved loop is a ClawForce workflow gap, onboarding/config gap, or app workflow gap.`,
      `- Propose or implement the minimal workflow mutation needed so repeated narrowed-but-unresolved passes do not keep spawning identical remediation tasks.`,
      `- Define the governed path for the next run after the mutation lands, including how verification should rerun automatically.`,
      `- Leave a clear operator-facing summary of the change or required approval path.`,
    ].filter(Boolean).join("\n"),
    priority: params.latestTask.priority === "P0" ? "P0" : "P1",
    kind: "infra",
    tags: ["workflow-mutation", `issue:${params.issue.issueType}`, "category:workflow_routing"],
    metadata: {
      sourceTaskId: params.latestTask.id,
      sourceIssueId: params.issue.id,
      issueType: params.issue.issueType,
      issueKey: params.issue.issueKey,
      failureCount: params.completionCount,
    },
  };
}

function buildIssuePatternWorkflowMutationTaskSpec(params: {
  issue: EntityIssue;
  representativeTask: Task;
  affectedEntities: Entity[];
  affectedIssues: EntityIssue[];
}): WorkflowMutationTaskSpec {
  const count = params.affectedEntities.length;
  const labels = params.affectedEntities
    .map((entity) => entity.title)
    .sort((a, b) => a.localeCompare(b));
  const representativeIssueId = getLinkedIssueIdFromTask(params.representativeTask) ?? params.issue.id;
  return {
    title: `Restructure workflow for repeated ${params.issue.issueType} across ${count} ${params.issue.entityKind}${count === 1 ? "" : "s"}`,
    description: [
      `The same open issue pattern is appearing across multiple ${params.issue.entityKind} entities.`,
      ``,
      `Issue title: ${params.issue.title}`,
      `Issue type: ${params.issue.issueType}`,
      `Affected entities (${count}): ${labels.join(", ")}`,
      `Representative remediation task: ${params.representativeTask.title} (${params.representativeTask.id})`,
      ``,
      `Acceptance criteria:`,
      `- Determine whether this repeated issue pattern is a ClawForce workflow gap, onboarding/config gap, or app-specific policy gap.`,
      `- Propose or implement the minimal workflow/setup mutation so ClawForce stops opening duplicate remediation tasks for the same cross-entity pattern.`,
      `- Define how verification should rerun after the mutation so the affected jurisdictions can advance without manual steering.`,
      `- Leave an operator-facing summary of the change or approval boundary.`,
    ].join("\n"),
    priority: "P1",
    kind: "infra",
    tags: [
      "workflow-mutation",
      `issue:${params.issue.issueType}`,
      "category:workflow_routing",
      "scope:cross-entity",
    ],
    metadata: {
      sourceTaskId: params.representativeTask.id,
      sourceIssueId: representativeIssueId,
      issueType: params.issue.issueType,
      issueTitle: params.issue.title,
      affectedIssueIds: params.affectedIssues.map((affected) => affected.id),
      affectedEntityIds: params.affectedEntities.map((entity) => entity.id),
      affectedEntityTitles: labels,
      failureCount: params.affectedIssues.length,
    },
  };
}

function maybeEscalateIssueLoop(
  projectId: string,
  issue: EntityIssue,
  entity: Entity,
  actor: string,
  db: DatabaseSync,
): boolean {
  const steward = resolveWorkflowStewardConfig(projectId);
  if (!steward?.agentId) return false;

  const completedTasks = listIssueTasks(projectId, issue.id, db)
    .filter((task) => task.state === "DONE")
    .sort((a, b) => b.createdAt - a.createdAt);
  const threshold = steward.autoProposalThreshold ?? 2;
  if (completedTasks.length < threshold) return false;

  const latestTask = completedTasks[0];
  if (!latestTask) return false;

  const reasoningPayload = JSON.stringify({
    source: "entity_remediation_loop",
    issueId: issue.id,
    issueType: issue.issueType,
    entityType: entity.kind,
    entityId: entity.id,
  });

  const cooldownMs = (steward.proposalCooldownHours ?? 24) * 60 * 60 * 1000;
  const existingProposalId = findRecentWorkflowMutationProposalId(
    projectId,
    entity.kind,
    entity.id,
    reasoningPayload,
    cooldownMs,
    db,
  );
  if (existingProposalId) {
    linkIssueToProposal(projectId, issue.id, existingProposalId, db);
    return true;
  }

  const recommendedChanges = [
    "Stop reopening the same reactive remediation loop after repeated narrowed-but-unresolved completions.",
    "Escalate this issue class into a workflow mutation once the configured threshold is reached.",
    "Define the post-mutation rerun path so verification resumes automatically without operator steering.",
  ];
  const stewardTask = buildIssueLoopWorkflowMutationTaskSpec({
    entity,
    issue,
    latestTask,
    completionCount: completedTasks.length,
  });
  const snapshot = {
    replayType: "workflow_mutation",
    stewardAgentId: steward.agentId,
    sourceTaskId: latestTask.id,
    sourceTaskTitle: latestTask.title,
    sourceIssueId: issue.id,
    reasonCode: "workflow_gap",
    mutationCategory: "workflow_routing",
    failureCount: completedTasks.length,
    entityType: entity.kind,
    entityId: entity.id,
    entityTitle: entity.title,
    latestReason: issue.title,
    recommendedChanges,
    stewardTask,
  } satisfies WorkflowMutationProposalSnapshot;

  const proposal = createProposal({
    projectId,
    title: `Workflow mutation review: repeated unresolved ${issue.issueType} loop for ${entity.title}`,
    description: [
      `Reactive remediation for ${entity.title} is looping without resolving the open issue.`,
      ``,
      `Issue: ${issue.title}`,
      `Issue type: ${issue.issueType}`,
      `Completed remediation tasks observed: ${completedTasks.length}`,
      `Latest completed remediation task: ${latestTask.title} (${latestTask.id})`,
      ``,
      `Expected steward action: propose or implement the minimal workflow mutation so ClawForce stops reopening identical remediation tasks for the same unresolved issue.`,
      `Suggested mutation category: workflow_routing`,
      ``,
      `Recommended changes:`,
      ...recommendedChanges.map((item) => `- ${item}`),
    ].join("\n"),
    proposedBy: steward.agentId,
    approvalPolicySnapshot: JSON.stringify(snapshot),
    riskTier: issue.blocking ? "high" : "medium",
    entityType: entity.kind,
    entityId: entity.id,
    origin: "workflow_mutation",
    reasoning: reasoningPayload,
  }, db);

  linkIssueToProposal(projectId, issue.id, proposal.id, db);

  getApprovalNotifier()?.sendProposalNotification({
    proposalId: proposal.id,
    projectId,
    title: proposal.title,
    description: proposal.description ?? undefined,
    proposedBy: steward.agentId,
    riskTier: proposal.risk_tier ?? undefined,
    toolContext: {
      toolName: "clawforce_task",
      category: "workflow_mutation",
      taskId: latestTask.id,
    },
  }).catch((err) => safeLog("entity.remediation.workflowMutationNotify", err));

  try {
    ingestEvent(projectId, "proposal_created", "internal", {
      proposalId: proposal.id,
      proposedBy: steward.agentId,
      riskTier: proposal.risk_tier,
      title: proposal.title,
      entityId: entity.id,
      entityType: entity.kind,
      taskId: latestTask.id,
      issueId: issue.id,
      origin: "workflow_mutation",
      reasonCode: "workflow_gap",
    }, `proposal-created:${proposal.id}`, db);
  } catch (err) {
    safeLog("entity.remediation.workflowMutationEvent", err);
  }

  return true;
}

function maybeEscalateIssuePattern(
  projectId: string,
  issue: EntityIssue,
  actor: string,
  db: DatabaseSync,
): boolean {
  const steward = resolveWorkflowStewardConfig(projectId);
  if (!steward?.agentId) return false;

  const matchingIssues = listMatchingOpenIssues(projectId, issue, db);
  const entityIds = Array.from(new Set(matchingIssues.map((candidate) => candidate.entityId)));
  const threshold = Math.max(3, steward.autoProposalThreshold ?? 2);
  if (entityIds.length < threshold) return false;

  const representativeTask = matchingIssues
    .flatMap((candidate) => listIssueTasks(projectId, candidate.id, db))
    .filter((task, index, tasks) =>
      tasks.findIndex((other) => other.id === task.id) === index)
    .sort((a, b) => {
      const aActive = TERMINAL_TASK_STATES.has(a.state) ? 1 : 0;
      const bActive = TERMINAL_TASK_STATES.has(b.state) ? 1 : 0;
      if (aActive !== bActive) return aActive - bActive;
      return b.updatedAt - a.updatedAt;
    })[0];
  if (!representativeTask) return false;

  const affectedEntities = entityIds
    .map((entityId) => getEntity(projectId, entityId, db))
    .filter((entity): entity is Entity => !!entity);
  if (affectedEntities.length < threshold) return false;

  const reasoningPayload = JSON.stringify({
    source: "cross_entity_issue_pattern",
    entityKind: issue.entityKind,
    issueType: issue.issueType,
    issueTitle: issue.title,
  });
  const cooldownMs = (steward.proposalCooldownHours ?? 24) * 60 * 60 * 1000;
  const existingProposalId = findRecentWorkflowMutationProposalIdByReasoning(
    projectId,
    reasoningPayload,
    cooldownMs,
    db,
  );
  if (existingProposalId) {
    linkIssuesToProposal(projectId, matchingIssues.map((candidate) => candidate.id), existingProposalId, db);
    pauseIssueTasksForWorkflowMutation(projectId, matchingIssues.map((candidate) => candidate.id), existingProposalId, actor, db);
    return true;
  }

  const recommendedChanges = [
    "Stop opening one reactive remediation task per entity when the same issue pattern repeats across a cohort.",
    "Convert this repeated issue pattern into a single workflow/setup decision backed by the workflow steward.",
    "After the mutation lands, rerun verification for the affected jurisdictions through one governed path instead of parallel duplicate remediations.",
  ];
  const stewardTask = buildIssuePatternWorkflowMutationTaskSpec({
    issue,
    representativeTask,
    affectedEntities,
    affectedIssues: matchingIssues,
  });
  const representativeIssueId = getLinkedIssueIdFromTask(representativeTask) ?? issue.id;
  const snapshot = {
    replayType: "workflow_mutation",
    stewardAgentId: steward.agentId,
    sourceTaskId: representativeTask.id,
    sourceTaskTitle: representativeTask.title,
    sourceIssueId: representativeIssueId,
    affectedIssueIds: matchingIssues.map((candidate) => candidate.id),
    reasonCode: "workflow_gap",
    mutationCategory: "workflow_routing",
    failureCount: matchingIssues.length,
    entityType: issue.entityKind,
    entityTitle: `${affectedEntities.length} ${issue.entityKind}${affectedEntities.length === 1 ? "" : "s"}`,
    latestReason: issue.title,
    recommendedChanges,
    stewardTask,
  } satisfies WorkflowMutationProposalSnapshot;

  const proposal = createProposal({
    projectId,
    title: `Workflow mutation review: repeated ${issue.issueType} pattern across ${affectedEntities.length} ${issue.entityKind}${affectedEntities.length === 1 ? "" : "s"}`,
    description: [
      `The same issue pattern is open across multiple ${issue.entityKind} entities.`,
      ``,
      `Issue: ${issue.title}`,
      `Issue type: ${issue.issueType}`,
      `Affected entities (${affectedEntities.length}): ${affectedEntities.map((entity) => entity.title).sort((a, b) => a.localeCompare(b)).join(", ")}`,
      `Representative remediation task: ${representativeTask.title} (${representativeTask.id})`,
      ``,
      `Expected steward action: propose or implement the minimal workflow/setup mutation so ClawForce handles this repeated pattern as one governed setup problem instead of duplicate entity remediations.`,
      `Suggested mutation category: workflow_routing`,
      ``,
      `Recommended changes:`,
      ...recommendedChanges.map((item) => `- ${item}`),
    ].join("\n"),
    proposedBy: steward.agentId,
    approvalPolicySnapshot: JSON.stringify(snapshot),
    riskTier: matchingIssues.some((candidate) => candidate.blocking) ? "high" : "medium",
    entityType: issue.entityKind,
    origin: "workflow_mutation",
    reasoning: reasoningPayload,
  }, db);

  const linkedIssueIds = matchingIssues.map((candidate) => candidate.id);
  linkIssuesToProposal(projectId, linkedIssueIds, proposal.id, db);
  pauseIssueTasksForWorkflowMutation(projectId, linkedIssueIds, proposal.id, actor, db);

  getApprovalNotifier()?.sendProposalNotification({
    proposalId: proposal.id,
    projectId,
    title: proposal.title,
    description: proposal.description ?? undefined,
    proposedBy: steward.agentId,
    riskTier: proposal.risk_tier ?? undefined,
  }).catch((err) => safeLog("entity.remediation.workflowMutationPatternNotify", err));

  try {
    ingestEvent(projectId, "proposal_created", "internal", {
      proposalId: proposal.id,
      proposedBy: steward.agentId,
      riskTier: proposal.risk_tier,
      title: proposal.title,
      entityType: issue.entityKind,
      issueId: issue.id,
      issueType: issue.issueType,
      origin: "workflow_mutation",
      reasonCode: "workflow_gap",
      affectedEntityIds: affectedEntities.map((entity) => entity.id),
    }, `proposal-created:${proposal.id}`, db);
  } catch (err) {
    safeLog("entity.remediation.workflowMutationPatternEvent", err);
  }

  return true;
}

export function ensureIssueRemediationTask(projectId: string, issueId: string, actor: string, dbOverride?: DatabaseSync): Task | null {
  const db = dbOverride;
  if (!db) throw new Error("ensureIssueRemediationTask requires dbOverride");
  const issue = getEntityIssue(projectId, issueId, db);
  if (!issue || issue.status !== "open") return null;
  const entity = getEntity(projectId, issue.entityId, db);
  if (!entity) return null;

  if (!issue.proposalId) {
    const existingWorkflowMutationProposalId = findWorkflowMutationProposalForIssue(projectId, issue.id, db);
    if (existingWorkflowMutationProposalId) {
      linkIssueToProposal(projectId, issue.id, existingWorkflowMutationProposalId, db);
      pauseIssueTasksForWorkflowMutation(projectId, [issue.id], existingWorkflowMutationProposalId, actor, db);
      return null;
    }
  }

  const linkedProposalStatus = getLinkedWorkflowMutationProposalStatus(projectId, issue, db);
  if (linkedProposalStatus) return null;

  const policy = resolveIssueTaskPolicy(projectId, entity, issue);
  if (!policy) return null;

  if (maybeEscalateIssuePattern(projectId, issue, actor, db)) {
    return null;
  }

  const active = findActiveIssueTask(projectId, issueId, db);
  if (active) return active;

  if (maybeEscalateIssueLoop(projectId, issue, entity, actor, db)) {
    return null;
  }

  const assignedTo = issue.ownerAgentId ?? entity.ownerAgentId;
  return createTask({
    projectId,
    title: policy.title,
    description: policy.description,
    priority: policy.priority,
    assignedTo: assignedTo ?? undefined,
    createdBy: actor,
    department: entity.department,
    team: entity.team,
    entityId: entity.id,
    entityType: entity.kind,
    kind: policy.kind,
    origin: "reactive",
    originId: issue.id,
    tags: policy.tags,
    metadata: {
      entityIssue: {
        issueId: issue.id,
        issueKey: issue.issueKey,
        issueType: issue.issueType,
        checkId: issue.checkId ?? null,
        playbook: issue.playbook ?? null,
        rerunCheckIds: policy.rerunCheckIds ?? [],
        rerunOnStates: policy.rerunOnStates,
        closeTaskOnResolved: policy.closeTaskOnResolved,
      },
    },
  }, db);
}

export function closeIssueRemediationTasks(projectId: string, issueId: string, actor: string, dbOverride?: DatabaseSync): Task[] {
  const db = dbOverride;
  if (!db) throw new Error("closeIssueRemediationTasks requires dbOverride");
  const tasks = listIssueTasks(projectId, issueId, db)
    .filter((task) => !TERMINAL_TASK_STATES.has(task.state));
  const closed: Task[] = [];
  for (const task of tasks) {
    try {
      const updated = transitionTask({
        projectId,
        taskId: task.id,
        toState: "CANCELLED",
        actor,
        reason: "Linked entity issue resolved",
      }, db);
      if (updated.ok) {
        closed.push(updated.task);
      }
    } catch (err) {
      safeLog("entity.remediation.closeTask", err);
    }
  }
  return closed;
}

export function getResolvedLinkedIssueForTask(
  projectId: string,
  task: Task,
  dbOverride?: DatabaseSync,
): EntityIssue | null {
  const db = dbOverride;
  if (!db) throw new Error("getResolvedLinkedIssueForTask requires dbOverride");
  const metadata = asRecord(task.metadata);
  const issueMeta = asRecord(metadata?.entityIssue);
  if (!issueMeta) return null;
  if (issueMeta.closeTaskOnResolved === false) return null;
  const issueId = typeof issueMeta.issueId === "string" ? issueMeta.issueId : null;
  if (!issueId) return null;
  const issue = getEntityIssue(projectId, issueId, db);
  if (!issue || issue.status === "open") return null;
  return issue;
}

export function maybeRerunIssueChecksForTask(
  projectId: string,
  taskId: string,
  triggerState: TaskState,
  actor: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride;
  if (!db) throw new Error("maybeRerunIssueChecksForTask requires dbOverride");
  const task = getTask(projectId, taskId, db);
  if (!task?.entityId) return false;
  const metadata = asRecord(task.metadata);
  const issueMeta = asRecord(metadata?.entityIssue);
  if (!issueMeta) return false;

  const rerunOnStates = Array.isArray(issueMeta.rerunOnStates)
    ? issueMeta.rerunOnStates.filter((value): value is TaskState => typeof value === "string")
    : [];
  if (!rerunOnStates.includes(triggerState)) return false;

  const rerunCheckIds = Array.isArray(issueMeta.rerunCheckIds)
    ? issueMeta.rerunCheckIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;

  runEntityChecks(projectId, task.entityId, {
    actor,
    trigger: "reactive_remediation",
    sourceType: "task",
    sourceId: task.id,
    checkIds: rerunCheckIds && rerunCheckIds.length > 0 ? rerunCheckIds : undefined,
    dbOverride: db,
  });
  return true;
}
