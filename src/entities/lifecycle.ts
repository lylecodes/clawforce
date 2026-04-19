import type { DatabaseSync } from "../sqlite-driver.js";
import type { Entity, Task, TaskState } from "../types.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { listTasks, transitionTask } from "../tasks/ops.js";
import {
  getEntity,
  listEntityIssues,
  requestEntityTransition,
  updateEntity,
} from "./ops.js";
import { getExtendedProjectConfig } from "../project.js";

const TERMINAL_TASK_STATES = new Set<TaskState>(["DONE", "FAILED", "CANCELLED"]);

export type EntityReadinessReconcileResult = {
  entityId: string;
  evaluated: boolean;
  ready: boolean;
  blockers: string[];
  blockersField?: string;
  closedTaskIds: string[];
  transitionProposalId?: string;
  transitioned?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function renderTemplate(template: string, entity: Entity): string {
  return template.replace(/\{\{\s*entity\.([^}]+)\s*\}\}/g, (_match, token) => {
    const key = String(token).trim();
    if (key === "title") return entity.title;
    const metadata = asRecord(entity.metadata);
    const value = metadata?.[key];
    return value == null ? "" : String(value);
  });
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function listNonTerminalEntityTasks(projectId: string, entityId: string, db: DatabaseSync): Task[] {
  return listTasks(projectId, { entityId, limit: 1000 }, db)
    .filter((task) => !TERMINAL_TASK_STATES.has(task.state));
}

function getExistingTransitionProposalId(
  projectId: string,
  entityId: string,
  toState: string,
  db: DatabaseSync,
): string | undefined {
  const row = db.prepare(`
    SELECT id
    FROM proposals
    WHERE project_id = ?
      AND entity_id = ?
      AND origin = 'entity_transition'
      AND status IN ('pending', 'approved')
      AND json_extract(approval_policy_snapshot, '$.toState') = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, entityId, toState) as { id?: string } | undefined;
  return typeof row?.id === "string" ? row.id : undefined;
}

function evaluateReadinessBlockers(entity: Entity, projectId: string, db: DatabaseSync): string[] {
  const kindConfig = getExtendedProjectConfig(projectId)?.entities?.[entity.kind];
  const readiness = kindConfig?.readiness;
  if (!readiness) return [];

  const metadata = asRecord(entity.metadata) ?? {};
  const blockers: string[] = [];
  const requirements = readiness.requirements;
  if (!requirements) return blockers;

  if (requirements.noOpenIssues) {
    const openIssues = listEntityIssues(projectId, {
      entityId: entity.id,
      status: "open",
      limit: 1000,
    }, db);
    if (openIssues.length > 0) {
      blockers.push(`${openIssues.length} open issue(s) remain`);
    }
  }

  for (const fieldName of requirements.metadataTrue ?? []) {
    if (metadata[fieldName] !== true) {
      blockers.push(`metadata.${fieldName} must be true`);
    }
  }

  for (const [fieldName, expected] of Object.entries(requirements.metadataEquals ?? {})) {
    if (metadata[fieldName] !== expected) {
      blockers.push(`metadata.${fieldName} must equal ${String(expected)}`);
    }
  }

  for (const [fieldName, minimum] of Object.entries(requirements.metadataMin ?? {})) {
    const value = metadata[fieldName];
    if (typeof value !== "number" || value < minimum) {
      blockers.push(`metadata.${fieldName} must be >= ${minimum}`);
    }
  }

  return blockers;
}

function syncBlockerMetadata(
  entity: Entity,
  blockersField: string | undefined,
  blockers: string[],
  actor: string,
  db: DatabaseSync,
): Entity {
  if (!blockersField) return entity;
  const currentBlockers = Array.isArray(entity.metadata?.[blockersField])
    ? entity.metadata?.[blockersField] as string[]
    : undefined;
  if (sameStringArray(currentBlockers, blockers)) return entity;

  const nextMetadata = {
    ...(entity.metadata ?? {}),
    [blockersField]: blockers,
  };
  return updateEntity(entity.projectId, entity.id, { metadata: nextMetadata }, actor, db);
}

function closeReadyTasks(
  entity: Entity,
  actor: string,
  db: DatabaseSync,
): string[] {
  const readiness = getExtendedProjectConfig(entity.projectId)?.entities?.[entity.kind]?.readiness;
  const titleTemplates = readiness?.closeTasksWhenReady?.titleTemplates ?? [];
  if (titleTemplates.length === 0) return [];

  const targetTitles = new Set(titleTemplates.map((template) => renderTemplate(template, entity)));
  const openTasks = listNonTerminalEntityTasks(entity.projectId, entity.id, db);
  const closedTaskIds: string[] = [];

  for (const task of openTasks) {
    if (!targetTitles.has(task.title)) continue;
    try {
      transitionTask({
        projectId: entity.projectId,
        taskId: task.id,
        toState: "CANCELLED",
        actor,
        reason: "Entity is ready for promotion; closing bootstrap task",
        verificationRequired: false,
      }, db);
      closedTaskIds.push(task.id);
    } catch (err) {
      safeLog("entity.lifecycle.closeReadyTask", err);
    }
  }

  return closedTaskIds;
}

export function reconcileEntityReadiness(
  projectId: string,
  entityId: string,
  actor = "system:entity-readiness",
  dbOverride?: DatabaseSync,
): EntityReadinessReconcileResult {
  const db = dbOverride ?? getDb(projectId);
  let entity = getEntity(projectId, entityId, db);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const kindConfig = getExtendedProjectConfig(projectId)?.entities?.[entity.kind];
  const readiness = kindConfig?.readiness;
  if (!readiness) {
    return {
      entityId,
      evaluated: false,
      ready: false,
      blockers: [],
      closedTaskIds: [],
    };
  }

  const whenStates = readiness.whenStates ?? [];
  const inScopeState = whenStates.length === 0 || whenStates.includes(entity.state);
  if (!inScopeState) {
    entity = syncBlockerMetadata(entity, readiness.blockersField, [], actor, db);
    return {
      entityId,
      evaluated: false,
      ready: false,
      blockers: [],
      blockersField: readiness.blockersField,
      closedTaskIds: [],
    };
  }

  const blockers = evaluateReadinessBlockers(entity, projectId, db);
  entity = syncBlockerMetadata(entity, readiness.blockersField, blockers, actor, db);

  const ready = blockers.length === 0;
  const closedTaskIds = ready ? closeReadyTasks(entity, actor, db) : [];

  let transitionProposalId: string | undefined;
  let transitioned = false;
  const transitionConfig = readiness.requestTransitionWhenReady;
  if (ready && transitionConfig && entity.state !== transitionConfig.toState) {
    transitionProposalId = getExistingTransitionProposalId(projectId, entity.id, transitionConfig.toState, db);
    if (!transitionProposalId) {
      const result = requestEntityTransition({
        projectId,
        entityId: entity.id,
        toState: transitionConfig.toState,
        actor: transitionConfig.actor ?? actor,
        reason: transitionConfig.reason ?? "Entity readiness requirements satisfied",
      }, db);
      if (result.ok) {
        transitioned = true;
      } else {
        transitionProposalId = result.proposal.id;
      }
    }
  }

  return {
    entityId,
    evaluated: true,
    ready,
    blockers,
    blockersField: readiness.blockersField,
    closedTaskIds,
    transitionProposalId,
    transitioned,
  };
}
