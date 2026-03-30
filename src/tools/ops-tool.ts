/**
 * Clawforce — Ops tool
 *
 * Runtime observability and control for manager agents.
 * Provides agent status, kill/disable/enable, reassign, audit queries, and sweep trigger.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import { getInitQuestions, buildConfigFromAnswers, getBudgetGuidance } from "../config/init-flow.js";
import { scaffoldConfigDir, initDomain } from "../config/wizard.js";
import { getActiveSessions, getSession } from "../enforcement/tracker.js";
import { listDisabledAgents, disableAgent, enableAgent, isAgentDisabled, disableScope, enableScope, isAgentEffectivelyDisabled, listDisabledScopes, disableDomain, enableDomain, isDomainDisabled, getDomainDisableInfo } from "../enforcement/disabled-store.js";
import type { DisableScope } from "../enforcement/disabled-store.js";
import { countRecentRetries } from "../enforcement/retry-store.js";
import { detectStuckAgents } from "../audit/stuck-detector.js";
import { killStuckAgent } from "../audit/auto-kill.js";
import { writeAuditEntry, queryAuditLog } from "../audit.js";
import { getDb } from "../db.js";
import { getTask, reassignTask, transitionTask } from "../tasks/ops.js";
import { sweep } from "../sweep/actions.js";
import { buildTaskPrompt } from "../dispatch/spawn.js";
import { assembleContext } from "../context/assembler.js";
import { getAgentConfig } from "../project.js";
import {
  listAllAssignments,
  registerWorkerAssignment,
  clearWorkerAssignment,
} from "../worker-registry.js";
import { stringEnum } from "../schema-helpers.js";
import { ingestEvent, listEvents } from "../events/store.js";
import { enqueue, getQueueStatus } from "../dispatch/queue.js";
import { processAndDispatch, getConcurrencyInfo } from "../dispatch/dispatcher.js";
import { aggregateMetrics, queryMetrics } from "../metrics.js";
import { canManageJobs, listJobs, upsertJob, deleteJob } from "../jobs.js";
import { checkBudget } from "../budget.js";
import { safeLog } from "../diagnostics.js";
import type { ToolResult } from "./common.js";
import {
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
  readStringArrayParam,
  resolveProjectId,
  safeExecute,
} from "./common.js";
import { EVENT_STATUSES } from "../types.js";
import type { EventStatus } from "../types.js";
import { activateEmergencyStop, deactivateEmergencyStop, isEmergencyStopActive } from "../safety.js";
import {
  createExperiment,
  startExperiment,
  pauseExperiment,
  completeExperiment,
  killExperiment,
  getExperiment,
  listExperiments,
} from "../experiments/lifecycle.js";
import { getExperimentResults } from "../experiments/results.js";
import type { ExperimentState } from "../types.js";

const OPS_ACTIONS = [
  "agent_status", "kill_agent", "disable_agent", "enable_agent",
  "reassign", "query_audit", "trigger_sweep", "dispatch_worker",
  "refresh_context", "emit_event", "list_events", "enqueue_work",
  "queue_status", "process_events", "dispatch_metrics",
  "list_jobs", "create_job", "update_job", "delete_job",
  "introspect", "allocate_budget",
  "plan_create", "plan_start", "plan_complete", "plan_abandon", "plan_list",
  "flag_knowledge", "approve_promotion", "dismiss_promotion", "resolve_flag", "dismiss_flag", "list_candidates", "list_flags",
  "init_questions", "init_apply", "route",
  "emergency_stop", "emergency_resume",
  "disable_domain", "enable_domain", "domain_status",
  "create_experiment", "start_experiment", "pause_experiment", "complete_experiment",
  "kill_experiment", "apply_experiment", "experiment_status", "list_experiments",
  "propose_feature",
] as const;

const ClawforceOpsSchema = Type.Object({
  action: stringEnum(OPS_ACTIONS, { description: "Action to perform." }),
  project_id: Type.String({ description: "Project identifier (required for all ops actions)." }),
  session_key: Type.Optional(Type.String({ description: "Session key (for kill_agent)." })),
  agent_id: Type.Optional(Type.String({ description: "Agent identifier (for disable_agent/enable_agent)." })),
  reason: Type.Optional(Type.String({ description: "Reason (for disable_agent)." })),
  scope_type: Type.Optional(Type.String({ description: "Disable scope: 'agent' (default), 'team', or 'department' (for disable_agent/enable_agent)." })),
  scope_value: Type.Optional(Type.String({ description: "Scope target value: agent_id, team name, or department name (for disable_agent/enable_agent when scope_type is set)." })),
  force: Type.Optional(Type.Boolean({ description: "Force kill even if agent is not stuck (for kill_agent)." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (for reassign)." })),
  new_assignee: Type.Optional(Type.String({ description: "New assignee agent ID (for reassign)." })),
  actor: Type.Optional(Type.String({ description: "Filter by actor (for query_audit)." })),
  audit_action: Type.Optional(Type.String({ description: "Filter by action (for query_audit)." })),
  target_type: Type.Optional(Type.String({ description: "Filter by target type (for query_audit)." })),
  target_id: Type.Optional(Type.String({ description: "Filter by target ID (for query_audit)." })),
  since: Type.Optional(Type.Number({ description: "Start timestamp ms (for query_audit)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for query_audit, default 50)." })),
  audit_table: Type.Optional(Type.String({ description: "Table to query: audit_log (default) or audit_runs (for query_audit)." })),
  // dispatch_worker params
  task_id_dispatch: Type.Optional(Type.String({ description: "Task ID to dispatch worker for (for dispatch_worker)." })),
  project_dir: Type.Optional(Type.String({ description: "Project directory path (for dispatch_worker)." })),
  prompt: Type.Optional(Type.String({ description: "Prompt/instructions for worker (for dispatch_worker)." })),
  profile: Type.Optional(Type.String({ description: "Claude CLI profile (for dispatch_worker)." })),
  model: Type.Optional(Type.String({ description: "Model to use (for dispatch_worker)." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (for dispatch_worker, default 10min)." })),
  allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools (for dispatch_worker)." })),
  max_turns: Type.Optional(Type.Number({ description: "Max turns (for dispatch_worker)." })),
  // refresh_context params
  agent_id_context: Type.Optional(Type.String({ description: "Agent ID to refresh context for (for refresh_context)." })),
  // emit_event params
  event_type: Type.Optional(Type.String({ description: "Event type: ci_failed, pr_opened, deploy_finished, task_completed, sweep_finding, custom (for emit_event)." })),
  event_payload: Type.Optional(Type.String({ description: "JSON payload for the event (for emit_event)." })),
  dedup_key: Type.Optional(Type.String({ description: "Deduplication key for idempotent ingestion (for emit_event)." })),
  // list_events params
  event_status: Type.Optional(Type.String({ description: "Filter by event status: pending, processing, handled, failed, ignored (for list_events)." })),
  event_type_filter: Type.Optional(Type.String({ description: "Filter by event type (for list_events)." })),
  // enqueue_work params
  enqueue_task_id: Type.Optional(Type.String({ description: "Task ID to enqueue (for enqueue_work)." })),
  enqueue_priority: Type.Optional(Type.Number({ description: "Priority 0-3 (for enqueue_work, default 2)." })),
  enqueue_payload: Type.Optional(Type.String({ description: "JSON payload with dispatch params: prompt, projectDir, profile, model, timeoutMs (for enqueue_work)." })),
  // job management params
  target_agent_id: Type.Optional(Type.String({ description: "Target agent ID (for list_jobs, create_job, update_job, delete_job)." })),
  job_name: Type.Optional(Type.String({ description: "Job name (for create_job, update_job, delete_job)." })),
  job_config: Type.Optional(Type.String({ description: "JSON object with job fields: cron, cronTimezone, briefing, exclude_briefing, expectations, performance_policy, compaction, nudge, sessionTarget, wakeMode, delivery, failureAlert, model, timeoutSeconds, lightContext, deleteAfterRun (for create_job, update_job)." })),
  filter_job_name: Type.Optional(Type.String({ description: "Filter audit_runs by job name (for query_audit with audit_table=audit_runs)." })),
  // allocate_budget params
  parent_agent_id: Type.Optional(Type.String({ description: "Parent agent for budget allocation." })),
  child_agent_id: Type.Optional(Type.String({ description: "Child agent to receive budget allocation." })),
  daily_limit_cents: Type.Optional(Type.Number({ description: "Daily budget limit in cents to allocate." })),
  // plan management params
  planned_items: Type.Optional(Type.String({ description: "JSON array of planned dispatch items for plan_create." })),
  plan_id: Type.Optional(Type.String({ description: "Dispatch plan ID for plan_start/plan_complete/plan_abandon." })),
  actual_results: Type.Optional(Type.String({ description: "JSON array of actual results for plan_complete." })),
  // knowledge lifecycle params
  source_type: Type.Optional(Type.String({ description: "Knowledge source type: soul, skill, or project_doc." })),
  source_ref: Type.Optional(Type.String({ description: "Source reference (file path or topic name)." })),
  flagged_content: Type.Optional(Type.String({ description: "The content that is wrong." })),
  correction: Type.Optional(Type.String({ description: "The correct information." })),
  severity: Type.Optional(Type.String({ description: "Flag severity: low, medium, high." })),
  candidate_id: Type.Optional(Type.String({ description: "Promotion candidate ID." })),
  flag_id: Type.Optional(Type.String({ description: "Knowledge flag ID." })),
  // init flow params
  init_answers: Type.Optional(Type.String({ description: "JSON object with init answers: domain_name, mission, agents, reporting, budget_cents (for init_apply)." })),
  config_dir: Type.Optional(Type.String({ description: "Config directory path (for init_apply, defaults to ~/.clawforce)." })),
  // route params
  route_name: Type.Optional(Type.String({ description: "Route name to execute (for route action)." })),
  route_config: Type.Optional(Type.String({ description: "JSON route config: { name, source, condition, outputs } (for route action)." })),
  stream_data: Type.Optional(Type.String({ description: "JSON stream data context for condition evaluation (for route action)." })),
  // experiment management params
  experiment_id: Type.Optional(Type.String({ description: "Experiment ID (for experiment_status, start/pause/complete/kill/apply_experiment)." })),
  experiment_name: Type.Optional(Type.String({ description: "Experiment name (for create_experiment)." })),
  experiment_description: Type.Optional(Type.String({ description: "Description (for create_experiment)." })),
  experiment_hypothesis: Type.Optional(Type.String({ description: "Hypothesis (for create_experiment)." })),
  experiment_variants: Type.Optional(Type.String({ description: "JSON array of variant definitions (for create_experiment)." })),
  experiment_strategy: Type.Optional(Type.String({ description: "Assignment strategy JSON (for create_experiment)." })),
  experiment_criteria: Type.Optional(Type.String({ description: "Completion criteria JSON (for create_experiment)." })),
  experiment_auto_apply: Type.Optional(Type.Boolean({ description: "Auto-apply winner when complete (for create_experiment)." })),
  experiment_state_filter: Type.Optional(Type.String({ description: "Filter by state: draft, running, paused, completed, cancelled (for list_experiments)." })),
  // propose_feature params
  proposal_title: Type.Optional(Type.String({ description: "Feature proposal title (for propose_feature)." })),
  proposal_description: Type.Optional(Type.String({ description: "Feature proposal description (for propose_feature)." })),
  proposal_reasoning: Type.Optional(Type.String({ description: "Gap analysis vs DIRECTION explaining why this feature is needed (for propose_feature)." })),
  proposal_goal_id: Type.Optional(Type.String({ description: "Related goal ID, if applicable (for propose_feature)." })),
});

export function createClawforceOpsTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
  projectDir?: string;
}) {
  return {
    label: "Team Operations",
    name: "clawforce_ops",
    description:
      "Team observability and control. " +
      "Read: agent_status, query_audit, refresh_context, list_events, queue_status, dispatch_metrics, list_jobs, introspect. " +
      "Write: kill_agent, disable_agent, enable_agent, reassign, trigger_sweep, dispatch_worker, emit_event, enqueue_work, process_events, create_job, update_job, delete_job, allocate_budget, emergency_stop, emergency_resume, disable_domain, enable_domain. " +
      "Job management: list_jobs (view agent jobs), create_job/update_job/delete_job (manage scoped sessions). " +
      "introspect: view your own config, expectations, budget, and SLO status. " +
      "Use emit_event to ingest external events (CI failures, PR opens, etc). " +
      "Use enqueue_work to add tasks to the dispatch queue with priority. " +
      "Use process_events to trigger event processing + dispatch. " +
      "Knowledge lifecycle: flag_knowledge (report wrong knowledge), approve_promotion/dismiss_promotion (manage promotion candidates), resolve_flag/dismiss_flag (manage knowledge corrections), list_candidates/list_flags (view pending items). " +
      "Init flow: init_questions (get setup wizard questions), init_apply (apply answers to scaffold config). " +
      "Proposals: propose_feature (submit a feature proposal with gap analysis reasoning for user approval). ",
    parameters: ClawforceOpsSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId, "");
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        if (!resolved.projectId) return jsonResult({ ok: false, reason: "Missing required parameter: project_id" });
        const projectId = resolved.projectId!;
        const caller = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "agent_status": {
            const db = getDb(projectId);
            const allSessions = getActiveSessions();
            const sessions = allSessions.filter((s) => s.projectId === projectId);
            const disabled = listDisabledAgents(projectId);
            const stuck = detectStuckAgents();
            const projectStuck = stuck.filter((s) => s.projectId === projectId);
            const allAssignments = listAllAssignments();
            const projectAssignments = allAssignments.filter((a) => a.projectId === projectId);

            const sessionSummaries = sessions.slice(0, 10).map((s) => {
              const runtimeMs = Date.now() - s.metrics.startedAt;
              let requiredCallsMade = 0;
              let requiredCallsTotal = 0;
              for (const req of s.requirements) {
                const actions = Array.isArray(req.action) ? req.action.sort().join("|") : req.action;
                const key = `${req.tool}:${actions}`;
                const count = s.satisfied.get(key) ?? 0;
                requiredCallsTotal += req.min_calls;
                requiredCallsMade += Math.min(count, req.min_calls);
              }

              return {
                sessionKey: s.sessionKey,
                agentId: s.agentId,
                runtimeMs,
                toolCalls: s.metrics.toolCalls.length,
                requiredCallsMade,
                requiredCallsTotal,
                errorCount: s.metrics.errorCount,
                retries: countRecentRetries(projectId, s.agentId),
              };
            });

            // Build per-worker stats from audit_runs
            const workerStatsMap = new Map<string, { totalRuns: number; successCount: number; totalDurationMs: number }>();
            try {
              const runRows = db.prepare(
                `SELECT agent_id, status, duration_ms FROM audit_runs
                 WHERE project_id = ? AND started_at > ?
                 ORDER BY started_at DESC LIMIT 200`,
              ).all(projectId, Date.now() - 24 * 60 * 60 * 1000) as Record<string, unknown>[];
              for (const r of runRows) {
                const agentId = r.agent_id as string;
                const stats = workerStatsMap.get(agentId) ?? { totalRuns: 0, successCount: 0, totalDurationMs: 0 };
                stats.totalRuns++;
                if (r.status === "compliant") stats.successCount++;
                stats.totalDurationMs += (r.duration_ms as number) ?? 0;
                workerStatsMap.set(agentId, stats);
              }
            } catch (err) {
              safeLog("ops.agentStatus.auditRuns", err);
            }

            // Count active tasks per worker
            const workerTaskCounts = new Map<string, number>();
            try {
              const taskRows = db.prepare(
                "SELECT assigned_to, COUNT(*) as cnt FROM tasks WHERE project_id = ? AND assigned_to IS NOT NULL AND state IN ('ASSIGNED', 'IN_PROGRESS') GROUP BY assigned_to",
              ).all(projectId) as Record<string, unknown>[];
              for (const r of taskRows) {
                workerTaskCounts.set(r.assigned_to as string, r.cnt as number);
              }
            } catch (err) {
              safeLog("ops.agentStatus.taskCounts", err);
            }

            const workerStats = [...new Set([...workerStatsMap.keys(), ...workerTaskCounts.keys()])].map((agentId) => {
              const stats = workerStatsMap.get(agentId);
              return {
                agentId,
                activeTaskCount: workerTaskCounts.get(agentId) ?? 0,
                recentRuns: stats?.totalRuns ?? 0,
                successRate: stats && stats.totalRuns > 0 ? Math.round((stats.successCount / stats.totalRuns) * 100) : null,
                avgDurationMs: stats && stats.totalRuns > 0 ? Math.round(stats.totalDurationMs / stats.totalRuns) : null,
              };
            });

            return jsonResult({
              ok: true,
              activeSessions: sessionSummaries,
              activeSessionCount: sessions.length,
              disabledAgents: disabled,
              stuckAgents: projectStuck.map((s) => ({
                sessionKey: s.sessionKey,
                agentId: s.agentId,
                runtimeMs: s.runtimeMs,
                reason: s.reason,
              })),
              workerAssignments: projectAssignments,
              workerStats,
            });
          }

          case "kill_agent": {
            const sessionKey = readStringParam(params, "session_key", { required: true })!;
            const force = readBooleanParam(params, "force") ?? false;

            const session = getSession(sessionKey);
            if (!session) {
              return jsonResult({ ok: false, reason: `Session not found: ${sessionKey}` });
            }
            if (session.projectId !== projectId) {
              return jsonResult({ ok: false, reason: `Session ${sessionKey} belongs to project ${session.projectId}, not ${projectId}` });
            }

            // Check if stuck
            const stuck = detectStuckAgents();
            const isStuck = stuck.some((s) => s.sessionKey === sessionKey);

            if (!isStuck && !force) {
              return jsonResult({ ok: false, reason: `Session ${sessionKey} is not stuck. Use force=true to kill anyway.` });
            }

            // Build a StuckAgent-like object for killStuckAgent
            const stuckEntry = stuck.find((s) => s.sessionKey === sessionKey) ?? {
              sessionKey,
              agentId: session.agentId,
              projectId: session.projectId,
              runtimeMs: Date.now() - session.metrics.startedAt,
              lastToolCallMs: session.metrics.lastToolCallAt,
              requiredCallsMade: 0,
              requiredCallsTotal: 0,
              reason: force ? "Force-killed by manager" : "Stuck",
            };

            const killed = await killStuckAgent(stuckEntry);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "kill_agent",
              targetType: "session",
              targetId: sessionKey,
              detail: JSON.stringify({ agentId: session.agentId, force, wasStuck: isStuck }),
            });

            const result: Record<string, unknown> = { ok: true, killed, sessionKey, agentId: session.agentId };
            if (force && !isStuck) {
              result.warning = "Agent was not stuck — force-killed.";
            }
            return jsonResult(result);
          }

          case "disable_agent": {
            const scopeType = (readStringParam(params, "scope_type") ?? "agent") as DisableScope;
            const reason = readStringParam(params, "reason") ?? "Terminated by manager";

            if (scopeType === "agent") {
              const agentId = readStringParam(params, "agent_id") ?? readStringParam(params, "scope_value");
              if (!agentId) return jsonResult({ ok: false, reason: "Missing required parameter: agent_id or scope_value" });

              disableAgent(projectId, agentId, reason);
              writeAuditEntry({
                projectId,
                actor: caller,
                action: "disable_agent",
                targetType: "agent",
                targetId: agentId,
                detail: reason,
              });
              return jsonResult({ ok: true, scopeType, agentId, disabled: true, reason });
            }

            // Team or department scope
            const scopeValue = readStringParam(params, "scope_value");
            if (!scopeValue) return jsonResult({ ok: false, reason: `Missing required parameter: scope_value (${scopeType} name)` });

            disableScope(projectId, scopeType, scopeValue, reason, caller);
            writeAuditEntry({
              projectId,
              actor: caller,
              action: "disable_agent",
              targetType: scopeType,
              targetId: scopeValue,
              detail: reason,
            });
            return jsonResult({ ok: true, scopeType, scopeValue, disabled: true, reason });
          }

          case "enable_agent": {
            const scopeType = (readStringParam(params, "scope_type") ?? "agent") as DisableScope;

            if (scopeType === "agent") {
              const agentId = readStringParam(params, "agent_id") ?? readStringParam(params, "scope_value");
              if (!agentId) return jsonResult({ ok: false, reason: "Missing required parameter: agent_id or scope_value" });

              if (!isAgentEffectivelyDisabled(projectId, agentId)) {
                return jsonResult({ ok: false, reason: `Agent ${agentId} is not disabled.` });
              }

              enableAgent(projectId, agentId);
              writeAuditEntry({
                projectId,
                actor: caller,
                action: "enable_agent",
                targetType: "agent",
                targetId: agentId,
              });
              return jsonResult({ ok: true, scopeType, agentId, disabled: false });
            }

            // Team or department scope
            const scopeValue = readStringParam(params, "scope_value");
            if (!scopeValue) return jsonResult({ ok: false, reason: `Missing required parameter: scope_value (${scopeType} name)` });

            enableScope(projectId, scopeType, scopeValue);
            writeAuditEntry({
              projectId,
              actor: caller,
              action: "enable_agent",
              targetType: scopeType,
              targetId: scopeValue,
            });
            return jsonResult({ ok: true, scopeType, scopeValue, disabled: false });
          }

          case "reassign": {
            const taskId = readStringParam(params, "task_id", { required: true })!;
            const newAssignee = readStringParam(params, "new_assignee", { required: true })!;

            // Read task before reassignment to capture previous assignee
            const taskBefore = getTask(projectId, taskId);
            const previousAssignee = taskBefore?.assignedTo;
            const previousState = taskBefore?.state;

            const result = reassignTask({
              projectId,
              taskId,
              newAssignee,
              actor: caller,
            });

            if (!result.ok) {
              return jsonResult({ ok: false, reason: result.reason });
            }

            return jsonResult({
              ok: true,
              taskId,
              previousAssignee,
              newAssignee,
              previousState,
              newState: result.transition.toState,
            });
          }

          case "query_audit": {
            const auditTable = readStringParam(params, "audit_table") ?? "audit_log";
            const actorFilter = readStringParam(params, "actor");
            const actionFilter = readStringParam(params, "audit_action");
            const targetType = readStringParam(params, "target_type");
            const targetId = readStringParam(params, "target_id");
            const since = readNumberParam(params, "since", { integer: true });
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;

            if (auditTable === "audit_runs") {
              const db = getDb(projectId);
              let query = "SELECT * FROM audit_runs WHERE project_id = ?";
              const queryParams: SQLInputValue[] = [projectId];

              if (actorFilter) {
                query += " AND agent_id = ?";
                queryParams.push(actorFilter);
              }
              if (since) {
                query += " AND started_at >= ?";
                queryParams.push(since);
              }
              const filterJobName = readStringParam(params, "filter_job_name");
              if (filterJobName) {
                query += " AND job_name = ?";
                queryParams.push(filterJobName);
              }

              query += " ORDER BY started_at DESC LIMIT ?";
              queryParams.push(limit);

              const rows = db.prepare(query).all(...queryParams) as Record<string, unknown>[];
              return jsonResult({ ok: true, table: "audit_runs", entries: rows, count: rows.length });
            }

            // Default: audit_log
            const entries = queryAuditLog({
              projectId,
              actor: actorFilter ?? undefined,
              action: actionFilter ?? undefined,
              targetType: targetType ?? undefined,
              targetId: targetId ?? undefined,
              since: since ?? undefined,
              limit,
            });

            return jsonResult({ ok: true, table: "audit_log", entries, count: entries.length });
          }

          case "trigger_sweep": {
            const result = await sweep({ projectId });

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "trigger_sweep",
              targetType: "project",
              targetId: projectId,
              detail: JSON.stringify(result),
            });

            return jsonResult({ ok: true, sweep: result });
          }

          case "dispatch_worker": {
            const taskId = readStringParam(params, "task_id_dispatch", { required: true })!;
            const prompt = readStringParam(params, "prompt", { required: true })!;
            const model = readStringParam(params, "model");

            const task = getTask(projectId, taskId);
            if (!task) {
              return jsonResult({ ok: false, reason: "Task not found" });
            }

            if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
              return jsonResult({
                ok: false,
                reason: `Cannot dispatch worker for task in state ${task.state}. Task must be ASSIGNED or IN_PROGRESS.`,
              });
            }

            // Enqueue through the dispatch queue (no more direct CLI spawn bypass)
            const priority = task.priority === "P0" ? 0 : task.priority === "P1" ? 1 : task.priority === "P3" ? 3 : 2;
            const queueItem = enqueue(projectId, taskId, {
              prompt: buildTaskPrompt(task, prompt),
              model: model ?? undefined,
            }, priority);

            if (!queueItem) {
              return jsonResult({ ok: false, reason: "Task already has a pending dispatch queue item" });
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "dispatch_worker",
              targetType: "task",
              targetId: taskId,
              detail: JSON.stringify({ queued: true, queueItemId: queueItem.id }),
            });

            return jsonResult({
              ok: true,
              queued: true,
              queueItemId: queueItem.id,
              taskId,
            });
          }

          case "refresh_context": {
            const agentIdForCtx = readStringParam(params, "agent_id_context") ?? caller;

            const entry = getAgentConfig(agentIdForCtx);
            if (!entry) {
              return jsonResult({ ok: false, reason: `Agent config not found for "${agentIdForCtx}".` });
            }

            const context = assembleContext(agentIdForCtx, entry.config, {
              projectId: entry.projectId,
              projectDir: entry.projectDir,
            });
            return jsonResult({ ok: true, context });
          }

          case "emit_event": {
            const eventType = readStringParam(params, "event_type", { required: true })!;
            const payloadStr = readStringParam(params, "event_payload") ?? "{}";
            const dedupKey = readStringParam(params, "dedup_key");

            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(payloadStr);
            } catch {
              return jsonResult({ ok: false, reason: "Invalid JSON in event_payload" });
            }

            const result = ingestEvent(
              projectId,
              eventType,
              "tool",
              payload,
              dedupKey ?? undefined,
            );

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "emit_event",
              targetType: "event",
              targetId: result.id,
              detail: JSON.stringify({ type: eventType, deduplicated: result.deduplicated }),
            });

            return jsonResult({ ok: true, ...result, type: eventType });
          }

          case "list_events": {
            const status = readStringParam(params, "event_status");
            const type = readStringParam(params, "event_type_filter");
            const limit = readNumberParam(params, "limit", { integer: true });

            // Validate event_status against known values
            if (status && !EVENT_STATUSES.includes(status as EventStatus)) {
              return jsonResult({
                ok: false,
                reason: `Invalid event_status "${status}". Valid values: ${EVENT_STATUSES.join(", ")}`,
              });
            }

            const events = listEvents(projectId, {
              status: status as EventStatus | undefined,
              type: type ?? undefined,
              limit: limit ?? undefined,
            });

            return jsonResult({ ok: true, events, count: events.length });
          }

          case "enqueue_work": {
            const taskId = readStringParam(params, "enqueue_task_id", { required: true })!;
            const priority = readNumberParam(params, "enqueue_priority", { integer: true });
            const payloadStr = readStringParam(params, "enqueue_payload");

            let payload: Record<string, unknown> | undefined;
            if (payloadStr) {
              try {
                payload = JSON.parse(payloadStr);
              } catch {
                return jsonResult({ ok: false, reason: "Invalid JSON in enqueue_payload" });
              }
            }

            const task = getTask(projectId, taskId);
            if (!task) {
              return jsonResult({ ok: false, reason: "Task not found" });
            }

            // Auto-transition OPEN → ASSIGNED so the dispatcher can claim the task.
            // Without this, every enqueue on an OPEN task fails with
            // "Task in non-dispatchable state: OPEN".
            let autoTransitioned = false;
            if (task.state === "OPEN") {
              const tr = transitionTask({
                projectId,
                taskId,
                toState: "ASSIGNED",
                actor: "system:dispatch",
                reason: "Auto-transitioned OPEN→ASSIGNED by enqueue_work",
              });
              if (!tr.ok) {
                return jsonResult({ ok: false, reason: `Failed to auto-transition task to ASSIGNED: ${tr.reason}` });
              }
              autoTransitioned = true;
            }

            const item = enqueue(projectId, taskId, payload, priority ?? undefined);
            if (!item) {
              return jsonResult({ ok: false, reason: "Task already has a non-terminal queue item" });
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "enqueue_work",
              targetType: "dispatch_queue",
              targetId: item.id,
              detail: JSON.stringify({ taskId, priority: item.priority, autoTransitioned }),
            });

            return jsonResult({ ok: true, queueItemId: item.id, taskId, priority: item.priority, autoTransitioned });
          }

          case "queue_status": {
            const status = getQueueStatus(projectId);
            const concurrency = getConcurrencyInfo();
            const detail = readStringParam(params, "detail") ?? "compact";

            // Alert indicators: dead letters and state-stuck in the last hour
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            let deadLettersLast1h = 0;
            let stateStuckLast1h = 0;
            try {
              const dlAgg = aggregateMetrics({ projectId, type: "dispatch", key: "dispatch_dead_letter", since: oneHourAgo });
              deadLettersLast1h = dlAgg[0]?.count ?? 0;
            } catch (err) { safeLog("ops.queueStatus.deadLetters", err); }
            try {
              const ssAgg = aggregateMetrics({ projectId, type: "dispatch", key: "dispatch_state_stuck", since: oneHourAgo });
              stateStuckLast1h = ssAgg[0]?.count ?? 0;
            } catch (err) { safeLog("ops.queueStatus.stateStuck", err); }

            const result: Record<string, unknown> = {
              ok: true,
              queued: status.queued,
              leased: status.leased,
              completed: status.completed,
              failed: status.failed,
              cancelled: status.cancelled,
              concurrency,
              alerts: { deadLettersLast1h, stateStuckLast1h },
            };
            // Only include full recent items when explicitly requested
            if (detail === "full") {
              result.recentItems = status.recentItems;
            }
            return jsonResult(result);
          }

          case "dispatch_metrics": {
            const since = readNumberParam(params, "since", { integer: true }) ?? (Date.now() - 24 * 60 * 60 * 1000);
            const until = Date.now();

            const agg = (key: string) => {
              try {
                const results = aggregateMetrics({ projectId, type: "dispatch", key, since, until });
                return results[0] ?? { key, count: 0, sum: 0, avg: 0, min: 0, max: 0 };
              } catch (err) { safeLog("ops.dispatchMetrics.agg", err); return { key, count: 0, sum: 0, avg: 0, min: 0, max: 0 }; }
            };

            const dispatchSuccess = agg("dispatch_success");
            const dispatchFailure = agg("dispatch_failure");
            const dispatchDuration = agg("dispatch_duration");
            const queueWaitTime = agg("queue_wait_time");
            const deadLetterCount = agg("dispatch_dead_letter").count;
            const stateStuckCount = agg("dispatch_state_stuck").count;
            const leaseExpiredCount = agg("queue_lease_expired").count;

            const totalDispatches = dispatchSuccess.count + dispatchFailure.count;
            const successRate = totalDispatches > 0
              ? Math.round((dispatchSuccess.count / totalDispatches) * 10000) / 100
              : null;

            let recentFailures: unknown[] = [];
            try {
              recentFailures = queryMetrics({ projectId, type: "dispatch", key: "dispatch_failure", since, limit: 5 });
            } catch (err) { safeLog("ops.dispatchMetrics.recentFailures", err); }

            return jsonResult({
              ok: true,
              timeWindow: { since, until },
              dispatchSuccess,
              dispatchFailure,
              dispatchDuration,
              queueWaitTime,
              deadLetterCount,
              stateStuckCount,
              leaseExpiredCount,
              successRate,
              recentFailures,
            });
          }

          case "process_events": {
            const result = await processAndDispatch(projectId);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "process_events",
              targetType: "project",
              targetId: projectId,
              detail: JSON.stringify(result),
            });

            return jsonResult({ ok: true, ...result });
          }

          // --- Job Management ---

          case "list_jobs": {
            const targetAgentId = readStringParam(params, "target_agent_id", { required: true })!;
            const jobs = listJobs(targetAgentId);
            if (jobs === null) {
              return jsonResult({ ok: false, reason: `Agent not found: ${targetAgentId}` });
            }

            return jsonResult({ ok: true, agentId: targetAgentId, jobs });
          }

          case "create_job": {
            const targetAgentId = readStringParam(params, "target_agent_id", { required: true })!;
            const jobName = readStringParam(params, "job_name", { required: true })!;
            const jobConfigStr = readStringParam(params, "job_config", { required: true })!;

            // Resolve caller agent ID from session key
            const callerSession = getSession(caller);
            const callerAgentId = callerSession?.agentId ?? caller;

            if (!canManageJobs(projectId, callerAgentId, targetAgentId)) {
              return jsonResult({ ok: false, reason: `Not authorized to manage jobs for agent ${targetAgentId}` });
            }

            // Validate job name format
            if (!/^[a-z][a-z0-9_-]*$/.test(jobName)) {
              return jsonResult({ ok: false, reason: `Invalid job name "${jobName}" — use lowercase alphanumeric with hyphens/underscores, starting with a letter.` });
            }

            // Check job doesn't already exist
            const existingJobs = listJobs(targetAgentId);
            if (existingJobs && existingJobs[jobName]) {
              return jsonResult({ ok: false, reason: `Job "${jobName}" already exists on agent ${targetAgentId}. Use update_job to modify it.` });
            }

            let jobConfig: Record<string, unknown>;
            try {
              jobConfig = JSON.parse(jobConfigStr);
            } catch {
              return jsonResult({ ok: false, reason: "Invalid JSON in job_config" });
            }

            const job = parseJobConfig(jobConfig);
            if (!upsertJob(targetAgentId, jobName, job)) {
              return jsonResult({ ok: false, reason: `Agent not found: ${targetAgentId}` });
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "create_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName, cron: job.cron }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              job,
              note: "Runtime change — will reset on restart. Update project YAML for persistence.",
            });
          }

          case "update_job": {
            const targetAgentId = readStringParam(params, "target_agent_id", { required: true })!;
            const jobName = readStringParam(params, "job_name", { required: true })!;
            const jobConfigStr = readStringParam(params, "job_config", { required: true })!;

            const callerSession = getSession(caller);
            const callerAgentId = callerSession?.agentId ?? caller;

            if (!canManageJobs(projectId, callerAgentId, targetAgentId)) {
              return jsonResult({ ok: false, reason: `Not authorized to manage jobs for agent ${targetAgentId}` });
            }

            const currentJobs = listJobs(targetAgentId);
            if (!currentJobs || !currentJobs[jobName]) {
              return jsonResult({ ok: false, reason: `Job "${jobName}" not found on agent ${targetAgentId}` });
            }

            let updates: Record<string, unknown>;
            try {
              updates = JSON.parse(jobConfigStr);
            } catch {
              return jsonResult({ ok: false, reason: "Invalid JSON in job_config" });
            }

            // Merge updates with existing job
            const existingJob = currentJobs[jobName]!;
            const merged = { ...existingJob, ...parseJobConfig(updates) };

            // Enforce wake bounds if agent has scheduling config
            if (merged.cron) {
              const agentEntry = getAgentConfig(targetAgentId);
              const wakeBounds = agentEntry?.config.scheduling?.wakeBounds;
              if (wakeBounds) {
                const { clampCronToWakeBounds } = await import("../scheduling/wake-bounds.js");
                merged.cron = clampCronToWakeBounds(merged.cron, wakeBounds);
              }
            }

            upsertJob(targetAgentId, jobName, merged);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "update_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName, updatedFields: Object.keys(updates) }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              job: merged,
              note: "Runtime change — will reset on restart. Update project YAML for persistence.",
            });
          }

          case "delete_job": {
            const targetAgentId = readStringParam(params, "target_agent_id", { required: true })!;
            const jobName = readStringParam(params, "job_name", { required: true })!;

            const callerSession = getSession(caller);
            const callerAgentId = callerSession?.agentId ?? caller;

            if (!canManageJobs(projectId, callerAgentId, targetAgentId)) {
              return jsonResult({ ok: false, reason: `Not authorized to manage jobs for agent ${targetAgentId}` });
            }

            if (!deleteJob(targetAgentId, jobName)) {
              return jsonResult({ ok: false, reason: `Job "${jobName}" not found on agent ${targetAgentId}` });
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "delete_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              deleted: true,
              note: "Runtime change — will reset on restart. Update project YAML for persistence.",
            });
          }

          case "introspect": {
            // Returns the calling agent's own config summary
            const callerSession = getSession(caller);
            const callerAgentId = callerSession?.agentId ?? caller;

            const entry = getAgentConfig(callerAgentId);
            if (!entry) {
              return jsonResult({ ok: false, reason: `Agent config not found for "${callerAgentId}"` });
            }

            const config = entry.config;
            const db = getDb(projectId);

            // Budget status
            let budget: unknown = null;
            try {
              budget = checkBudget({ projectId, agentId: callerAgentId });
            } catch (err) {
              safeLog("ops.introspect.budget", err);
            }

            // Recent SLO evaluations
            let sloEvals: unknown[] = [];
            try {
              const rows = db.prepare(
                `SELECT slo_name, passed, actual, threshold, evaluated_at
                 FROM slo_evaluations WHERE project_id = ?
                 ORDER BY evaluated_at DESC LIMIT 10`,
              ).all(projectId) as Record<string, unknown>[];
              sloEvals = rows;
            } catch (err) {
              safeLog("ops.introspect.slo", err);
            }

            // Active policies for this agent
            let policies: unknown[] = [];
            try {
              const rows = db.prepare(
                `SELECT name, type, enabled FROM policies
                 WHERE project_id = ? AND (target_agent IS NULL OR target_agent = ?)
                 AND enabled = 1`,
              ).all(projectId, callerAgentId) as Record<string, unknown>[];
              policies = rows;
            } catch (err) {
              safeLog("ops.introspect.policies", err);
            }

            return jsonResult({
              ok: true,
              agentId: callerAgentId,
              extends: config.extends,
              title: config.title,
              expectations: config.expectations,
              performance_policy: config.performance_policy,
              jobs: config.jobs ? Object.keys(config.jobs) : [],
              budget,
              recentSloEvaluations: sloEvals,
              activePolicies: policies,
            });
          }

          case "allocate_budget": {
            const parentAgentId = readStringParam(params, "parent_agent_id");
            const childAgentId = readStringParam(params, "child_agent_id");
            const dailyLimitCents = readNumberParam(params, "daily_limit_cents");
            const allocationConfigStr = readStringParam(params, "allocation_config");

            if (!parentAgentId || !childAgentId) {
              return jsonResult({ ok: false, error: "parent_agent_id and child_agent_id required" });
            }

            // Support v2 allocation_config JSON param alongside legacy daily_limit_cents
            let allocationConfig: import("../budget-cascade.js").BudgetAllocation | undefined;
            if (allocationConfigStr) {
              try {
                const parsed = JSON.parse(allocationConfigStr);
                // Accept BudgetConfigV2 format and use as BudgetAllocation (daily/hourly/monthly)
                const { normalizeBudgetConfig } = await import("../budget/normalize.js");
                const normalized = normalizeBudgetConfig(parsed);
                allocationConfig = {
                  hourly: normalized.hourly,
                  daily: normalized.daily,
                  monthly: normalized.monthly,
                };
              } catch {
                return jsonResult({ ok: false, error: "allocation_config must be valid JSON" });
              }
            } else if (dailyLimitCents == null) {
              return jsonResult({ ok: false, error: "Either allocation_config or daily_limit_cents required" });
            }

            const { allocateBudget } = await import("../budget-cascade.js");
            const db = getDb(projectId);
            const result = allocateBudget({
              projectId,
              parentAgentId,
              childAgentId,
              dailyLimitCents: dailyLimitCents ?? undefined,
              allocationConfig,
            }, db);
            if (result.ok) {
              writeAuditEntry({ projectId, actor: caller, action: "allocate_budget", targetType: "budget", targetId: childAgentId, detail: JSON.stringify({ parentAgentId, childAgentId, dailyLimitCents, allocationConfig }) }, db);
            }
            return jsonResult(result);
          }

          case "plan_create": {
            const plannedItemsStr = readStringParam(params, "planned_items");
            if (!plannedItemsStr) return jsonResult({ ok: false, error: "planned_items required (JSON array)" });
            let plannedItems;
            try { plannedItems = JSON.parse(plannedItemsStr); } catch { return jsonResult({ ok: false, error: "planned_items must be valid JSON" }); }
            const { createPlan } = await import("../scheduling/plans.js");
            const plan = createPlan({ projectId, agentId: caller, plannedItems }, getDb(projectId));
            writeAuditEntry({ projectId, actor: caller, action: "plan_create", targetType: "plan", targetId: plan.id, detail: JSON.stringify({ itemCount: plannedItems.length, estimatedCostCents: plan.estimatedCostCents }) }, getDb(projectId));
            return jsonResult({ ok: true, plan });
          }
          case "plan_start": {
            const planId = readStringParam(params, "plan_id");
            if (!planId) return jsonResult({ ok: false, error: "plan_id required" });
            const { startPlan } = await import("../scheduling/plans.js");
            startPlan(projectId, planId, getDb(projectId));
            return jsonResult({ ok: true, planId, status: "executing" });
          }
          case "plan_complete": {
            const planId = readStringParam(params, "plan_id");
            const actualResultsStr = readStringParam(params, "actual_results");
            if (!planId || !actualResultsStr) return jsonResult({ ok: false, error: "plan_id and actual_results required" });
            let actualResults;
            try { actualResults = JSON.parse(actualResultsStr); } catch { return jsonResult({ ok: false, error: "actual_results must be valid JSON" }); }
            const { completePlan } = await import("../scheduling/plans.js");
            completePlan(projectId, planId, { actualResults }, getDb(projectId));
            writeAuditEntry({ projectId, actor: caller, action: "plan_complete", targetType: "plan", targetId: planId }, getDb(projectId));
            return jsonResult({ ok: true, planId, status: "completed" });
          }
          case "plan_abandon": {
            const planId = readStringParam(params, "plan_id");
            if (!planId) return jsonResult({ ok: false, error: "plan_id required" });
            const { abandonPlan } = await import("../scheduling/plans.js");
            abandonPlan(projectId, planId, getDb(projectId));
            return jsonResult({ ok: true, planId, status: "abandoned" });
          }
          case "plan_list": {
            const { listPlans } = await import("../scheduling/plans.js");
            const limit = readNumberParam(params, "limit") ?? 10;
            const plans = listPlans(projectId, caller, getDb(projectId), limit);
            return jsonResult({ ok: true, plans });
          }

          // --- Knowledge Lifecycle ---

          case "flag_knowledge": {
            const sourceType = readStringParam(params, "source_type");
            const sourceRef = readStringParam(params, "source_ref");
            const flaggedContent = readStringParam(params, "flagged_content");
            const correction = readStringParam(params, "correction");
            const severity = readStringParam(params, "severity") ?? "medium";
            if (!sourceType || !sourceRef || !flaggedContent || !correction) {
              return jsonResult({ ok: false, error: "source_type, source_ref, flagged_content, and correction required" });
            }
            const { createFlag } = await import("../memory/demotion.js");
            const flag = createFlag({ projectId, agentId: caller, sourceType: sourceType as any, sourceRef, flaggedContent, correction, severity: severity as any }, getDb(projectId));
            writeAuditEntry({ projectId, actor: caller, action: "flag_knowledge", targetType: "knowledge", targetId: flag.id, detail: JSON.stringify({ sourceType, sourceRef, severity }) }, getDb(projectId));
            return jsonResult({ ok: true, flag });
          }
          case "approve_promotion": {
            const candidateId = readStringParam(params, "candidate_id");
            if (!candidateId) return jsonResult({ ok: false, error: "candidate_id required" });
            const { approveCandidate } = await import("../memory/promotion.js");
            approveCandidate(projectId, candidateId, getDb(projectId));
            writeAuditEntry({ projectId, actor: caller, action: "approve_promotion", targetType: "knowledge", targetId: candidateId }, getDb(projectId));
            return jsonResult({ ok: true, candidateId, status: "approved" });
          }
          case "dismiss_promotion": {
            const candidateId = readStringParam(params, "candidate_id");
            if (!candidateId) return jsonResult({ ok: false, error: "candidate_id required" });
            const { dismissCandidate } = await import("../memory/promotion.js");
            dismissCandidate(projectId, candidateId, getDb(projectId));
            return jsonResult({ ok: true, candidateId, status: "dismissed" });
          }
          case "resolve_flag": {
            const flagId = readStringParam(params, "flag_id");
            if (!flagId) return jsonResult({ ok: false, error: "flag_id required" });
            const { resolveFlag } = await import("../memory/demotion.js");
            resolveFlag(projectId, flagId, getDb(projectId));
            writeAuditEntry({ projectId, actor: caller, action: "resolve_flag", targetType: "knowledge", targetId: flagId }, getDb(projectId));
            return jsonResult({ ok: true, flagId, status: "resolved" });
          }
          case "dismiss_flag": {
            const flagId = readStringParam(params, "flag_id");
            if (!flagId) return jsonResult({ ok: false, error: "flag_id required" });
            const { dismissFlag } = await import("../memory/demotion.js");
            dismissFlag(projectId, flagId, getDb(projectId));
            return jsonResult({ ok: true, flagId, status: "dismissed" });
          }
          case "list_candidates": {
            const { listCandidates } = await import("../memory/promotion.js");
            const candidates = listCandidates(projectId, getDb(projectId), "pending");
            return jsonResult({ ok: true, candidates });
          }
          case "list_flags": {
            const { listFlags } = await import("../memory/demotion.js");
            const flags = listFlags(projectId, "pending", getDb(projectId));
            return jsonResult({ ok: true, flags });
          }

          case "init_questions": {
            const questions = getInitQuestions();
            return jsonResult({ questions });
          }

          case "route": {
            const routeConfigJson = readStringParam(params, "route_config");
            const streamDataJson = readStringParam(params, "stream_data");
            if (!routeConfigJson) return jsonResult({ error: "route_config is required" });

            let routeConfig, streamData;
            try {
              routeConfig = JSON.parse(routeConfigJson);
              streamData = streamDataJson ? JSON.parse(streamDataJson) : {};
            } catch {
              return jsonResult({ error: "Invalid JSON in route_config or stream_data" });
            }

            const { executeRoute } = await import("../streams/router.js");
            const results = await executeRoute(routeConfig, streamData, JSON.stringify(streamData), projectId);
            return jsonResult(results);
          }

          case "emergency_stop": {
            const reason = readStringParam(params, "reason") ?? "Activated by manager";
            activateEmergencyStop(projectId);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "emergency_stop",
              targetType: "project",
              targetId: projectId,
              detail: reason,
            });

            return jsonResult({ ok: true, emergencyStop: true, reason });
          }

          case "emergency_resume": {
            if (!isEmergencyStopActive(projectId)) {
              return jsonResult({ ok: false, reason: "Emergency stop is not active for this project." });
            }

            deactivateEmergencyStop(projectId);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "emergency_resume",
              targetType: "project",
              targetId: projectId,
            });

            return jsonResult({ ok: true, emergencyStop: false, message: "Emergency stop deactivated — dispatches resumed." });
          }

          case "disable_domain": {
            const reason = readStringParam(params, "reason") ?? "Disabled by manager";

            if (isDomainDisabled(projectId)) {
              const info = getDomainDisableInfo(projectId);
              return jsonResult({
                ok: false,
                reason: "Domain is already disabled.",
                existingDisable: info ? { reason: info.reason, disabledAt: info.disabledAt, disabledBy: info.disabledBy } : undefined,
              });
            }

            disableDomain(projectId, reason, caller);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "disable_domain",
              targetType: "domain",
              targetId: projectId,
              detail: reason,
            });

            return jsonResult({ ok: true, domainDisabled: true, reason });
          }

          case "enable_domain": {
            if (!isDomainDisabled(projectId)) {
              return jsonResult({ ok: false, reason: "Domain is not disabled." });
            }

            enableDomain(projectId);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "enable_domain",
              targetType: "domain",
              targetId: projectId,
            });

            return jsonResult({ ok: true, domainDisabled: false, message: "Domain enabled — dispatches will resume." });
          }

          case "domain_status": {
            const disabled = isDomainDisabled(projectId);
            const info = disabled ? getDomainDisableInfo(projectId) : null;
            const emergencyStop = isEmergencyStopActive(projectId);

            // Get disabled scopes summary
            const scopes = listDisabledScopes(projectId);
            const disabledAgentsList = listDisabledAgents(projectId);

            return jsonResult({
              ok: true,
              domainDisabled: disabled,
              domainDisableInfo: info ? { reason: info.reason, disabledAt: info.disabledAt, disabledBy: info.disabledBy } : null,
              emergencyStopActive: emergencyStop,
              disabledScopes: scopes.filter(s => s.scopeType !== "domain"),
              disabledAgents: disabledAgentsList,
            });
          }

          case "init_apply": {
            const answersJson = readStringParam(params, "init_answers");
            if (!answersJson) return jsonResult({ error: "init_answers is required" });

            let answers;
            try {
              answers = JSON.parse(answersJson);
            } catch {
              return jsonResult({ error: "init_answers must be valid JSON" });
            }

            const configDir = readStringParam(params, "config_dir") ??
              path.join(process.env.HOME ?? "/tmp", ".clawforce");

            const { global, domain } = buildConfigFromAnswers(answers);

            // Scaffold directory and write configs
            scaffoldConfigDir(configDir);

            // Write agents to global config
            if (global.agents) {
              const { loadGlobalConfig } = await import("../config/loader.js");
              const existing = loadGlobalConfig(configDir);
              Object.assign(existing.agents, global.agents);
              const YAML = await import("yaml");
              const configPath = path.join(configDir, "config.yaml");
              fs.writeFileSync(configPath, YAML.stringify(existing), "utf-8");
            }

            // Create domain
            initDomain(configDir, domain);

            // Get budget guidance
            const guidance = getBudgetGuidance(answers);

            return jsonResult({
              success: true,
              domain: domain.name,
              agents: domain.agents,
              config_dir: configDir,
              budget_guidance: guidance,
            });
          }

          // --- Experiment Management ---

          case "create_experiment": {
            const name = readStringParam(params, "experiment_name");
            if (!name) return jsonResult({ ok: false, reason: "experiment_name is required" });

            const variantsStr = readStringParam(params, "experiment_variants");
            if (!variantsStr) return jsonResult({ ok: false, reason: "experiment_variants is required (JSON array)" });

            let variants: Array<{ name: string; isControl?: boolean; config: Record<string, unknown> }>;
            try {
              variants = JSON.parse(variantsStr);
            } catch {
              return jsonResult({ ok: false, reason: "experiment_variants must be valid JSON array" });
            }

            const strategyStr = readStringParam(params, "experiment_strategy");
            let assignmentStrategy: Record<string, unknown> | undefined;
            if (strategyStr) {
              try {
                assignmentStrategy = JSON.parse(strategyStr);
              } catch {
                return jsonResult({ ok: false, reason: "experiment_strategy must be valid JSON" });
              }
            }

            const criteriaStr = readStringParam(params, "experiment_criteria");
            let completionCriteria: Record<string, unknown> | undefined;
            if (criteriaStr) {
              try {
                completionCriteria = JSON.parse(criteriaStr);
              } catch {
                return jsonResult({ ok: false, reason: "experiment_criteria must be valid JSON" });
              }
            }

            const db = getDb(projectId);
            try {
              const result = createExperiment(projectId, {
                name,
                description: readStringParam(params, "experiment_description") ?? undefined,
                hypothesis: readStringParam(params, "experiment_hypothesis") ?? undefined,
                assignmentStrategy: assignmentStrategy as any,
                completionCriteria: completionCriteria as any,
                autoApplyWinner: readBooleanParam(params, "experiment_auto_apply") ?? false,
                createdBy: caller,
                variants,
              }, db);

              writeAuditEntry({
                projectId,
                actor: caller,
                action: "create_experiment",
                targetType: "experiment",
                targetId: result.id,
                detail: JSON.stringify({ name, variantCount: variants.length }),
              }, db);

              return jsonResult({ ok: true, experiment: result });
            } catch (err) {
              return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          case "start_experiment": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            try {
              const result = startExperiment(projectId, experimentId, db);
              writeAuditEntry({ projectId, actor: caller, action: "start_experiment", targetType: "experiment", targetId: experimentId }, db);
              return jsonResult({ ok: true, experiment: result });
            } catch (err) {
              return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          case "pause_experiment": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            try {
              const result = pauseExperiment(projectId, experimentId, db);
              writeAuditEntry({ projectId, actor: caller, action: "pause_experiment", targetType: "experiment", targetId: experimentId }, db);
              return jsonResult({ ok: true, experiment: result });
            } catch (err) {
              return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          case "complete_experiment": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            try {
              const result = completeExperiment(projectId, experimentId, undefined, db);
              writeAuditEntry({ projectId, actor: caller, action: "complete_experiment", targetType: "experiment", targetId: experimentId }, db);
              return jsonResult({ ok: true, experiment: result });
            } catch (err) {
              return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          case "kill_experiment": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            try {
              const result = killExperiment(projectId, experimentId, db);
              writeAuditEntry({ projectId, actor: caller, action: "kill_experiment", targetType: "experiment", targetId: experimentId }, db);
              return jsonResult({ ok: true, experiment: result });
            } catch (err) {
              return jsonResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
            }
          }

          case "apply_experiment": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            const exp = getExperiment(projectId, experimentId, db);
            if (!exp) return jsonResult({ ok: false, reason: `Experiment not found: ${experimentId}` });

            if (exp.state !== "completed") {
              return jsonResult({ ok: false, reason: `Cannot apply experiment in state "${exp.state}" — must be "completed"` });
            }

            // Determine winner: use stored winner or compute from results
            let winnerVariantId = exp.winnerVariantId;
            if (!winnerVariantId) {
              const results = getExperimentResults(projectId, experimentId, db);
              winnerVariantId = results.winner?.id;
            }

            if (!winnerVariantId) {
              return jsonResult({ ok: false, reason: "No winner variant determined. Complete the experiment with a winner or ensure variants have session data." });
            }

            const winnerVariant = exp.variants.find(v => v.id === winnerVariantId);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "apply_experiment",
              targetType: "experiment",
              targetId: experimentId,
              detail: JSON.stringify({ winnerVariantId, winnerVariantName: winnerVariant?.name }),
            }, db);

            return jsonResult({
              ok: true,
              experimentId,
              winnerVariantId,
              winnerVariant: winnerVariant ?? null,
              message: "Winner variant identified. Apply variant config to agent configuration manually.",
            });
          }

          case "experiment_status": {
            const experimentId = readStringParam(params, "experiment_id");
            if (!experimentId) return jsonResult({ ok: false, reason: "experiment_id is required" });

            const db = getDb(projectId);
            const exp = getExperiment(projectId, experimentId, db);
            if (!exp) return jsonResult({ ok: false, reason: `Experiment not found: ${experimentId}` });

            const results = getExperimentResults(projectId, experimentId, db);

            return jsonResult({ ok: true, experiment: exp, results });
          }

          case "list_experiments": {
            const stateFilter = readStringParam(params, "experiment_state_filter");
            const db = getDb(projectId);
            const experiments = listExperiments(projectId, stateFilter as ExperimentState | undefined, db);
            return jsonResult({ ok: true, experiments, count: experiments.length });
          }

          case "propose_feature": {
            const title = readStringParam(params, "proposal_title");
            const description = readStringParam(params, "proposal_description");
            const reasoning = readStringParam(params, "proposal_reasoning");
            const relatedGoalId = readStringParam(params, "proposal_goal_id");
            if (!title) return jsonResult({ ok: false, reason: "proposal_title is required" });
            if (!description) return jsonResult({ ok: false, reason: "proposal_description is required" });

            const db = getDb(projectId);
            const proposalId = randomUUID();
            const now = Date.now();

            db.prepare(`
              INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, created_at, origin, reasoning, related_goal_id)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'lead_proposal', ?, ?)
            `).run(
              proposalId,
              projectId,
              title,
              description,
              caller,
              options?.agentSessionKey ?? null,
              now,
              reasoning ?? null,
              relatedGoalId ?? null,
            );

            // Emit proposal_created event
            try {
              ingestEvent(projectId, "proposal_created", "internal", {
                proposalId,
                proposedBy: caller,
                origin: "lead_proposal",
                title,
                reasoning: reasoning ?? undefined,
                relatedGoalId: relatedGoalId ?? undefined,
              }, `proposal-created:${proposalId}`);
            } catch (err) {
              safeLog("ops.propose_feature.event", err);
            }

            // Notify via approval channel if available
            try {
              const { getApprovalNotifier } = await import("../approval/notify.js");
              const notifier = getApprovalNotifier();
              if (notifier) {
                await notifier.sendProposalNotification({
                  proposalId,
                  projectId,
                  title,
                  description,
                  proposedBy: caller,
                  riskTier: "low",
                });
              }
            } catch (err) {
              safeLog("ops.propose_feature.notify", err);
            }

            return jsonResult({
              ok: true,
              proposalId,
              origin: "lead_proposal",
              status: "pending",
              message: "Feature proposal submitted for user approval.",
            });
          }

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

// --- Helpers ---

import type { JobDefinition, ContextSource, Expectation, PerformancePolicy, CronDelivery, CronFailureAlert } from "../types.js";

/** Parse a raw JSON object into a JobDefinition. */
function parseJobConfig(raw: Record<string, unknown>): JobDefinition {
  const job: JobDefinition = {};
  if (typeof raw.cron === "string" && raw.cron.trim()) job.cron = raw.cron.trim();
  if (Array.isArray(raw.briefing)) job.briefing = raw.briefing as ContextSource[];
  if (Array.isArray(raw.exclude_briefing)) job.exclude_briefing = raw.exclude_briefing as string[];
  if (Array.isArray(raw.expectations)) job.expectations = raw.expectations as Expectation[];
  if (raw.performance_policy && typeof raw.performance_policy === "object") {
    job.performance_policy = raw.performance_policy as PerformancePolicy;
  }
  if (raw.compaction !== undefined) job.compaction = raw.compaction as boolean;
  if (typeof raw.nudge === "string" && raw.nudge.trim()) job.nudge = raw.nudge.trim();
  if (typeof raw.cronTimezone === "string" && raw.cronTimezone.trim()) job.cronTimezone = raw.cronTimezone.trim();
  if (typeof raw.sessionTarget === "string") job.sessionTarget = raw.sessionTarget as "main" | "isolated";
  if (typeof raw.wakeMode === "string") job.wakeMode = raw.wakeMode as "next-heartbeat" | "now";
  if (typeof raw.delivery === "object" && raw.delivery !== null) job.delivery = raw.delivery as CronDelivery;
  if (raw.failureAlert !== undefined) job.failureAlert = raw.failureAlert as CronFailureAlert;
  if (typeof raw.model === "string" && raw.model.trim()) job.model = raw.model.trim();
  if (typeof raw.timeoutSeconds === "number") job.timeoutSeconds = raw.timeoutSeconds;
  if (typeof raw.lightContext === "boolean") job.lightContext = raw.lightContext;
  if (typeof raw.deleteAfterRun === "boolean") job.deleteAfterRun = raw.deleteAfterRun;
  return job;
}
