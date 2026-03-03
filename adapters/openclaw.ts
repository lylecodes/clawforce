/**
 * clawforce — OpenClaw plugin adapter
 *
 * Thin integration layer that connects clawforce to OpenClaw's plugin system.
 * Translates OpenClaw lifecycle events into clawforce core calls.
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi as _OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Extended plugin API type — adds runtime methods not yet in the public SDK type definitions.
 */
type OpenClawPluginApi = _OpenClawPluginApi & {
  injectAgentMessage(params: {
    sessionKey: string;
    message: string;
  }): Promise<{ runId?: string }>;
};

import { assembleContext } from "../src/context/assembler.js";
import { validateWorkforceConfig } from "../src/config-validator.js";
import { checkCompliance } from "../src/enforcement/check.js";
import { executeFailureAction, executeCrashAction, recordCompliantRun } from "../src/enforcement/actions.js";
import { resolveEscalationTarget, routeEscalation } from "../src/enforcement/escalation-router.js";
import { endSession, getSession, recordToolCall, recoverOrphanedSessions, startTracking } from "../src/enforcement/tracker.js";
import { emitDiagnosticEvent, setDiagnosticEmitter } from "../src/diagnostics.js";
import { getActiveProjectIds, initClawforce, shutdownClawforce } from "../src/lifecycle.js";
import {
  getAgentConfig,
  initProject,
  loadWorkforceConfig,
  loadProject,
  registerWorkforceConfig,
  resolveProjectDir,
} from "../src/project.js";
import { approveProposal, listPendingProposals, rejectProposal } from "../src/approval/resolve.js";
import { registerKillFunction } from "../src/audit/auto-kill.js";
import { disableAgent, isAgentDisabled } from "../src/enforcement/disabled-store.js";
import { handleWorkerSessionEnd } from "../src/tasks/session-end.js";
import { buildOnboardingContext } from "../src/context/onboarding.js";
import { registerPolicies } from "../src/policy/registry.js";
import { generateDefaultScopePolicies } from "../src/profiles.js";
import { withPolicyCheck } from "../src/policy/middleware.js";
import { adaptTool } from "../src/tools/common.js";
import { createClawforceLogTool } from "../src/tools/log-tool.js";
import { createClawforceSetupTool } from "../src/tools/setup-tool.js";
import { createClawforceTaskTool } from "../src/tools/task-tool.js";
import { createClawforceVerifyTool } from "../src/tools/verify-tool.js";
import { createClawforceCompactTool } from "../src/tools/compact-tool.js";
import { createClawforceWorkflowTool } from "../src/tools/workflow-tool.js";
import { createClawforceOpsTool } from "../src/tools/ops-tool.js";
import { createClawforceMemoryTool } from "../src/tools/memory-tool.js";
import type { CronRegistrar, CronRegistrarInput } from "../src/types.js";

type ClawforcePluginConfig = {
  enabled?: boolean;
  projectsDir?: string;
  sweepIntervalMs?: number;
  defaultMaxRetries?: number;
  staleTaskHours?: number;
  cronStuckTimeoutMs?: number;
  cronMaxConsecutiveFailures?: number;
};

const DEFAULT_CONFIG: Required<ClawforcePluginConfig> = {
  enabled: true,
  projectsDir: "~/.clawforce",
  sweepIntervalMs: 60_000,
  defaultMaxRetries: 3,
  staleTaskHours: 4,
  cronStuckTimeoutMs: 300_000,
  cronMaxConsecutiveFailures: 3,
};

function resolveConfig(raw?: Record<string, unknown>): Required<ClawforcePluginConfig> {
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    projectsDir: typeof raw.projectsDir === "string" ? raw.projectsDir : DEFAULT_CONFIG.projectsDir,
    sweepIntervalMs: typeof raw.sweepIntervalMs === "number" ? raw.sweepIntervalMs : DEFAULT_CONFIG.sweepIntervalMs,
    defaultMaxRetries: typeof raw.defaultMaxRetries === "number" ? raw.defaultMaxRetries : DEFAULT_CONFIG.defaultMaxRetries,
    staleTaskHours: typeof raw.staleTaskHours === "number" ? raw.staleTaskHours : DEFAULT_CONFIG.staleTaskHours,
    cronStuckTimeoutMs: typeof raw.cronStuckTimeoutMs === "number" ? raw.cronStuckTimeoutMs : DEFAULT_CONFIG.cronStuckTimeoutMs,
    cronMaxConsecutiveFailures: typeof raw.cronMaxConsecutiveFailures === "number" ? raw.cronMaxConsecutiveFailures : DEFAULT_CONFIG.cronMaxConsecutiveFailures,
  };
}

type MinimalLogger = { info(msg: string): void; warn(msg: string): void };

/**
 * Scan projectsDir for project subdirectories containing project.yaml.
 * For each valid project: load + validate enforcement config, register agents,
 * init DB, and register for sweep service.
 */
function scanAndRegisterProjects(projectsDir: string, logger: MinimalLogger): void {
  const resolved = resolveProjectDir(projectsDir);
  if (!fs.existsSync(resolved)) {
    logger.info(`Clawforce: projects dir does not exist yet: ${resolved}`);
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    logger.warn(`Clawforce: failed to read projects dir: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let registered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectDir = path.join(resolved, entry.name);
    const configPath = path.join(projectDir, "project.yaml");
    if (!fs.existsSync(configPath)) continue;

    try {
      // Load and register workforce config (agent configs)
      const wfConfig = loadWorkforceConfig(configPath);
      if (wfConfig) {
        const warnings = validateWorkforceConfig(wfConfig);
        for (const w of warnings) {
          const prefix = w.agentId ? `[${entry.name}/${w.agentId}]` : `[${entry.name}]`;
          if (w.level === "error") {
            logger.warn(`Clawforce config error ${prefix}: ${w.message}`);
          } else {
            logger.info(`Clawforce config warning ${prefix}: ${w.message}`);
          }
        }

        // Only skip if there are hard errors with no agents
        const hasErrors = warnings.some((w) => w.level === "error");
        if (!hasErrors || Object.keys(wfConfig.agents).length > 0) {
          registerWorkforceConfig(entry.name, wfConfig, projectDir);

          // Build combined policy list: explicit + auto-generated scope defaults
          const allPolicies: Array<{ name: string; type: string; target?: string; config: Record<string, unknown> }> = [];
          if (wfConfig.policies && wfConfig.policies.length > 0) {
            allPolicies.push(...wfConfig.policies);
          }
          try {
            const agentEntries = Object.fromEntries(
              Object.entries(wfConfig.agents).map(([id, cfg]) => [id, { role: cfg.role }]),
            );
            const scopePolicies = generateDefaultScopePolicies(agentEntries, wfConfig.policies);
            allPolicies.push(...scopePolicies);
          } catch (scopeErr) {
            logger.warn(`Clawforce: failed to generate scope policies for "${entry.name}": ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`);
          }
          if (allPolicies.length > 0) {
            try {
              registerPolicies(entry.name, allPolicies);
            } catch (policyErr) {
              logger.warn(`Clawforce: failed to register policies for "${entry.name}": ${policyErr instanceof Error ? policyErr.message : String(policyErr)}`);
            }
          }
        }
      }

      // Load project config and initialize (DB, sweep registration, orchestrator)
      const projectConfig = loadProject(configPath);
      initProject(projectConfig);

      // Recover orphaned sessions from previous crashes
      const orphans = recoverOrphanedSessions(entry.name);
      for (const orphan of orphans) {
        logger.warn(`Clawforce: orphaned session detected — agent ${orphan.agentId} (${orphan.toolCallCount} tool calls, started ${new Date(orphan.startedAt).toISOString()})`);
      }

      registered++;
    } catch (err) {
      logger.warn(
        `Clawforce: failed to load project "${entry.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (registered > 0) {
    logger.info(`Clawforce: registered ${registered} project(s) from ${resolved}`);
  }
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

    // --- Disabled agent tracking (persistent) ---
    type CronServiceLike = { list(opts?: { includeDisabled?: boolean }): Promise<Array<{ id: string; agentId?: string; enabled: boolean; name: string }>>; update(id: string, patch: { enabled: boolean }): Promise<unknown> };
    let capturedCronService: CronServiceLike | null = null;

    async function handleDisable(agentId: string): Promise<void> {
      // Persist to SQLite via the agent's project
      const entry = getAgentConfig(agentId);
      if (entry) {
        disableAgent(entry.projectId, agentId, "Underperforming or unresponsive");
      }
      emitDiagnosticEvent({ type: "agent_disabled", agentId });
      if (capturedCronService) {
        try {
          const jobs = await capturedCronService.list({ includeDisabled: false });
          for (const job of jobs) {
            if (job.agentId === agentId && job.enabled) {
              await capturedCronService.update(job.id, { enabled: false });
              api.logger.info(`Clawforce: disabled cron job "${job.name}" for ${agentId}`);
            }
          }
        } catch (err) {
          api.logger.warn(`Clawforce: failed to disable cron for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // --- Context injection via before_prompt_build ---
    api.on("before_prompt_build", async (_event, ctx) => {
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
        // Start compliance tracking for this session
        startTracking(sessionKey, agentId, entry.projectId, entry.config);

        const content = assembleContext(agentId, entry.config, {
            projectId: entry.projectId,
            projectDir: entry.projectDir,
          });
        if (content) {
          return { prependContext: content };
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
          );
          api.logger.warn(
            `Clawforce: ${session.agentId} crashed — action: ${actionResult.action}`,
          );

          // Retry: re-inject into the crashed agent's session
          if (actionResult.action === "retry" && actionResult.retryPrompt) {
            try {
              await api.injectAgentMessage({
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

          // Escalation
          if (actionResult.alertMessage) {
            const target = resolveEscalationTarget(agentEntry.config);
            await routeEscalation({
              injectAgentMessage: api.injectAgentMessage.bind(api),
              target,
              message: actionResult.alertMessage,
              sourceAgentId: session.agentId,
              logger: api.logger,
            });
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
    });

    // --- Compliance enforcement at agent_end ---
    api.on("agent_end", async (event, ctx) => {
      if (!ctx.sessionKey) return;

      const session = endSession(ctx.sessionKey);
      if (!session) return; // Not an enforced agent

      const result = checkCompliance(session);

      if (result.compliant) {
        recordCompliantRun(result);
        api.logger.info(`Clawforce: ${session.agentId} session compliant`);
        return;
      }

      // Non-compliant — execute failure action
      const agentEntry = getAgentConfig(session.agentId);
      if (!agentEntry) return;

      const actionResult = executeFailureAction(
        agentEntry.config.performance_policy,
        result,
      );

      api.logger.warn(
        `Clawforce: ${session.agentId} non-compliant — action: ${actionResult.action}`,
      );

      // Retry: re-inject the compliance prompt into this agent's session
      if (actionResult.action === "retry" && actionResult.retryPrompt) {
        try {
          await api.injectAgentMessage({
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

      // Escalation: route alert to the configured target
      if (actionResult.alertMessage) {
        const target = resolveEscalationTarget(agentEntry.config);
        await routeEscalation({
          injectAgentMessage: api.injectAgentMessage.bind(api),
          target,
          message: actionResult.alertMessage,
          sourceAgentId: session.agentId,
          logger: api.logger,
        });
      }
    });

    // --- Tool registration ---
    // Helper to wrap tool with policy enforcement when agent has an associated project
    function wrapWithPolicy(
      tool: ReturnType<typeof adaptTool>,
      toolName: string,
      ctx: { agentId?: string; sessionKey?: string },
    ): ReturnType<typeof adaptTool> {
      const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
      if (!agentEntry) return tool;

      const originalExecute = tool.execute.bind(tool);
      tool.execute = async (...args: Parameters<typeof originalExecute>) => {
        // Hard-block disabled agents from executing any tool
        if (ctx.agentId && isAgentDisabled(agentEntry.projectId, ctx.agentId)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "Agent is disabled by Clawforce. No tool calls are permitted." }) }],
          };
        }
        return originalExecute(...args);
      };

      // Apply policy enforcement on top
      const policyWrapped = tool.execute;
      tool.execute = withPolicyCheck(policyWrapped as typeof originalExecute, {
        projectId: agentEntry.projectId,
        agentId: ctx.agentId!,
        sessionKey: ctx.sessionKey,
        toolName,
      });
      return tool;
    }

    api.registerTool(
      (ctx) => wrapWithPolicy(
        adaptTool(createClawforceTaskTool({ agentSessionKey: ctx.sessionKey })),
        "clawforce_task", ctx,
      ),
      { name: "clawforce_task" },
    );

    api.registerTool(
      (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        const tool = adaptTool(createClawforceLogTool({
          agentSessionKey: ctx.sessionKey,
          agentId: agentEntry ? ctx.agentId! : ctx.sessionKey,
        }));
        return wrapWithPolicy(tool, "clawforce_log", ctx);
      },
      { name: "clawforce_log" },
    );

    api.registerTool(
      (ctx) => wrapWithPolicy(
        adaptTool(createClawforceVerifyTool({ agentSessionKey: ctx.sessionKey })),
        "clawforce_verify", ctx,
      ),
      { name: "clawforce_verify" },
    );

    api.registerTool(
      (ctx) => wrapWithPolicy(
        adaptTool(createClawforceWorkflowTool({ agentSessionKey: ctx.sessionKey })),
        "clawforce_workflow", ctx,
      ),
      { name: "clawforce_workflow" },
    );

    api.registerTool(
      () => adaptTool(createClawforceSetupTool({ projectsDir: cfg.projectsDir })),
      { name: "clawforce_setup" },
    );

    api.registerTool(
      (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        const projectDir = agentEntry?.projectDir;
        if (!projectDir) {
          // No project dir — return a no-op tool that explains the situation
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
        return wrapWithPolicy(
          adaptTool(createClawforceCompactTool({
            projectDir,
            agentSessionKey: ctx.sessionKey,
            agentId: ctx.agentId ?? undefined,
          })),
          "clawforce_compact", ctx,
        );
      },
      { name: "clawforce_compact" },
    );

    api.registerTool(
      (ctx) => wrapWithPolicy(
        adaptTool(createClawforceOpsTool({ agentSessionKey: ctx.sessionKey })),
        "clawforce_ops", ctx,
      ),
      { name: "clawforce_ops" },
    );

    api.registerTool(
      (ctx) => {
        const agentEntry = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        const tool = adaptTool(createClawforceMemoryTool({
          agentSessionKey: ctx.sessionKey,
          agentId: agentEntry ? ctx.agentId! : ctx.sessionKey,
          agentConfig: agentEntry?.config,
        }));
        return wrapWithPolicy(tool, "clawforce_memory", ctx);
      },
      { name: "clawforce_memory" },
    );

    // --- Gateway methods: cron + kill ---
    // Lazy cron registrar: captures context.cron on first gateway method call
    let capturedCronAdd: ((input: CronRegistrarInput) => Promise<void>) | null = null;
    const pendingCronJobs: CronRegistrarInput[] = [];
    const cronRegistrar: CronRegistrar = async (job) => {
      if (capturedCronAdd) {
        await capturedCronAdd(job);
      } else {
        // Buffer until cron service is captured
        pendingCronJobs.push(job);
      }
    };

    // Gateway method to bootstrap cron + kill — invoked lazily on first gateway call
    api.registerGatewayMethod("clawforce.init", async ({ context, respond }) => {
      // Capture cron service (full service for disable support, add function for job registration)
      if (!capturedCronAdd && context.cron) {
        capturedCronService = context.cron;
        capturedCronAdd = async (input) => {
          await context.cron.add(input);
        };
        // Flush buffered cron jobs
        for (const job of pendingCronJobs) {
          try {
            await capturedCronAdd(job);
          } catch (err) {
            api.logger.warn(`Clawforce: failed to flush buffered cron job: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        pendingCronJobs.length = 0;
      }

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

      respond(true);
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

    // --- Sweep service ---
    let cronCheckTimer: ReturnType<typeof setTimeout> | null = null;

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

        initClawforce({
          enabled: true,
          projectsDir: cfg.projectsDir,
          sweepIntervalMs: cfg.sweepIntervalMs,
          defaultMaxRetries: cfg.defaultMaxRetries,
          verificationRequired: true,
          cronRegistrar,
        });
        // Scan for project configs and register agents
        scanAndRegisterProjects(cfg.projectsDir, api.logger);

        // Warn if cron jobs are buffered but service isn't captured yet
        if (pendingCronJobs.length > 0 && !capturedCronAdd) {
          api.logger.warn(
            `Clawforce: ${pendingCronJobs.length} cron job(s) buffered but cron service not captured. ` +
            `Ensure the gateway calls clawforce.init.`,
          );
        }

        cronCheckTimer = setTimeout(() => {
          if (!capturedCronAdd && pendingCronJobs.length > 0) {
            api.logger.warn(
              `Clawforce: cron still not captured after 30s. ${pendingCronJobs.length} job(s) pending.`,
            );
          }
        }, 30_000);
        cronCheckTimer.unref();

        api.logger.info(`Clawforce initialized (sweep every ${cfg.sweepIntervalMs}ms)`);
      },
      stop: async () => {
        if (cronCheckTimer) {
          clearTimeout(cronCheckTimer);
          cronCheckTimer = null;
        }
        await shutdownClawforce();
        api.logger.info("Clawforce shut down");
      },
    });
  },
};

export default clawforcePlugin;
