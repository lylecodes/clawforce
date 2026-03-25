/**
 * Clawforce — Log tool
 *
 * Universal "write what happened" tool. Every agent is forced to call this.
 * Actions: write (knowledge entry), outcome (session result), search, list.
 *
 * Design principle: tools return context alongside results.
 * - write → returns recent related entries (avoid duplicates)
 * - search → returns matching entries with full context
 * - list → returns recent entries
 * - outcome → stores in audit_runs table
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { verifyAuditChain, writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam, resolveProjectId, safeExecute } from "./common.js";

const LOG_ACTIONS = ["write", "outcome", "search", "list", "verify_audit", "record_decision"] as const;

const CATEGORIES = ["decision", "pattern", "issue", "outcome", "context", "finding", "suggestion"] as const;

const OUTCOME_STATUSES = ["success", "failure", "partial"] as const;

const ClawforceLogSchema = Type.Object({
  action: stringEnum(LOG_ACTIONS, { description: "Action to perform." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  // write params
  category: Type.Optional(Type.String({ description: "Entry category: decision, pattern, issue, outcome, context (default: context)." })),
  title: Type.Optional(Type.String({ description: "Entry title (for write)." })),
  content: Type.Optional(Type.String({ description: "Entry content (for write/outcome)." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for filtering." })),
  task_id: Type.Optional(Type.String({ description: "Related task ID." })),
  // outcome params
  status: Type.Optional(Type.String({ description: "Outcome status: success, failure, partial." })),
  summary: Type.Optional(Type.String({ description: "Outcome summary (for outcome)." })),
  details: Type.Optional(Type.String({ description: "Outcome details (for outcome)." })),
  artifacts: Type.Optional(Type.Array(Type.String(), { description: "Artifact references (for outcome)." })),
  // record_decision params (OODA)
  observation: Type.Optional(Type.String({ description: "What was observed (OODA Observe phase)." })),
  orientation: Type.Optional(Type.String({ description: "How the situation was interpreted (OODA Orient phase)." })),
  decision: Type.Optional(Type.String({ description: "What was decided (OODA Decide phase)." })),
  rationale: Type.Optional(Type.String({ description: "Why this decision was made." })),
  // search/list params
  query: Type.Optional(Type.String({ description: "Search query text. Uses substring matching, not semantic search. Use specific terms for best results." })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20)." })),
});

export function createClawforceLogTool(options?: {
  agentSessionKey?: string;
  agentId?: string;
  projectId?: string;
}) {
  return {
    label: "Work Journal",
    name: "clawforce_log",
    description:
      "Record work journal entries and query past records. " +
      "Write: write — Record decisions, patterns, and issues. " +
      "Planning: record_decision — Record structured OODA planning decisions (observation, orientation, decision, rationale). " +
      "Report: outcome — Log session results. " +
      "Query: search, list — Find past entries (keyword-based substring matching). " +
      "Audit: verify_audit — Check chain integrity.",
    parameters: ClawforceLogSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const actor = options?.agentId ?? options?.agentSessionKey ?? "unknown";
        const sessionKey = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "write":
            return handleWrite(projectId, actor, sessionKey, params);

          case "outcome":
            return handleOutcome(projectId, actor, sessionKey, params);

          case "search":
            return handleSearch(projectId, params);

          case "list":
            return handleList(projectId, params);

          case "verify_audit":
            return handleVerifyAudit(projectId);

          case "record_decision":
            return handleRecordDecision(projectId, actor, sessionKey, params);

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

function handleWrite(
  projectId: string,
  actor: string,
  sessionKey: string,
  params: Record<string, unknown>,
): ToolResult {
  const categoryRaw = readStringParam(params, "category") ?? "context";
  if (!CATEGORIES.includes(categoryRaw as typeof CATEGORIES[number])) {
    return jsonResult({ ok: false, reason: `Invalid category: ${categoryRaw}. Must be one of: ${CATEGORIES.join(", ")}` });
  }
  const category = categoryRaw;
  const title = readStringParam(params, "title", { required: true })!;
  const content = readStringParam(params, "content", { required: true })!;
  const tags = readStringArrayParam(params, "tags");
  const taskId = readStringParam(params, "task_id");

  const db = getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO knowledge (id, project_id, category, title, content, tags, source_agent, source_session, source_task, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, category, title, content, tags ? JSON.stringify(tags) : null, actor, sessionKey, taskId, now);

  // Context at point of decision: return recent related entry titles (compact by default)
  const detail = readStringParam(params, "detail") ?? "compact";
  const related = db.prepare(`
    SELECT id, category, title${detail === "full" ? ", content" : ""}, tags, created_at
    FROM knowledge
    WHERE project_id = ? AND category = ? AND id != ?
    ORDER BY created_at DESC
    LIMIT 5
  `).all(projectId, category, id) as KnowledgeRow[];

  return jsonResult({
    ok: true,
    entry: { id, category, title, tags, created_at: now },
    related_entries: detail === "full"
      ? related.map(formatKnowledgeRow)
      : related.map(r => ({ id: r.id, title: r.title, category: r.category })),
  });
}

function handleOutcome(
  projectId: string,
  actor: string,
  sessionKey: string,
  params: Record<string, unknown>,
): ToolResult {
  const statusRaw = readStringParam(params, "status") ?? "success";
  if (!OUTCOME_STATUSES.includes(statusRaw as typeof OUTCOME_STATUSES[number])) {
    return jsonResult({ ok: false, reason: `Invalid status: ${statusRaw}. Must be one of: ${OUTCOME_STATUSES.join(", ")}` });
  }
  const status = statusRaw;
  const summary = readStringParam(params, "summary") ?? "";
  const details = readStringParam(params, "details");
  const artifacts = readStringArrayParam(params, "artifacts");

  const db = getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, details, artifacts, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, projectId, actor, sessionKey, status, summary,
    details, artifacts ? JSON.stringify(artifacts) : null,
    now, now,
  );

  return jsonResult({
    ok: true,
    audit_run: { id, status, summary, created_at: now },
  });
}

function handleSearch(projectId: string, params: Record<string, unknown>): ToolResult {
  const query = readStringParam(params, "query");
  const category = readStringParam(params, "category");
  const tags = readStringArrayParam(params, "tags");
  const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;

  const db = getDb(projectId);

  let sql = "SELECT id, category, title, content, tags, source_agent, created_at FROM knowledge WHERE project_id = ?";
  const sqlParams: (string | number | null)[] = [projectId];

  if (category) {
    sql += " AND category = ?";
    sqlParams.push(category);
  }

  if (query) {
    sql += " AND (title LIKE ? OR content LIKE ?)";
    sqlParams.push(`%${query}%`, `%${query}%`);
  }

  if (tags && tags.length > 0) {
    // Match any of the provided tags in the JSON array (exact match via json_each)
    const tagConditions = tags.map(() => "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
    sql += ` AND (${tagConditions.join(" OR ")})`;
    for (const tag of tags) {
      sqlParams.push(tag);
    }
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  sqlParams.push(limit);

  const rows = db.prepare(sql).all(...sqlParams) as KnowledgeRow[];

  return jsonResult({
    ok: true,
    entries: rows.map(formatKnowledgeRow),
    count: rows.length,
  });
}

function handleList(projectId: string, params: Record<string, unknown>): ToolResult {
  const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
  const category = readStringParam(params, "category");

  const db = getDb(projectId);

  let sql = "SELECT id, category, title, content, tags, source_agent, created_at FROM knowledge WHERE project_id = ?";
  const sqlParams: (string | number | null)[] = [projectId];

  if (category) {
    sql += " AND category = ?";
    sqlParams.push(category);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  sqlParams.push(limit);

  const rows = db.prepare(sql).all(...sqlParams) as KnowledgeRow[];

  return jsonResult({
    ok: true,
    entries: rows.map(formatKnowledgeRow),
    count: rows.length,
  });
}

function handleVerifyAudit(projectId: string): ToolResult {
  const result = verifyAuditChain(projectId);
  return jsonResult({ ok: true, ...result });
}

function handleRecordDecision(
  projectId: string,
  actor: string,
  sessionKey: string,
  params: Record<string, unknown>,
): ToolResult {
  const title = readStringParam(params, "title", { required: true })!;
  const observation = readStringParam(params, "observation") ?? "";
  const orientation = readStringParam(params, "orientation") ?? "";
  const decision = readStringParam(params, "decision") ?? "";
  const rationale = readStringParam(params, "rationale") ?? "";
  const tags = readStringArrayParam(params, "tags");

  const db = getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  // Build structured content
  const contentParts: string[] = [];
  if (observation) contentParts.push(`**Observe:** ${observation}`);
  if (orientation) contentParts.push(`**Orient:** ${orientation}`);
  if (decision) contentParts.push(`**Decide:** ${decision}`);
  if (rationale) contentParts.push(`**Rationale:** ${rationale}`);
  const content = contentParts.join("\n\n");

  // Store as knowledge entry (category: decision) for cross-session retrieval
  db.prepare(`
    INSERT INTO knowledge (id, project_id, category, title, content, tags, source_agent, source_session, created_at)
    VALUES (?, ?, 'decision', ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, title, content, tags ? JSON.stringify(tags) : null, actor, sessionKey, now);

  // Also record as audit entry for accountability
  writeAuditEntry({
    projectId,
    actor,
    action: "planning_decision",
    targetType: "planning",
    targetId: id,
    detail: JSON.stringify({ title, observation, orientation, decision, rationale }),
  }, db);

  return jsonResult({
    ok: true,
    entry: { id, category: "decision", title, tags, created_at: now },
    message: "Planning decision recorded to knowledge base and audit trail.",
  });
}

// --- Helpers ---

type KnowledgeRow = {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string | null;
  source_agent?: string;
  created_at: number;
};

function formatKnowledgeRow(row: KnowledgeRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: row.tags ? JSON.parse(row.tags) : [],
    source_agent: row.source_agent,
    created_at: row.created_at,
  };
}
