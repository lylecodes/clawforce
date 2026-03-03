/**
 * Clawforce — Memory tool
 *
 * Shared memory feedback layer for autonomous agents.
 * Agents save learnings scoped by identity (agent, team, department, role).
 * Same-type agents share memories, creating a feedback loop across sessions.
 *
 * Actions: save, recall, validate, deprecate, list.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { getDb } from "../db.js";
import { stringEnum } from "../schema-helpers.js";
import type { AgentConfig } from "../types.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, safeExecute } from "./common.js";

export const MEMORY_ACTIONS = ["save", "recall", "validate", "deprecate", "list"] as const;

export const MEMORY_CATEGORIES = ["learning", "pattern", "rule", "warning", "insight"] as const;

const ClawforceMemorySchema = Type.Object({
  action: stringEnum(MEMORY_ACTIONS, { description: "Action to perform." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  // save params
  scope: Type.Optional(Type.String({ description: "Memory scope: agent:<id>, team:<name>, dept:<name>, role:<role>. Defaults to agent:<your-id>." })),
  category: Type.Optional(Type.String({ description: "Category: learning, pattern, rule, warning, insight (default: learning)." })),
  title: Type.Optional(Type.String({ description: "Memory title (for save)." })),
  content: Type.Optional(Type.String({ description: "Memory content (for save)." })),
  confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0 (default 0.7)." })),
  task_id: Type.Optional(Type.String({ description: "Related task ID." })),
  supersedes: Type.Optional(Type.String({ description: "ID of memory this replaces (will be deprecated)." })),
  // recall/search params
  query: Type.Optional(Type.String({ description: "Search query text (substring matching)." })),
  // validate/deprecate params
  memory_id: Type.Optional(Type.String({ description: "Memory entry ID (for validate/deprecate)." })),
  // list/recall filters
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
});

export function createClawforceMemoryTool(options?: {
  agentSessionKey?: string;
  agentId?: string;
  agentConfig?: AgentConfig;
}) {
  return {
    label: "Shared Memory",
    name: "clawforce_memory",
    description:
      "Save and recall shared learnings across sessions. " +
      "Memories are scoped by agent identity — same-team/department/role agents share memories. " +
      "save: Record a learning with scope and confidence. " +
      "recall: Query scoped memories (auto-filtered to your scopes). " +
      "validate: Confirm a memory is still accurate (boosts its ranking). " +
      "deprecate: Mark a memory as outdated. " +
      "list: Browse memories by scope.",
    parameters: ClawforceMemorySchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const projectId = readStringParam(params, "project_id") ?? "default";
        const actor = options?.agentId ?? options?.agentSessionKey ?? "unknown";
        const sessionKey = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "save":
            return handleSave(projectId, actor, sessionKey, options?.agentConfig, params);

          case "recall":
            return handleRecall(projectId, actor, options?.agentConfig, params);

          case "validate":
            return handleValidate(projectId, params);

          case "deprecate":
            return handleDeprecate(projectId, params);

          case "list":
            return handleList(projectId, params);

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

/**
 * Derive the scopes an agent can read from, based on their config.
 */
export function deriveAgentScopes(agentId: string, config?: AgentConfig): string[] {
  const scopes = [`agent:${agentId}`];
  if (config?.role) scopes.push(`role:${config.role}`);
  if (config?.team) scopes.push(`team:${config.team}`);
  if (config?.department) scopes.push(`dept:${config.department}`);
  return scopes;
}

function handleSave(
  projectId: string,
  actor: string,
  sessionKey: string,
  agentConfig: AgentConfig | undefined,
  params: Record<string, unknown>,
): ToolResult {
  const categoryRaw = readStringParam(params, "category") ?? "learning";
  if (!MEMORY_CATEGORIES.includes(categoryRaw as typeof MEMORY_CATEGORIES[number])) {
    return jsonResult({ ok: false, reason: `Invalid category: ${categoryRaw}. Must be one of: ${MEMORY_CATEGORIES.join(", ")}` });
  }
  const category = categoryRaw;
  const title = readStringParam(params, "title", { required: true })!;
  const content = readStringParam(params, "content", { required: true })!;
  const scope = readStringParam(params, "scope") ?? `agent:${actor}`;
  const confidenceRaw = readNumberParam(params, "confidence") ?? 0.7;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const taskId = readStringParam(params, "task_id");
  const supersedes = readStringParam(params, "supersedes");

  const db = getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  // If superseding, mark the old entry as deprecated
  if (supersedes) {
    db.prepare(`
      UPDATE memory SET deprecated = 1 WHERE id = ? AND project_id = ?
    `).run(supersedes, projectId);
  }

  db.prepare(`
    INSERT INTO memory (id, project_id, scope, category, title, content, confidence, source_agent, source_session, source_task, supersedes, deprecated, validation_count, created_at, last_validated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, projectId, scope, category, title, content, confidence, actor, sessionKey, taskId, supersedes, now, now);

  // Return related memories for context
  const related = db.prepare(`
    SELECT id, scope, category, title, content, confidence, validation_count, created_at
    FROM memory
    WHERE project_id = ? AND scope = ? AND deprecated = 0 AND id != ?
    ORDER BY (confidence * validation_count) DESC, last_validated_at DESC
    LIMIT 5
  `).all(projectId, scope, id) as MemoryRow[];

  return jsonResult({
    ok: true,
    entry: { id, scope, category, title, confidence, created_at: now },
    related_memories: related.map(formatMemoryRow),
  });
}

function handleRecall(
  projectId: string,
  actor: string,
  agentConfig: AgentConfig | undefined,
  params: Record<string, unknown>,
): ToolResult {
  const query = readStringParam(params, "query");
  const category = readStringParam(params, "category");
  const scopeFilter = readStringParam(params, "scope");
  const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;

  const db = getDb(projectId);

  // Determine scopes to query
  let scopes: string[];
  if (scopeFilter) {
    scopes = [scopeFilter];
  } else {
    scopes = deriveAgentScopes(actor, agentConfig);
  }

  const placeholders = scopes.map(() => "?").join(", ");
  let sql = `SELECT id, scope, category, title, content, confidence, validation_count, source_agent, created_at, last_validated_at
    FROM memory
    WHERE project_id = ? AND scope IN (${placeholders}) AND deprecated = 0`;
  const sqlParams: (string | number | null)[] = [projectId, ...scopes];

  if (category) {
    sql += " AND category = ?";
    sqlParams.push(category);
  }

  if (query) {
    sql += " AND (title LIKE ? OR content LIKE ?)";
    sqlParams.push(`%${query}%`, `%${query}%`);
  }

  sql += " ORDER BY (confidence * validation_count) DESC, last_validated_at DESC LIMIT ?";
  sqlParams.push(limit);

  const rows = db.prepare(sql).all(...sqlParams) as MemoryRow[];

  return jsonResult({
    ok: true,
    memories: rows.map(formatMemoryRow),
    count: rows.length,
    scopes_queried: scopes,
  });
}

function handleValidate(projectId: string, params: Record<string, unknown>): ToolResult {
  const memoryId = readStringParam(params, "memory_id", { required: true })!;

  const db = getDb(projectId);
  const now = Date.now();

  const existing = db.prepare(
    "SELECT id, deprecated FROM memory WHERE id = ? AND project_id = ?",
  ).get(memoryId, projectId) as { id: string; deprecated: number } | undefined;

  if (!existing) {
    return jsonResult({ ok: false, reason: `Memory entry not found: ${memoryId}` });
  }

  if (existing.deprecated) {
    return jsonResult({ ok: false, reason: `Memory entry is deprecated: ${memoryId}` });
  }

  db.prepare(`
    UPDATE memory
    SET validation_count = validation_count + 1, last_validated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(now, memoryId, projectId);

  const updated = db.prepare(
    "SELECT id, scope, category, title, confidence, validation_count, last_validated_at FROM memory WHERE id = ?",
  ).get(memoryId) as MemoryRow;

  return jsonResult({
    ok: true,
    memory: formatMemoryRow(updated),
  });
}

function handleDeprecate(projectId: string, params: Record<string, unknown>): ToolResult {
  const memoryId = readStringParam(params, "memory_id", { required: true })!;

  const db = getDb(projectId);

  const existing = db.prepare(
    "SELECT id FROM memory WHERE id = ? AND project_id = ?",
  ).get(memoryId, projectId) as { id: string } | undefined;

  if (!existing) {
    return jsonResult({ ok: false, reason: `Memory entry not found: ${memoryId}` });
  }

  db.prepare(`
    UPDATE memory SET deprecated = 1 WHERE id = ? AND project_id = ?
  `).run(memoryId, projectId);

  return jsonResult({
    ok: true,
    deprecated: memoryId,
  });
}

function handleList(projectId: string, params: Record<string, unknown>): ToolResult {
  const scope = readStringParam(params, "scope");
  const category = readStringParam(params, "category");
  const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;

  const db = getDb(projectId);

  let sql = "SELECT id, scope, category, title, content, confidence, validation_count, source_agent, created_at, last_validated_at FROM memory WHERE project_id = ? AND deprecated = 0";
  const sqlParams: (string | number | null)[] = [projectId];

  if (scope) {
    sql += " AND scope = ?";
    sqlParams.push(scope);
  }

  if (category) {
    sql += " AND category = ?";
    sqlParams.push(category);
  }

  sql += " ORDER BY (confidence * validation_count) DESC, last_validated_at DESC LIMIT ?";
  sqlParams.push(limit);

  const rows = db.prepare(sql).all(...sqlParams) as MemoryRow[];

  return jsonResult({
    ok: true,
    memories: rows.map(formatMemoryRow),
    count: rows.length,
  });
}

// --- Helpers ---

type MemoryRow = {
  id: string;
  scope: string;
  category: string;
  title: string;
  content?: string;
  confidence: number;
  validation_count: number;
  source_agent?: string;
  created_at: number;
  last_validated_at?: number;
};

function formatMemoryRow(row: MemoryRow) {
  return {
    id: row.id,
    scope: row.scope,
    category: row.category,
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    validation_count: row.validation_count,
    source_agent: row.source_agent,
    created_at: row.created_at,
    last_validated_at: row.last_validated_at,
  };
}
