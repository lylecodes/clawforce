#!/usr/bin/env node
/**
 * ClawForce — SessionStart hook for Claude Code
 *
 * Initializes compliance tracking and injects governance context
 * into the agent's system prompt. Claude Code calls this hook when
 * a new session begins.
 *
 * Reads: CLAWFORCE_AGENT_ID, CLAWFORCE_PROJECT_ID, CLAWFORCE_SESSION_KEY, CLAWFORCE_PROJECTS_DIR
 * Writes: JSON to stdout with { systemPrompt } if context available
 */

import { initClawforce, initializeAllDomains, assembleContext, startTracking, getAgentConfig } from '../../../src/index.js';

const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const agentId = process.env.CLAWFORCE_AGENT_ID;
const sessionKey = process.env.CLAWFORCE_SESSION_KEY;
const projectId = process.env.CLAWFORCE_PROJECT_ID;

if (!agentId || !projectId) {
  // Not a ClawForce-managed session — skip silently
  process.exit(0);
}

try {
  initClawforce({ enabled: true, projectsDir, sweepIntervalMs: 0, defaultMaxRetries: 3 });
  initializeAllDomains(projectsDir);

  const entry = getAgentConfig(agentId);
  if (!entry) {
    process.exit(0);
  }

  // Start compliance tracking
  if (sessionKey) {
    startTracking(sessionKey, agentId, projectId, entry.config);
  }

  // Assemble governance context
  const context = assembleContext(agentId, entry.config, {
    projectId,
    projectDir: entry.projectDir,
    sessionKey,
  });

  // Output context for injection into the session
  if (context) {
    const output = JSON.stringify({ systemPrompt: context });
    process.stdout.write(output);
  }
} catch (e) {
  // Don't crash the hook — log and exit cleanly
  process.stderr.write(`[clawforce] SessionStart hook error: ${e.message}\n`);
}
