/**
 * Clawforce — Session archive telemetry
 *
 * Archives completed sessions with compressed transcripts and context.
 * Provides retrieval with transparent decompression.
 */

import crypto from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { getCostSummary } from "../cost.js";
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

export type SessionArchiveDiagnostics = {
  complianceObserved?: boolean;
  compliant?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  terminatedReason?: string;
  timeoutMs?: number;
  logicalCompletion?: boolean;
  summarySynthetic?: boolean;
  observedWork?: boolean;
  resultSource?: string;
  outputFilePresent?: boolean;
  outputChars?: number;
  outputLooksLikeLaunchTranscript?: boolean;
  stdoutChars?: number;
  stdoutLooksLikeLaunchTranscript?: boolean;
  stderrChars?: number;
  stderrLooksLikeLaunchTranscript?: boolean;
  promptChars?: number;
  systemContextChars?: number;
  finalPromptChars?: number;
  mcpBridgeDisabled?: boolean;
  configOverrideCount?: number;
  binary?: string;
  cwd?: string | null;
  stdoutPreview?: string;
  stderrPreview?: string;
};

export type SessionArchiveFilters = {
  agentId?: string;
  taskId?: string;
  since?: number;
  until?: number;
  outcome?: string;
  limit?: number;
  offset?: number;
};

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function buildPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}

export function extractSessionArchiveDiagnostics(archive: Pick<SessionArchive, "complianceDetail">): SessionArchiveDiagnostics | null {
  if (!archive.complianceDetail) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(archive.complianceDetail);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const detail = parsed as Record<string, unknown>;
  const stdout = asOptionalString(detail.stdout);
  const stderr = asOptionalString(detail.stderr);
  const stdoutPreview = buildPreview(stdout);
  const stderrPreview = buildPreview(stderr);

  const diagnostics: SessionArchiveDiagnostics = {
    complianceObserved: asOptionalBoolean(detail.complianceObserved),
    compliant: asOptionalBoolean(detail.compliant),
    exitCode: detail.exitCode === null
      ? null
      : asOptionalNumber(detail.exitCode),
    signal: detail.signal === null
      ? null
      : asOptionalString(detail.signal),
    terminatedReason: asOptionalString(detail.terminatedReason),
    timeoutMs: asOptionalNumber(detail.timeoutMs),
    logicalCompletion: asOptionalBoolean(detail.logicalCompletion),
    summarySynthetic: asOptionalBoolean(detail.summarySynthetic),
    observedWork: asOptionalBoolean(detail.observedWork),
    resultSource: asOptionalString(detail.resultSource),
    outputFilePresent: asOptionalBoolean(detail.outputFilePresent),
    outputChars: asOptionalNumber(detail.outputChars),
    outputLooksLikeLaunchTranscript: asOptionalBoolean(detail.outputLooksLikeLaunchTranscript),
    stdoutChars: asOptionalNumber(detail.stdoutChars) ?? stdout?.length,
    stdoutLooksLikeLaunchTranscript: asOptionalBoolean(detail.stdoutLooksLikeLaunchTranscript),
    stderrChars: asOptionalNumber(detail.stderrChars) ?? stderr?.length,
    stderrLooksLikeLaunchTranscript: asOptionalBoolean(detail.stderrLooksLikeLaunchTranscript),
    promptChars: asOptionalNumber(detail.promptChars),
    systemContextChars: asOptionalNumber(detail.systemContextChars),
    finalPromptChars: asOptionalNumber(detail.finalPromptChars),
    mcpBridgeDisabled: asOptionalBoolean(detail.mcpBridgeDisabled),
    configOverrideCount: asOptionalNumber(detail.configOverrideCount),
    binary: asOptionalString(detail.binary),
    cwd: detail.cwd === null
      ? null
      : asOptionalString(detail.cwd),
    stdoutPreview,
    stderrPreview,
  };

  return Object.values(diagnostics).some((value) => value !== undefined)
    ? diagnostics
    : null;
}

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

  // Aggregate cost from cost_records if not provided by the caller
  let totalCostCents = params.totalCostCents ?? 0;
  let totalInputTokens = params.totalInputTokens ?? 0;
  let totalOutputTokens = params.totalOutputTokens ?? 0;
  if (totalCostCents === 0) {
    try {
      const costSummary = getCostSummary({
        projectId: params.projectId,
        agentId: params.agentId,
        since: params.startedAt,
        until: params.endedAt ?? Date.now(),
      }, db);
      if (costSummary.totalCostCents > 0) {
        totalCostCents = costSummary.totalCostCents;
        if (totalInputTokens === 0) totalInputTokens = costSummary.totalInputTokens;
        if (totalOutputTokens === 0) totalOutputTokens = costSummary.totalOutputTokens;
      }
    } catch (err) {
      safeLog("telemetry.archive.costAggregation", err);
    }
  }

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
      totalCostCents, totalInputTokens, totalOutputTokens,
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
  if (filters?.taskId) {
    conditions.push("task_id = ?");
    params.push(filters.taskId);
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

  // Exclude heavy compressed columns (transcript, context_content, agent_config_snapshot)
  // from list queries to keep response size small. Full data is available via getSessionArchive().
  const sql = `
    SELECT id, session_key, agent_id, project_id, context_hash,
           task_id, queue_item_id, job_name, outcome, exit_signal, compliance_detail,
           total_cost_cents, total_input_tokens, total_output_tokens,
           model, provider, config_version_id, experiment_variant_id,
           started_at, ended_at, duration_ms, tool_call_count, error_count, created_at
    FROM session_archives
    WHERE ${conditions.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapArchiveRow);
}

/**
 * Count total session archives matching the given filters (ignoring limit/offset).
 * Used for pagination metadata.
 */
export function countSessionArchives(
  projectId: string,
  filters?: Pick<SessionArchiveFilters, "agentId" | "taskId" | "since" | "until" | "outcome">,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const conditions = ["project_id = ?"];
  const params: (string | number | null)[] = [projectId];

  if (filters?.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters?.taskId) {
    conditions.push("task_id = ?");
    params.push(filters.taskId);
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

  const sql = `SELECT COUNT(*) as cnt FROM session_archives WHERE ${conditions.join(" AND ")}`;
  const row = db.prepare(sql).get(...params) as Record<string, number> | undefined;
  return row?.cnt ?? 0;
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
