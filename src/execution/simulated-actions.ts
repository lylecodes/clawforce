import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import type {
  DomainExecutionEffect,
  SimulatedAction,
  SimulatedActionStatus,
} from "../types.js";

export type RecordSimulatedActionParams = {
  projectId: string;
  domainId?: string;
  agentId?: string;
  sessionKey?: string;
  taskId?: string;
  entityType?: string;
  entityId?: string;
  proposalId?: string;
  sourceType: string;
  sourceId?: string;
  actionType: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  policyDecision: DomainExecutionEffect;
  status?: SimulatedActionStatus;
};

export type SimulatedActionStats = {
  total: number;
  pending: number;
  simulated: number;
  blocked: number;
  approvedForLive: number;
  discarded: number;
  latestCreatedAt: number | null;
};

function rowToSimulatedAction(row: Record<string, unknown>): SimulatedAction {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    domainId: row.domain_id as string,
    agentId: (row.agent_id as string) ?? undefined,
    sessionKey: (row.session_key as string) ?? undefined,
    taskId: (row.task_id as string) ?? undefined,
    entityType: (row.entity_type as string) ?? undefined,
    entityId: (row.entity_id as string) ?? undefined,
    proposalId: (row.proposal_id as string) ?? undefined,
    sourceType: row.source_type as string,
    sourceId: (row.source_id as string) ?? undefined,
    actionType: row.action_type as string,
    targetType: (row.target_type as string) ?? undefined,
    targetId: (row.target_id as string) ?? undefined,
    summary: row.summary as string,
    payload: typeof row.payload === "string" && row.payload
      ? JSON.parse(row.payload as string) as Record<string, unknown>
      : undefined,
    policyDecision: row.policy_decision as DomainExecutionEffect,
    status: row.status as SimulatedActionStatus,
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number) ?? undefined,
  };
}

export function recordSimulatedAction(
  params: RecordSimulatedActionParams,
  dbOverride?: DatabaseSync,
): SimulatedAction {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const createdAt = Date.now();
  const status = params.status
    ?? (params.policyDecision === "simulate" ? "simulated" : "blocked");
  db.prepare(`
    INSERT INTO simulated_actions (
      id, project_id, domain_id, agent_id, session_key, task_id,
      entity_type, entity_id, proposal_id, source_type, source_id, action_type,
      target_type, target_id, summary, payload, policy_decision, status,
      created_at, resolved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    params.projectId,
    params.domainId ?? params.projectId,
    params.agentId ?? null,
    params.sessionKey ?? null,
    params.taskId ?? null,
    params.entityType ?? null,
    params.entityId ?? null,
    params.proposalId ?? null,
    params.sourceType,
    params.sourceId ?? null,
    params.actionType,
    params.targetType ?? null,
    params.targetId ?? null,
    params.summary,
    params.payload ? JSON.stringify(params.payload) : null,
    params.policyDecision,
    status,
    createdAt,
  );

  return {
    id,
    projectId: params.projectId,
    domainId: params.domainId ?? params.projectId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    entityType: params.entityType,
    entityId: params.entityId,
    proposalId: params.proposalId,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    actionType: params.actionType,
    targetType: params.targetType,
    targetId: params.targetId,
    summary: params.summary,
    payload: params.payload,
    policyDecision: params.policyDecision,
    status,
    createdAt,
  };
}

export function listSimulatedActions(
  projectId: string,
  filters?: {
    status?: SimulatedActionStatus | SimulatedActionStatus[];
    entityType?: string;
    entityId?: string;
    taskId?: string;
    proposalId?: string;
    limit?: number;
  },
  dbOverride?: DatabaseSync,
): SimulatedAction[] {
  const db = dbOverride ?? getDb(projectId);
  const clauses = ["project_id = ?"];
  const params: Array<string | number> = [projectId];

  const statuses = filters?.status
    ? (Array.isArray(filters.status) ? filters.status : [filters.status])
    : [];
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filters?.entityType) {
    clauses.push("entity_type = ?");
    params.push(filters.entityType);
  }
  if (filters?.entityId) {
    clauses.push("entity_id = ?");
    params.push(filters.entityId);
  }
  if (filters?.taskId) {
    clauses.push("task_id = ?");
    params.push(filters.taskId);
  }
  if (filters?.proposalId) {
    clauses.push("proposal_id = ?");
    params.push(filters.proposalId);
  }

  const limit = Math.min(filters?.limit ?? 50, 200);
  params.push(limit);

  const rows = db.prepare(`
    SELECT *
    FROM simulated_actions
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSimulatedAction);
}

export function getSimulatedAction(
  projectId: string,
  actionId: string,
  dbOverride?: DatabaseSync,
): SimulatedAction | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT *
    FROM simulated_actions
    WHERE project_id = ? AND id = ?
    LIMIT 1
  `).get(projectId, actionId) as Record<string, unknown> | undefined;
  return row ? rowToSimulatedAction(row) : null;
}

export function getSimulatedActionByProposal(
  projectId: string,
  proposalId: string,
  dbOverride?: DatabaseSync,
): SimulatedAction | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT *
    FROM simulated_actions
    WHERE project_id = ? AND proposal_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, proposalId) as Record<string, unknown> | undefined;
  return row ? rowToSimulatedAction(row) : null;
}

export function getSimulatedActionStats(
  projectId: string,
  dbOverride?: DatabaseSync,
): SimulatedActionStats {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'simulated' THEN 1 ELSE 0 END) AS simulated,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status = 'approved_for_live' THEN 1 ELSE 0 END) AS approved_for_live,
      SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) AS discarded,
      MAX(created_at) AS latest_created_at
    FROM simulated_actions
    WHERE project_id = ?
  `).get(projectId) as Record<string, unknown> | undefined;

  const simulated = Number(row?.simulated ?? 0);
  const blocked = Number(row?.blocked ?? 0);
  return {
    total: Number(row?.total ?? 0),
    pending: simulated + blocked,
    simulated,
    blocked,
    approvedForLive: Number(row?.approved_for_live ?? 0),
    discarded: Number(row?.discarded ?? 0),
    latestCreatedAt: typeof row?.latest_created_at === "number"
      ? row.latest_created_at as number
      : null,
  };
}

export function attachProposalToSimulatedAction(
  projectId: string,
  actionId: string,
  proposalId: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(`
    UPDATE simulated_actions
    SET proposal_id = ?
    WHERE project_id = ? AND id = ?
  `).run(proposalId, projectId, actionId);
}

export function setSimulatedActionStatus(
  projectId: string,
  actionId: string,
  status: SimulatedActionStatus,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(`
    UPDATE simulated_actions
    SET status = ?, resolved_at = ?
    WHERE project_id = ? AND id = ?
  `).run(status, Date.now(), projectId, actionId);
}
