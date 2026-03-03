/**
 * Clawforce — Stuck agent detector
 *
 * Identifies agents that have been running too long without making
 * required tool calls. Used by the sweep service.
 */

import type { SessionCompliance } from "../enforcement/tracker.js";
import { getActiveSessions } from "../enforcement/tracker.js";

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

/**
 * Detect stuck agents from active sessions.
 */
export function detectStuckAgents(config?: Partial<StuckDetectorConfig>): StuckAgent[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
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

function checkIfStuck(
  session: SessionCompliance,
  now: number,
  cfg: StuckDetectorConfig,
): StuckAgent | null {
  const runtimeMs = now - session.metrics.startedAt;
  const lastToolCallMs = session.metrics.lastToolCallAt;

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

  // Check 1: No tool calls at all — agent never started working
  if (!session.metrics.firstToolCallAt) {
    return {
      ...base,
      reason: `Running ${Math.round(runtimeMs / 1000)}s with zero tool calls`,
    };
  }

  // Check 2: Has made tool calls but none satisfy requirements
  if (requiredCallsMade === 0) {
    return {
      ...base,
      reason: `Running ${Math.round(runtimeMs / 1000)}s with no required tool calls`,
    };
  }

  // Check 3: Has made required calls but has been idle too long
  if (lastToolCallMs) {
    const idleMs = now - lastToolCallMs;
    if (idleMs > cfg.idleTimeoutMs) {
      return {
        ...base,
        reason: `Idle for ${Math.round(idleMs / 1000)}s after running ${Math.round(runtimeMs / 1000)}s`,
      };
    }
  }

  return null;
}
