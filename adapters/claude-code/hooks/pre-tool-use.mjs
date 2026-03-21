#!/usr/bin/env node
/**
 * ClawForce — PreToolUse hook for Claude Code
 *
 * Enforces tool policies before a tool call executes.
 * Reads the tool call event from stdin, runs ClawForce's 3-layer
 * policy enforcement, and outputs a block decision if denied.
 *
 * Reads: JSON from stdin with { tool_name, tool_input }
 * Writes: JSON to stdout with { decision: "block", reason } if blocked
 *         Nothing if allowed (implicit allow)
 */

import { initClawforce, initializeAllDomains } from '../../../src/index.js';

// Dynamic import for enforceToolPolicy — it's in the policy subdirectory
const { enforceToolPolicy } = await import('../../../src/policy/middleware.js');

const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const agentId = process.env.CLAWFORCE_AGENT_ID;
const sessionKey = process.env.CLAWFORCE_SESSION_KEY;
const projectId = process.env.CLAWFORCE_PROJECT_ID;

if (!agentId || !projectId) {
  process.exit(0);
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3 });
    initializeAllDomains(projectsDir);

    const event = JSON.parse(input);
    const toolName = event.tool_name || event.toolName;
    const toolInput = event.tool_input || event.toolInput || {};

    if (!toolName) {
      // Can't enforce without a tool name — allow
      process.exit(0);
    }

    // Skip enforcement for ClawForce's own tools — they have built-in policy checks
    if (toolName.startsWith('clawforce_')) {
      process.exit(0);
    }

    const result = enforceToolPolicy({
      projectId,
      agentId,
      sessionKey: sessionKey || 'unknown',
      toolName,
    }, toolInput);

    if (!result.allowed) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: result.reason || 'Blocked by ClawForce policy',
      }));
    }
    // If allowed, output nothing (implicit allow)
  } catch (e) {
    process.stderr.write(`[clawforce] PreToolUse hook error: ${e.message}\n`);
    // On error, allow the call to proceed (fail-open for hooks)
  }
});
