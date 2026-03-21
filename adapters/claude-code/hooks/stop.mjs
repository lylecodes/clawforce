#!/usr/bin/env node
/**
 * ClawForce — Stop hook for Claude Code
 *
 * Runs compliance check at session end and logs the result.
 * Called by Claude Code when the agent session terminates.
 *
 * Reads: CLAWFORCE_SESSION_KEY, CLAWFORCE_PROJECT_ID, CLAWFORCE_PROJECTS_DIR
 * Writes: Nothing (compliance result logged to stderr if non-compliant)
 */

import { initClawforce, endSession, checkCompliance, recordCompliantRun, executeFailureAction, getAgentConfig } from '../../../dist/src/index.js';

const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const sessionKey = process.env.CLAWFORCE_SESSION_KEY;
const projectId = process.env.CLAWFORCE_PROJECT_ID;

if (!sessionKey) {
  process.exit(0);
}

try {
  initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3 });

  const session = endSession(sessionKey);
  if (!session) {
    // Session wasn't tracked — nothing to check
    process.exit(0);
  }

  const result = checkCompliance(session);

  if (result.compliant) {
    recordCompliantRun(result);
    process.exit(0);
  }

  // Non-compliant — log violations
  process.stderr.write(`[clawforce] Session non-compliant: ${result.violations.join(', ')}\n`);

  // Execute failure action if agent has a performance policy
  const agentEntry = getAgentConfig(session.agentId);
  if (agentEntry) {
    const actionResult = executeFailureAction(
      session.performancePolicy ?? agentEntry.config.performance_policy,
      result,
    );
    process.stderr.write(`[clawforce] Failure action: ${actionResult.action}\n`);
  }
} catch (e) {
  process.stderr.write(`[clawforce] Stop hook error: ${e.message}\n`);
}
