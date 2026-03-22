/**
 * Clawforce — Tool call detail capture
 *
 * Captures full tool call I/O for telemetry.
 * Buffers in memory during a session, flushes to SQLite at session end.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type ToolCallDetail = {
  toolName: string;
  action: string | null;
  input: string;
  output: string;
  sequenceNumber: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  estimatedCostCents?: number;
  timestamp: number;
};

export type ToolCallDetailRow = ToolCallDetail & {
  id: string;
  sessionKey: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  createdAt: number;
};

// --- Truncation ---

const MAX_FIELD_SIZE = 10 * 1024; // 10KB

/**
 * Truncate a string to fit within the max field size.
 * Returns a JSON envelope with truncation metadata if truncated.
 */
export function truncateField(value: string): string {
  if (value.length <= MAX_FIELD_SIZE) return value;
  return JSON.stringify({
    truncated: true,
    originalSize: value.length,
    content: value.slice(0, MAX_FIELD_SIZE - 100), // leave room for envelope
  });
}

// --- Core functions ---

/**
 * Batch insert tool call details from the in-memory buffer.
 * Called at session end to persist all captured tool calls.
 */
export function flushToolCallDetails(
  sessionKey: string,
  projectId: string,
  agentId: string,
  toolCalls: ToolCallDetail[],
  taskId?: string,
  dbOverride?: DatabaseSync,
): number {
  if (toolCalls.length === 0) return 0;

  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      INSERT INTO tool_call_details (
        id, session_key, project_id, agent_id,
        tool_name, action, input, output,
        sequence_number, duration_ms, success, error_message,
        estimated_cost_cents, task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const call of toolCalls) {
      try {
        stmt.run(
          crypto.randomUUID(),
          sessionKey,
          projectId,
          agentId,
          call.toolName,
          call.action ?? null,
          truncateField(call.input),
          truncateField(call.output),
          call.sequenceNumber,
          call.durationMs,
          call.success ? 1 : 0,
          call.errorMessage ?? null,
          call.estimatedCostCents ?? null,
          taskId ?? null,
          now,
        );
        inserted++;
      } catch (err) {
        safeLog("telemetry.flush-tool-call", err);
      }
    }

    return inserted;
  } catch (err) {
    safeLog("telemetry.flush-tool-calls", err);
    return 0;
  }
}

/**
 * Retrieve all tool call details for a session, ordered by sequence.
 */
export function getToolCallDetails(
  projectId: string,
  sessionKey: string,
  dbOverride?: DatabaseSync,
): ToolCallDetailRow[] {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(`
    SELECT * FROM tool_call_details
    WHERE project_id = ? AND session_key = ?
    ORDER BY sequence_number ASC
  `).all(projectId, sessionKey) as Record<string, unknown>[];

  return rows.map(mapToolCallRow);
}

// --- Helpers ---

function mapToolCallRow(row: Record<string, unknown>): ToolCallDetailRow {
  return {
    id: row.id as string,
    sessionKey: row.session_key as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    toolName: row.tool_name as string,
    action: (row.action as string) ?? null,
    input: row.input as string,
    output: row.output as string,
    sequenceNumber: row.sequence_number as number,
    durationMs: row.duration_ms as number,
    success: (row.success as number) === 1,
    errorMessage: (row.error_message as string) ?? undefined,
    estimatedCostCents: (row.estimated_cost_cents as number) ?? undefined,
    taskId: (row.task_id as string) ?? undefined,
    timestamp: row.created_at as number,
    createdAt: row.created_at as number,
  };
}
