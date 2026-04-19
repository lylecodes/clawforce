/**
 * Clawforce — Compliance tracker
 *
 * Tracks per-session compliance state and metrics.
 * Updated via after_tool_call hook, checked at agent_end.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import type { AgentConfig, Expectation, PerformancePolicy } from "../types.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

/** Record of a single tool call for metrics. */
export type ToolCallRecord = {
  toolName: string;
  action: string | null;
  timestamp: number;
  durationMs: number;
  success: boolean;
};

/** Patterns that indicate exploratory file-not-found errors (not real failures). */
const EXPLORATORY_ERROR_PATTERNS = [
  /ENOENT/i,
  /no such file/i,
  /file not found/i,
  /does not exist/i,
  /couldn't read/i,
  /cannot find/i,
];

/** Full session metrics snapshot. */
export type SessionMetrics = {
  startedAt: number;
  toolCalls: ToolCallRecord[];
  firstToolCallAt: number | null;
  lastToolCallAt: number | null;
  firstProgressAt: number | null;
  lastProgressAt: number | null;
  progressSignalCount: number;
  requiredCallTimings: number[];
  errorCount: number;
  /** Errors excluded from errorCount (ENOENT, file-not-found, etc.) — exploratory, not real failures. */
  exploratoryErrorCount: number;
  significantResults: Array<{ toolName: string; action: string | null; resultPreview: string }>;
  toolCallBuffer: Array<{
    toolName: string;
    action: string | null;
    input: string;
    output: string;
    durationMs: number;
    success: boolean;
    errorMessage?: string;
    sequenceNumber: number;
    timestamp: number;
  }>;
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
  /** Child process id for direct executors, when available. */
  processId?: number | null;
  /** Whether this session is expected to surface tool telemetry into ClawForce. */
  expectsToolTelemetry?: boolean;
};

/** Persist session state every N tool calls (when compliance state hasn't changed). */
const PERSIST_EVERY_N_CALLS = 5;
export const SESSION_HEARTBEAT_INTERVAL_MS = 10_000;
export const SESSION_HEARTBEAT_LIVE_MS = 25_000;
export const SESSION_HEARTBEAT_STALE_MS = 60_000;

export type SessionHeartbeatState = "live" | "quiet" | "stale";
export type SessionHeartbeatStatus = {
  state: SessionHeartbeatState;
  ageMs: number | null;
};

type EnforcementTrackerRuntimeState = {
  sessions: Map<string, SessionCompliance>;
};

const runtime = getDefaultRuntimeState();

function getTrackedSessions(): EnforcementTrackerRuntimeState["sessions"] {
  return (runtime.enforcementTracker as EnforcementTrackerRuntimeState).sessions;
}

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
  options?: {
    expectsToolTelemetry?: boolean;
  },
): void {
  const compliance: SessionCompliance = {
    sessionKey,
    agentId,
    projectId,
    requirements: config.expectations,
    performancePolicy: config.performance_policy,
    jobName,
    expectsToolTelemetry: options?.expectsToolTelemetry ?? true,
    satisfied: new Map(),
    metrics: {
      startedAt: Date.now(),
      toolCalls: [],
      firstToolCallAt: null,
      lastToolCallAt: null,
      firstProgressAt: null,
      lastProgressAt: null,
      progressSignalCount: 0,
      requiredCallTimings: [],
      errorCount: 0,
      exploratoryErrorCount: 0,
      significantResults: [],
      toolCallBuffer: [],
    },
  };

  // Initialize satisfied counts
  for (const req of config.expectations) {
    compliance.satisfied.set(requirementKey(req), 0);
  }

  getTrackedSessions().set(sessionKey, compliance);
  persistSession(sessionKey);
}

/**
 * Check if an error message indicates an exploratory file-not-found error.
 * These are common during agent file exploration and should not count as real failures.
 */
function isExploratoryError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return EXPLORATORY_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
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
  errorMessage?: string,
): void {
  const session = getTrackedSessions().get(sessionKey);
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
    if (isExploratoryError(errorMessage)) {
      session.metrics.exploratoryErrorCount++;
    } else {
      session.metrics.errorCount++;
    }
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
 * Record a significant tool output for auto-lifecycle evidence.
 * Buffers up to MAX_RESULTS results, each truncated to the given limit (default 2000 chars).
 */
export function recordSignificantResult(
  sessionKey: string,
  toolName: string,
  action: string | null,
  result: string,
  truncationLimit?: number,
): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;
  const MAX_RESULTS = 5;
  const maxChars = truncationLimit ?? 2000;
  if (session.metrics.significantResults.length >= MAX_RESULTS) return;
  session.metrics.significantResults.push({
    toolName,
    action,
    resultPreview: result.length > maxChars ? result.slice(0, maxChars) + "..." : result,
  });
}

/**
 * Record a full tool call detail into the session buffer for telemetry flush.
 */
export function recordToolCallDetail(
  sessionKey: string,
  toolName: string,
  action: string | null,
  input: string,
  output: string,
  durationMs: number,
  success: boolean,
  errorMessage?: string,
): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;
  session.metrics.toolCallBuffer.push({
    toolName, action, input, output, durationMs, success, errorMessage,
    sequenceNumber: session.metrics.toolCallBuffer.length,
    timestamp: Date.now(),
  });
}

/**
 * Get compliance state for a session.
 */
export function getSession(sessionKey: string): SessionCompliance | null {
  return getTrackedSessions().get(sessionKey) ?? null;
}

/**
 * Set dispatch context on an active session.
 * Called from before_prompt_build when a dispatch tag is detected.
 */
export function setDispatchContext(sessionKey: string, context: { queueItemId: string; taskId: string }): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;
  session.dispatchContext = context;
  persistSession(sessionKey);
}

/**
 * Persist the direct executor child process id for cross-process recovery.
 */
export function setSessionProcessId(sessionKey: string, processId: number | null): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;
  session.processId = processId;
  persistSession(sessionKey);
}

/**
 * Refresh the persisted heartbeat timestamp for an active session.
 * Used by long-running direct executors to prove liveness even when no tool
 * calls have been observed yet.
 */
export function heartbeatSession(sessionKey: string): void {
  persistSession(sessionKey);
}

/**
 * Record non-tool transcript progress for sessions where the executor is
 * clearly doing work but ClawForce has not observed structured tool telemetry.
 */
export function recordSessionProgress(sessionKey: string): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;

  const now = Date.now();
  session.metrics.progressSignalCount += 1;
  session.metrics.lastProgressAt = now;
  if (!session.metrics.firstProgressAt) {
    session.metrics.firstProgressAt = now;
  }

  if (
    session.metrics.progressSignalCount === 1
    || session.metrics.progressSignalCount % PERSIST_EVERY_N_CALLS === 0
  ) {
    persistSession(sessionKey);
  }
}

/**
 * Remove session tracking (after enforcement check).
 */
export function endSession(sessionKey: string): SessionCompliance | null {
  const session = getTrackedSessions().get(sessionKey);
  if (session) {
    getTrackedSessions().delete(sessionKey);
    unpersistSession(sessionKey, session.projectId);
  }
  return session ?? null;
}

/**
 * Get all active sessions (for sweep).
 */
export function getActiveSessions(): SessionCompliance[] {
  return [...getTrackedSessions().values()];
}

/**
 * Clear all sessions (for testing).
 */
export function resetTrackerForTest(): void {
  getTrackedSessions().clear();
}

// --- Session persistence (crash recovery) ---

/**
 * Persist session state to SQLite for crash recovery.
 */
export function persistSession(sessionKey: string): void {
  const session = getTrackedSessions().get(sessionKey);
  if (!session) return;

  try {
    const db = getDb(session.projectId);
    db.prepare(`
      INSERT OR REPLACE INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context, process_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      session.processId ?? null,
    );
  } catch (err) {
    safeLog("tracker.persist", err);
  }
}

/**
 * Classify a persisted session heartbeat for operator surfaces.
 */
export function getSessionHeartbeatStatus(
  lastPersistedAt: number | null | undefined,
  now = Date.now(),
): SessionHeartbeatStatus {
  if (!lastPersistedAt || !Number.isFinite(lastPersistedAt)) {
    return { state: "stale", ageMs: null };
  }

  const ageMs = Math.max(0, now - lastPersistedAt);
  if (ageMs <= SESSION_HEARTBEAT_LIVE_MS) {
    return { state: "live", ageMs };
  }
  if (ageMs <= SESSION_HEARTBEAT_STALE_MS) {
    return { state: "quiet", ageMs };
  }
  return { state: "stale", ageMs };
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

export type PersistedTrackedSession = {
  sessionKey: string;
  agentId: string;
  projectId: string;
  startedAt: number;
  toolCallCount: number;
  lastPersistedAt: number | null;
  dispatchContext?: { queueItemId: string; taskId: string };
  processId?: number | null;
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

export function listPersistedTrackedSessions(
  projectId: string,
  dbOverride?: DatabaseSync,
): PersistedTrackedSession[] {
  try {
    const db = dbOverride ?? getDb(projectId);
    const rows = db.prepare(
      "SELECT session_key, agent_id, project_id, started_at, tool_call_count, last_persisted_at, dispatch_context, process_id FROM tracked_sessions WHERE project_id = ?"
    ).all(projectId) as Record<string, unknown>[];

    return rows.map((row) => {
      let dispatchContext: { queueItemId: string; taskId: string } | undefined;
      if (row.dispatch_context) {
        try {
          dispatchContext = JSON.parse(row.dispatch_context as string);
        } catch {
          dispatchContext = undefined;
        }
      }
      return {
        sessionKey: row.session_key as string,
        agentId: row.agent_id as string,
        projectId: row.project_id as string,
        startedAt: row.started_at as number,
        toolCallCount: row.tool_call_count as number,
        lastPersistedAt: (row.last_persisted_at as number | null | undefined) ?? null,
        dispatchContext,
        processId: (row.process_id as number | null | undefined) ?? null,
      };
    });
  } catch (err) {
    safeLog("tracker.listPersisted", err);
    return [];
  }
}

export function killPersistedSessionProcess(
  projectId: string,
  sessionKey: string,
  reason: string,
  dbOverride?: DatabaseSync,
): boolean {
  try {
    const session = listPersistedTrackedSessions(projectId, dbOverride).find((candidate) => candidate.sessionKey === sessionKey);
    if (!session?.processId || !Number.isFinite(session.processId)) {
      return false;
    }

    const pid = session.processId;
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best effort
      }
    }, 5_000).unref?.();
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    safeLog("tracker.killPersisted", `Failed to kill persisted session (${reason}): ${detail}`);
    return false;
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
