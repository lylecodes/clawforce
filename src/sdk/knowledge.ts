/**
 * Clawforce SDK — Knowledge Namespace
 *
 * Provides shared memory for agents: store facts, search them, retrieve them.
 * Backed by the `knowledge` table (created in migration V1).
 *
 * Vocabulary mapping (internal → SDK):
 *   category      → type
 *   source_agent  → agentId
 *   source_task   → taskId
 *
 * All operations are scoped to the domain (projectId).
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

type KnowledgeRow = {
  id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  tags: string | null;
  source_agent: string | null;
  source_session: string | null;
  source_task: string | null;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Public entry type
// ---------------------------------------------------------------------------

export interface KnowledgeEntry {
  id: string;
  /** Maps to the internal `category` column. */
  type: string;
  title: string;
  content: string;
  tags: string[];
  /** Maps to `source_agent`. */
  agentId?: string;
  /** Maps to `source_task`. */
  taskId?: string;
  /** Unix timestamp (ms). */
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEntry(row: KnowledgeRow): KnowledgeEntry {
  let metadata: Record<string, unknown> | undefined;
  // metadata is not a dedicated column — keep it undefined
  // (the row shape from V1 has no metadata column)
  void metadata;

  return {
    id: row.id,
    type: row.category,
    title: row.title,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    agentId: row.source_agent ?? undefined,
    taskId: row.source_task ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// KnowledgeNamespace
// ---------------------------------------------------------------------------

export class KnowledgeNamespace {
  constructor(readonly domain: string) {}

  /**
   * Store a knowledge entry.
   *
   * @param params.type     Category (e.g. "decision", "pattern", "context").
   * @param params.content  Full text content.
   * @param params.agentId  Source agent that created the entry.
   * @param params.taskId   Related task ID.
   * @param params.tags     Tag list for filtering.
   * @param params.metadata Additional structured data (stored as JSON in
   *                        content — the knowledge table has no dedicated
   *                        metadata column).
   */
  store(params: {
    type: string;
    content: string;
    title?: string;
    agentId?: string;
    taskId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): KnowledgeEntry {
    const db = getDb(this.domain);
    const id = randomUUID();
    const now = Date.now();
    const title = params.title ?? params.type;
    const tagsJson = params.tags?.length ? JSON.stringify(params.tags) : null;

    // If metadata is provided, append it as a JSON block to content so it is
    // searchable and retrievable without a dedicated column.
    let content = params.content;
    if (params.metadata && Object.keys(params.metadata).length > 0) {
      content += "\n\n<!-- metadata:" + JSON.stringify(params.metadata) + " -->";
    }

    db.prepare(`
      INSERT INTO knowledge (id, project_id, category, title, content, tags, source_agent, source_task, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, this.domain, params.type, title, content, tagsJson, params.agentId ?? null, params.taskId ?? null, now);

    return {
      id,
      type: params.type,
      title,
      content,
      tags: params.tags ?? [],
      agentId: params.agentId,
      taskId: params.taskId,
      createdAt: now,
      metadata: params.metadata,
    };
  }

  /**
   * Search knowledge entries by content or title (substring / LIKE match).
   * Optionally filter by type and/or agentId.
   */
  search(
    query: string,
    opts?: { type?: string; agentId?: string; limit?: number },
  ): KnowledgeEntry[] {
    const db = getDb(this.domain);
    const limit = opts?.limit ?? 20;

    let sql =
      "SELECT id, project_id, category, title, content, tags, source_agent, source_session, source_task, created_at " +
      "FROM knowledge WHERE project_id = ?";
    const sqlParams: (string | number | null)[] = [this.domain];

    if (opts?.type) {
      sql += " AND category = ?";
      sqlParams.push(opts.type);
    }

    if (opts?.agentId) {
      sql += " AND source_agent = ?";
      sqlParams.push(opts.agentId);
    }

    sql += " AND (title LIKE ? OR content LIKE ?)";
    sqlParams.push(`%${query}%`, `%${query}%`);

    sql += " ORDER BY created_at DESC LIMIT ?";
    sqlParams.push(limit);

    const rows = db.prepare(sql).all(...sqlParams) as KnowledgeRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Get a specific entry by ID. Returns undefined if not found.
   */
  get(id: string): KnowledgeEntry | undefined {
    const db = getDb(this.domain);
    const row = db
      .prepare(
        "SELECT id, project_id, category, title, content, tags, source_agent, source_session, source_task, created_at " +
        "FROM knowledge WHERE project_id = ? AND id = ?",
      )
      .get(this.domain, id) as KnowledgeRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /**
   * List knowledge entries with optional filters.
   */
  list(filters?: {
    type?: string;
    agentId?: string;
    tags?: string[];
    limit?: number;
  }): KnowledgeEntry[] {
    const db = getDb(this.domain);
    const limit = filters?.limit ?? 20;

    let sql =
      "SELECT id, project_id, category, title, content, tags, source_agent, source_session, source_task, created_at " +
      "FROM knowledge WHERE project_id = ?";
    const sqlParams: (string | number | null)[] = [this.domain];

    if (filters?.type) {
      sql += " AND category = ?";
      sqlParams.push(filters.type);
    }

    if (filters?.agentId) {
      sql += " AND source_agent = ?";
      sqlParams.push(filters.agentId);
    }

    if (filters?.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map(
        () => "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)",
      );
      sql += ` AND (${tagConditions.join(" OR ")})`;
      for (const tag of filters.tags) {
        sqlParams.push(tag);
      }
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    sqlParams.push(limit);

    const rows = db.prepare(sql).all(...sqlParams) as KnowledgeRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Remove a knowledge entry by ID.
   * No-op if the entry does not exist in this domain.
   */
  remove(id: string): void {
    const db = getDb(this.domain);
    db.prepare("DELETE FROM knowledge WHERE project_id = ? AND id = ?").run(
      this.domain,
      id,
    );
  }
}
