/**
 * clawforce — OpenClaw plugin adapter
 *
 * Thin integration layer that connects clawforce to OpenClaw's plugin system.
 * Translates OpenClaw lifecycle events into clawforce core calls.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi as _OpenClawPluginApi } from "openclaw/plugin-sdk";

type OpenClawPluginApi = _OpenClawPluginApi;

/**
 * Inject a message into an agent session via the OpenClaw CLI.
 * Replaces api.injectAgentMessage which doesn't exist in the plugin SDK.
 */
function cliInjectMessage(params: { sessionKey: string; message: string }): Promise<{ runId?: string }> {
  // Extract agentId from sessionKey pattern "agent:<agentId>:..."
  const agentMatch = params.sessionKey.match(/^agent:([^:]+):/);
  const agentId = agentMatch?.[1] ?? params.sessionKey;
  return new Promise((resolve, reject) => {
    execFile("openclaw", ["agent", "--agent", agentId, "--message", params.message], { timeout: 600_000 }, (err) => {
      if (err) reject(err);
      else resolve({});
    });
  });
}

/**
 * Re-dispatch a continuous job with full safety gates, backoff, and enriched nudge.
 * Extracted from the non-compliant completion path so both compliant and non-compliant
 * paths share the same logic — preventing tight idle loops that burn money.
 */
async function redispatchContinuousJob(
  session: { agentId: string; projectId: string; jobName?: string },
  jobDef: { continuous?: boolean; nudge?: string },
  api: { logger: { info: (msg: string) => void; warn: (msg: string) => void } },
): Promise<void> {
  if (!session.jobName || !jobDef.continuous) return;

  const { shouldDispatch } = await import("../src/dispatch/dispatcher.js");
  const { isEmergencyStopActive } = await import("../src/safety.js");

  if (isEmergencyStopActive(session.projectId)) {
    api.logger.warn(`Clawforce: continuous job "${session.jobName}" blocked — emergency stop active`);
    return;
  }

  const gateCheck = shouldDispatch(session.projectId, session.agentId);
  if (!gateCheck.ok) {
    api.logger.warn(`Clawforce: continuous job "${session.jobName}" blocked — ${gateCheck.reason}`);
    return;
  }

  // Always back off between continuous cycles — prevents tight loops.
  // Longer backoff when board is empty (planning needed), shorter when work exists.
  let backoffMs = 60_000; // 1 min minimum between cycles
  let nudge = jobDef.nudge ?? `Continue your "${session.jobName}" job. Pick up where you left off.`;
  try {
    const db = getDb(session.projectId);
    const activeRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state IN ('ASSIGNED','IN_PROGRESS','REVIEW','OPEN')"
    ).get(session.projectId) as Record<string, number>;
    const activeTasks = activeRow?.cnt ?? 0;
    if (activeTasks === 0) {
      backoffMs = 5 * 60 * 1000; // 5 min backoff when board is empty
      nudge += "\n\nThe task board is EMPTY. Review the planning context in your briefing and create new tasks with acceptance criteria.";
      api.logger.info(`Clawforce: continuous job "${session.jobName}" backing off 5min — board empty for ${session.agentId}`);
    }
  } catch { /* non-fatal — proceed with default 1min backoff */ }

  const taggedNudge = `[clawforce:job=${session.jobName}]\n\n${nudge}`;
  // Use cron dispatch with sessionTarget: "isolated" for truly fresh sessions.
  // The CLI path (execFile) always reuses the agent's main session and accumulates history.
  const dispatch = async () => {
    const cronService = getCronService();
    if (!cronService) {
      api.logger.warn(`Clawforce: continuous re-dispatch skipped — cron service not available for ${session.agentId}`);
      return;
    }
    try {
      const { toCronJobCreate } = await import("../src/manager-cron.js");
      const input = toCronJobCreate({
        name: `continuous:${session.agentId}:${session.jobName}:${Date.now()}`,
        schedule: `at:${new Date().toISOString()}`,
        agentId: session.agentId,
        payload: taggedNudge,
        sessionTarget: "isolated",
        wakeMode: "now",
        deleteAfterRun: true,
      });
      await cronService.add(input);
      api.logger.info(`Clawforce: continuous job "${session.jobName}" re-dispatched for ${session.agentId} (isolated session)`);
    } catch (err) {
      api.logger.warn(`Clawforce: continuous re-dispatch failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (backoffMs > 0) {
    setTimeout(dispatch, backoffMs);
  } else {
    dispatch();
  }
}

import { assembleContext, clearAssemblerCache } from "../src/context/assembler.js";
import { resolveJobName, resolveDispatchContext, resolveEffectiveConfig } from "../src/jobs.js";
import { checkCompliance } from "../src/enforcement/check.js";
import { executeFailureAction, executeCrashAction, recordCompliantRun } from "../src/enforcement/actions.js";
import { countRecentRetries } from "../src/enforcement/retry-store.js";
import { resolveEscalationTarget, routeEscalation } from "../src/enforcement/escalation-router.js";
import { endSession, getSession, recordToolCall, recordSignificantResult, recoverOrphanedSessions, setDispatchContext, startTracking } from "../src/enforcement/tracker.js";
import { emitDiagnosticEvent, setDiagnosticEmitter } from "../src/diagnostics.js";
import { getActiveProjectIds, initClawforce, registerProject, shutdownClawforce } from "../src/lifecycle.js";
import {
  getAgentConfig,
  getExtendedProjectConfig,
  getRegisteredAgentIds,
  resolveProjectDir,
  loadWorkforceConfig,
  registerWorkforceConfig,
} from "../src/project.js";
import { getEffectiveLifecycleConfig, getSafetyConfig } from "../src/safety.js";
import { syncAgentsToOpenClaw, toNamespacedAgentId } from "../src/agent-sync.js";
import { approveProposal, listPendingProposals, rejectProposal } from "../src/approval/resolve.js";
import { resolveApprovalChannel } from "../src/approval/channel-router.js";
import {
  type ApprovalNotifier,
  type NotificationPayload,
  setApprovalNotifier,
  getApprovalNotifier,
  formatTelegramMessage,
  buildApprovalButtons,
} from "../src/approval/notify.js";
import { persistToolCallIntent } from "../src/approval/intent-store.js";
import { checkPreApproval, consumePreApproval } from "../src/approval/pre-approved.js";
import { recordToolGateHit, getEffectiveTier } from "../src/risk/bulk-detector.js";
import { getRiskConfig } from "../src/risk/config.js";
import { getDb } from "../src/db.js";
import { completeItem, failItem } from "../src/dispatch/queue.js";
import { attachEvidence, getTask, releaseTaskLease, transitionTask } from "../src/tasks/ops.js";
import { setDispatchInjector } from "../src/dispatch/inject-dispatch.js";
import { recoverProject } from "../src/dispatch/restart-recovery.js";
import { registerKillFunction, killStuckAgent } from "../src/audit/auto-kill.js";
import { checkBudget } from "../src/budget.js";
import { disableAgent, isAgentDisabled, isAgentEffectivelyDisabled } from "../src/enforcement/disabled-store.js";
import { handleWorkerSessionEnd } from "../src/tasks/session-end.js";
import { buildOnboardingContext } from "../src/context/onboarding.js";
import { getAllowedActionsForTool } from "../src/profiles.js";
import { resolveEffectiveScope } from "../src/scope.js";
import { withPolicyCheck, enforceToolPolicy } from "../src/policy/middleware.js";
import { adaptTool, type ToolResult } from "../src/tools/common.js";
import { createClawforceLogTool } from "../src/tools/log-tool.js";
import { createClawforceSetupTool } from "../src/tools/setup-tool.js";
import { createClawforceTaskTool } from "../src/tools/task-tool.js";
import { createClawforceVerifyTool } from "../src/tools/verify-tool.js";
import { createClawforceCompactTool } from "../src/tools/compact-tool.js";
import { createClawforceWorkflowTool } from "../src/tools/workflow-tool.js";
import { createClawforceOpsTool } from "../src/tools/ops-tool.js";
import { createClawforceContextTool } from "../src/tools/context-tool.js";
import { createClawforceMessageTool } from "../src/tools/message-tool.js";
import { createClawforceChannelTool } from "../src/tools/channel-tool.js";
import { setMessageNotifier, formatMessageNotification } from "../src/messaging/notify.js";
import { setChannelNotifier, formatChannelMessage } from "../src/channels/notify.js";
import { setDeliveryAdapter } from "../src/channels/deliver.js";
import { advanceMeetingTurn, concludeMeeting, getMeetingStatus } from "../src/channels/meeting.js";
import { buildChannelTranscript } from "../src/channels/messages.js";
import { getChannel } from "../src/channels/store.js";
// Memory system
import { runGhostRecall, runCronRecall, clearCooldown, type GhostTurnIntensity, type MemoryToolInstance, type GhostRecallResult, INTENSITY_PRESETS } from "../src/memory/ghost-turn.js";
import { trackRetrieval } from "../src/memory/retrieval-tracker.js";
import {
  isMemoryWriteCall,
  getFlushPrompt,
} from "../src/memory/flush-tracker.js";
// OpenClaw RAG memory tool factories — lazy-imported at registration time
type MemoryToolFactory = (opts: { agentSessionKey?: string }) => Record<string, unknown> | null;
import { recordCostFromLlmOutput } from "../src/cost.js";
import { registerBulkPricing } from "../src/pricing.js";
import { updateProviderUsage } from "../src/rate-limits.js";
import { recordCall as recordRateLimitCall, checkCallLimit, clearSession as clearRateLimitSession, calculateBackoffDelay, type RateLimitConfig, type BackoffConfig } from "../src/safety/rate-limiter.js";
import { initializeAllDomains } from "../src/config/init.js";
import { startConfigWatcher, stopConfigWatcher } from "../src/config/watcher.js";
// Dashboard
import { createDashboardHandler } from "../src/dashboard/gateway-routes.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { emitSSE } from "../src/dashboard/sse.js";
import { setCronService, getCronService } from "../src/manager-cron.js";

type GhostRecallConfig = {
  enabled?: boolean;
  intensity?: GhostTurnIntensity;
  windowSize?: number;
  maxInjectedChars?: number;
  maxSearches?: number;
  debug?: boolean;
  injectExpectations?: boolean;
};

type MemoryFlushConfig = {
  enabled?: boolean;
  flushInterval?: number;
  minToolCalls?: number;
};

type ClawforcePluginConfig = {
  enabled?: boolean;
  projectsDir?: string;
  sweepIntervalMs?: number;
  defaultMaxRetries?: number;
  staleTaskHours?: number;
  cronStuckTimeoutMs?: number;
  cronMaxConsecutiveFailures?: number;
  ghostRecall?: GhostRecallConfig;
  memoryFlush?: MemoryFlushConfig;
  /** Sync clawforce agents to OpenClaw config (agents.list[]). Default: true. */
  syncAgents?: boolean;
  /** Override for domain config directory (defaults to projectsDir). */
  configDir?: string;
  /** Start the standalone compatibility dashboard server alongside the embedded OpenClaw route. Default: true. */
  standaloneDashboard?: boolean;
};

const DEFAULT_GHOST_RECALL: Required<GhostRecallConfig> = {
  enabled: true,
  intensity: "medium",
  windowSize: 10,
  maxInjectedChars: 4000,
  maxSearches: 3,
  debug: false,
  injectExpectations: true,
};

const DEFAULT_MEMORY_FLUSH: Required<MemoryFlushConfig> = {
  enabled: true,
  flushInterval: 15,
  minToolCalls: 3,
};

const DEFAULT_CONFIG = {
  enabled: true,
  projectsDir: "~/.clawforce",
  sweepIntervalMs: 60_000,
  defaultMaxRetries: 3,
  staleTaskHours: 4,
  cronStuckTimeoutMs: 300_000,
  cronMaxConsecutiveFailures: 3,
  ghostRecall: DEFAULT_GHOST_RECALL,
  memoryFlush: DEFAULT_MEMORY_FLUSH,
} as const;

function resolveGhostRecall(raw?: Record<string, unknown>): Required<GhostRecallConfig> {
  if (!raw) return { ...DEFAULT_GHOST_RECALL };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_GHOST_RECALL.enabled,
    intensity: (["low", "medium", "high"].includes(raw.intensity as string) ? raw.intensity : DEFAULT_GHOST_RECALL.intensity) as GhostTurnIntensity,
    windowSize: typeof raw.windowSize === "number" ? raw.windowSize : DEFAULT_GHOST_RECALL.windowSize,
    maxInjectedChars: typeof raw.maxInjectedChars === "number" ? raw.maxInjectedChars : DEFAULT_GHOST_RECALL.maxInjectedChars,
    maxSearches: typeof raw.maxSearches === "number" ? raw.maxSearches : DEFAULT_GHOST_RECALL.maxSearches,
    debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_GHOST_RECALL.debug,
    injectExpectations: typeof raw.injectExpectations === "boolean" ? raw.injectExpectations : DEFAULT_GHOST_RECALL.injectExpectations,
  };
}

function resolveMemoryFlush(raw?: Record<string, unknown>): Required<MemoryFlushConfig> {
  if (!raw) return { ...DEFAULT_MEMORY_FLUSH };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_MEMORY_FLUSH.enabled,
    flushInterval: typeof raw.flushInterval === "number" ? raw.flushInterval : DEFAULT_MEMORY_FLUSH.flushInterval,
    minToolCalls: typeof raw.minToolCalls === "number" ? raw.minToolCalls : DEFAULT_MEMORY_FLUSH.minToolCalls,
  };
}

type ResolvedConfig = {
  enabled: boolean;
  projectsDir: string;
  configDir?: string;
  sweepIntervalMs: number;
  defaultMaxRetries: number;
  staleTaskHours: number;
  cronStuckTimeoutMs: number;
  cronMaxConsecutiveFailures: number;
  ghostRecall: Required<GhostRecallConfig>;
  memoryFlush: Required<MemoryFlushConfig>;
  syncAgents: boolean;
  standaloneDashboard: boolean;
};

function resolveConfig(raw?: Record<string, unknown>): ResolvedConfig {
  const envStandalone = process.env.CLAWFORCE_DASHBOARD_STANDALONE;
  const standaloneOverride = envStandalone === undefined
    ? undefined
    : !["0", "false", "no", "off"].includes(envStandalone.trim().toLowerCase());
  if (!raw) {
    return {
      ...DEFAULT_CONFIG,
      ghostRecall: { ...DEFAULT_GHOST_RECALL },
      memoryFlush: { ...DEFAULT_MEMORY_FLUSH },
      syncAgents: true,
      standaloneDashboard: standaloneOverride ?? true,
    };
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    projectsDir: typeof raw.projectsDir === "string" ? raw.projectsDir : DEFAULT_CONFIG.projectsDir,
    configDir: typeof raw.configDir === "string" ? raw.configDir : undefined,
    sweepIntervalMs: typeof raw.sweepIntervalMs === "number" ? raw.sweepIntervalMs : DEFAULT_CONFIG.sweepIntervalMs,
    defaultMaxRetries: typeof raw.defaultMaxRetries === "number" ? raw.defaultMaxRetries : DEFAULT_CONFIG.defaultMaxRetries,
    staleTaskHours: typeof raw.staleTaskHours === "number" ? raw.staleTaskHours : DEFAULT_CONFIG.staleTaskHours,
    cronStuckTimeoutMs: typeof raw.cronStuckTimeoutMs === "number" ? raw.cronStuckTimeoutMs : DEFAULT_CONFIG.cronStuckTimeoutMs,
    cronMaxConsecutiveFailures: typeof raw.cronMaxConsecutiveFailures === "number" ? raw.cronMaxConsecutiveFailures : DEFAULT_CONFIG.cronMaxConsecutiveFailures,
    ghostRecall: resolveGhostRecall(raw.ghostRecall as Record<string, unknown> | undefined),
    memoryFlush: resolveMemoryFlush(raw.memoryFlush as Record<string, unknown> | undefined),
    syncAgents: typeof raw.syncAgents === "boolean" ? raw.syncAgents : true,
    standaloneDashboard: standaloneOverride
      ?? (typeof raw.standaloneDashboard === "boolean" ? raw.standaloneDashboard : true),
  };
}

const clawforcePlugin = {
  id: "clawforce",
  name: "Clawforce",
  description: "Reliability and accountability layer for autonomous agents. Task lifecycle, context injection, compliance, and auditing.",
  version: "0.2.0",

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);

    if (!cfg.enabled) {
      api.logger.info("Clawforce disabled via config");
      return;
    }

    // --- Wire dispatch injector via api.runtime.subagent.run() ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subagentRuntime = (api.runtime as any)?.subagent;
    setDispatchInjector(async (params) => {
      return subagentRuntime.run(params);
    });

    // --- Disabled agent tracking (persistent) ---
    async function handleDisable(agentId: string): Promise<void> {
      // Persist to SQLite via the agent's project
      const entry = getAgentConfig(agentId);
      if (entry) {
        disableAgent(entry.projectId, agentId, "Underperforming or unresponsive");
      }
      emitDiagnosticEvent({ type: "agent_disabled", agentId });
    }

    // --- Memory mode toggle (per-session) ---
    const memoryModeStore = new Map<string, boolean>();

    // --- Turn counter (per-session) for maxTurnsPerCycle ---
    const sessionTurnCountStore = new Map<string, number>();

    // --- Meeting session tracking (per-session) ---
    const meetingSessionStore = new Map<string, { channelId: string; turnIndex: number; projectId: string }>();

    // --- Context injection via before_prompt_build ---
    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = ctx.agentId;
      const sessionKey = ctx.sessionKey;
      if (!agentId) return;

      // Try enforcement config first (new system)
      const entry = getAgentConfig(agentId);

      // Block disabled agents from running (checks persistent store)
      if (entry && isAgentEffectivelyDisabled(entry.projectId, agentId)) {
        api.logger.warn(`Clawforce: blocking disabled agent ${agentId}`);
        return { prependContext: "## Clawforce: Agent Disabled\n\nThis agent has been disabled due to repeated failures or non-compliance. Do not proceed with any tasks. Report this status if asked." };
      }

      if (entry && sessionKey) {
        // Resolve job-scoped config if a job tag is present in the prompt
        const jobName = resolveJobName((event as { prompt?: string }).prompt);
        let config = entry.config;
        if (jobName) {
          const effective = resolveEffectiveConfig(entry.config, jobName);
          if (effective) {
            config = effective;
          } else {
            api.logger.warn(`Clawforce: unknown job "${jobName}" for agent ${agentId} — using base config`);
          }
        }

        // Refresh provider rate limits (non-blocking, best-effort)
        // TODO: OpenClaw has loadProviderUsageSummary() which fetches live rate
        // limit data, but it's not exported from the plugin-sdk public API.
        // When openclaw exposes this via plugin-sdk or api.runtime, wire it here:
        //   const summary = await api.runtime.system.loadProviderUsageSummary?.();
        //   for (const s of summary.providers) updateProviderUsage(s.provider, s);
        // For now, rate limit data comes from llm_output hook headers if available.

        // H7: Assemble context first — only start tracking if context assembly succeeds
        let content: string | null = null;
        try {
          content = assembleContext(agentId, config, {
            projectId: entry.projectId,
            projectDir: entry.projectDir,
            sessionKey,
          });
        } catch (err) {
          api.logger.warn(`Clawforce: context assembly failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }

        if (!content || content.trim().length === 0) {
          api.logger.warn(`Clawforce: empty context for ${agentId} — injecting fallback`);
          content = `You are ${agentId}. Check your task board for assigned work using clawforce_task list.`;
        }

        // Telemetry: detect config changes and store context hash
        try {
          const { detectConfigChange } = await import("../src/telemetry/config-tracker.js");
          detectConfigChange(entry.projectId, content, agentId, getDb(entry.projectId));
        } catch { /* telemetry must never break the main flow */ }

        // Start compliance tracking after confirmed context success
        startTracking(sessionKey, agentId, entry.projectId, config, jobName ?? undefined);

        // SSE: notify dashboard that agent is now active
        emitSSE(entry.projectId, "agent:status", {
          agentId,
          status: "active",
          sessionKey,
        });

        // Detect dispatch context (links session to dispatch queue item)
        // Check event.prompt first (cron/job path), then fall back to user messages (CLI spawn path)
        const rawPrompt = (event as { prompt?: string }).prompt;
        let dispatchCtx = resolveDispatchContext(rawPrompt);
        if (!dispatchCtx) {
          const msgs = (event as { messages?: Array<{ role: string; content: unknown }> }).messages;
          // Debug: log last user message for worker sessions
          if (msgs && msgs.length > 0) {
            const lastUser = [...msgs].reverse().find(m => m.role === "user");
            if (lastUser) {
              const preview = typeof lastUser.content === "string" ? lastUser.content.slice(0, 100) : JSON.stringify(lastUser.content)?.slice(0, 100);
              api.logger.info(`Clawforce: dispatch-detect-msg agent=${agentId} lastUser=${preview}`);
            }
          }
          if (msgs) {
            for (const m of msgs) {
              if (m.role !== "user") continue;
              // content can be string or structured [{type:"text",text:"..."}]
              let text: string | undefined;
              if (typeof m.content === "string") {
                text = m.content;
              } else if (Array.isArray(m.content)) {
                text = (m.content as Array<{ type?: string; text?: string }>)
                  .filter(p => p.type === "text" && typeof p.text === "string")
                  .map(p => p.text)
                  .join("\n");
              }
              if (text) {
                dispatchCtx = resolveDispatchContext(text);
                if (dispatchCtx) break;
              }
            }
          }
        }
        if (dispatchCtx) {
          setDispatchContext(sessionKey, dispatchCtx);

          // Auto-transition ASSIGNED → IN_PROGRESS on dispatch start
          const lifecycleCfg = getEffectiveLifecycleConfig(entry.projectId);
          if (lifecycleCfg.autoTransitionOnDispatch) {
            try {
              const db = getDb(entry.projectId);
              const task = getTask(entry.projectId, dispatchCtx.taskId, db);
              if (task && task.state === "ASSIGNED") {
                transitionTask({ projectId: entry.projectId, taskId: dispatchCtx.taskId, toState: "IN_PROGRESS", actor: agentId }, db);
              }
            } catch { /* non-fatal */ }
          }
        }

        // Detect meeting tag [clawforce:meeting=<channelId>:<turnIndex>]
        const prompt = (event as { prompt?: string }).prompt ?? "";
        const meetingMatch = prompt.match(/\[clawforce:meeting=([^:]+):(\d+)\]/);
        if (meetingMatch) {
          const meetingChannelId = meetingMatch[1]!;
          const turnIndex = parseInt(meetingMatch[2]!, 10);
          meetingSessionStore.set(sessionKey, { channelId: meetingChannelId, turnIndex, projectId: entry.projectId });

          // Inject full channel transcript + meeting prompt into context
          try {
            const transcript = buildChannelTranscript(entry.projectId, meetingChannelId, { limit: 50 });
            const status = getMeetingStatus(entry.projectId, meetingChannelId);
            const meetingCfg = status?.channel?.metadata?.meetingConfig as { prompt?: string } | undefined;
            const meetingPrompt = meetingCfg?.prompt;

            const meetingContext = [
              "## Meeting Context\n",
              `You are participating in a meeting (turn ${turnIndex + 1}/${status?.participants?.length ?? "?"}).`,
              meetingPrompt ? `\n**Meeting topic:** ${meetingPrompt}` : "",
              transcript ? `\n### Transcript so far:\n${transcript}` : "\n(No messages yet — you're first.)",
              "\nUse `clawforce_channel send` to contribute your response to this meeting channel.",
            ].filter(Boolean).join("\n");

            content = content ? `${content}\n\n${meetingContext}` : meetingContext;
          } catch (err) {
            api.logger.warn(`Clawforce: meeting context injection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Ghost turn memory recall
        // Per-agent memory.recall config overrides plugin-level ghostRecall defaults
        const agentRecall = config.memory?.recall;
        const recallEnabled = agentRecall?.enabled ?? cfg.ghostRecall.enabled;
        const recallIntensity = agentRecall?.intensity ?? cfg.ghostRecall.intensity;
        const recallMaxSearches = agentRecall?.maxSearches ?? cfg.ghostRecall.maxSearches;
        const recallMaxInjectedChars = agentRecall?.maxInjectedChars ?? cfg.ghostRecall.maxInjectedChars;
        const recallCooldownMs = agentRecall?.cooldownMs; // undefined = use intensity preset default

        let ghostContext: string | null = null;
        if (recallEnabled && _createMemorySearchTool) {
          try {
            const isMemMode = memoryModeStore.get(sessionKey) ?? false;
            const isCron = !!jobName;
            let recallResult: GhostRecallResult | null = null;

            // Determine the memory tool to use based on provider config
            const providerType = config.memory?.provider?.type ?? "builtin";
            let toolInstance: MemoryToolInstance | null = null;

            if (providerType === "mcp") {
              // TODO: MCP memory provider — use MCP server's recall/search tool
              // When MCP client infrastructure is available, connect to the configured
              // MCP server and use its search tool instead of OpenClaw's built-in memory_search.
              // For now, fall back to builtin.
              const mcpCfg = config.memory?.provider?.mcp;
              if (mcpCfg) {
                api.logger.info(`Clawforce: MCP memory provider configured (server: ${mcpCfg.server}) — falling back to builtin until MCP client is available`);
              }
              const rawTool = _createMemorySearchTool({ agentSessionKey: sessionKey });
              toolInstance = rawTool ? adaptMemoryTool(rawTool) as unknown as MemoryToolInstance : null;
            } else {
              const rawTool = _createMemorySearchTool({ agentSessionKey: sessionKey });
              toolInstance = rawTool ? adaptMemoryTool(rawTool) as unknown as MemoryToolInstance : null;
            }

            if (isCron) {
              // Cron path: use job prompt directly, no LLM triage
              const cronPrompt = (event as { prompt?: string }).prompt ?? "";
              recallResult = await runCronRecall(cronPrompt, toolInstance, {
                maxSearches: recallMaxSearches,
                maxInjectedChars: recallMaxInjectedChars,
                debug: cfg.ghostRecall.debug,
                sessionKey,
                projectId: entry.projectId,
                agentId,
              });
            } else {
              // User-facing path: LLM triage on recent messages
              recallResult = await runGhostRecall(
                (event as { messages?: unknown[] }).messages ?? [],
                toolInstance,
                {
                  sessionKey,
                  intensity: recallIntensity,
                  memoryMode: isMemMode,
                  windowSize: cfg.ghostRecall.windowSize,
                  maxInjectedChars: recallMaxInjectedChars,
                  maxSearches: recallMaxSearches,
                  debug: cfg.ghostRecall.debug,
                  projectId: entry.projectId,
                  agentId,
                  cooldownOverrideMs: recallCooldownMs,
                },
              );
            }

            if (recallResult) {
              ghostContext = recallResult.formatted;
              // Track each retrieved memory for the promotion pipeline
              for (const result of recallResult.rawResults) {
                try {
                  trackRetrieval(entry.projectId, agentId, sessionKey, result);
                } catch {
                  // Non-critical — don't let tracking failure break the recall
                }
              }
            }
          } catch (err) {
            emitDiagnosticEvent({ type: "ghost_turn_error", sessionKey, error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Expectations re-injection (after ghost context)
        let expectationsContext: string | null = null;
        const injectExpectations = cfg.ghostRecall.injectExpectations ?? true;
        if (injectExpectations && config.expectations?.length) {
          const { formatExpectationsReminder } = await import("../src/memory/ghost-turn.js");
          expectationsContext = formatExpectationsReminder(config.expectations);
        }

        // Session length guard: inject wrap-up instruction when maxTurnsPerCycle exceeded
        let wrapUpContext: string | null = null;
        const maxTurns = config.scheduling?.maxTurnsPerCycle;
        if (maxTurns !== undefined) {
          const currentTurn = (sessionTurnCountStore.get(sessionKey) ?? 0) + 1;
          sessionTurnCountStore.set(sessionKey, currentTurn);
          if (currentTurn > maxTurns) {
            wrapUpContext = `## Coordination Cycle Limit\n\nYou've been running for ${currentTurn} turns this cycle (limit: ${maxTurns}). Wrap up your current work, log your decisions, and conclude. Your next coordination cycle will continue where you left off.`;
          }
        }

        const parts = [content, ghostContext, expectationsContext, wrapUpContext].filter(Boolean);
        if (parts.length > 0) {
          return { prependContext: parts.join("\n\n") };
        }
      }

      // Onboarding: inject setup instructions when no projects are configured
      if (getActiveProjectIds().length === 0) {
        return { prependContext: buildOnboardingContext(cfg.projectsDir) };
      }
    }, { priority: 10 });

    // --- Auto-failure capture on worker session end ---
    api.on("subagent_ended", async (event) => {
      if (!event.targetSessionKey) return;
      const outcome = event.outcome;
      if (outcome === "ok") return;

      // Handle via enforcement system if this was a tracked session
      clearRateLimitSession(event.targetSessionKey);
      const session = endSession(event.targetSessionKey);
      if (session) {
        const agentEntry = getAgentConfig(session.agentId);
        if (agentEntry) {
          const actionResult = executeCrashAction(
            agentEntry.config.performance_policy,
            session.projectId,
            session.agentId,
            session.sessionKey,
            event.error,
            session.metrics,
            session.jobName,
          );
          api.logger.warn(
            `Clawforce: ${session.agentId} crashed — action: ${actionResult.action}`,
          );

          // Retry: re-inject into the crashed agent's session with exponential backoff
          if (actionResult.action === "retry" && actionResult.retryPrompt) {
            try {
              const safetyConfig = getSafetyConfig(session.projectId);
              const backoffConfig: BackoffConfig = {
                baseDelayMs: safetyConfig.retryBackoffBaseMs,
                maxDelayMs: safetyConfig.retryBackoffMaxMs,
              };
              const retryCount = countRecentRetries(session.projectId, session.agentId);
              const delayMs = calculateBackoffDelay(retryCount, backoffConfig);
              api.logger.info(
                `Clawforce: crash retry ${session.agentId} with ${Math.round(delayMs / 1000)}s backoff (attempt ${retryCount + 1})`,
              );
              const retryPrompt = actionResult.retryPrompt;
              const targetSession = event.targetSessionKey;
              setTimeout(async () => {
                try {
                  await cliInjectMessage({
                    sessionKey: targetSession,
                    message: retryPrompt,
                  });
                } catch (err) {
                  api.logger.warn(
                    `Clawforce: crash retry inject failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }, delayMs);
            } catch (err) {
              api.logger.warn(
                `Clawforce: crash retry backoff failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            return;
          }

          // Disable agent if action requires it
          if (actionResult.disabled) {
            await handleDisable(session.agentId);
          }

          // H9: Escalation with error boundary
          if (actionResult.alertMessage) {
            try {
              const target = resolveEscalationTarget(agentEntry.config);
              await routeEscalation({
                injectAgentMessage: cliInjectMessage,
                target,
                message: actionResult.alertMessage,
                sourceAgentId: session.agentId,
                logger: api.logger,
              });
            } catch (err) {
              api.logger.warn(`Clawforce: escalation failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return;
        }
      }

      // Legacy fallback
      handleWorkerSessionEnd({
        sessionKey: event.targetSessionKey,
        status: outcome === "timeout" ? "timeout" : "error",
        error: event.error,
      });
    });

    // --- Compliance tracking via after_tool_call ---
    api.on("after_tool_call", async (event, ctx) => {
      if (!ctx.sessionKey) return;
      const toolName = event.toolName;
      // Extract action param from tool call params if available
      const action = typeof event.params === "object" && event.params !== null
        ? (event.params as Record<string, unknown>).action as string | undefined
        : undefined;
      const errorMsg = event.error
        ? (typeof event.error === "string" ? event.error : String(event.error))
        : undefined;
      recordToolCall(
        ctx.sessionKey,
        toolName,
        action ?? null,
        event.durationMs ?? 0,
        !event.error,
        errorMsg,
      );

      // Buffer significant tool outputs for auto-lifecycle evidence
      // Resolve lifecycle config for this agent's project
      const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
      const lcConfig = agentEntry ? getEffectiveLifecycleConfig(agentEntry.projectId) : null;
      if (lcConfig?.autoCaptureEvidence !== false) {
        const significantTools = new Set(lcConfig?.significantTools ?? ["Bash", "Write", "Edit", "Read"]);
        if (event.result && significantTools.has(toolName)) {
          const resultStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          if (resultStr.length > 100) {
            recordSignificantResult(ctx.sessionKey, toolName, action ?? null, resultStr, lcConfig?.evidenceTruncationLimit);
          }
        }
      }

      // Telemetry: capture tool call detail with I/O into session buffer
      try {
        const { recordToolCallDetail } = await import("../src/enforcement/tracker.js");
        const inputStr = event.params ? JSON.stringify(event.params).slice(0, 10000) : "";
        const outputStr = event.result
          ? (typeof event.result === "string" ? event.result : JSON.stringify(event.result)).slice(0, 10000)
          : "";
        recordToolCallDetail(
          ctx.sessionKey,
          toolName,
          action ?? null,
          inputStr,
          outputStr,
          event.durationMs ?? 0,
          !event.error,
          event.error ? (typeof event.error === "string" ? event.error : String(event.error)) : undefined,
        );
      } catch { /* telemetry must never break the main flow */ }

      // Memory write detection (informational — flush timing delegated to OpenClaw)
      if (cfg.memoryFlush.enabled && isMemoryWriteCall(toolName, event.params)) {
        emitDiagnosticEvent({ type: "memory_write_detected", sessionKey: ctx.sessionKey, toolName });
      }

      // --- Rate limiting: record call and check per-session limit ---
      try {
        const rlEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        if (rlEntry) {
          const safetyConfig = getSafetyConfig(rlEntry.projectId);
          const rlConfig: RateLimitConfig = {
            maxCallsPerSession: safetyConfig.maxCallsPerSession,
            maxCallsPerMinute: safetyConfig.maxCallsPerMinute,
            maxCallsPerMinutePerAgent: safetyConfig.maxCallsPerMinutePerAgent,
          };

          const rlAgentId = ctx.agentId!;
          const rlSessionKey = ctx.sessionKey!;

          // Record this call
          recordRateLimitCall(rlEntry.projectId, rlAgentId, rlSessionKey);

          // Check if session has exceeded its per-session call limit
          const limitCheck = checkCallLimit(
            rlEntry.projectId,
            rlAgentId,
            rlSessionKey,
            rlConfig,
          );

          if (!limitCheck.allowed) {
            api.logger.warn(
              `Clawforce: rate limit exceeded for ${rlAgentId} (${rlSessionKey}) — killing session. Reason: ${limitCheck.reason}`,
            );
            emitDiagnosticEvent({
              type: "rate_limit_exceeded",
              sessionKey: rlSessionKey,
              agentId: rlAgentId,
              projectId: rlEntry.projectId,
              reason: limitCheck.reason,
            });
            await killStuckAgent({
              sessionKey: rlSessionKey,
              agentId: rlAgentId,
              projectId: rlEntry.projectId,
              runtimeMs: 0,
              lastToolCallMs: null,
              requiredCallsMade: 0,
              requiredCallsTotal: 0,
              reason: `Rate limit: ${limitCheck.reason}`,
            });
          }
        }
      } catch (err) {
        // Rate limiting must never break the main flow
        try { api.logger.warn(`Clawforce: rate limit check failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* */ }
      }
    });

    // --- Universal tool gating via before_tool_call ---
    // Enforces clawforce policies on ALL tools (MCP, external, OpenClaw native).
    // Clawforce's own tools are skipped — they have withPolicyCheck() defense-in-depth.
    api.on("before_tool_call", async (event, ctx) => {
      if (!ctx.agentId) return;

      const entry = getAgentConfig(ctx.agentId);
      if (!entry) return; // Unknown agent — not managed by clawforce, allow

      // --- Emergency stop: block ALL tool calls when kill switch is active ---
      try {
        const db = getDb(entry.projectId);
        const estop = db.prepare(
          "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
        ).get(entry.projectId) as { value: string } | undefined;
        if (estop?.value === "true") {
          return {
            block: true,
            blockReason: "EMERGENCY STOP — all tool calls blocked. Run: pnpm cf kill --resume",
          };
        }
      } catch { /* DB may not be available — allow */ }

      // --- Per-minute rate limit gate: block if global or agent rate exceeded ---
      try {
        if (ctx.sessionKey) {
          const safetyConfig = getSafetyConfig(entry.projectId);
          const rlConfig: RateLimitConfig = {
            maxCallsPerSession: safetyConfig.maxCallsPerSession,
            maxCallsPerMinute: safetyConfig.maxCallsPerMinute,
            maxCallsPerMinutePerAgent: safetyConfig.maxCallsPerMinutePerAgent,
          };
          const limitCheck = checkCallLimit(
            entry.projectId,
            ctx.agentId,
            ctx.sessionKey,
            rlConfig,
          );
          if (!limitCheck.allowed) {
            emitDiagnosticEvent({
              type: "rate_limit_blocked",
              sessionKey: ctx.sessionKey,
              agentId: ctx.agentId,
              projectId: entry.projectId,
              toolName: event.toolName,
              reason: limitCheck.reason,
            });
            return {
              block: true,
              blockReason: `Clawforce rate limit: ${limitCheck.reason}`,
            };
          }
        }
      } catch {
        // Rate limit check failures are non-fatal — allow the call
      }

      // Skip clawforce tools — they already run through withPolicyCheck()
      if (event.toolName.startsWith("clawforce_") || event.toolName === "memory_search" || event.toolName === "memory_get") {
        return;
      }

      const result = enforceToolPolicy(
        {
          projectId: entry.projectId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          toolName: event.toolName,
        },
        event.params ?? {},
      );

      if (!result.allowed) {
        return {
          block: true,
          blockReason: `Clawforce policy: ${result.reason}`,
        };
      }

      // --- Tool gates: block MCP/external tools that require approval ---
      const extConfig = getExtendedProjectConfig(entry.projectId);
      const gate = extConfig?.toolGates?.[event.toolName];
      if (gate) {
        // Record hit for bulk detection (always, even if pre-approved)
        recordToolGateHit(entry.projectId, ctx.agentId, gate.category);

        // Determine effective tier (may be escalated by bulk detection)
        const { tier: effectiveTier, bulkEscalated } = getEffectiveTier(
          entry.projectId, ctx.agentId, gate.category,
          gate.tier, extConfig.bulkThresholds,
        );

        // Determine gate action: explicit override on gate entry, or from risk tier policies
        const riskConfig = getRiskConfig(extConfig.riskTiers);
        const gateAction = gate.gate
          ?? riskConfig.policies[effectiveTier]?.gate
          ?? "approval";

        // "none" → allow without approval
        if (gateAction === "none") return;

        // "delay" → allow (delay is informational for tool gates — actual delay handled at dispatch level)
        if (gateAction === "delay") return;

        // Check pre-approvals first (fast path for re-dispatched tasks)
        const session = ctx.sessionKey ? getSession(ctx.sessionKey) : null;
        const taskId = session?.dispatchContext?.taskId;
        if (taskId && checkPreApproval({ projectId: entry.projectId, taskId, toolName: event.toolName })) {
          consumePreApproval({ projectId: entry.projectId, taskId, toolName: event.toolName });
          return; // pre-approved, allow
        }

        // "human_approval" → block entirely (no proposal, requires config change)
        if (gateAction === "human_approval") {
          return {
            block: true,
            blockReason: `Clawforce: ${gate.category} is blocked (risk: ${effectiveTier}, gate: human_approval). Requires configuration change to allow.`,
          };
        }

        // "confirm" or "approval" → create proposal + intent, block the call
        const isConfirm = gateAction === "confirm";
        const titlePrefix = isConfirm ? "Confirm" : "Tool gate";
        const bulkNote = bulkEscalated ? ` [bulk escalated from ${gate.tier}]` : "";

        try {
          const proposalId = crypto.randomUUID();
          const db = getDb(entry.projectId);
          db.prepare(`
            INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(
            proposalId, entry.projectId,
            `${titlePrefix}: ${gate.category} (${effectiveTier})${bulkNote}`,
            `${event.toolName} call requires ${isConfirm ? "confirmation" : "approval"}`,
            ctx.agentId, effectiveTier, Date.now(),
          );

          // Persist the intent for re-dispatch on approval
          persistToolCallIntent({
            proposalId,
            projectId: entry.projectId,
            agentId: ctx.agentId,
            taskId,
            toolName: event.toolName,
            toolParams: (event.params ?? {}) as Record<string, unknown>,
            category: gate.category,
            riskTier: effectiveTier,
          }, db);

          // Notify via channel (async, non-blocking)
          getApprovalNotifier()?.sendProposalNotification({
            proposalId,
            projectId: entry.projectId,
            title: `${titlePrefix}: ${gate.category} (${effectiveTier})${bulkNote}`,
            description: `${event.toolName} call requires ${isConfirm ? "confirmation" : "approval"}`,
            proposedBy: ctx.agentId,
            riskTier: effectiveTier,
            toolContext: { toolName: event.toolName, category: gate.category, taskId },
          }).catch(() => { /* non-fatal */ });

          // Emit proposal_created event
          try {
            const { ingestEvent } = await import("../src/events/store.js");
            ingestEvent(entry.projectId, "proposal_created", "internal", {
              proposalId,
              proposedBy: ctx.agentId,
              riskTier: effectiveTier,
              title: `${titlePrefix}: ${gate.category} (${effectiveTier})${bulkNote}`,
              toolName: event.toolName,
              bulkEscalated,
            }, `proposal-created:${proposalId}`, db);
          } catch { /* non-fatal */ }

          return {
            block: true,
            blockReason: `Clawforce: ${gate.category} requires ${isConfirm ? "confirmation" : "approval"} (risk: ${effectiveTier}${bulkNote}). Proposal ${proposalId} created.`,
          };
        } catch (err) {
          api.logger.warn(`Clawforce: tool gate error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // --- Compliance enforcement at agent_end ---
    api.on("agent_end", async (event, ctx) => {
      if (!ctx.sessionKey) return;

      // SSE: notify dashboard that agent session ended
      if (ctx.agentId) {
        const agentEntry = getAgentConfig(ctx.agentId);
        if (agentEntry) {
          emitSSE(agentEntry.projectId, "agent:status", {
            agentId: ctx.agentId,
            status: "idle",
            sessionKey: ctx.sessionKey,
          });
        }
      }

      // --- Compliance check ---
      const session = endSession(ctx.sessionKey);

      // Clean up session state
      clearCooldown(ctx.sessionKey);
      clearAssemblerCache(ctx.sessionKey);
      clearRateLimitSession(ctx.sessionKey);
      memoryModeStore.delete(ctx.sessionKey);
      sessionTurnCountStore.delete(ctx.sessionKey);

      // --- Meeting turn advancement ---
      const meetingCtx = meetingSessionStore.get(ctx.sessionKey);
      if (meetingCtx) {
        meetingSessionStore.delete(ctx.sessionKey);
        try {
          const result = advanceMeetingTurn(meetingCtx.projectId, meetingCtx.channelId);
          if (result.done) {
            concludeMeeting(meetingCtx.projectId, meetingCtx.channelId, "system");
            api.logger.info(`Clawforce: meeting concluded in channel ${meetingCtx.channelId}`);
          } else {
            api.logger.info(`Clawforce: meeting advanced to turn ${result.turnIndex} (${result.nextAgent})`);
          }
        } catch (err) {
          api.logger.warn(`Clawforce: meeting turn advance failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- Memory persist rules (session_end trigger) ---
      if (ctx.agentId) {
        const persistEntry = getAgentConfig(ctx.agentId);
        if (persistEntry) {
          try {
            const { shouldPersistMemory, getExtractionPrompt } = await import("../src/memory/persist.js");
            const matchingRules = shouldPersistMemory("session_end", persistEntry.config);
            if (matchingRules.length > 0) {
              const prompts = matchingRules.map((rule) => getExtractionPrompt(rule, persistEntry.config));
              // TODO: When MCP memory provider is active, call MCP server's retain/store tool.
              // For now, emit a diagnostic event with the extraction prompts for downstream consumers.
              emitDiagnosticEvent({
                type: "memory_persist_triggered",
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
                trigger: "session_end",
                ruleCount: matchingRules.length,
                prompts,
              });
            }
          } catch (err) {
            // Non-critical — don't let persist logic break session cleanup
            api.logger.warn(`Clawforce: memory persist error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (!session) return; // Not an enforced agent

      // --- Auto-lifecycle: evidence capture + transition for dispatched sessions ---
      // Fallback: if before_prompt_build didn't detect the dispatch tag (e.g. CLI spawn
      // where event.messages was empty on first turn), try detecting it from messages now.
      if (!session.dispatchContext) {
        const endMsgs = (event as { messages?: Array<{ role: string; content: unknown }> }).messages;
        if (endMsgs) {
          for (const m of endMsgs) {
            if (m.role !== "user") continue;
            let text: string | undefined;
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content)) {
              text = (m.content as Array<{ type?: string; text?: string }>)
                .filter(p => p.type === "text" && typeof p.text === "string")
                .map(p => p.text).join("\n");
            }
            if (text) {
              const ctx2 = resolveDispatchContext(text);
              if (ctx2) {
                setDispatchContext(ctx.sessionKey, ctx2);
                session.dispatchContext = ctx2;
                break;
              }
            }
          }
        }
      }
      if (session.dispatchContext) {
        const { queueItemId, taskId } = session.dispatchContext;
        const db = getDb(session.projectId);
        const task = getTask(session.projectId, taskId, db);
        const endLifecycleCfg = getEffectiveLifecycleConfig(session.projectId);

        // Release task lease BEFORE transitions — the lease holder (dispatch:<id>)
        // differs from the worker's actor identity, causing lease conflict rejections.
        try {
          releaseTaskLease(session.projectId, taskId, `dispatch:${queueItemId}`, db);
        } catch { /* non-fatal */ }

        // Auto-capture evidence and transition for tasks still in work states
        if (task && (task.state === "IN_PROGRESS" || task.state === "ASSIGNED")) {
          // Extract last assistant message from transcript
          const messages = (event as Record<string, unknown>).messages as Array<{ role: string; content: unknown }> | undefined ?? [];
          const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
          const lastText = lastAssistant?.content ?? "";
          const lastMessage = typeof lastText === "string" ? lastText : JSON.stringify(lastText);

          // Build evidence from buffered tool outputs + last message
          if (endLifecycleCfg.autoCaptureEvidence) {
            const parts: string[] = [];
            if (session.metrics.significantResults.length > 0) {
              parts.push("## Tool Outputs\n");
              for (const r of session.metrics.significantResults) {
                parts.push(`### ${r.toolName}${r.action ? ` (${r.action})` : ""}\n\`\`\`\n${r.resultPreview}\n\`\`\``);
              }
            }
            if (lastMessage.trim()) {
              parts.push(`\n## Agent Summary\n${lastMessage.slice(0, 3000)}`);
            }

            const evidence = parts.join("\n") || "Session completed with no captured output.";

            // Auto-attach evidence
            try {
              attachEvidence({ projectId: session.projectId, taskId, type: "output", content: evidence, attachedBy: session.agentId }, db);
            } catch { /* non-fatal */ }
          }

          // Run verification gates if configured
          const verificationResult = (() => {
            try {
              const { runVerificationIfConfigured } = require("../src/verification/lifecycle.js") as typeof import("../src/verification/lifecycle.js");
              const cfAgentEntry = getAgentConfig(session.agentId);
              const projectDir = cfAgentEntry?.projectDir ?? resolveProjectDir(session.projectId);
              return runVerificationIfConfigured(session.projectId, projectDir);
            } catch { return null; }
          })();

          // Attach gate results as evidence
          if (verificationResult) {
            try {
              attachEvidence({
                projectId: session.projectId,
                taskId,
                type: "test_result",
                content: verificationResult.formatted,
                attachedBy: "system:verification",
              }, db);
            } catch { /* non-fatal */ }
          }

          // Auto-transition based on session outcome + verification gates
          if (endLifecycleCfg.autoTransitionOnComplete) {
            try {
              // If still ASSIGNED (before_prompt_build didn't transition), step through IN_PROGRESS first
              const currentTask = getTask(session.projectId, taskId, db);
              if (currentTask?.state === "ASSIGNED") {
                transitionTask({ projectId: session.projectId, taskId, toState: "IN_PROGRESS", actor: session.agentId }, db);
              }

              const targetState = (session.metrics.toolCalls.length === 0)
                ? "FAILED" as const
                : (session.metrics.errorCount > session.metrics.toolCalls.length * 0.5)
                  ? "FAILED" as const
                  : (verificationResult && !verificationResult.result.allRequiredPassed)
                    ? "FAILED" as const
                    : "REVIEW" as const;
              transitionTask({ projectId: session.projectId, taskId, toState: targetState, actor: session.agentId }, db);
            } catch (err) {
              api.logger.warn(`Clawforce: auto-transition failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Immediate event processing for manager dispatch
          if (endLifecycleCfg.immediateReviewDispatch) {
            try {
              const { processEvents } = await import("../src/events/router.js");
              processEvents(session.projectId, db);
            } catch { /* non-fatal */ }
          }
        }

        // Dispatch queue completion handling
        try {
          const queueDb = getDb(session.projectId);
          const updatedTask = getTask(session.projectId, taskId, queueDb);

          if (updatedTask && updatedTask.state !== "ASSIGNED" && updatedTask.state !== "IN_PROGRESS") {
            // Task advanced — dispatch succeeded
            completeItem(queueItemId, queueDb, session.projectId);
            emitDiagnosticEvent({ type: "dispatch_session_succeeded", sessionKey: ctx.sessionKey, queueItemId, taskId, finalState: updatedTask.state });
          } else {
            // Task stuck — dispatch failed
            const reason = `Task remained in ${updatedTask?.state ?? "unknown"} after dispatch session`;
            failItem(queueItemId, reason, queueDb, session.projectId);
            emitDiagnosticEvent({ type: "dispatch_session_failed", sessionKey: ctx.sessionKey, queueItemId, taskId, reason });
          }

          // Release the task lease acquired by the dispatcher
          releaseTaskLease(session.projectId, taskId, `dispatch:${queueItemId}`, queueDb);
        } catch (err) {
          api.logger.warn(`Clawforce: dispatch completion handling failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const result = checkCompliance(session);

      // Telemetry: flush tool call details and archive session
      try {
        const { flushToolCallDetails } = await import("../src/telemetry/tool-capture.js");
        const { archiveSession } = await import("../src/telemetry/session-archive.js");
        const db = getDb(session.projectId);
        const taskId = session.dispatchContext?.taskId;

        // Flush buffered tool call details to persistent storage
        flushToolCallDetails(
          ctx.sessionKey,
          session.projectId,
          session.agentId,
          session.metrics.toolCallBuffer,
          taskId,
          db,
        );

        // Aggregate cost from cost_records for this session
        const costRow = db.prepare(
          `SELECT COALESCE(SUM(cost_cents), 0) as total,
                  COALESCE(SUM(input_tokens), 0) as inputTokens,
                  COALESCE(SUM(output_tokens), 0) as outputTokens
           FROM cost_records WHERE project_id = ? AND session_key = ?`
        ).get(session.projectId, ctx.sessionKey) as { total: number; inputTokens: number; outputTokens: number } | undefined;

        // Archive the completed session
        const messages = (event as Record<string, unknown>).messages as unknown[] | undefined;
        archiveSession({
          sessionKey: ctx.sessionKey,
          agentId: session.agentId,
          projectId: session.projectId,
          transcript: messages ? JSON.stringify(messages) : undefined,
          outcome: result.compliant ? "compliant" : "non_compliant",
          exitSignal: (event as Record<string, unknown>).success ? "success" : "error",
          complianceDetail: JSON.stringify(result),
          toolCallCount: session.metrics.toolCalls.length,
          errorCount: session.metrics.errorCount,
          startedAt: session.metrics.startedAt,
          endedAt: Date.now(),
          taskId,
          jobName: session.jobName,
          totalCostCents: costRow?.total ?? 0,
          totalInputTokens: costRow?.inputTokens ?? 0,
          totalOutputTokens: costRow?.outputTokens ?? 0,
        }, db);
      } catch { /* telemetry must never break the main flow */ }

      if (result.compliant) {
        recordCompliantRun(result);
        api.logger.info(`Clawforce: ${session.agentId} session compliant`);

        // Continuous job re-dispatch: if this was a continuous job, start the next cycle
        if (session.jobName) {
          const agentEntryForRedispatch = getAgentConfig(session.agentId);
          if (agentEntryForRedispatch) {
            const jobDef = agentEntryForRedispatch.config.jobs?.[session.jobName];
            if (jobDef?.continuous) {
              await redispatchContinuousJob(session, jobDef, api);
            }
          }
        }

        return;
      }

      // Non-compliant — execute failure action
      const agentEntry = getAgentConfig(session.agentId);
      if (!agentEntry) return;

      const actionResult = executeFailureAction(
        session.performancePolicy ?? agentEntry.config.performance_policy,
        result,
      );

      api.logger.warn(
        `Clawforce: ${session.agentId} non-compliant — action: ${actionResult.action}`,
      );

      // Retry: re-inject the compliance prompt with exponential backoff
      if (actionResult.action === "retry" && actionResult.retryPrompt) {
        try {
          const safetyConfig = getSafetyConfig(session.projectId);
          const backoffConfig: BackoffConfig = {
            baseDelayMs: safetyConfig.retryBackoffBaseMs,
            maxDelayMs: safetyConfig.retryBackoffMaxMs,
          };
          const retryCount = countRecentRetries(session.projectId, session.agentId);
          const delayMs = calculateBackoffDelay(retryCount, backoffConfig);
          api.logger.info(
            `Clawforce: retry ${session.agentId} with ${Math.round(delayMs / 1000)}s backoff (attempt ${retryCount + 1})`,
          );
          emitDiagnosticEvent({
            type: "retry_backoff",
            agentId: session.agentId,
            projectId: session.projectId,
            retryCount,
            delayMs,
          });
          const retryPrompt = actionResult.retryPrompt;
          const retrySessionKey = ctx.sessionKey;
          setTimeout(async () => {
            try {
              await cliInjectMessage({
                sessionKey: retrySessionKey,
                message: retryPrompt,
              });
            } catch (err) {
              api.logger.warn(
                `Clawforce: retry inject failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }, delayMs);
        } catch (err) {
          api.logger.warn(
            `Clawforce: retry backoff failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // Disable agent if action requires it
      if (actionResult.disabled) {
        await handleDisable(session.agentId);
      }

      // H9: Escalation with error boundary
      if (actionResult.alertMessage) {
        try {
          const target = resolveEscalationTarget(agentEntry.config);
          await routeEscalation({
            injectAgentMessage: cliInjectMessage,
            target,
            message: actionResult.alertMessage,
            sourceAgentId: session.agentId,
            projectId: session.projectId,
            logger: api.logger,
          });
        } catch (err) {
          api.logger.warn(`Clawforce: escalation failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- Continuous job re-dispatch ---
      // If the agent's current job is marked continuous, immediately re-dispatch.
      if (session.jobName) {
        const cfAgentEntry = getAgentConfig(session.agentId);
        if (cfAgentEntry) {
          const jobDef = cfAgentEntry.config.jobs?.[session.jobName];
          if (jobDef?.continuous) {
            await redispatchContinuousJob(session, jobDef, api);
          }
        }
      }
    });

    // --- Auto-capture costs via llm_output + hard budget enforcement ---
    api.on("llm_output", async (event, ctx) => {
      if (!ctx.agentId || !ctx.sessionKey) return;

      const entry = getAgentConfig(ctx.agentId);
      if (!entry) return;

      // Resolve task ID from tracked session dispatch context
      const session = getSession(ctx.sessionKey);
      const taskId = session?.dispatchContext?.taskId;

      try {
        recordCostFromLlmOutput({
          projectId: entry.projectId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          taskId,
          provider: event.provider,
          model: event.model,
          usage: event.usage ?? {},
        });
        // SSE: notify dashboard of cost/budget updates
        emitSSE(entry.projectId, "budget:update", {
          projectId: entry.projectId,
          agentId: ctx.agentId,
          provider: event.provider,
          model: event.model,
        });
      } catch (err) {
        api.logger.warn(`Clawforce: cost capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Hard budget enforcement: kill session immediately if over budget.
      // This is a stopgap — ideally a before_llm hook would prevent the call entirely.
      try {
        const budgetResult = checkBudget({
          projectId: entry.projectId,
          agentId: ctx.agentId,
          taskId,
          sessionKey: ctx.sessionKey,
        });
        if (!budgetResult.ok) {
          api.logger.warn(`Clawforce: budget exceeded for ${ctx.agentId} (${ctx.sessionKey}) — killing session. Reason: ${budgetResult.reason}`);
          await killStuckAgent({
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            projectId: entry.projectId,
            runtimeMs: 0,
            lastToolCallMs: null,
            requiredCallsMade: 0,
            requiredCallsTotal: 0,
            reason: `Budget exceeded: ${budgetResult.reason}`,
          });
        }
      } catch (err) {
        api.logger.warn(`Clawforce: budget enforcement check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // --- Tool registration ---

    /**
     * Filter a tool's schema to only expose allowed actions.
     * Deep-clones parameters to avoid mutating shared module-level constants.
     */
    function filterToolSchema(
      tool: ReturnType<typeof adaptTool>,
      allowedActions: string[] | "*",
    ): ReturnType<typeof adaptTool> {
      if (allowedActions === "*") return tool;
      if (!tool.parameters) return tool;

      // Deep-clone parameters to avoid mutating shared schemas
      const params = JSON.parse(JSON.stringify(tool.parameters));
      let removedActions: string[] = [];
      if (params?.properties?.action?.enum) {
        const original = params.properties.action.enum as string[];
        const filtered = original.filter((a: string) => allowedActions.includes(a));
        removedActions = original.filter((a: string) => !allowedActions.includes(a));
        params.properties.action.enum = filtered;
      }

      // Strip removed action references from descriptions
      let description = tool.description;
      if (removedActions.length > 0 && description) {
        description = stripRemovedActionReferences(description, removedActions);
        // Also strip from property descriptions
        if (params?.properties) {
          for (const prop of Object.values(params.properties) as Array<Record<string, unknown>>) {
            if (typeof prop.description === "string") {
              prop.description = stripRemovedActionReferences(prop.description, removedActions);
            }
          }
        }
      }

      return { ...tool, description, parameters: params };
    }

    /**
     * Remove references to removed actions from a description string.
     * Handles patterns like "action_name: description," and "action_name" mentions.
     */
    function stripRemovedActionReferences(text: string, removedActions: string[]): string {
      let result = text;
      for (const action of removedActions) {
        // Remove "action_name: description." or "action_name: description," patterns
        result = result.replace(new RegExp(`\\b${action}:\\s*[^.,;]*[.,;]?\\s*`, "g"), "");
        // Remove "action_name, " or ", action_name" in comma-separated lists
        result = result.replace(new RegExp(`,?\\s*\\b${action}\\b\\s*,?`, "g"), (match) => {
          // If match has commas on both sides, keep one comma
          return match.startsWith(",") && match.endsWith(",") ? "," : "";
        });
      }
      // Clean up double spaces and trailing punctuation artifacts
      result = result.replace(/\s{2,}/g, " ").replace(/,\s*\./g, ".").trim();
      return result;
    }

    /**
     * Create a scoped tool factory that handles:
     * 1. Registration filtering (returns null if tool not in scope → hidden)
     * 2. Schema filtering (prunes action enum to allowed actions)
     * 3. Policy wrapping (runtime enforcement as safety net)
     */
    function scopedToolFactory(
      toolName: string,
      createToolFn: (ctx: { agentId?: string; sessionKey?: string }) => ReturnType<typeof adaptTool>,
    ): (ctx: { agentId?: string; sessionKey?: string }) => ReturnType<typeof adaptTool> | null {
      return (ctx) => {
        // Resolve scope — always returns a scope (UNREGISTERED_SCOPE for unknown agents)
        const scope = ctx.agentId ? resolveEffectiveScope(ctx.agentId) : null;

        if (scope) {
          const allowedActions = getAllowedActionsForTool(scope, toolName);
          // Tool not in scope → hidden from this agent
          if (allowedActions === null) return null;

          // Create the tool, then filter schema and wrap with policy
          const tool = createToolFn(ctx);
          const filtered = filterToolSchema(tool, allowedActions);
          return wrapWithPolicy(filtered, toolName, ctx);
        }

        // No agentId provided — create tool and wrap with policy
        const tool = createToolFn(ctx);
        return wrapWithPolicy(tool, toolName, ctx);
      };
    }

    // Helper to wrap tool with policy enforcement when agent has an associated project
    function wrapWithPolicy(
      tool: ReturnType<typeof adaptTool>,
      toolName: string,
      ctx: { agentId?: string; sessionKey?: string },
    ): ReturnType<typeof adaptTool> {
      const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
      if (!agentEntry) return tool;

      // H6: Capture original execute once, build chain without mutating tool in-place
      const originalExecute = tool.execute.bind(tool) as (...args: unknown[]) => Promise<ToolResult>;
      const disabledCheckedExecute = async (...args: unknown[]): Promise<ToolResult> => {
        // Hard-block disabled agents from executing any tool
        if (ctx.agentId && isAgentEffectivelyDisabled(agentEntry.projectId, ctx.agentId)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "Agent is disabled by Clawforce. No tool calls are permitted." }) }],
            details: null,
          };
        }
        return originalExecute(...args);
      };

      // Apply policy enforcement on top of disabled check
      const policyWrappedExecute = withPolicyCheck(disabledCheckedExecute, {
        projectId: agentEntry.projectId,
        agentId: ctx.agentId!,
        sessionKey: ctx.sessionKey,
        toolName,
      });

      return { ...tool, execute: policyWrappedExecute };
    }

    api.registerTool(
      scopedToolFactory("clawforce_task", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceTaskTool({
          agentSessionKey: ctx.sessionKey,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_task" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_log", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceLogTool({
          agentSessionKey: ctx.sessionKey,
          agentId: agentEntry ? ctx.agentId! : ctx.sessionKey,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_log" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_verify", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceVerifyTool({
          agentSessionKey: ctx.sessionKey,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_verify" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_workflow", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceWorkflowTool({
          agentSessionKey: ctx.sessionKey,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_workflow" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_setup", (ctx) =>
        adaptTool(createClawforceSetupTool({
          projectsDir: cfg.projectsDir,
          agentId: ctx.agentId ?? undefined,
        })),
      ),
      { name: "clawforce_setup" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_compact", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        const projectDir = agentEntry?.projectDir;
        if (!projectDir) {
          return adaptTool({
            label: "Clawforce Compact",
            name: "clawforce_compact",
            description: "Session compaction tool (requires project configuration).",
            parameters: {},
            execute: async () => ({
              content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "No project directory configured for this agent." }) }],
              details: null,
            }),
          });
        }
        return adaptTool(createClawforceCompactTool({
          projectDir,
          agentSessionKey: ctx.sessionKey,
          agentId: ctx.agentId ?? undefined,
        }));
      }),
      { name: "clawforce_compact" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_ops", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceOpsTool({
          agentSessionKey: ctx.sessionKey,
          projectId: agentEntry?.projectId,
          projectDir: agentEntry?.projectDir,
        }));
      }),
      { name: "clawforce_ops" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_context", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceContextTool({
          agentSessionKey: ctx.sessionKey,
          agentId: ctx.agentId ?? undefined,
          projectId: agentEntry?.projectId,
          projectDir: agentEntry?.projectDir,
        }));
      }),
      { name: "clawforce_context" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_message", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceMessageTool({
          agentSessionKey: ctx.sessionKey,
          agentId: ctx.agentId ?? undefined,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_message" },
    );

    api.registerTool(
      scopedToolFactory("clawforce_channel", (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        return adaptTool(createClawforceChannelTool({
          agentSessionKey: ctx.sessionKey,
          projectId: agentEntry?.projectId,
        }));
      }),
      { name: "clawforce_channel" },
    );

    // --- OpenClaw RAG memory tools ---
    // Lazy-import factories from OpenClaw's internal memory tool module.
    let _createMemorySearchTool: MemoryToolFactory | null | undefined;
    let _createMemoryGetTool: MemoryToolFactory | null | undefined;

    async function loadMemoryFactories(): Promise<void> {
      if (_createMemorySearchTool !== undefined) return; // already attempted
      try {
        // Use variable to prevent Vite from statically analyzing the import path
        const memoryModPath = "openclaw/dist/plugin-sdk/agents/tools/memory-tool.js";
        const mod = await import(/* @vite-ignore */ memoryModPath) as Record<string, unknown>;
        _createMemorySearchTool = (mod.createMemorySearchTool as MemoryToolFactory) ?? null;
        _createMemoryGetTool = (mod.createMemoryGetTool as MemoryToolFactory) ?? null;
      } catch {
        _createMemorySearchTool = null;
        _createMemoryGetTool = null;
      }
    }

    // H8: Memory factories are loaded in the gateway_start service below, not fire-and-forget

    function memoryNotConfiguredTool(name: string): ReturnType<typeof adaptTool> {
      return adaptTool({
        label: name === "memory_search" ? "Memory Search" : "Memory Get",
        name,
        description: `OpenClaw RAG memory tool (not configured). Ensure OpenClaw memory is enabled in your project settings.`,
        parameters: {},
        execute: async () => ({
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "OpenClaw memory is not configured for this environment." }) }],
          details: null,
        }),
      });
    }

    function adaptMemoryTool(raw: Record<string, unknown>): ReturnType<typeof adaptTool> {
      // Ensure label is present (OpenClaw tools may omit it)
      const tool = {
        label: (raw.label as string) ?? (raw.name as string) ?? "Memory",
        name: raw.name as string,
        description: raw.description as string,
        parameters: raw.parameters,
        execute: raw.execute as (...args: unknown[]) => Promise<ToolResult>,
      };
      return adaptTool(tool);
    }

    // memory_search — OpenClaw RAG semantic search
    api.registerTool(
      scopedToolFactory("memory_search", (ctx) => {
        if (!_createMemorySearchTool) return memoryNotConfiguredTool("memory_search");
        const tool = _createMemorySearchTool({ agentSessionKey: ctx.sessionKey });
        if (!tool) return memoryNotConfiguredTool("memory_search");
        return adaptMemoryTool(tool);
      }),
      { name: "memory_search" },
    );

    // memory_get — OpenClaw RAG memory retrieval
    api.registerTool(
      scopedToolFactory("memory_get", (ctx) => {
        if (!_createMemoryGetTool) return memoryNotConfiguredTool("memory_get");
        const tool = _createMemoryGetTool({ agentSessionKey: ctx.sessionKey });
        if (!tool) return memoryNotConfiguredTool("memory_get");
        return adaptMemoryTool(tool);
      }),
      { name: "memory_get" },
    );

    // --- Gateway methods: kill + channel ---
    // Gateway method to bootstrap kill + channel APIs — invoked lazily on first gateway call
    api.registerGatewayMethod("clawforce.init", async ({ context, respond }) => {
      // Capture kill function from abort controllers
      if (context.chatAbortControllers) {
        registerKillFunction(async (sessionKey, reason) => {
          for (const [runId, entry] of context.chatAbortControllers) {
            if (entry.sessionKey === sessionKey) {
              entry.controller.abort();
              context.chatAbortControllers.delete(runId);
              api.logger.info(`Clawforce: killed session ${sessionKey} — ${reason}`);
              return true;
            }
          }
          return false;
        });
      }

      // Capture channel APIs for delivery and notifications
      const channelApis = api.runtime?.channel;
      if (channelApis?.telegram?.sendMessageTelegram) {
        const sendTelegram = channelApis.telegram.sendMessageTelegram;

        // Wire unified delivery adapter
        setDeliveryAdapter({
          send: async (channel, content, target, options) => {
            switch (channel) {
              case "telegram": {
                if (!sendTelegram) return { sent: false, error: "Telegram not configured" };
                try {
                  const sendOpts: Record<string, unknown> = {
                    textMode: options?.format ?? "markdown",
                  };
                  if (options?.buttons) sendOpts.buttons = options.buttons;
                  if (target.threadId) sendOpts.messageThreadId = Number(target.threadId);
                  const result = await sendTelegram(
                    String(target.chatId ?? ""),
                    content,
                    sendOpts as never,
                  );
                  return { sent: !!result, messageId: result?.messageId };
                } catch (err) {
                  return { sent: false, error: err instanceof Error ? err.message : String(err) };
                }
              }
              default:
                return { sent: false, error: `Unsupported channel: ${channel}` };
            }
          },
        });
        api.logger.info("Clawforce: unified delivery adapter configured (Telegram)");

        const notifier: ApprovalNotifier = {
          async sendProposalNotification(payload: NotificationPayload) {
            const channel = resolveApprovalChannel(payload.projectId, payload.proposedBy);
            if (channel.channel !== "telegram") {
              return { sent: false, channel: channel.channel };
            }

            const target = channel.target;
            if (!target) {
              return { sent: false, channel: "telegram", error: "No Telegram target configured" };
            }

            try {
              const message = formatTelegramMessage(payload);
              const buttons = buildApprovalButtons(payload.projectId, payload.proposalId);
              const result = await sendTelegram(target, message, {
                textMode: "markdown",
                buttons,
                messageThreadId: channel.threadId,
              });

              // Store notification_message_id for audit trail
              try {
                const db = getDb(payload.projectId);
                db.prepare(
                  "UPDATE proposals SET notification_message_id = ?, channel = 'telegram' WHERE id = ? AND project_id = ?",
                ).run(result.messageId, payload.proposalId, payload.projectId);
              } catch { /* non-fatal */ }

              return { sent: true, channel: "telegram", messageId: result.messageId };
            } catch (err) {
              api.logger.warn(`Clawforce: failed to send Telegram notification: ${err instanceof Error ? err.message : String(err)}`);
              return { sent: false, channel: "telegram", error: err instanceof Error ? err.message : String(err) };
            }
          },

          async editProposalMessage(_proposalId, _projectId, _resolution, _feedback) {
            // Message editing requires editMessageTelegram which isn't on the runtime channel API.
            // Resolution is communicated via the callback response to the user.
          },
        };

        setApprovalNotifier(notifier);
        api.logger.info("Clawforce: approval notifier configured (Telegram)");

        // Wire message notifier using same Telegram channel
        setMessageNotifier({
          async sendMessageNotification(message) {
            try {
              const msgChannel = resolveApprovalChannel(message.projectId, message.toAgent);
              if (msgChannel.channel !== "telegram" || !msgChannel.target) {
                return { sent: false, error: "No Telegram target" };
              }
              const text = formatMessageNotification(message);
              const result = await sendTelegram(msgChannel.target, text, { textMode: "markdown" });
              return { sent: true, messageId: result?.messageId };
            } catch (err) {
              return { sent: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
        });
        api.logger.info("Clawforce: message notifier configured (Telegram)");

        // Wire channel notifier for Telegram mirroring
        setChannelNotifier({
          async sendChannelNotification({ channel, message }) {
            const telegramGroupId = (channel.metadata as Record<string, unknown> | undefined)?.telegramGroupId as string | undefined;
            if (!telegramGroupId) return { sent: false, error: "No Telegram group configured" };

            try {
              const text = formatChannelMessage(channel, message);
              const telegramThreadId = (channel.metadata as Record<string, unknown> | undefined)?.telegramThreadId as number | undefined;
              const result = await sendTelegram(telegramGroupId, text, {
                textMode: "markdown",
                ...(telegramThreadId ? { messageThreadId: telegramThreadId } : {}),
              });
              return { sent: true };
            } catch (err) {
              return { sent: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
        });
        api.logger.info("Clawforce: channel notifier configured (Telegram)");
      }

      // Wire cron service for dispatch
      if (context.cron) {
        setCronService({
          add: async (input) => context.cron.add(input),
          list: async (opts) => context.cron.list ? context.cron.list(opts) : [],
          update: async (id, patch) => context.cron.update ? context.cron.update(id, patch) : undefined,
          remove: async (id) => context.cron.remove ? context.cron.remove(id) : undefined,
          run: async (id) => context.cron.run ? context.cron.run(id) : undefined,
        });
        api.logger.info("Clawforce: cron service wired for dispatch");
      }

      respond(true);
    });

    // --- Bootstrap gateway method ---
    // Eagerly captures context.cron so getCronService() works everywhere in-process.
    // Called once at gateway_start via WebSocket RPC.
    api.registerGatewayMethod("clawforce.bootstrap", async ({ context, respond }) => {
      try {
        if (context.cron && !getCronService()) {
          setCronService({
            add: async (input) => context.cron.add(input),
            list: async (opts) => context.cron.list ? context.cron.list(opts) : [],
            update: async (id, patch) => context.cron.update ? context.cron.update(id, patch) : undefined,
            remove: async (id) => context.cron.remove ? context.cron.remove(id) : undefined,
            run: async (id) => context.cron.run ? context.cron.run(id) : undefined,
          });
          api.logger.info("Clawforce: cron service bootstrapped");
        }
        respond(true);
      } catch (err) {
        api.logger.warn(`Clawforce bootstrap error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        respond(false, undefined, { code: "BOOTSTRAP_ERROR", message: String(err) });
      }
    });

    // --- Dispatch gateway method ---
    // Creates a one-shot cron job to dispatch an agent session.
    // Also defensively captures cron if bootstrap hasn't run yet.
    api.registerGatewayMethod("clawforce.dispatch", async ({ params, context, respond }) => {
      // Defensive: capture cron if bootstrap hasn't fired
      if (context.cron && !getCronService()) {
        setCronService({
          add: async (input) => context.cron.add(input),
          list: async (opts) => context.cron.list ? context.cron.list(opts) : [],
          update: async (id, patch) => context.cron.update ? context.cron.update(id, patch) : undefined,
          remove: async (id) => context.cron.remove ? context.cron.remove(id) : undefined,
          run: async (id) => context.cron.run ? context.cron.run(id) : undefined,
        });
      }
      const { agentId, message, sessionTarget, deleteAfterRun } = params as {
        agentId: string;
        message: string;
        sessionTarget?: string;
        deleteAfterRun?: boolean;
      };
      if (!agentId || !message) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "agentId and message required" });
        return;
      }
      if (!context.cron) {
        respond(false, undefined, { code: "UNAVAILABLE", message: "cron service not available" });
        return;
      }
      try {
        const jobName = `clawforce-dispatch:${Date.now()}`;
        await context.cron.add({
          name: jobName,
          agentId,
          enabled: true,
          schedule: { kind: "at", at: new Date().toISOString() },
          sessionTarget: (sessionTarget ?? "isolated") as "isolated" | "main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message },
          deleteAfterRun: deleteAfterRun !== false,
        });
        respond(true, { ok: true, jobName });
      } catch (err) {
        respond(false, undefined, { code: "DISPATCH_FAILED", message: err instanceof Error ? err.message : String(err) });
      }
    });

    // --- Approval callback gateway method ---
    api.registerGatewayMethod("clawforce.approval_callback", async ({ params, respond }) => {
      const { action, projectId, proposalId, feedback } = params as {
        action: "approve" | "reject";
        projectId: string;
        proposalId: string;
        feedback?: string;
      };

      if (!action || !projectId || !proposalId) {
        respond(false, { error: "Missing required params: action, projectId, proposalId" });
        return;
      }

      try {
        if (action === "approve") {
          const result = approveProposal(projectId, proposalId, feedback);
          respond(!!result, result ? { proposal: { id: result.id, status: result.status } } : { error: "Not found or already resolved" });
        } else {
          const result = rejectProposal(projectId, proposalId, feedback);
          respond(!!result, result ? { proposal: { id: result.id, status: result.status } } : { error: "Not found or already resolved" });
        }
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // --- Kill sessions gateway method ---
    // Aborts all active ClawForce agent sessions via gateway AbortController.
    // Called by `cf kill` to immediately stop running agents without killing the gateway.
    api.registerGatewayMethod("clawforce.kill", async ({ params, context, respond }) => {
      const { reason, agents } = params as { projectId?: string; reason?: string; agents?: string[] };
      const killReason = reason ?? "Emergency kill via CLI";
      const targetAgents = agents ?? [];
      let killed = 0;

      // Use the registered kill function (captured from clawforce.init session context).
      // This has access to the actual chatAbortControllers from a session scope.
      const { killStuckAgent: killAgent } = await import("../src/audit/auto-kill.js");

      if (targetAgents.length > 0) {
        for (const agentId of targetAgents) {
          // Build session key patterns this agent might use
          for (const kind of ["main", "cron"]) {
            const sessionKey = `agent:${agentId}:${kind}`;
            try {
              const result = await killAgent({ sessionKey, agentId, reason: killReason } as import("../src/audit/stuck-detector.js").StuckAgent);
              if (result) {
                killed++;
                api.logger.info(`Clawforce: killed ${sessionKey} — ${killReason}`);
              }
            } catch { /* continue */ }
          }
        }
      }

      respond(true, { killed, reason: killReason, method: killed > 0 ? "abort-controller" : "no-active-sessions" });
    });

    // --- Channel message injection gateway method ---
    // API surface for human Telegram messages → channel (gateway wiring is an OpenClaw concern)
    api.registerGatewayMethod("clawforce.inject_channel_message", async ({ params, respond }) => {
      const { projectId, channelId, channelName, content, senderName } = params as {
        projectId: string;
        channelId?: string;
        channelName?: string;
        content: string;
        senderName?: string;
      };

      if (!projectId || !content || (!channelId && !channelName)) {
        respond(false, { error: "Missing required params: projectId, content, and either channelId or channelName" });
        return;
      }

      try {
        const { sendChannelMessage } = await import("../src/channels/messages.js");
        const { getChannel: getChannelById, getChannelByName: getChannelByN } = await import("../src/channels/store.js");

        const channel = channelId
          ? getChannelById(projectId, channelId)
          : getChannelByN(projectId, channelName!);

        if (!channel) {
          respond(false, { error: "Channel not found" });
          return;
        }

        const message = sendChannelMessage({
          fromAgent: senderName ?? "human",
          channelId: channel.id,
          projectId,
          content,
        });

        respond(true, { messageId: message.id, channelId: channel.id });
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // --- Approval commands ---
    api.registerCommand({
      name: "clawforce-proposals",
      description: "List pending Clawforce proposals",
      acceptsArgs: true,
      handler: (ctx) => {
        const projectIds = ctx.args?.trim()
          ? [ctx.args.trim()]
          : getActiveProjectIds();

        if (projectIds.length === 0) {
          return { text: "No Clawforce projects registered." };
        }

        const lines: string[] = [];
        for (const pid of projectIds) {
          try {
            const proposals = listPendingProposals(pid);
            if (proposals.length === 0) {
              lines.push(`**${pid}**: no pending proposals`);
            } else {
              lines.push(`**${pid}** (${proposals.length} pending):`);
              for (const p of proposals) {
                const age = Math.round((Date.now() - p.created_at) / 60_000);
                lines.push(`  - \`${p.id}\` ${p.title} (${age}m ago, by ${p.proposed_by})`);
              }
            }
          } catch (err) {
            api.logger.warn(`Clawforce: failed to query proposals for ${pid}: ${err instanceof Error ? err.message : String(err)}`);
            lines.push(`**${pid}**: failed to query proposals`);
          }
        }
        return { text: lines.join("\n") };
      },
    });

    api.registerCommand({
      name: "clawforce-approve",
      description: "Approve an Clawforce proposal: /clawforce-approve <proposal_id> (single project) or /clawforce-approve <project_id> <proposal_id> [feedback]",
      acceptsArgs: true,
      handler: (ctx) => {
        const parts = (ctx.args ?? "").trim().split(/\s+/);
        if (parts.length < 1 || !parts[0]) {
          return { text: "Usage: /clawforce-approve <proposal_id> (single project) or /clawforce-approve <project_id> <proposal_id> [feedback]" };
        }
        let projectId: string;
        let proposalId: string;
        let feedback: string | undefined;
        if (parts.length === 1) {
          // Auto-resolve: only works if exactly 1 project is registered
          const activeIds = getActiveProjectIds();
          if (activeIds.length !== 1) {
            return { text: "Usage: /clawforce-approve <project_id> <proposal_id> [feedback] (multiple projects registered — project_id required)" };
          }
          projectId = activeIds[0]!;
          proposalId = parts[0]!;
        } else {
          [projectId, proposalId] = parts as [string, string];
          feedback = parts.length > 2 ? parts.slice(2).join(" ") : undefined;
        }
        try {
          const result = approveProposal(projectId, proposalId, feedback);
          if (!result) return { text: `Proposal \`${proposalId}\` not found or already resolved.` };
          return { text: `Approved proposal \`${proposalId}\` in project ${projectId}.` };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    api.registerCommand({
      name: "clawforce-reject",
      description: "Reject an Clawforce proposal: /clawforce-reject <proposal_id> (single project) or /clawforce-reject <project_id> <proposal_id> [feedback]",
      acceptsArgs: true,
      handler: (ctx) => {
        const parts = (ctx.args ?? "").trim().split(/\s+/);
        if (parts.length < 1 || !parts[0]) {
          return { text: "Usage: /clawforce-reject <proposal_id> (single project) or /clawforce-reject <project_id> <proposal_id> [feedback]" };
        }
        let projectId: string;
        let proposalId: string;
        let feedback: string | undefined;
        if (parts.length === 1) {
          // Auto-resolve: only works if exactly 1 project is registered
          const activeIds = getActiveProjectIds();
          if (activeIds.length !== 1) {
            return { text: "Usage: /clawforce-reject <project_id> <proposal_id> [feedback] (multiple projects registered — project_id required)" };
          }
          projectId = activeIds[0]!;
          proposalId = parts[0]!;
        } else {
          [projectId, proposalId] = parts as [string, string];
          feedback = parts.length > 2 ? parts.slice(2).join(" ") : undefined;
        }
        try {
          const result = rejectProposal(projectId, proposalId, feedback);
          if (!result) return { text: `Proposal \`${proposalId}\` not found or already resolved.` };
          return { text: `Rejected proposal \`${proposalId}\` in project ${projectId}.` };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    // --- Memory mode command ---
    api.registerCommand({
      name: "clawforce-memory",
      description: "Toggle memory mode — maximum context recall on every turn",
      acceptsArgs: true,
      handler: (ctx) => {
        const key = ctx.senderId ?? ctx.from;
        if (!key) return { text: "No active session." };
        const current = memoryModeStore.get(key) ?? false;
        memoryModeStore.set(key, !current);
        return { text: `Memory mode ${!current ? "ON — max intensity recall on every turn" : "OFF — normal recall"}` };
      },
    });

    // --- Dashboard HTTP handler ---
    // Resolve dashboard dist directory — try sibling clawforce-dashboard project first,
    // then fall back to a dashboard/ subdirectory (for bundled/monorepo layouts).
    const dashboardDistCandidates = [
      path.resolve(import.meta.dirname, "../../clawforce-dashboard/dist"),
      path.resolve(import.meta.dirname, "../dashboard/dist"),
    ];
    const resolvedDashboardDir = dashboardDistCandidates.find(d => fs.existsSync(d))
      ?? dashboardDistCandidates[0]!;
    api.logger.info(`Clawforce: dashboard dir candidates: ${JSON.stringify(dashboardDistCandidates)}`);
    api.logger.info(`Clawforce: resolved dashboard dir: ${resolvedDashboardDir} (exists: ${fs.existsSync(resolvedDashboardDir)})`);

    const standaloneHost = process.env.CLAWFORCE_DASHBOARD_HOST ?? "127.0.0.1";
    const standalonePort = process.env.CLAWFORCE_DASHBOARD_PORT
      ? Number(process.env.CLAWFORCE_DASHBOARD_PORT)
      : 3117;

    const dashboardHandler = createDashboardHandler({
      staticDir: resolvedDashboardDir,
      injectAgentMessage: (params) => cliInjectMessage(params),
      runtime: {
        mode: "openclaw-plugin",
        authMode: "openclaw-plugin",
        standaloneCompatibilityServer: cfg.standaloneDashboard,
        ...(cfg.standaloneDashboard
          ? { standaloneUrl: `http://${standaloneHost}:${standalonePort}/clawforce/` }
          : {}),
        notes: [
          "This dashboard route is embedded in OpenClaw and uses OpenClaw plugin authentication.",
          ...(cfg.standaloneDashboard
            ? ["A standalone compatibility server is also enabled for direct browser access outside the OpenClaw Control UI shell."]
            : ["The standalone compatibility server is disabled; use the embedded OpenClaw route."]),
        ],
      },
    });

    api.registerHttpRoute({
      path: "/clawforce",
      auth: "plugin",
      match: "prefix",
      handler: dashboardHandler,
    });

    // --- Standalone dashboard server (port 3117) ---
    // Serves the React SPA + API from a dedicated port, bypassing the
    // gateway's Control UI SPA catch-all that intercepts /clawforce/ paths.
    const dashboardServer = createDashboardServer({
      dashboardDir: resolvedDashboardDir,
      injectAgentMessage: (params) => cliInjectMessage(params),
    });

    // --- Auto-init domains on gateway start (no external clawforce.init call needed) ---
    api.on("gateway_start", async () => {
      api.logger.info("Clawforce: gateway_start hook fired");
      // Simulate what clawforce.init does — initialize domains from config
      const defaultConfigDir = path.join(process.env.HOME ?? "/tmp", ".clawforce");
      try {
        initClawforce({
          enabled: true,
          projectsDir: defaultConfigDir,
          sweepIntervalMs: 60_000,
          defaultMaxRetries: 3,
          verificationRequired: true,
        });
        const domainResult = initializeAllDomains(defaultConfigDir);
        api.logger.info(`Clawforce auto-init result: ${domainResult.domains.length} domain(s), ${domainResult.errors.length} error(s), ${domainResult.warnings.length} warning(s)`);
        if (domainResult.domains.length > 0) {
          api.logger.info(`Clawforce auto-init: ${domainResult.domains.length} domain(s): ${domainResult.domains.join(", ")}`);
        }
        for (const err of domainResult.errors) {
          api.logger.info(`Clawforce DOMAIN-ERROR: ${err}`);
        }

        // --- Auto-activate project.yaml subdirectories ---
        // Scan ~/.clawforce/<project-id>/project.yaml for flat project configs
        // that aren't picked up by the domain-based initializeAllDomains path.
        try {
          const subdirs = fs.readdirSync(defaultConfigDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

          for (const subdir of subdirs) {
            const projectYaml = path.join(defaultConfigDir, subdir, "project.yaml");
            if (!fs.existsSync(projectYaml)) continue;

            // Skip if already registered by initializeAllDomains
            const alreadyRegistered = getRegisteredAgentIds().some((aid) => {
              const entry = getAgentConfig(aid);
              return entry?.projectId === subdir;
            });
            if (alreadyRegistered) continue;

            try {
              const wfConfig = loadWorkforceConfig(projectYaml);
              if (wfConfig && Object.keys(wfConfig.agents).length > 0) {
                const projectDir = (wfConfig as Record<string, unknown>).project_dir as string | undefined
                  ?? path.join(defaultConfigDir, subdir);
                registerWorkforceConfig(subdir, wfConfig, projectDir);
                // Register in the active-project set so getActiveProjectIds() returns
                // this project after restart, without requiring a manual activate call.
                registerProject(subdir);
                const agentCount = Object.keys(wfConfig.agents).length;
                api.logger.info(`Clawforce: auto-activated project "${subdir}" (${agentCount} agent(s))`);

                // Ensure domain result includes this project for recovery
                if (!domainResult.domains.includes(subdir)) {
                  domainResult.domains.push(subdir);
                }
              }
            } catch (err) {
              api.logger.warn(`Clawforce: failed to auto-activate "${subdir}": ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          api.logger.warn(`Clawforce: project scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // --- Restart recovery: clean up orphaned state from before restart ---
        for (const domainId of domainResult.domains) {
          try {
            const recovery = recoverProject(domainId);
            const total = recovery.staleTasks + recovery.failedDispatches + recovery.releasedLeases;
            if (total > 0) {
              api.logger.info(
                `Clawforce restart recovery [${domainId}]: ${recovery.staleTasks} stale tasks released, ` +
                `${recovery.failedDispatches} dispatch items failed, ${recovery.releasedLeases} expired leases released`,
              );
            }
          } catch (err) {
            api.logger.warn(`Clawforce restart recovery failed for ${domainId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Sync agents to OpenClaw's agents.list so they're addressable
        // Each agent gets namespaced with its domain (projectId) to prevent collisions
        const agentIds = getRegisteredAgentIds();
        const agentsToSync = agentIds
          .map((id) => {
            const entry = getAgentConfig(id);
            if (!entry) return null;
            return { agentId: id, config: entry.config, projectDir: entry.projectDir, domain: entry.projectId };
          })
          .filter((e): e is NonNullable<typeof e> => e !== null);

        if (agentsToSync.length > 0) {
          void syncAgentsToOpenClaw({
            agents: agentsToSync,
            loadConfig: () => api.runtime.config.loadConfig(),
            writeConfigFile: (c) => api.runtime.config.writeConfigFile(c as never),
            logger: api.logger,
          });
          api.logger.info(`Clawforce: synced ${agentsToSync.length} agent(s) to OpenClaw`);
        }

        // --- Config hot-reload: watch for config file changes ---
        try {
          startConfigWatcher(defaultConfigDir, (change) => {
            api.logger.info(`Clawforce: config change detected (${change.file}) — reloading...`);
            try {
              const reloadResult = initializeAllDomains(defaultConfigDir);
              api.logger.info(
                `Clawforce: config reloaded — ${reloadResult.domains.length} domain(s), ` +
                `${reloadResult.errors.length} error(s), ${reloadResult.warnings.length} warning(s)`,
              );
              // Re-sync agents after reload
              const reloadedAgentIds = getRegisteredAgentIds();
              const reloadedAgents = reloadedAgentIds
                .map((id) => {
                  const entry = getAgentConfig(id);
                  if (!entry) return null;
                  return { agentId: id, config: entry.config, projectDir: entry.projectDir, domain: entry.projectId };
                })
                .filter((e): e is NonNullable<typeof e> => e !== null);
              if (reloadedAgents.length > 0) {
                void syncAgentsToOpenClaw({
                  agents: reloadedAgents,
                  loadConfig: () => api.runtime.config.loadConfig(),
                  writeConfigFile: (c) => api.runtime.config.writeConfigFile(c as never),
                  logger: api.logger,
                });
                api.logger.info(`Clawforce: re-synced ${reloadedAgents.length} agent(s) after config reload`);
              }
            } catch (err) {
              api.logger.warn(`Clawforce: config reload failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          });
          api.logger.info("Clawforce: config watcher started");
        } catch (err) {
          api.logger.warn(`Clawforce: config watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }

        // --- Periodic cron job cleanup ---
        // One-shot dispatch jobs accumulate as disabled entries in OpenClaw's cron store.
        // This prevents the cron timer from re-arming. Clean stale jobs every 5 minutes.
        setInterval(async () => {
          const cronService = getCronService();
          if (!cronService) return;
          try {
            const allJobs = await cronService.list({ includeDisabled: true });
            const now = Date.now();
            let cleaned = 0;
            for (const job of allJobs) {
              // Remove disabled one-shot jobs (completed dispatches)
              if (!job.enabled && job.deleteAfterRun && cronService.remove) {
                await cronService.remove(job.id);
                cleaned++;
              }
              // Remove enabled one-shot jobs that are >30min past due (stuck)
              if (job.enabled && job.schedule?.kind === "at" && job.state?.nextRunAtMs && job.state.nextRunAtMs < now - 5 * 60_000) {
                if (cronService.remove) {
                  await cronService.remove(job.id);
                  cleaned++;
                }
              }
            }
            if (cleaned > 0) {
              api.logger.info(`Clawforce: cleaned ${cleaned} stale cron job(s)`);
            }
          } catch (err) {
            // Non-fatal — cleanup is best-effort
          }
        }, 5 * 60_000); // Every 5 minutes

        // --- Capture cron service via self-dispatch ---
        // gateway_start doesn't provide cron context, but clawforce.dispatch does.
        // Schedule a CLI dispatch to the first lead agent — this routes through
        // the gateway WS handler which provides context.cron to clawforce.dispatch.
        if (domainResult.domains.length > 0) {
          const firstDomain = domainResult.domains[0]!;
          const leadIds = getRegisteredAgentIds().filter(id => {
            const e = getAgentConfig(id);
            return e?.projectId === firstDomain && (e?.config.extends === "manager" || e?.config.coordination?.enabled);
          });
          if (leadIds.length > 0) {
            const leadId = leadIds[0]!;
            const leadEntry = getAgentConfig(leadId);
            const namespacedLead = leadEntry ? toNamespacedAgentId(leadEntry.projectId, leadId) : leadId;
            setTimeout(() => {
              try {
                const { execSync: exec } = require("node:child_process") as typeof import("node:child_process");
                exec(
                  `openclaw gateway call clawforce.dispatch --params '${JSON.stringify({ agentId: namespacedLead, message: "[clawforce:job=dev_cycle] Check task board. Assign OPEN tasks. Review REVIEW tasks. Dispatch workers.", sessionTarget: "isolated", deleteAfterRun: true })}'`,
                  { timeout: 15_000, stdio: "ignore" },
                );
                api.logger.info(`Clawforce: cron captured via auto-dispatch of ${leadId}`);
              } catch (err) {
                api.logger.warn(`Clawforce: auto-dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }, 5_000);
          }
        }

        // --- Auto-start continuous jobs on gateway init ---
        // Read configurable stagger from domain dispatch config.
        // Default 30s between agents to avoid API rate limits.
        const dispatchConfig = domainResult.domains.length > 0
          ? (getExtendedProjectConfig(domainResult.domains[0]!) as { dispatch?: { stagger_seconds?: number } } | null)?.dispatch
          : undefined;
        const staggerSec = dispatchConfig?.stagger_seconds ?? 30;
        let staggerIndex = 0;
        for (const agId of getRegisteredAgentIds()) {
          const ent = getAgentConfig(agId);
          if (!ent?.config.jobs) continue;
          for (const [jobName, jobDef] of Object.entries(ent.config.jobs)) {
            if (!jobDef.continuous) continue;
            const nudge = jobDef.nudge ?? `Start your "${jobName}" job.`;
            const taggedMessage = `[clawforce:job=${jobName}]\n\n${nudge}`;
            const delayMs = 10_000 + (staggerIndex * staggerSec * 1000);
            staggerIndex++;
            // Namespace the agent ID for OpenClaw's cron service
            const namespacedAgId = toNamespacedAgentId(ent.projectId, agId);
            setTimeout(async () => {
              const cronService = getCronService();
              if (!cronService) {
                api.logger.warn(`Clawforce: continuous job auto-start skipped — cron not ready for ${agId}/${jobName}`);
                return;
              }
              try {
                const { toCronJobCreate: toCron } = await import("../src/manager-cron.js");
                const input = toCron({
                  name: `continuous:${namespacedAgId}:${jobName}:${Date.now()}`,
                  schedule: `at:${new Date().toISOString()}`,
                  agentId: namespacedAgId,
                  payload: taggedMessage,
                  sessionTarget: "isolated",
                  wakeMode: "now",
                  deleteAfterRun: true,
                });
                await cronService.add(input);
                api.logger.info(`Clawforce: continuous job "${jobName}" auto-started for ${namespacedAgId} (isolated session)`);
              } catch (err) {
                api.logger.warn(`Clawforce: continuous job auto-start failed for ${agId}/${jobName}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }, delayMs);
          }
        }
      } catch (err) {
        api.logger.warn(`Clawforce auto-init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    if (cfg.standaloneDashboard) {
      api.registerService({
        id: "clawforce-dashboard",
        start: async () => {
          await dashboardServer.start();
          api.logger.info(`Clawforce dashboard compatibility server at http://${standaloneHost}:${standalonePort}/clawforce/`);
        },
        stop: async () => {
          await dashboardServer.stop();
          api.logger.info("Clawforce dashboard server stopped");
        },
      });
    } else {
      api.logger.info("Clawforce: standalone dashboard compatibility server disabled; relying on the embedded OpenClaw route only");
    }

    // --- Sweep service ---
    api.registerService({
      id: "clawforce-sweep",
      start: async () => {
        // Route diagnostic events through the plugin logger
        setDiagnosticEmitter((payload) => {
          const msg = JSON.stringify(payload);
          const type = String(payload.type ?? "");
          if (type.includes("fail") || type.includes("error")) {
            api.logger.warn(`Clawforce diagnostic: ${msg}`);
          } else {
            api.logger.info(`Clawforce diagnostic: ${msg}`);
          }
        });

        // H8: Await memory factory loading before anything else uses them
        await loadMemoryFactories();

        initClawforce({
          enabled: true,
          projectsDir: cfg.projectsDir,
          sweepIntervalMs: cfg.sweepIntervalMs,
          defaultMaxRetries: cfg.defaultMaxRetries,
          verificationRequired: true,
        });
        // Initialize domain-based configs (Phase 9)
        try {
          const domainResult = initializeAllDomains(cfg.configDir ?? cfg.projectsDir);
          if (domainResult.domains.length > 0) {
            api.logger.info(`Clawforce: initialized ${domainResult.domains.length} domain(s): ${domainResult.domains.join(", ")}`);
          }
          for (const warning of domainResult.warnings) {
            api.logger.info(`Clawforce domain warning: ${warning}`);
          }
          for (const error of domainResult.errors) {
            api.logger.warn(`Clawforce domain error: ${error}`);
          }
        } catch (err) {
          api.logger.warn(`Clawforce: domain initialization failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Sync clawforce agents to OpenClaw config (agents.list[])
        // Each agent gets namespaced with its domain (projectId) to prevent collisions
        if (cfg.syncAgents) {
          const agentIds = getRegisteredAgentIds();
          const agentsToSync = agentIds
            .map((id) => {
              const entry = getAgentConfig(id);
              if (!entry) return null;
              return { agentId: id, config: entry.config, projectDir: entry.projectDir, domain: entry.projectId };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null);

          if (agentsToSync.length > 0) {
            void syncAgentsToOpenClaw({
              agents: agentsToSync,
              loadConfig: () => api.runtime.config.loadConfig(),
              writeConfigFile: (c) => api.runtime.config.writeConfigFile(c as never),
              logger: api.logger,
            });
          }
        }

        // Load model pricing from OpenClaw's model registry
        try {
          const config = api.config;
          const providers = config.models?.providers;
          if (providers) {
            const pricingEntries: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = [];
            for (const provider of Object.values(providers) as Array<{ models?: Array<{ id?: string; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }> }>) {
              for (const model of provider.models ?? []) {
                if (model.id && model.cost) {
                  pricingEntries.push({
                    id: model.id,
                    cost: {
                      input: model.cost.input ?? 0,
                      output: model.cost.output ?? 0,
                      cacheRead: model.cost.cacheRead ?? 0,
                      cacheWrite: model.cost.cacheWrite ?? 0,
                    },
                  });
                }
              }
            }
            if (pricingEntries.length > 0) {
              registerBulkPricing(pricingEntries);
              api.logger.info(`Clawforce: loaded pricing for ${pricingEntries.length} models from OpenClaw config`);
            }
          }
        } catch (err) {
          api.logger.warn(`Clawforce: failed to load model pricing from config: ${err instanceof Error ? err.message : String(err)}`);
        }

        api.logger.info(`Clawforce initialized (sweep every ${cfg.sweepIntervalMs}ms)`);
      },
      stop: async () => {
        stopConfigWatcher();
        await shutdownClawforce();
        api.logger.info("Clawforce shut down (config watcher stopped)");
      },
    });
  },
};

export default clawforcePlugin;
