/**
 * Clawforce SDK — Entities Namespace
 *
 * Wraps internal entity lifecycle operations with the public SDK vocabulary:
 *   owner    → ownerAgentId
 *   group    → department
 *   subgroup → team
 */

import {
  listEntityCheckRuns as internalListEntityCheckRuns,
  runEntityChecks as internalRunEntityChecks,
} from "../entities/checks.js";
import {
  createEntity as internalCreateEntity,
  getChildEntities as internalGetChildEntities,
  getEntity as internalGetEntity,
  getEntityIssue as internalGetEntityIssue,
  getEntityTransitions as internalGetEntityTransitions,
  listEntities as internalListEntities,
  listEntityIssues as internalListEntityIssues,
  listEntityKinds as internalListEntityKinds,
  recordEntityIssue as internalRecordEntityIssue,
  requestEntityTransition as internalRequestEntityTransition,
  resolveEntityIssue as internalResolveEntityIssue,
  summarizeEntityIssues as internalSummarizeEntityIssues,
  transitionEntity as internalTransitionEntity,
  updateEntity as internalUpdateEntity,
} from "../entities/ops.js";
import type {
  EntityCheckRun as InternalEntityCheckRun,
  Entity as InternalEntity,
  EntityIssue as InternalEntityIssue,
  EntityIssueSummary as InternalEntityIssueSummary,
  EntityTransitionRecord as InternalEntityTransition,
} from "../types.js";
import type {
  Entity,
  EntityCheckResult,
  EntityCheckRun,
  EntityDetail,
  EntityIssue,
  EntityIssueSummary,
  EntityKind,
  EntityParams,
  EntityTransition,
  EntityTransitionRequest,
} from "./types.js";

function toPublicEntity(entity: InternalEntity): Entity {
  return {
    id: entity.id,
    kind: entity.kind,
    title: entity.title,
    state: entity.state,
    health: entity.health,
    owner: entity.ownerAgentId,
    parentEntityId: entity.parentEntityId,
    group: entity.department,
    subgroup: entity.team,
    metadata: entity.metadata,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    lastVerifiedAt: entity.lastVerifiedAt,
  };
}

function toPublicEntityIssue(issue: InternalEntityIssue): EntityIssue {
  return {
    id: issue.id,
    issueKey: issue.issueKey,
    entityId: issue.entityId,
    entityKind: issue.entityKind,
    checkId: issue.checkId,
    issueType: issue.issueType,
    source: issue.source,
    severity: issue.severity,
    status: issue.status,
    title: issue.title,
    description: issue.description,
    fieldName: issue.fieldName,
    evidence: issue.evidence,
    recommendedAction: issue.recommendedAction,
    playbook: issue.playbook,
    owner: issue.ownerAgentId,
    blocking: issue.blocking,
    approvalRequired: issue.approvalRequired,
    proposalId: issue.proposalId,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    resolvedAt: issue.resolvedAt,
  };
}

function toPublicIssueSummary(summary: InternalEntityIssueSummary): EntityIssueSummary {
  return { ...summary };
}

function toPublicCheckRun(run: InternalEntityCheckRun): EntityCheckRun {
  return {
    id: run.id,
    entityId: run.entityId,
    entityKind: run.entityKind,
    checkId: run.checkId,
    status: run.status,
    command: run.command,
    parserType: run.parserType,
    actor: run.actor,
    trigger: run.trigger,
    sourceType: run.sourceType,
    sourceId: run.sourceId,
    exitCode: run.exitCode,
    issueCount: run.issueCount,
    stdout: run.stdout,
    stderr: run.stderr,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
  };
}

function toPublicTransition(transition: InternalEntityTransition): EntityTransition {
  return { ...transition };
}

export class EntitiesNamespace {
  constructor(readonly domain: string) {}

  kinds(): EntityKind[] {
    return internalListEntityKinds(this.domain).map(({ kind, config }) => ({
      kind,
      title: config.title,
      description: config.description,
      states: Object.keys(config.states),
      healthValues: config.health?.values,
    }));
  }

  create(params: EntityParams, actor?: string): Entity {
    const entity = internalCreateEntity({
      projectId: this.domain,
      kind: params.kind,
      title: params.title,
      state: params.state,
      health: params.health,
      ownerAgentId: params.owner,
      parentEntityId: params.parentEntityId,
      department: params.group,
      team: params.subgroup,
      metadata: params.metadata,
      lastVerifiedAt: params.lastVerifiedAt,
      createdBy: actor ?? "sdk",
    });
    return toPublicEntity(entity);
  }

  get(entityId: string): Entity | undefined {
    const entity = internalGetEntity(this.domain, entityId);
    return entity ? toPublicEntity(entity) : undefined;
  }

  detail(entityId: string): EntityDetail | undefined {
    const entity = internalGetEntity(this.domain, entityId);
    if (!entity) return undefined;
    return {
      entity: toPublicEntity(entity),
      children: internalGetChildEntities(this.domain, entityId).map(toPublicEntity),
      transitions: internalGetEntityTransitions(this.domain, entityId).map(toPublicTransition),
      issues: internalListEntityIssues(this.domain, { entityId }).map(toPublicEntityIssue),
      issueSummary: toPublicIssueSummary(internalSummarizeEntityIssues(this.domain, entityId)),
      checkRuns: internalListEntityCheckRuns(this.domain, entityId).map(toPublicCheckRun),
    };
  }

  list(filters?: {
    kind?: string;
    state?: string;
    health?: string;
    owner?: string;
    parentEntityId?: string | null;
    group?: string;
    subgroup?: string;
    limit?: number;
  }): Entity[] {
    return internalListEntities(this.domain, {
      kind: filters?.kind,
      state: filters?.state,
      health: filters?.health,
      ownerAgentId: filters?.owner,
      parentEntityId: filters?.parentEntityId,
      department: filters?.group,
      team: filters?.subgroup,
      limit: filters?.limit,
    }).map(toPublicEntity);
  }

  update(entityId: string, updates: Partial<EntityParams>, actor?: string): Entity {
    const entity = internalUpdateEntity(this.domain, entityId, {
      title: updates.title,
      ownerAgentId: updates.owner === undefined ? undefined : updates.owner ?? null,
      parentEntityId: updates.parentEntityId === undefined ? undefined : updates.parentEntityId ?? null,
      department: updates.group === undefined ? undefined : updates.group ?? null,
      team: updates.subgroup === undefined ? undefined : updates.subgroup ?? null,
      metadata: updates.metadata,
      lastVerifiedAt: updates.lastVerifiedAt === undefined ? undefined : updates.lastVerifiedAt ?? null,
    }, actor ?? "sdk");
    return toPublicEntity(entity);
  }

  transition(
    entityId: string,
    updates: { toState?: string; toHealth?: string; reason?: string; metadata?: Record<string, unknown> },
    actor?: string,
  ): Entity {
    const entity = internalTransitionEntity({
      projectId: this.domain,
      entityId,
      toState: updates.toState,
      toHealth: updates.toHealth,
      reason: updates.reason,
      metadata: updates.metadata,
      actor: actor ?? "sdk",
    });
    return toPublicEntity(entity);
  }

  requestTransition(
    entityId: string,
    updates: { toState?: string; toHealth?: string; reason?: string; metadata?: Record<string, unknown> },
    actor?: string,
  ): EntityTransitionRequest {
    const result = internalRequestEntityTransition({
      projectId: this.domain,
      entityId,
      toState: updates.toState,
      toHealth: updates.toHealth,
      reason: updates.reason,
      metadata: updates.metadata,
      actor: actor ?? "sdk",
    });
    if (result.ok) {
      return { ok: true, entity: toPublicEntity(result.entity) };
    }
    return {
      ok: false,
      approvalRequired: true,
      reason: result.reason,
      proposal: {
        id: result.proposal.id,
        title: result.proposal.title,
        description: result.proposal.description,
        status: result.proposal.status,
      },
      blockingIssues: result.blockingIssues.map(toPublicEntityIssue),
    };
  }

  children(entityId: string): Entity[] {
    return internalGetChildEntities(this.domain, entityId).map(toPublicEntity);
  }

  history(entityId: string) {
    return internalGetEntityTransitions(this.domain, entityId);
  }

  issues(entityId: string): EntityIssue[] {
    return internalListEntityIssues(this.domain, { entityId }).map(toPublicEntityIssue);
  }

  issue(issueId: string): EntityIssue | undefined {
    const issue = internalGetEntityIssue(this.domain, issueId);
    return issue ? toPublicEntityIssue(issue) : undefined;
  }

  issueSummary(entityId: string): EntityIssueSummary {
    return toPublicIssueSummary(internalSummarizeEntityIssues(this.domain, entityId));
  }

  checkRuns(entityId: string, limit = 20): EntityCheckRun[] {
    return internalListEntityCheckRuns(this.domain, entityId, limit).map(toPublicCheckRun);
  }

  runChecks(entityId: string, options?: { checkIds?: string[]; actor?: string }): {
    entity: Entity;
    results: EntityCheckResult[];
  } {
    const result = internalRunEntityChecks(this.domain, entityId, {
      checkIds: options?.checkIds,
      actor: options?.actor ?? "sdk",
      trigger: "sdk",
      sourceType: "sdk",
      sourceId: "runChecks",
    });
    return {
      entity: toPublicEntity(result.entity),
      results: result.results.map((run) => ({
        id: run.id,
        entityId: run.entityId,
        entityKind: run.entityKind,
        checkId: run.checkId,
        status: run.status,
        command: run.command,
        parserType: run.parserType,
        actor: run.actor,
        trigger: run.trigger,
        sourceType: run.sourceType,
        sourceId: run.sourceId,
        exitCode: run.exitCode,
        issueCount: run.issueCount,
        stdout: run.stdout,
        stderr: run.stderr,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
        issues: run.issues.map(toPublicEntityIssue),
      })),
    };
  }

  reportIssue(params: {
    entityId: string;
    issueKey: string;
    issueType: string;
    source: string;
    title: string;
    checkId?: string;
    severity?: EntityIssue["severity"];
    description?: string;
    fieldName?: string;
    evidence?: Record<string, unknown>;
    recommendedAction?: string;
    playbook?: string;
    owner?: string;
  }, actor?: string): EntityIssue {
    return toPublicEntityIssue(internalRecordEntityIssue({
      projectId: this.domain,
      entityId: params.entityId,
      issueKey: params.issueKey,
      issueType: params.issueType,
      source: params.source,
      title: params.title,
      actor: actor ?? "sdk",
      checkId: params.checkId,
      severity: params.severity,
      description: params.description,
      fieldName: params.fieldName,
      evidence: params.evidence,
      recommendedAction: params.recommendedAction,
      playbook: params.playbook,
      ownerAgentId: params.owner,
    }));
  }

  resolveIssue(issueId: string, actor?: string, status?: "resolved" | "dismissed"): EntityIssue {
    return toPublicEntityIssue(internalResolveEntityIssue({
      projectId: this.domain,
      issueId,
      actor: actor ?? "sdk",
      status,
    }));
  }
}
