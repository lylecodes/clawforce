/**
 * Clawforce — Stuck agent detector
 *
 * Identifies agents that have been running too long without making
 * required tool calls. Used by the sweep service.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import type { PersistedTrackedSession, SessionCompliance } from "../enforcement/tracker.js";
import {
  getActiveSessions,
  getSessionHeartbeatStatus,
  listPersistedTrackedSessions,
} from "../enforcement/tracker.js";

export type StuckAgent = {
  sessionKey: string;
  agentId: string;
  projectId: string;
  runtimeMs: number;
  lastToolCallMs: number | null;
  requiredCallsMade: number;
  requiredCallsTotal: number;
  reason: string;
};

export type StuckDetectorConfig = {
  /** Max runtime before flagging as stuck (default 5 min). */
  stuckTimeoutMs: number;
  /** Max time between tool calls before flagging (default 3 min). */
  idleTimeoutMs: number;
};

const DEFAULT_CONFIG: StuckDetectorConfig = {
  stuckTimeoutMs: 300_000,
  idleTimeoutMs: 180_000,
};

function resolveConfig(config?: Partial<StuckDetectorConfig>): StuckDetectorConfig {
  return {
    stuckTimeoutMs: config?.stuckTimeoutMs ?? DEFAULT_CONFIG.stuckTimeoutMs,
    idleTimeoutMs: config?.idleTimeoutMs ?? DEFAULT_CONFIG.idleTimeoutMs,
  };
}

/**
 * Detect stuck agents from active sessions.
 */
export function detectStuckAgents(config?: Partial<StuckDetectorConfig>): StuckAgent[] {
  const cfg = resolveConfig(config);
  const now = Date.now();
  const sessions = getActiveSessions();
  const stuck: StuckAgent[] = [];

  for (const session of sessions) {
    const result = checkIfStuck(session, now, cfg);
    if (result) {
      stuck.push(result);
    }
  }

  return stuck;
}

export function detectPersistedStuckAgents(
  projectId: string,
  db: DatabaseSync,
  config?: Partial<StuckDetectorConfig>,
): StuckAgent[] {
  const cfg = resolveConfig(config);
  const now = Date.now();
  const activeKeys = new Set(getActiveSessions().map((session) => session.sessionKey));
  const sessions = listPersistedTrackedSessions(projectId, db);
  const stuck: StuckAgent[] = [];

  for (const session of sessions) {
    if (activeKeys.has(session.sessionKey)) continue;
    const result = checkIfPersistedSessionIsStuck(session, now, cfg);
    if (result) {
      stuck.push(result);
    }
  }

  return stuck;
}

function checkIfStuck(
  session: SessionCompliance,
  now: number,
  cfg: StuckDetectorConfig,
): StuckAgent | null {
  const runtimeMs = now - session.metrics.startedAt;
  const lastToolCallMs = session.metrics.lastToolCallAt;
  const lastProgressMs = session.metrics.lastProgressAt;
  const lastObservedActivityMs = [lastToolCallMs, lastProgressMs]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce<number | null>((latest, value) => latest == null ? value : Math.max(latest, value), null);

  // Count how many required outputs have been satisfied
  let requiredCallsMade = 0;
  let requiredCallsTotal = 0;
  for (const req of session.requirements) {
    const actions = Array.isArray(req.action) ? req.action.sort().join("|") : req.action;
    const key = `${req.tool}:${actions}`;
    const count = session.satisfied.get(key) ?? 0;
    requiredCallsTotal += req.min_calls;
    requiredCallsMade += Math.min(count, req.min_calls);
  }

  const base = {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    projectId: session.projectId,
    runtimeMs,
    lastToolCallMs,
    requiredCallsMade,
    requiredCallsTotal,
  };

  if (runtimeMs <= cfg.stuckTimeoutMs) return null;

  if (!session.metrics.firstToolCallAt && session.metrics.firstProgressAt) {
    if (session.expectsToolTelemetry !== false) {
      return {
        ...base,
        reason: `Running ${Math.round(runtimeMs / 1000)}s with transcript progress but zero tool calls`,
      };
    }
    const idleMs = lastProgressMs != null ? now - lastProgressMs : 0;
    if (idleMs > cfg.idleTimeoutMs) {
      return {
        ...base,
        reason: `No transcript progress for ${Math.round(idleMs / 1000)}s after running ${Math.round(runtimeMs / 1000)}s`,
      };
    }
    return null;
  }

  // Check 1: No tool calls at all — agent never started working
  if (!session.metrics.firstToolCallAt) {
    if (session.expectsToolTelemetry === false) return null;
    return {
      ...base,
      reason: `Running ${Math.round(runtimeMs / 1000)}s with zero tool calls`,
    };
  }

  // Check 2: Has made tool calls but none satisfy requirements
  if (requiredCallsMade === 0) {
    if (lastProgressMs != null) {
      const idleMs = now - lastProgressMs;
      if (idleMs <= cfg.idleTimeoutMs) {
        return null;
      }
    }
    if (session.expectsToolTelemetry === false) return null;
    return {
      ...base,
      reason: `Running ${Math.round(runtimeMs / 1000)}s with no required tool calls`,
    };
  }

  // Check 3: Has made required calls but has been idle too long
  if (lastObservedActivityMs) {
    const idleMs = now - lastObservedActivityMs;
    if (idleMs > cfg.idleTimeoutMs) {
      return {
        ...base,
        reason: `Idle for ${Math.round(idleMs / 1000)}s after running ${Math.round(runtimeMs / 1000)}s`,
      };
    }
  }

  return null;
}

function checkIfPersistedSessionIsStuck(
  session: PersistedTrackedSession,
  now: number,
  cfg: StuckDetectorConfig,
): StuckAgent | null {
  const runtimeMs = now - session.startedAt;
  if (runtimeMs <= cfg.stuckTimeoutMs) return null;

  const heartbeat = getSessionHeartbeatStatus(session.lastPersistedAt, now);
  const base = {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    projectId: session.projectId,
    runtimeMs,
    lastToolCallMs: null,
    requiredCallsMade: session.toolCallCount > 0 ? 1 : 0,
    requiredCallsTotal: 1,
  };

  if (session.toolCallCount === 0) {
    if (heartbeat.state === "stale") {
      return {
        ...base,
        reason: `Persisted session stale for ${Math.round((heartbeat.ageMs ?? 0) / 1000)}s with zero tool calls`,
      };
    }
    return null;
  }

  if ((heartbeat.ageMs ?? Number.POSITIVE_INFINITY) > cfg.idleTimeoutMs) {
    return {
      ...base,
      reason: `Persisted session stale for ${Math.round((heartbeat.ageMs ?? 0) / 1000)}s after ${session.toolCallCount} tool calls`,
    };
  }

  return null;
}
