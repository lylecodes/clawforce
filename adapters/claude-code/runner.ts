/**
 * Clawforce — Claude Code runner
 *
 * Entry point for running ClawForce with Claude Code as the adapter backend.
 * Initializes ClawForce core, starts the MCP server, and provides a dispatch loop
 * placeholder for scheduled/queued work.
 *
 * Phase 1: Skeleton with initialization and MCP server start.
 * Phase 2 will add the full dispatch loop and hook integration.
 */

import path from "node:path";
import { initClawforce } from "../../src/lifecycle.js";
import { initializeAllDomains } from "../../src/config/init.js";
import { createMcpServer, type McpServerOptions } from "./mcp-server.js";
import { resolveClaudeCodeConfig, type ClaudeCodeConfig } from "./types.js";
import { createDashboardServer } from "../../src/dashboard/server.js";

// --- Types ---

export type RunnerOptions = {
  /** Path to ClawForce config directory (default: ~/.clawforce). */
  projectsDir?: string;
  /** Claude Code adapter config. */
  claudeCode?: Partial<ClaudeCodeConfig>;
  /** MCP server options. */
  mcp?: McpServerOptions;
  /** Dashboard options. */
  dashboard?: {
    enabled?: boolean;
    port?: number;
  };
  /** Sweep interval in ms (default: 60_000). */
  sweepIntervalMs?: number;
};

export type RunnerInstance = {
  /** Stop the runner and all associated services. */
  stop(): Promise<void>;
  /** Whether the runner is currently running. */
  readonly running: boolean;
  /** The resolved Claude Code config. */
  readonly config: ReturnType<typeof resolveClaudeCodeConfig>;
  /** MCP server instance (if started). */
  readonly mcpServer: ReturnType<typeof createMcpServer> | null;
};

// --- Runner ---

/**
 * Start the ClawForce runner with Claude Code as the adapter.
 *
 * This initializes:
 * 1. ClawForce core (lifecycle, DB, sweep timer)
 * 2. Domain configs from the projects directory
 * 3. MCP server for Claude Code tool access
 * 4. Dashboard server (optional)
 *
 * The runner does NOT start a dispatch loop in Phase 1.
 * That will be added when the dispatch queue integration is complete.
 */
export async function startRunner(options?: RunnerOptions): Promise<RunnerInstance> {
  const projectsDir = options?.projectsDir
    ?? path.join(process.env.HOME ?? "/tmp", ".clawforce");
  const sweepIntervalMs = options?.sweepIntervalMs ?? 60_000;
  const claudeCodeConfig = resolveClaudeCodeConfig(options?.claudeCode);

  let running = true;
  let mcpServer: ReturnType<typeof createMcpServer> | null = null;
  let dashboardServer: ReturnType<typeof createDashboardServer> | null = null;

  // 1. Initialize ClawForce core
  initClawforce({
    enabled: true,
    projectsDir,
    sweepIntervalMs,
    defaultMaxRetries: 3,
    verificationRequired: true,
  });

  // 2. Initialize domain configs
  const domainResult = initializeAllDomains(projectsDir);
  if (domainResult.errors.length > 0) {
    for (const err of domainResult.errors) {
      console.error(`[clawforce-runner] Domain error: ${err}`);
    }
  }
  if (domainResult.domains.length > 0) {
    console.log(`[clawforce-runner] Initialized ${domainResult.domains.length} domain(s): ${domainResult.domains.join(", ")}`);
  }

  // 3. Start MCP server
  mcpServer = createMcpServer({
    ...options?.mcp,
    projectId: options?.mcp?.projectId,
    agentId: options?.mcp?.agentId,
  });
  await mcpServer.start();
  console.log(`[clawforce-runner] MCP server listening on ${mcpServer.host}:${mcpServer.port}`);

  // 4. Start dashboard (optional)
  if (options?.dashboard?.enabled !== false) {
    const dashboardPort = options?.dashboard?.port ?? 3117;
    dashboardServer = createDashboardServer({ port: dashboardPort });
    await dashboardServer.start();
    console.log(`[clawforce-runner] Dashboard at http://localhost:${dashboardPort}`);
  }

  // 5. Placeholder: dispatch loop
  // Phase 2 will add:
  // - Queue polling for pending dispatches
  // - Spawning claude -p processes via dispatchViaClaude()
  // - Result collection and compliance checking
  // - Retry/escalation handling

  return {
    async stop() {
      if (!running) return;
      running = false;

      if (mcpServer) {
        await mcpServer.stop();
        mcpServer = null;
      }
      if (dashboardServer) {
        await dashboardServer.stop();
        dashboardServer = null;
      }

      console.log("[clawforce-runner] Stopped");
    },

    get running() {
      return running;
    },

    get config() {
      return claudeCodeConfig;
    },

    get mcpServer() {
      return mcpServer;
    },
  };
}
