import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "../sqlite-driver.js";
import { createProposal, type Proposal } from "../approval/resolve.js";
import { getApprovalNotifier } from "../approval/notify.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import { recordChange } from "../history/store.js";
import { getExtendedProjectConfig } from "../project.js";
import type {
  Entity,
  EntityIssue,
  EntityIssueSeverity,
  EntityIssueStatus,
  EntityIssueSummary,
  EntityKindConfig,
  EntityTransitionRecord,
} from "../types.js";
import {
  allowsEntityTransition,
  getEntityTransitionRule,
  resolveInitialEntityState,
  validateEntityHealth,
  validateEntityMetadata,
  validateEntityParentKind,
} from "./config.js";

const ENTITY_ISSUE_SEVERITY_ORDER: EntityIssueSeverity[] = ["low", "medium", "high", "critical"];

function rowToEntityIssue(row: Record<string, unknown>): EntityIssue {
  return {
    id: row.id as string,
    issueKey: row.issue_key as string,
    projectId: row.project_id as string,
    entityId: row.entity_id as string,
    entityKind: row.entity_kind as string,
    checkId: (row.check_id as string) ?? undefined,
    issueType: row.issue_type as string,
    source: row.source as string,
    severity: row.severity as EntityIssueSeverity,
    status: row.status as EntityIssueStatus,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    fieldName: (row.field_name as string) ?? undefined,
    evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    recommendedAction: (row.recommended_action as string) ?? undefined,
    playbook: (row.playbook as string) ?? undefined,
    ownerAgentId: (row.owner_agent_id as string) ?? undefined,
    blocking: Boolean(row.blocking),
    approvalRequired: Boolean(row.approval_required),
    proposalId: (row.proposal_id as string) ?? undefined,
    firstSeenAt: row.first_seen_at as number,
    lastSeenAt: row.last_seen_at as number,
    resolvedAt: (row.resolved_at as number) ?? undefined,
  };
}

function rowToEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    kind: row.kind as string,
    title: row.title as string,
    state: row.state as string,
    health: (row.health as string) ?? undefined,
    ownerAgentId: (row.owner_agent_id as string) ?? undefined,
    parentEntityId: (row.parent_entity_id as string) ?? undefined,
    department: (row.department as string) ?? undefined,
    team: (row.team as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastVerifiedAt: (row.last_verified_at as number) ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

function rowToEntityTransition(row: Record<string, unknown>): EntityTransitionRecord {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    projectId: row.project_id as string,
    fromState: (row.from_state as string) ?? undefined,
    toState: (row.to_state as string) ?? undefined,
    fromHealth: (row.from_health as string) ?? undefined,
    toHealth: (row.to_health as string) ?? undefined,
    actor: row.actor as string,
    reason: (row.reason as string) ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    createdAt: row.created_at as number,
  };
}

function compareIssueSeverity(a: EntityIssueSeverity, b: EntityIssueSeverity): number {
  return ENTITY_ISSUE_SEVERITY_ORDER.indexOf(a) - ENTITY_ISSUE_SEVERITY_ORDER.indexOf(b);
}

function getHigherSeverity(
  current: EntityIssueSeverity | undefined,
  candidate: EntityIssueSeverity,
): EntityIssueSeverity {
  if (!current) return candidate;
  return compareIssueSeverity(current, candidate) >= 0 ? current : candidate;
}

function getKindConfig(projectId: string, kind: string): EntityKindConfig {
  const config = getExtendedProjectConfig(projectId);
  const kindConfig = config?.entities?.[kind];
  if (!kindConfig) {
    throw new Error(`Entity kind "${kind}" is not configured for project "${projectId}"`);
  }
  return kindConfig;
}

function assertValidState(kind: EntityKindConfig, state: string): void {
  if (!(state in kind.states)) {
    throw new Error(`Invalid entity state "${state}"`);
  }
}

function assertValidMetadata(kind: EntityKindConfig, metadata: Record<string, unknown> | undefined): void {
  const errors = validateEntityMetadata(kind, metadata);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

function getParentEntity(projectId: string, parentEntityId: string, db: DatabaseSync): Entity {
  const parent = getEntity(projectId, parentEntityId, db);
  if (!parent) {
    throw new Error(`Parent entity not found: ${parentEntityId}`);
  }
  return parent;
}

function wouldCreateCycle(
  projectId: string,
  entityId: string,
  candidateParentId: string,
  db: DatabaseSync,
): boolean {
  let currentId: string | undefined = candidateParentId;
  while (currentId) {
    if (currentId === entityId) return true;
    const row = db.prepare(
      "SELECT parent_entity_id FROM entities WHERE id = ? AND project_id = ?",
    ).get(currentId, projectId) as Record<string, unknown> | undefined;
    currentId = (row?.parent_entity_id as string) ?? undefined;
  }
  return false;
}

function resolveIssueConfig(projectId: string, kind: string, issueType: string) {
  return getKindConfig(projectId, kind).issues?.types?.[issueType];
}

function resolveIssueSeverity(
  kindConfig: EntityKindConfig,
  issueType: string,
  severity: EntityIssueSeverity | undefined,
): EntityIssueSeverity {
  return severity
    ?? kindConfig.issues?.types?.[issueType]?.defaultSeverity
    ?? "medium";
}

function resolveIssueBlocking(
  kindConfig: EntityKindConfig,
  issueType: string,
  severity: EntityIssueSeverity,
  blocking: boolean | undefined,
): boolean {
  if (blocking !== undefined) return blocking;
  if (kindConfig.issues?.types?.[issueType]?.blocking !== undefined) {
    return kindConfig.issues.types[issueType]!.blocking!;
  }
  return (kindConfig.issues?.defaultBlockingSeverities ?? []).includes(severity);
}

function resolveIssueApprovalRequired(
  kindConfig: EntityKindConfig,
  issueType: string,
  approvalRequired: boolean | undefined,
): boolean {
  if (approvalRequired !== undefined) return approvalRequired;
  return kindConfig.issues?.types?.[issueType]?.approvalRequired ?? false;
}

function resolveIssuePlaybook(
  kindConfig: EntityKindConfig,
  issueType: string,
  checkId: string | undefined,
  playbook: string | undefined,
): string | undefined {
  if (playbook) return playbook;
  return kindConfig.issues?.types?.[issueType]?.playbook
    ?? (checkId ? kindConfig.issues?.checks?.[checkId]?.playbook : undefined);
}

function resolveSuggestedHealth(kindConfig: EntityKindConfig, issue: EntityIssue): string | undefined {
  const typedHealth = kindConfig.issues?.types?.[issue.issueType]?.health;
  if (typedHealth) return typedHealth;
  return kindConfig.issues?.defaultHealthBySeverity?.[issue.severity];
}

export function syncEntityHealthFromIssues(projectId: string, entityId: string, db: DatabaseSync): void {
  const entity = getEntity(projectId, entityId, db);
  if (!entity) return;
  const kindConfig = getKindConfig(projectId, entity.kind);
  if (kindConfig.issues?.autoSyncHealth === false) return;

  const summary = summarizeEntityIssues(projectId, entityId, db);
  const nextHealth = summary.suggestedHealth ?? kindConfig.health?.clear ?? kindConfig.health?.default ?? null;
  if ((entity.health ?? null) === nextHealth) return;

  db.prepare(
    "UPDATE entities SET health = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).run(nextHealth, Date.now(), entityId, projectId);
}

export type CreateEntityParams = {
  projectId: string;
  kind: string;
  title: string;
  state?: string;
  health?: string;
  ownerAgentId?: string;
  parentEntityId?: string;
  department?: string;
  team?: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
  lastVerifiedAt?: number;
};

export function createEntity(params: CreateEntityParams, dbOverride?: DatabaseSync): Entity {
  const db = dbOverride ?? getDb(params.projectId);
  const kindConfig = getKindConfig(params.projectId, params.kind);
  if (kindConfig.runtimeCreate === false) {
    throw new Error(`Entity kind "${params.kind}" cannot be created at runtime`);
  }

  const state = params.state ?? resolveInitialEntityState(kindConfig);
  assertValidState(kindConfig, state);

  const healthError = validateEntityHealth(kindConfig, params.health);
  if (healthError) throw new Error(healthError);
  assertValidMetadata(kindConfig, params.metadata);

  if (params.parentEntityId) {
    const parent = getParentEntity(params.projectId, params.parentEntityId, db);
    const parentError = validateEntityParentKind(kindConfig, parent.kind);
    if (parentError) throw new Error(parentError);
  }

  const id = randomUUID();
  const now = Date.now();
  const health = params.health ?? kindConfig.health?.default ?? null;

  db.prepare(`
    INSERT INTO entities (
      id, project_id, kind, title, state, health, owner_agent_id, parent_entity_id,
      department, team, created_by, created_at, updated_at, last_verified_at, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.kind,
    params.title,
    state,
    health,
    params.ownerAgentId ?? null,
    params.parentEntityId ?? null,
    params.department ?? null,
    params.team ?? null,
    params.createdBy,
    now,
    now,
    params.lastVerifiedAt ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );

  const entity = getEntity(params.projectId, id, db)!;

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.createdBy,
      action: "entity.create",
      targetType: "entity",
      targetId: id,
      detail: `${params.kind}:${params.title}`,
    }, db);
  } catch (err) {
    safeLog("entity.create.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity",
      resourceId: id,
      action: "create",
      provenance: "human",
      actor: params.createdBy,
      after: entity,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.create.history", err);
  }

  try {
    ingestEvent(params.projectId, "entity_created", "internal", {
      entityId: id,
      kind: params.kind,
      title: params.title,
      state,
      health: entity.health ?? null,
      ownerAgentId: entity.ownerAgentId ?? null,
      parentEntityId: entity.parentEntityId ?? null,
    }, `entity-created:${id}`, db);
    emitDiagnosticEvent({ type: "entity_created", projectId: params.projectId, entityId: id, kind: params.kind });
  } catch (err) {
    safeLog("entity.create.event", err);
  }

  return entity;
}

export type UpdateEntityParams = {
  title?: string;
  ownerAgentId?: string | null;
  parentEntityId?: string | null;
  department?: string | null;
  team?: string | null;
  metadata?: Record<string, unknown>;
  lastVerifiedAt?: number | null;
};

export function updateEntity(
  projectId: string,
  entityId: string,
  updates: UpdateEntityParams,
  actor: string,
  dbOverride?: DatabaseSync,
): Entity {
  const db = dbOverride ?? getDb(projectId);
  const current = getEntity(projectId, entityId, db);
  if (!current) throw new Error(`Entity not found: ${entityId}`);
  const kindConfig = getKindConfig(projectId, current.kind);

  if (updates.parentEntityId) {
    if (wouldCreateCycle(projectId, entityId, updates.parentEntityId, db)) {
      throw new Error("Entity parent relationship would create a cycle");
    }
    const parent = getParentEntity(projectId, updates.parentEntityId, db);
    const parentError = validateEntityParentKind(kindConfig, parent.kind);
    if (parentError) throw new Error(parentError);
  }

  const nextMetadata = updates.metadata ?? current.metadata;
  assertValidMetadata(kindConfig, nextMetadata);

  const next = {
    ...current,
    title: updates.title ?? current.title,
    ownerAgentId: updates.ownerAgentId !== undefined ? updates.ownerAgentId ?? undefined : current.ownerAgentId,
    parentEntityId: updates.parentEntityId !== undefined ? updates.parentEntityId ?? undefined : current.parentEntityId,
    department: updates.department !== undefined ? updates.department ?? undefined : current.department,
    team: updates.team !== undefined ? updates.team ?? undefined : current.team,
    metadata: nextMetadata,
    lastVerifiedAt: updates.lastVerifiedAt !== undefined ? updates.lastVerifiedAt ?? undefined : current.lastVerifiedAt,
    updatedAt: Date.now(),
  } satisfies Entity;

  db.prepare(`
    UPDATE entities
    SET title = ?, owner_agent_id = ?, parent_entity_id = ?, department = ?, team = ?,
        metadata = ?, last_verified_at = ?, updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(
    next.title,
    next.ownerAgentId ?? null,
    next.parentEntityId ?? null,
    next.department ?? null,
    next.team ?? null,
    next.metadata ? JSON.stringify(next.metadata) : null,
    next.lastVerifiedAt ?? null,
    next.updatedAt,
    entityId,
    projectId,
  );

  const updated = getEntity(projectId, entityId, db)!;

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "entity.update",
      targetType: "entity",
      targetId: entityId,
      detail: updated.title,
    }, db);
  } catch (err) {
    safeLog("entity.update.audit", err);
  }

  try {
    recordChange(projectId, {
      resourceType: "entity",
      resourceId: entityId,
      action: "update",
      provenance: "human",
      actor,
      before: current,
      after: updated,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.update.history", err);
  }

  try {
    ingestEvent(projectId, "entity_updated", "internal", {
      entityId,
      kind: updated.kind,
      title: updated.title,
      state: updated.state,
      health: updated.health ?? null,
    }, `entity-updated:${entityId}:${updated.updatedAt}`, db);
  } catch (err) {
    safeLog("entity.update.event", err);
  }

  return updated;
}

export type ListEntityIssuesFilter = {
  entityId?: string;
  status?: EntityIssueStatus;
  severity?: EntityIssueSeverity;
  issueType?: string;
  source?: string;
  limit?: number;
};

export type RecordEntityIssueParams = {
  projectId: string;
  entityId: string;
  issueKey: string;
  issueType: string;
  source: string;
  sourceType?: string;
  sourceId?: string;
  title: string;
  actor: string;
  checkId?: string;
  severity?: EntityIssueSeverity;
  description?: string;
  fieldName?: string;
  evidence?: Record<string, unknown>;
  recommendedAction?: string;
  playbook?: string;
  ownerAgentId?: string;
  blocking?: boolean;
  approvalRequired?: boolean;
};

export type ResolveEntityIssueParams = {
  projectId: string;
  issueId: string;
  actor: string;
  status?: Extract<EntityIssueStatus, "resolved" | "dismissed">;
};

function assertIssueCheck(projectId: string, kind: string, checkId: string | undefined, issueType: string): void {
  if (!checkId) return;
  const check = getKindConfig(projectId, kind).issues?.checks?.[checkId];
  if (!check) {
    throw new Error(`Unknown entity check "${checkId}" for kind "${kind}"`);
  }
  if (check.issueTypes && check.issueTypes.length > 0 && !check.issueTypes.includes(issueType)) {
    throw new Error(`Issue type "${issueType}" is not allowed for check "${checkId}"`);
  }
}

export function getEntityIssue(
  projectId: string,
  issueId: string,
  dbOverride?: DatabaseSync,
): EntityIssue | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM entity_issues WHERE id = ? AND project_id = ?",
  ).get(issueId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToEntityIssue(row) : null;
}

export function listEntityIssues(
  projectId: string,
  filters?: ListEntityIssuesFilter,
  dbOverride?: DatabaseSync,
): EntityIssue[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (filters?.entityId) {
    conditions.push("entity_id = ?");
    values.push(filters.entityId);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters?.severity) {
    conditions.push("severity = ?");
    values.push(filters.severity);
  }
  if (filters?.issueType) {
    conditions.push("issue_type = ?");
    values.push(filters.issueType);
  }
  if (filters?.source) {
    conditions.push("source = ?");
    values.push(filters.source);
  }

  const limit = Math.min(filters?.limit ?? 200, 1000);
  values.push(limit);

  const rows = db.prepare(`
    SELECT * FROM entity_issues
    WHERE ${conditions.join(" AND ")}
    ORDER BY last_seen_at DESC, first_seen_at DESC
    LIMIT ?
  `).all(...values) as Record<string, unknown>[];

  return rows.map(rowToEntityIssue);
}

export function summarizeEntityIssues(
  projectId: string,
  entityId: string,
  dbOverride?: DatabaseSync,
): EntityIssueSummary {
  const db = dbOverride ?? getDb(projectId);
  const entity = getEntity(projectId, entityId, db);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);
  const kindConfig = getKindConfig(projectId, entity.kind);
  const issues = listEntityIssues(projectId, { entityId, status: "open", limit: 1000 }, db);

  const openBySeverity: Partial<Record<EntityIssueSeverity, number>> = {};
  let highestSeverity: EntityIssueSeverity | undefined;
  let suggestedHealth: string | undefined;
  let pendingProposalCount = 0;

  for (const issue of issues) {
    openBySeverity[issue.severity] = (openBySeverity[issue.severity] ?? 0) + 1;
    const previousHighest = highestSeverity;
    highestSeverity = getHigherSeverity(highestSeverity, issue.severity);
    const candidateHealth = resolveSuggestedHealth(kindConfig, issue);
    if (!previousHighest || highestSeverity !== previousHighest) {
      suggestedHealth = candidateHealth ?? suggestedHealth;
    } else if (!suggestedHealth && candidateHealth) {
      suggestedHealth = candidateHealth;
    }
    if (issue.proposalId) {
      const row = db.prepare(
        "SELECT status FROM proposals WHERE id = ? AND project_id = ?",
      ).get(issue.proposalId, projectId) as Record<string, unknown> | undefined;
      if ((row?.status as string | undefined) === "pending") {
        pendingProposalCount += 1;
      }
    }
  }

  return {
    openCount: issues.length,
    blockingOpenCount: issues.filter((issue) => issue.blocking).length,
    approvalRequiredCount: issues.filter((issue) => issue.approvalRequired).length,
    pendingProposalCount,
    highestSeverity,
    suggestedHealth,
    openIssueTypes: Array.from(new Set(issues.map((issue) => issue.issueType))).sort(),
    openBySeverity,
  };
}

export function recordEntityIssue(
  params: RecordEntityIssueParams,
  dbOverride?: DatabaseSync,
): EntityIssue {
  const db = dbOverride ?? getDb(params.projectId);
  const entity = getEntity(params.projectId, params.entityId, db);
  if (!entity) throw new Error(`Entity not found: ${params.entityId}`);
  const kindConfig = getKindConfig(params.projectId, entity.kind);
  const issueConfig = resolveIssueConfig(params.projectId, entity.kind, params.issueType);
  if (kindConfig.issues?.types && !issueConfig && !params.issueType.startsWith("system:")) {
    throw new Error(`Unknown issue type "${params.issueType}" for entity kind "${entity.kind}"`);
  }
  assertIssueCheck(params.projectId, entity.kind, params.checkId, params.issueType);

  const severity = resolveIssueSeverity(kindConfig, params.issueType, params.severity);
  const blocking = resolveIssueBlocking(kindConfig, params.issueType, severity, params.blocking);
  const approvalRequired = resolveIssueApprovalRequired(kindConfig, params.issueType, params.approvalRequired);
  const playbook = resolveIssuePlaybook(kindConfig, params.issueType, params.checkId, params.playbook);
  const ownerAgentId = params.ownerAgentId ?? entity.ownerAgentId;
  const now = Date.now();

  const existingRow = db.prepare(`
    SELECT * FROM entity_issues
    WHERE project_id = ? AND entity_id = ? AND issue_key = ?
    LIMIT 1
  `).get(params.projectId, params.entityId, params.issueKey) as Record<string, unknown> | undefined;

  let issueId = existingRow?.id as string | undefined;
  if (issueId) {
    db.prepare(`
      UPDATE entity_issues
      SET check_id = ?, issue_type = ?, source = ?, severity = ?, status = 'open',
          title = ?, description = ?, field_name = ?, evidence = ?, recommended_action = ?,
          playbook = ?, owner_agent_id = ?, blocking = ?, approval_required = ?,
          last_seen_at = ?, resolved_at = NULL
      WHERE id = ? AND project_id = ?
    `).run(
      params.checkId ?? null,
      params.issueType,
      params.source,
      severity,
      params.title,
      params.description ?? null,
      params.fieldName ?? null,
      params.evidence ? JSON.stringify(params.evidence) : null,
      params.recommendedAction ?? null,
      playbook ?? null,
      ownerAgentId ?? null,
      blocking ? 1 : 0,
      approvalRequired ? 1 : 0,
      now,
      issueId,
      params.projectId,
    );
  } else {
    issueId = randomUUID();
    db.prepare(`
      INSERT INTO entity_issues (
        id, issue_key, project_id, entity_id, entity_kind, check_id, issue_type, source,
        severity, status, title, description, field_name, evidence, recommended_action,
        playbook, owner_agent_id, blocking, approval_required, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issueId,
      params.issueKey,
      params.projectId,
      params.entityId,
      entity.kind,
      params.checkId ?? null,
      params.issueType,
      params.source,
      severity,
      params.title,
      params.description ?? null,
      params.fieldName ?? null,
      params.evidence ? JSON.stringify(params.evidence) : null,
      params.recommendedAction ?? null,
      playbook ?? null,
      ownerAgentId ?? null,
      blocking ? 1 : 0,
      approvalRequired ? 1 : 0,
      now,
      now,
    );
  }

  const issue = getEntityIssue(params.projectId, issueId, db)!;
  syncEntityHealthFromIssues(params.projectId, params.entityId, db);

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: existingRow ? "entity.issue.update" : "entity.issue.open",
      targetType: "entity_issue",
      targetId: issue.id,
      detail: `${issue.issueType}:${issue.title}`,
    }, db);
  } catch (err) {
    safeLog("entity.issue.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity_issue",
      resourceId: issue.id,
      action: existingRow ? "update" : "create",
      provenance: "human",
      actor: params.actor,
      before: existingRow ? rowToEntityIssue(existingRow) : undefined,
      after: issue,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.issue.history", err);
  }

  try {
    ingestEvent(
      params.projectId,
      existingRow ? "entity_issue_updated" : "entity_issue_opened",
      "internal",
      {
        entityId: params.entityId,
        entityKind: entity.kind,
        issueId: issue.id,
        issueKey: issue.issueKey,
        issueType: issue.issueType,
        severity: issue.severity,
        blocking: issue.blocking,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
      },
      `entity-issue:${issue.id}:${issue.lastSeenAt}`,
      db,
    );
  } catch (err) {
    safeLog("entity.issue.event", err);
  }

  return issue;
}

export function resolveEntityIssue(
  params: ResolveEntityIssueParams,
  dbOverride?: DatabaseSync,
): EntityIssue {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getEntityIssue(params.projectId, params.issueId, db);
  if (!current) throw new Error(`Entity issue not found: ${params.issueId}`);
  if (current.status !== "open") return current;

  const status = params.status ?? "resolved";
  const now = Date.now();

  db.prepare(`
    UPDATE entity_issues
    SET status = ?, resolved_at = ?, last_seen_at = ?
    WHERE id = ? AND project_id = ?
  `).run(status, now, now, params.issueId, params.projectId);

  const issue = getEntityIssue(params.projectId, params.issueId, db)!;
  syncEntityHealthFromIssues(params.projectId, issue.entityId, db);

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "entity.issue.resolve",
      targetType: "entity_issue",
      targetId: issue.id,
      detail: `${status}:${issue.issueType}`,
    }, db);
  } catch (err) {
    safeLog("entity.issue.resolve.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity_issue",
      resourceId: issue.id,
      action: "update",
      provenance: "human",
      actor: params.actor,
      before: current,
      after: issue,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.issue.resolve.history", err);
  }

  try {
    ingestEvent(params.projectId, "entity_issue_resolved", "internal", {
      entityId: issue.entityId,
      entityKind: issue.entityKind,
      issueId: issue.id,
      issueType: issue.issueType,
      status,
    }, `entity-issue-resolved:${issue.id}:${now}`, db);
  } catch (err) {
    safeLog("entity.issue.resolve.event", err);
  }

  return issue;
}

export type TransitionEntityParams = {
  projectId: string;
  entityId: string;
  toState?: string;
  toHealth?: string;
  actor: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type RequestEntityTransitionParams = TransitionEntityParams & {
  sessionKey?: string;
};

export type RequestEntityTransitionResult =
  | { ok: true; entity: Entity }
  | {
      ok: false;
      approvalRequired: true;
      reason: string;
      proposal: Proposal;
      blockingIssues: EntityIssue[];
    };

function linkIssuesToProposal(
  projectId: string,
  issueIds: string[],
  proposalId: string,
  db: DatabaseSync,
): void {
  if (issueIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE entity_issues SET proposal_id = ? WHERE project_id = ? AND id = ?`,
  );
  for (const issueId of issueIds) {
    stmt.run(proposalId, projectId, issueId);
  }
}

export function requestEntityTransition(
  params: RequestEntityTransitionParams,
  dbOverride?: DatabaseSync,
): RequestEntityTransitionResult {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getEntity(params.projectId, params.entityId, db);
  if (!current) throw new Error(`Entity not found: ${params.entityId}`);
  const kindConfig = getKindConfig(params.projectId, current.kind);
  const nextState = params.toState ?? current.state;
  const transitionRule = nextState !== current.state
    ? getEntityTransitionRule(kindConfig, current.state, nextState)
    : undefined;

  const openIssues = listEntityIssues(params.projectId, {
    entityId: params.entityId,
    status: "open",
    limit: 1000,
  }, db);

  const blockingIssues = openIssues.filter((issue) => {
    if (!transitionRule) return false;
    if (transitionRule.blockedByIssueTypes?.includes(issue.issueType)) return true;
    if (transitionRule.blockedBySeverities?.includes(issue.severity)) return true;
    if (transitionRule.blockedByOpenIssues && issue.blocking) return true;
    return false;
  });

  const approvalRequired = Boolean(transitionRule?.approvalRequired) || blockingIssues.length > 0;
  if (!approvalRequired) {
    return { ok: true, entity: transitionEntity(params, db) };
  }

  const reasonParts = [
    transitionRule?.approvalRequired ? `transition ${current.state} -> ${nextState} requires approval` : undefined,
    blockingIssues.length > 0 ? `${blockingIssues.length} blocking issue(s) remain open` : undefined,
  ].filter(Boolean);
  const reason = reasonParts.join("; ");

  const proposal = createProposal({
    projectId: params.projectId,
    title: `Approve entity transition: ${current.title} ${current.state} -> ${nextState}`,
    description: [
      `Entity ${current.title} (${current.kind}) requested transition ${current.state} -> ${nextState}.`,
      reasonParts.length > 0 ? `Reason: ${reason}.` : undefined,
    ].filter(Boolean).join(" "),
    proposedBy: params.actor,
    sessionKey: params.sessionKey,
    approvalPolicySnapshot: JSON.stringify({
      entityId: params.entityId,
      toState: params.toState,
      toHealth: params.toHealth,
      reason: params.reason,
      actor: params.actor,
      metadata: params.metadata,
    }),
    riskTier: blockingIssues.length > 0 ? "high" : "medium",
    entityType: current.kind,
    entityId: current.id,
    origin: "entity_transition",
    reasoning: reason || undefined,
  }, db);

  linkIssuesToProposal(
    params.projectId,
    blockingIssues.filter((issue) => issue.approvalRequired || issue.blocking).map((issue) => issue.id),
    proposal.id,
    db,
  );

  getApprovalNotifier()?.sendProposalNotification({
    proposalId: proposal.id,
    projectId: params.projectId,
    title: proposal.title,
    description: proposal.description ?? undefined,
    proposedBy: params.actor,
    riskTier: proposal.risk_tier ?? undefined,
  }).catch((err) => safeLog("entity.transition.proposalNotify", err));

  try {
    ingestEvent(params.projectId, "proposal_created", "internal", {
      proposalId: proposal.id,
      proposedBy: params.actor,
      riskTier: proposal.risk_tier,
      title: proposal.title,
      entityId: current.id,
      entityType: current.kind,
    }, `proposal-created:${proposal.id}`, db);
  } catch (err) {
    safeLog("entity.transition.proposalEvent", err);
  }

  return {
    ok: false,
    approvalRequired: true,
    reason,
    proposal,
    blockingIssues,
  };
}

export function transitionEntity(
  params: TransitionEntityParams,
  dbOverride?: DatabaseSync,
): Entity {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getEntity(params.projectId, params.entityId, db);
  if (!current) throw new Error(`Entity not found: ${params.entityId}`);
  const kindConfig = getKindConfig(params.projectId, current.kind);

  const nextState = params.toState ?? current.state;
  const nextHealth = params.toHealth ?? current.health;

  if (nextState === current.state && nextHealth === current.health) {
    return current;
  }

  assertValidState(kindConfig, nextState);
  const healthError = validateEntityHealth(kindConfig, nextHealth);
  if (healthError) throw new Error(healthError);

  if (nextState !== current.state) {
    if (!allowsEntityTransition(kindConfig, current.state, nextState)) {
      throw new Error(`Transition ${current.state} -> ${nextState} is not allowed for entity kind "${current.kind}"`);
    }
    const transitionRule = getEntityTransitionRule(kindConfig, current.state, nextState);
    if (transitionRule?.reasonRequired && !params.reason) {
      throw new Error(`Transition ${current.state} -> ${nextState} requires a reason`);
    }
  }

  const now = Date.now();
  db.prepare(
    "UPDATE entities SET state = ?, health = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).run(nextState, nextHealth ?? null, now, params.entityId, params.projectId);

  const transitionId = randomUUID();
  db.prepare(`
    INSERT INTO entity_transitions (
      id, entity_id, project_id, from_state, to_state, from_health, to_health, actor, reason, metadata, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    transitionId,
    params.entityId,
    params.projectId,
    current.state,
    nextState,
    current.health ?? null,
    nextHealth ?? null,
    params.actor,
    params.reason ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
  );

  const updated = getEntity(params.projectId, params.entityId, db)!;

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "entity.transition",
      targetType: "entity",
      targetId: params.entityId,
      detail: `${current.state}/${current.health ?? "none"} -> ${updated.state}/${updated.health ?? "none"}`,
    }, db);
  } catch (err) {
    safeLog("entity.transition.audit", err);
  }

  try {
    recordChange(params.projectId, {
      resourceType: "entity",
      resourceId: params.entityId,
      action: "transition",
      provenance: "human",
      actor: params.actor,
      before: current,
      after: updated,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.transition.history", err);
  }

  try {
    ingestEvent(params.projectId, "entity_transitioned", "internal", {
      entityId: params.entityId,
      kind: updated.kind,
      fromState: current.state,
      toState: updated.state,
      fromHealth: current.health ?? null,
      toHealth: updated.health ?? null,
      reason: params.reason ?? null,
    }, `entity-transitioned:${params.entityId}:${now}`, db);
    emitDiagnosticEvent({
      type: "entity_transitioned",
      projectId: params.projectId,
      entityId: params.entityId,
      kind: updated.kind,
      fromState: current.state,
      toState: updated.state,
    });
  } catch (err) {
    safeLog("entity.transition.event", err);
  }

  return updated;
}

export function getEntity(projectId: string, entityId: string, dbOverride?: DatabaseSync): Entity | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM entities WHERE id = ? AND project_id = ?",
  ).get(entityId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToEntity(row) : null;
}

export type ListEntitiesFilter = {
  kind?: string;
  state?: string;
  health?: string;
  ownerAgentId?: string;
  parentEntityId?: string | null;
  department?: string;
  team?: string;
  limit?: number;
};

export function listEntities(
  projectId: string,
  filter?: ListEntitiesFilter,
  dbOverride?: DatabaseSync,
): Entity[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (filter?.kind) {
    conditions.push("kind = ?");
    values.push(filter.kind);
  }
  if (filter?.state) {
    conditions.push("state = ?");
    values.push(filter.state);
  }
  if (filter?.health) {
    conditions.push("health = ?");
    values.push(filter.health);
  }
  if (filter?.ownerAgentId) {
    conditions.push("owner_agent_id = ?");
    values.push(filter.ownerAgentId);
  }
  if (filter?.parentEntityId !== undefined) {
    if (filter.parentEntityId === null) {
      conditions.push("parent_entity_id IS NULL");
    } else {
      conditions.push("parent_entity_id = ?");
      values.push(filter.parentEntityId);
    }
  }
  if (filter?.department) {
    conditions.push("department = ?");
    values.push(filter.department);
  }
  if (filter?.team) {
    conditions.push("team = ?");
    values.push(filter.team);
  }

  const limit = Math.min(filter?.limit ?? 200, 1000);
  values.push(limit);

  const rows = db.prepare(`
    SELECT * FROM entities
    WHERE ${conditions.join(" AND ")}
    ORDER BY kind ASC, title ASC, created_at ASC
    LIMIT ?
  `).all(...values) as Record<string, unknown>[];
  return rows.map(rowToEntity);
}

export function getChildEntities(
  projectId: string,
  entityId: string,
  dbOverride?: DatabaseSync,
): Entity[] {
  return listEntities(projectId, { parentEntityId: entityId }, dbOverride);
}

export function getEntityTransitions(
  projectId: string,
  entityId: string,
  dbOverride?: DatabaseSync,
): EntityTransitionRecord[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM entity_transitions WHERE entity_id = ? AND project_id = ? ORDER BY created_at ASC",
  ).all(entityId, projectId) as Record<string, unknown>[];
  return rows.map(rowToEntityTransition);
}

export function listEntityKinds(projectId: string): Array<{ kind: string; config: EntityKindConfig }> {
  const config = getExtendedProjectConfig(projectId);
  return Object.entries(config?.entities ?? {}).map(([kind, kindConfig]) => ({ kind, config: kindConfig }));
}
