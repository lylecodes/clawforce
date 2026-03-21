#!/usr/bin/env node
/**
 * ClawForce — PostToolUse hook for Claude Code
 *
 * Records tool calls for compliance tracking after execution completes.
 * Reads the tool call result event from stdin and updates the session tracker.
 *
 * Reads: JSON from stdin with { tool_name, tool_input, duration_ms, error }
 * Writes: Nothing (fire-and-forget tracking)
 */

import { initClawforce, recordToolCall } from '../../../src/index.js';

const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const sessionKey = process.env.CLAWFORCE_SESSION_KEY;

if (!sessionKey) {
  process.exit(0);
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3 });

    const event = JSON.parse(input);
    const toolName = event.tool_name || event.toolName;
    const toolInput = event.tool_input || event.toolInput || {};
    const durationMs = event.duration_ms || event.durationMs || 0;
    const hasError = !!(event.error);

    if (!toolName) {
      process.exit(0);
    }

    // Extract action from tool input if present
    const action = typeof toolInput === 'object' ? (toolInput.action || null) : null;

    recordToolCall(sessionKey, toolName, action, durationMs, !hasError);
  } catch (e) {
    process.stderr.write(`[clawforce] PostToolUse hook error: ${e.message}\n`);
  }
});
