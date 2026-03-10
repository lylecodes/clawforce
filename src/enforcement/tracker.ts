/**
 * Clawforce — Compliance tracker
 *
 * Tracks per-session compliance state and metrics.
 * Updated via after_tool_call hook, checked at agent_end.
 */

import type { AgentConfig, Expectation, PerformancePolicy } from "../types.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

/** Record of a single tool call for metrics. */
export type ToolCallRecord = {
  toolName: string;
  action: string | null;
  timestamp: number;
  durationMs: number;
  success: boolean;
};

/** Full session metrics snapshot. */
export type SessionMetrics = {
  startedAt: number;
  toolCalls: ToolCallRecord[];
  firstToolCallAt: number | null;
  lastToolCallAt: number | null;
  requiredCallTimings: number[];
  errorCount: number;
};

/** Per-session compliance state. */
export type SessionCompliance = {
  sessionKey: string;
  agentId: string;
  projectId: string;
  requirements: Expectation[];
  /** requirement key → call count */
  satisfied: Map<string, number>;
  metrics: SessionMetrics;
  /** Effective performance policy for this session (may differ from base if job-scoped). */
  performancePolicy?: PerformancePolicy;
  /** Job name if this session is running a scoped job. */
  jobName?: string;
  /** Dispatch context if this session was spawned via the dispatch queue. */
  dispatchContext?: { queueItemId: string; taskId: string };
};

/** Persist session state every N tool calls (when compliance state hasn't changed). */
const PERSIST_EVERY_N_CALLS = 5;

/** In-memory store of active sessions. */
const sessions = new Map<string, SessionCompliance>();

/**
 * Start tracking a session.
 * Called when an agent with enforcement config starts.
 */
export function startTracking(
  sessionKey: string,
  agentId: string,
  projectId: string,
  config: AgentConfig,
  jobName?: string,
): void {
  const compliance: SessionCompliance = {
    sessionKey,
    agentId,
    projectId,
    requirements: config.expectations,
    performancePolicy: config.performance_policy,
    jobName,
    satisfied: new Map(),
    metrics: {
      startedAt: Date.now(),
      toolCalls: [],
      firstToolCallAt: null,
      lastToolCallAt: null,
      requiredCallTimings: [],
      errorCount: 0,
    },
  };

  // Initialize satisfied counts
  for (const req of config.expectations) {
    compliance.satisfied.set(requirementKey(req), 0);
  }

  sessions.set(sessionKey, compliance);
  persistSession(sessionKey);
}

/**
 * Record a tool call.
 * Called from after_tool_call hook.
 */
export function recordToolCall(
  sessionKey: string,
  toolName: string,
  action: string | null,
  durationMs: number,
  success: boolean,
): void {
  const session = sessions.get(sessionKey);
  if (!session) return;

  const now = Date.now();
  const record: ToolCallRecord = {
    toolName,
    action,
    timestamp: now,
    durationMs,
    success,
  };

  session.metrics.toolCalls.push(record);
  session.metrics.lastToolCallAt = now;
  if (!session.metrics.firstToolCallAt) {
    session.metrics.firstToolCallAt = now;
  }
  if (!success) {
    session.metrics.errorCount++;
  }

  // Check if this satisfies any requirement (only successful calls count)
  let satisfiedChanged = false;
  if (success) {
    for (const req of session.requirements) {
      if (matchesRequirement(req, toolName, action)) {
        const key = requirementKey(req);
        const current = session.satisfied.get(key) ?? 0;
        session.satisfied.set(key, current + 1);
        session.metrics.requiredCallTimings.push(now);
        satisfiedChanged = true;
      }
    }
  }

  // Persist when compliance state changes OR every Nth call
  if (satisfiedChanged || session.metrics.toolCalls.length % PERSIST_EVERY_N_CALLS === 0) {
    persistSession(sessionKey);
  }
}

/**
 * Get compliance state for a session.
 */
export function getSession(sessionKey: string): SessionCompliance | null {
  return sessions.get(sessionKey) ?? null;
}

/**
 * Set dispatch context on an active session.
 * Called from before_prompt_build when a dispatch tag is detected.
 */
export function setDispatchContext(sessionKey: string, context: { queueItemId: string; taskId: string }): void {
  const session = sessions.get(sessionKey);
  if (!session) return;
  session.dispatchContext = context;
  persistSession(sessionKey);
}

/**
 * Remove session tracking (after enforcement check).
 */
export function endSession(sessionKey: string): SessionCompliance | null {
  const session = sessions.get(sessionKey);
  if (session) {
    sessions.delete(sessionKey);
    unpersistSession(sessionKey, session.projectId);
  }
  return session ?? null;
}

/**
 * Get all active sessions (for sweep).
 */
export function getActiveSessions(): SessionCompliance[] {
  return [...sessions.values()];
}

/**
 * Clear all sessions (for testing).
 */
export function resetTrackerForTest(): void {
  sessions.clear();
}

// --- Session persistence (crash recovery) ---

/**
 * Persist session state to SQLite for crash recovery.
 */
export function persistSession(sessionKey: string): void {
  const session = sessions.get(sessionKey);
  if (!session) return;

  try {
    const db = getDb(session.projectId);
    db.prepare(`
      INSERT OR REPLACE INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionKey,
      session.agentId,
      session.projectId,
      session.metrics.startedAt,
      JSON.stringify(session.requirements),
      JSON.stringify(Object.fromEntries(session.satisfied)),
      session.metrics.toolCalls.length,
      Date.now(),
      session.dispatchContext ? JSON.stringify(session.dispatchContext) : null,
    );
  } catch (err) {
    safeLog("tracker.persist", err);
  }
}

/**
 * Remove persisted session (called when session ends normally).
 */
export function unpersistSession(sessionKey: string, projectId: string): void {
  try {
    const db = getDb(projectId);
    db.prepare("DELETE FROM tracked_sessions WHERE session_key = ?").run(sessionKey);
  } catch (err) {
    safeLog("tracker.unpersist", err);
  }
}

export type OrphanedSession = {
  sessionKey: string;
  agentId: string;
  projectId: string;
  startedAt: number;
  toolCallCount: number;
  dispatchContext?: { queueItemId: string; taskId: string };
};

/**
 * Find and clean up sessions from crashed processes.
 * Returns orphaned session info for diagnostic logging.
 */
export function recoverOrphanedSessions(projectId: string): OrphanedSession[] {
  try {
    const db = getDb(projectId);
    const rows = db.prepare(
      "SELECT session_key, agent_id, project_id, started_at, tool_call_count, dispatch_context FROM tracked_sessions WHERE project_id = ?"
    ).all(projectId) as Record<string, unknown>[];

    if (rows.length === 0) return [];

    const orphans: OrphanedSession[] = rows.map(row => {
      let dispatchContext: { queueItemId: string; taskId: string } | undefined;
      if (row.dispatch_context) {
        try { dispatchContext = JSON.parse(row.dispatch_context as string); } catch { /* ignore */ }
      }
      return {
        sessionKey: row.session_key as string,
        agentId: row.agent_id as string,
        projectId: row.project_id as string,
        startedAt: row.started_at as number,
        toolCallCount: row.tool_call_count as number,
        dispatchContext,
      };
    });

    // Clean up orphaned rows
    db.prepare("DELETE FROM tracked_sessions WHERE project_id = ?").run(projectId);

    return orphans;
  } catch (err) {
    safeLog("tracker.recoverOrphans", err);
    return [];
  }
}

// --- Helpers ---

/**
 * Generate a stable key for a requirement.
 */
function requirementKey(req: Expectation): string {
  const actions = Array.isArray(req.action) ? req.action.sort().join("|") : req.action;
  return `${req.tool}:${actions}`;
}

/**
 * Check if a tool call matches a requirement.
 */
function matchesRequirement(req: Expectation, toolName: string, action: string | null): boolean {
  if (req.tool !== toolName) return false;
  // If the requirement specifies an action, the tool call must also have a matching action
  if (Array.isArray(req.action)) {
    return action !== null && req.action.includes(action);
  }
  if (req.action) {
    return action === req.action;
  }
  // Requirement has no action constraint — tool name match is sufficient
  return true;
}
