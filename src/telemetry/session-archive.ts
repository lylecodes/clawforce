/**
 * Clawforce — Session archive telemetry
 *
 * Archives completed sessions with compressed transcripts and context.
 * Provides retrieval with transparent decompression.
 */

import crypto from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type SessionArchiveParams = {
  sessionKey: string;
  agentId: string;
  projectId: string;
  contextHash?: string;
  contextContent?: string;
  transcript?: string;
  agentConfigSnapshot?: string;
  taskId?: string;
  queueItemId?: string;
  jobName?: string;
  outcome: string;
  exitSignal?: string;
  complianceDetail?: string;
  totalCostCents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  model?: string;
  provider?: string;
  configVersionId?: string;
  experimentVariantId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  toolCallCount?: number;
  errorCount?: number;
};

export type SessionArchive = SessionArchiveParams & {
  id: string;
  createdAt: number;
};

export type SessionArchiveFilters = {
  agentId?: string;
  since?: number;
  until?: number;
  outcome?: string;
  limit?: number;
  offset?: number;
};

// --- Compression helpers ---

function compress(text: string): string {
  return deflateSync(Buffer.from(text, "utf-8")).toString("base64");
}

function decompress(data: string): string {
  return inflateSync(Buffer.from(data, "base64")).toString("utf-8");
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// --- Core functions ---

/**
 * Create a session archive entry with compressed transcript and context.
 */
export function archiveSession(
  params: SessionArchiveParams,
  dbOverride?: DatabaseSync,
): SessionArchive {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  // Compress large text fields
  const contextContent = params.contextContent
    ? compress(params.contextContent)
    : null;
  const transcript = params.transcript
    ? compress(params.transcript)
    : null;
  const agentConfigSnapshot = params.agentConfigSnapshot
    ? compress(params.agentConfigSnapshot)
    : null;

  try {
    db.prepare(`
      INSERT INTO session_archives (
        id, session_key, agent_id, project_id,
        context_hash, context_content, transcript, agent_config_snapshot,
        task_id, queue_item_id, job_name,
        outcome, exit_signal, compliance_detail,
        total_cost_cents, total_input_tokens, total_output_tokens,
        model, provider,
        config_version_id, experiment_variant_id,
        started_at, ended_at, duration_ms,
        tool_call_count, error_count,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.sessionKey, params.agentId, params.projectId,
      params.contextHash ?? null, contextContent, transcript, agentConfigSnapshot,
      params.taskId ?? null, params.queueItemId ?? null, params.jobName ?? null,
      params.outcome, params.exitSignal ?? null, params.complianceDetail ?? null,
      params.totalCostCents ?? 0, params.totalInputTokens ?? 0, params.totalOutputTokens ?? 0,
      params.model ?? null, params.provider ?? null,
      params.configVersionId ?? null, params.experimentVariantId ?? null,
      params.startedAt, params.endedAt ?? null, params.durationMs ?? null,
      params.toolCallCount ?? 0, params.errorCount ?? 0,
      now,
    );
  } catch (err) {
    safeLog("telemetry.archive", err);
    throw err;
  }

  return { ...params, id, createdAt: now };
}

/**
 * Retrieve a session archive with decompressed fields.
 */
export function getSessionArchive(
  projectId: string,
  sessionKey: string,
  dbOverride?: DatabaseSync,
): SessionArchive | null {
  const db = dbOverride ?? getDb(projectId);

  const row = db.prepare(`
    SELECT * FROM session_archives
    WHERE project_id = ? AND session_key = ?
    LIMIT 1
  `).get(projectId, sessionKey) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapArchiveRow(row);
}

/**
 * List session archives with optional filters and pagination.
 */
export function listSessionArchives(
  projectId: string,
  filters?: SessionArchiveFilters,
  dbOverride?: DatabaseSync,
): SessionArchive[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions = ["project_id = ?"];
  const params: (string | number | null)[] = [projectId];

  if (filters?.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters?.since) {
    conditions.push("started_at >= ?");
    params.push(filters.since);
  }
  if (filters?.until) {
    conditions.push("started_at <= ?");
    params.push(filters.until);
  }
  if (filters?.outcome) {
    conditions.push("outcome = ?");
    params.push(filters.outcome);
  }

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const sql = `
    SELECT * FROM session_archives
    WHERE ${conditions.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapArchiveRow);
}

// --- Helpers ---

function mapArchiveRow(row: Record<string, unknown>): SessionArchive {
  return {
    id: row.id as string,
    sessionKey: row.session_key as string,
    agentId: row.agent_id as string,
    projectId: row.project_id as string,
    contextHash: (row.context_hash as string) ?? undefined,
    contextContent: row.context_content
      ? decompress(row.context_content as string)
      : undefined,
    transcript: row.transcript
      ? decompress(row.transcript as string)
      : undefined,
    agentConfigSnapshot: row.agent_config_snapshot
      ? decompress(row.agent_config_snapshot as string)
      : undefined,
    taskId: (row.task_id as string) ?? undefined,
    queueItemId: (row.queue_item_id as string) ?? undefined,
    jobName: (row.job_name as string) ?? undefined,
    outcome: row.outcome as string,
    exitSignal: (row.exit_signal as string) ?? undefined,
    complianceDetail: (row.compliance_detail as string) ?? undefined,
    totalCostCents: (row.total_cost_cents as number) ?? 0,
    totalInputTokens: (row.total_input_tokens as number) ?? 0,
    totalOutputTokens: (row.total_output_tokens as number) ?? 0,
    model: (row.model as string) ?? undefined,
    provider: (row.provider as string) ?? undefined,
    configVersionId: (row.config_version_id as string) ?? undefined,
    experimentVariantId: (row.experiment_variant_id as string) ?? undefined,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    toolCallCount: (row.tool_call_count as number) ?? 0,
    errorCount: (row.error_count as number) ?? 0,
    createdAt: row.created_at as number,
  };
}
