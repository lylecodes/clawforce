/**
 * Clawforce — Compliance check
 *
 * Evaluates whether a session satisfied all required outputs.
 * Returns a compliance result with details for auditing.
 */

import type { SessionCompliance, SessionMetrics } from "./tracker.js";

export type ComplianceResult = {
  compliant: boolean;
  sessionKey: string;
  agentId: string;
  projectId: string;
  /** Job name if this session ran a scoped job. */
  jobName?: string;
  /** Which requirements were satisfied and which weren't. */
  requirements: RequirementResult[];
  /** Full metrics snapshot. */
  metrics: SessionMetrics;
  /** Human-readable summary of what went wrong. */
  violations: string[];
};

export type RequirementResult = {
  tool: string;
  action: string | string[];
  min_calls: number;
  actual_calls: number;
  satisfied: boolean;
};

/**
 * Check compliance for a session.
 */
export function checkCompliance(session: SessionCompliance): ComplianceResult {
  const requirements: RequirementResult[] = [];
  const violations: string[] = [];

  for (const req of session.requirements) {
    const actions = Array.isArray(req.action) ? req.action.sort().join("|") : req.action;
    const key = `${req.tool}:${actions}`;
    const actual = session.satisfied.get(key) ?? 0;
    const satisfied = actual >= req.min_calls;

    requirements.push({
      tool: req.tool,
      action: req.action,
      min_calls: req.min_calls,
      actual_calls: actual,
      satisfied,
    });

    if (!satisfied) {
      const actionStr = Array.isArray(req.action) ? req.action.join(" or ") : req.action;
      violations.push(
        `Required ${req.tool} (${actionStr}) at least ${req.min_calls}x, called ${actual}x`,
      );
    }
  }

  return {
    compliant: violations.length === 0,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    projectId: session.projectId,
    jobName: session.jobName,
    requirements,
    metrics: session.metrics,
    violations,
  };
}

/**
 * Build a retry prompt for non-compliant agents.
 * Tells the agent exactly what it didn't do and includes session context.
 */
export function buildRetryPrompt(result: ComplianceResult): string {
  const lines = [
    "## Performance Review",
    "",
    "Your previous session did not meet expectations.",
    "You did not complete the following deliverables:",
    "",
  ];

  for (const v of result.violations) {
    lines.push(`- ${v}`);
  }

  // Session summary for context
  const { metrics } = result;
  const durationMs = (metrics.lastToolCallAt ?? Date.now()) - metrics.startedAt;
  const durationSec = Math.round(durationMs / 1000);
  lines.push("");
  lines.push("### Session Summary");
  lines.push(`- Tool calls made: ${metrics.toolCalls.length}`);
  lines.push(`- Errors encountered: ${metrics.errorCount}`);
  lines.push(`- Session duration: ${durationSec}s`);

  // Recent tool calls for context
  if (metrics.toolCalls.length > 0) {
    const recent = metrics.toolCalls.slice(-5);
    lines.push("");
    lines.push("### Recent Tool Calls");
    for (const call of recent) {
      const actionStr = call.action ? ` (${call.action})` : "";
      const statusStr = call.success ? "ok" : "error";
      lines.push(`- ${call.toolName}${actionStr} — ${statusStr}`);
    }
  }

  lines.push("");
  lines.push("You are responsible for completing these deliverables in this session.");

  return lines.join("\n");
}
