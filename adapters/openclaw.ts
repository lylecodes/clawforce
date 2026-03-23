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

import { assembleContext, clearAssemblerCache } from "../src/context/assembler.js";
import { resolveJobName, resolveDispatchContext, resolveEffectiveConfig } from "../src/jobs.js";
import { checkCompliance } from "../src/enforcement/check.js";
import { executeFailureAction, executeCrashAction, recordCompliantRun } from "../src/enforcement/actions.js";
import { resolveEscalationTarget, routeEscalation } from "../src/enforcement/escalation-router.js";
import { endSession, getSession, recordToolCall, recordSignificantResult, recoverOrphanedSessions, setDispatchContext, startTracking } from "../src/enforcement/tracker.js";
import { emitDiagnosticEvent, setDiagnosticEmitter } from "../src/diagnostics.js";
import { getActiveProjectIds, initClawforce, shutdownClawforce } from "../src/lifecycle.js";
import {
  getAgentConfig,
  getExtendedProjectConfig,
  getRegisteredAgentIds,
  resolveProjectDir,
} from "../src/project.js";
import { getEffectiveLifecycleConfig } from "../src/safety.js";
import { syncAgentsToOpenClaw } from "../src/agent-sync.js";
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
import { registerKillFunction } from "../src/audit/auto-kill.js";
import { disableAgent, isAgentDisabled } from "../src/enforcement/disabled-store.js";
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
import { initializeAllDomains } from "../src/config/init.js";
// Dashboard
import { createDashboardHandler } from "../src/dashboard/gateway-routes.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { emitSSE } from "../src/dashboard/sse.js";
import { setCronService } from "../src/manager-cron.js";

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
};

function resolveConfig(raw?: Record<string, unknown>): ResolvedConfig {
  if (!raw) return { ...DEFAULT_CONFIG, ghostRecall: { ...DEFAULT_GHOST_RECALL }, memoryFlush: { ...DEFAULT_MEMORY_FLUSH }, syncAgents: true };
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

    // --- Wire dispatch injector via CLI ---
    setDispatchInjector(cliInjectMessage);

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

    // --- Experiment variant tracking (per-session) ---
    const experimentSessionStore = new Map<string, { experimentId: string; variantId: string }>();

    // --- Context injection via before_prompt_build ---
    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = ctx.agentId;
      const sessionKey = ctx.sessionKey;
      if (!agentId) return;

      // Try enforcement config first (new system)
      const entry = getAgentConfig(agentId);

      // Block disabled agents from running (checks persistent store)
      if (entry && isAgentDisabled(entry.projectId, agentId)) {
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

        // Experiment variant resolution — assign session to active experiment variant
        // before context assembly so the variant config overrides take effect.
        const dispatchCtxForExperiment = resolveDispatchContext((event as { prompt?: string }).prompt);
        try {
          const { getActiveExperimentForProject, assignVariant, getVariantConfig } = await import("../src/experiments/assignment.js");
          const { mergeVariantConfig } = await import("../src/experiments/config.js");

          const db = getDb(entry.projectId);
          const activeExperiment = getActiveExperimentForProject(entry.projectId, db);
          if (activeExperiment) {
            const assignment = assignVariant(activeExperiment.experimentId, sessionKey, {
              agentId,
              jobName: jobName ?? undefined,
              taskId: dispatchCtxForExperiment?.taskId,
            }, db);
            if (assignment.variantId) {
              const variantConfig = getVariantConfig(activeExperiment.experimentId, assignment.variantId, db);
              if (variantConfig) {
                config = mergeVariantConfig(config, variantConfig);
              }
              experimentSessionStore.set(sessionKey, {
                experimentId: activeExperiment.experimentId,
                variantId: assignment.variantId,
              });
            }
          }
        } catch { /* experiment assignment is non-fatal */ }

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
        const dispatchCtx = resolveDispatchContext((event as { prompt?: string }).prompt);
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
        let ghostContext: string | null = null;
        if (cfg.ghostRecall.enabled && _createMemorySearchTool) {
          try {
            const isMemMode = memoryModeStore.get(sessionKey) ?? false;
            const isCron = !!jobName;
            let recallResult: GhostRecallResult | null = null;

            if (isCron) {
              // Cron path: use job prompt directly, no LLM triage
              const cronPrompt = (event as { prompt?: string }).prompt ?? "";
              const rawTool = _createMemorySearchTool({ agentSessionKey: sessionKey });
              const toolInstance = rawTool ? adaptMemoryTool(rawTool) as unknown as MemoryToolInstance : null;
              recallResult = await runCronRecall(cronPrompt, toolInstance, {
                maxSearches: cfg.ghostRecall.maxSearches,
                maxInjectedChars: cfg.ghostRecall.maxInjectedChars,
                debug: cfg.ghostRecall.debug,
                sessionKey,
                projectId: entry.projectId,
                agentId,
              });
            } else {
              // User-facing path: LLM triage on recent messages
              const rawTool = _createMemorySearchTool({ agentSessionKey: sessionKey });
              const toolInstance = rawTool ? adaptMemoryTool(rawTool) as unknown as MemoryToolInstance : null;
              recallResult = await runGhostRecall(
                (event as { messages?: unknown[] }).messages ?? [],
                toolInstance,
                {
                  sessionKey,
                  intensity: cfg.ghostRecall.intensity,
                  memoryMode: isMemMode,
                  windowSize: cfg.ghostRecall.windowSize,
                  maxInjectedChars: cfg.ghostRecall.maxInjectedChars,
                  maxSearches: cfg.ghostRecall.maxSearches,
                  debug: cfg.ghostRecall.debug,
                  projectId: entry.projectId,
                  agentId,
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

          // Retry: re-inject into the crashed agent's session
          if (actionResult.action === "retry" && actionResult.retryPrompt) {
            try {
              await cliInjectMessage({
                sessionKey: event.targetSessionKey,
                message: actionResult.retryPrompt,
              });
            } catch (err) {
              api.logger.warn(
                `Clawforce: crash retry inject failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
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
      recordToolCall(
        ctx.sessionKey,
        toolName,
        action ?? null,
        event.durationMs ?? 0,
        !event.error,
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
    });

    // --- Universal tool gating via before_tool_call ---
    // Enforces clawforce policies on ALL tools (MCP, external, OpenClaw native).
    // Clawforce's own tools are skipped — they have withPolicyCheck() defense-in-depth.
    api.on("before_tool_call", async (event, ctx) => {
      if (!ctx.agentId) return;

      const entry = getAgentConfig(ctx.agentId);
      if (!entry) return; // Unknown agent — not managed by clawforce, allow

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
      memoryModeStore.delete(ctx.sessionKey);
      sessionTurnCountStore.delete(ctx.sessionKey);
      experimentSessionStore.delete(ctx.sessionKey);

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

      if (!session) return; // Not an enforced agent

      // --- Auto-lifecycle: evidence capture + transition for dispatched sessions ---
      if (session.dispatchContext) {
        const { queueItemId, taskId } = session.dispatchContext;
        const db = getDb(session.projectId);
        const task = getTask(session.projectId, taskId, db);
        const endLifecycleCfg = getEffectiveLifecycleConfig(session.projectId);

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
              return runVerificationIfConfigured(session.projectId, projectDir, session.agentId);
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
              if (session.metrics.toolCalls.length === 0) {
                transitionTask({ projectId: session.projectId, taskId, toState: "FAILED", actor: session.agentId }, db);
              } else if (session.metrics.errorCount > session.metrics.toolCalls.length * 0.5) {
                transitionTask({ projectId: session.projectId, taskId, toState: "FAILED", actor: session.agentId }, db);
              } else if (verificationResult && !verificationResult.result.allRequiredPassed) {
                transitionTask({ projectId: session.projectId, taskId, toState: "FAILED", actor: session.agentId }, db);
              } else {
                transitionTask({ projectId: session.projectId, taskId, toState: "REVIEW", actor: session.agentId }, db);
              }
            } catch { /* non-fatal */ }
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
        }, db);
      } catch { /* telemetry must never break the main flow */ }

      if (result.compliant) {
        recordCompliantRun(result);
        api.logger.info(`Clawforce: ${session.agentId} session compliant`);
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

      // Retry: re-inject the compliance prompt into this agent's session
      if (actionResult.action === "retry" && actionResult.retryPrompt) {
        try {
          await cliInjectMessage({
            sessionKey: ctx.sessionKey,
            message: actionResult.retryPrompt,
          });
        } catch (err) {
          api.logger.warn(
            `Clawforce: retry inject failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`,
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
      // If the agent's current job is marked continuous, immediately re-dispatch
      // via the cron API. This creates a tight loop: agent finishes → starts again.
      if (session.jobName) {
        const cfAgentEntry = getAgentConfig(session.agentId);
        if (cfAgentEntry) {
          const jobDef = cfAgentEntry.config.jobs?.[session.jobName];
          if (jobDef?.continuous) {
            // Check safety gates before re-dispatching
            const { shouldDispatch } = await import("../src/dispatch/dispatcher.js");
            const { isEmergencyStopActive } = await import("../src/safety.js");

            if (isEmergencyStopActive(session.projectId)) {
              api.logger.warn(`Clawforce: continuous job "${session.jobName}" blocked — emergency stop active`);
            } else {
              const gateCheck = shouldDispatch(session.projectId, session.agentId);
              if (!gateCheck.ok) {
                api.logger.warn(`Clawforce: continuous job "${session.jobName}" blocked — ${gateCheck.reason}`);
              } else {
                // Direct dispatch via injectAgentMessage — no cron middleman
                try {
                  const nudge = jobDef.nudge ?? `Continue your "${session.jobName}" job. Pick up where you left off.`;
                  await cliInjectMessage({
                    sessionKey: ctx.sessionKey,
                    message: nudge,
                  });
                  api.logger.info(`Clawforce: continuous job "${session.jobName}" re-dispatched for ${session.agentId}`);
                } catch (err) {
                  api.logger.warn(`Clawforce: continuous re-dispatch failed for ${session.agentId}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
        }
      }
    });

    // --- Auto-capture costs via llm_output ---
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
        if (ctx.agentId && isAgentDisabled(agentEntry.projectId, ctx.agentId)) {
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
    const dashboardHandler = createDashboardHandler({
      staticDir: path.resolve(import.meta.dirname, "../dashboard/dist"),
      injectAgentMessage: (params) => cliInjectMessage(params),
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
      port: 3117,
      injectAgentMessage: (params) => cliInjectMessage(params),
    });

    // --- Auto-init domains on gateway start (no external clawforce.init call needed) ---
    api.on("gateway_start", async () => {
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
        if (domainResult.domains.length > 0) {
          api.logger.info(`Clawforce auto-init: ${domainResult.domains.length} domain(s): ${domainResult.domains.join(", ")}`);
        }
        for (const err of domainResult.errors) {
          api.logger.warn(`Clawforce domain error: ${err}`);
        }

        // Sync agents to OpenClaw's agents.list so they're addressable
        const agentIds = getRegisteredAgentIds();
        const agentsToSync = agentIds
          .map((id) => {
            const entry = getAgentConfig(id);
            if (!entry) return null;
            return { agentId: id, config: entry.config, projectDir: entry.projectDir };
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

        // --- Auto-start continuous jobs on gateway init ---
        // Find any agents with continuous jobs and dispatch them.
        // Stagger starts by 10s each to avoid overwhelming the gateway handshake.
        let staggerIndex = 0;
        for (const agentId of getRegisteredAgentIds()) {
          const entry = getAgentConfig(agentId);
          if (!entry?.config.jobs) continue;
          for (const [jobName, jobDef] of Object.entries(entry.config.jobs)) {
            if (!jobDef.continuous) continue;
            const nudge = jobDef.nudge ?? `Start your "${jobName}" job.`;
            const taggedMessage = `[clawforce:job=${jobName}]\n\n${nudge}`;
            const delayMs = 10_000 + (staggerIndex * 10_000); // 10s, 20s, 30s, ...
            staggerIndex++;
            setTimeout(() => {
              try {
                execFile("openclaw", [
                  "agent",
                  "--agent", agentId,
                  "--message", taggedMessage,
                ], { timeout: 600_000 }, (err: Error | null) => {
                  if (err) {
                    api.logger.warn(`Clawforce: continuous job auto-start failed for ${agentId}/${jobName}: ${err.message}`);
                  } else {
                    api.logger.info(`Clawforce: continuous job "${jobName}" completed for ${agentId}`);
                  }
                });
                api.logger.info(`Clawforce: continuous job "${jobName}" auto-started for ${agentId}`);
              } catch (err) {
                api.logger.warn(`Clawforce: continuous job auto-start failed for ${agentId}/${jobName}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }, delayMs);
          }
        }
      } catch (err) {
        api.logger.warn(`Clawforce auto-init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.registerService({
      id: "clawforce-dashboard",
      start: async () => {
        await dashboardServer.start();
        api.logger.info("Clawforce dashboard at http://localhost:3117");
      },
      stop: async () => {
        await dashboardServer.stop();
        api.logger.info("Clawforce dashboard server stopped");
      },
    });

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
        if (cfg.syncAgents) {
          const agentIds = getRegisteredAgentIds();
          const agentsToSync = agentIds
            .map((id) => {
              const entry = getAgentConfig(id);
              if (!entry) return null;
              return { agentId: id, config: entry.config, projectDir: entry.projectDir };
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
        await shutdownClawforce();
        api.logger.info("Clawforce shut down");
      },
    });
  },
};

export default clawforcePlugin;
