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
import { listDisabledAgents, disableAgent, enableAgent, isAgentDisabled } from "../enforcement/disabled-store.js";
import { countRecentRetries } from "../enforcement/retry-store.js";
import { detectStuckAgents } from "../audit/stuck-detector.js";
import { killStuckAgent } from "../audit/auto-kill.js";
import { writeAuditEntry, queryAuditLog } from "../audit.js";
import { getDb } from "../db.js";
import { getTask, reassignTask } from "../tasks/ops.js";
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
import { getCronService, buildJobCronJob, toCronJobCreate } from "../manager-cron.js";
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

const OPS_ACTIONS = [
  "agent_status", "kill_agent", "disable_agent", "enable_agent",
  "reassign", "query_audit", "trigger_sweep", "dispatch_worker",
  "refresh_context", "emit_event", "list_events", "enqueue_work",
  "queue_status", "process_events", "dispatch_metrics",
  "list_jobs", "create_job", "update_job", "delete_job", "toggle_job_cron",
  "cron_status", "introspect", "allocate_budget",
  "plan_create", "plan_start", "plan_complete", "plan_abandon", "plan_list",
  "flag_knowledge", "approve_promotion", "dismiss_promotion", "resolve_flag", "dismiss_flag", "list_candidates", "list_flags",
  "init_questions", "init_apply",
] as const;

const ClawforceOpsSchema = Type.Object({
  action: stringEnum(OPS_ACTIONS, { description: "Action to perform." }),
  project_id: Type.String({ description: "Project identifier (required for all ops actions)." }),
  session_key: Type.Optional(Type.String({ description: "Session key (for kill_agent)." })),
  agent_id: Type.Optional(Type.String({ description: "Agent identifier (for disable_agent/enable_agent)." })),
  reason: Type.Optional(Type.String({ description: "Reason (for disable_agent)." })),
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
  target_agent_id: Type.Optional(Type.String({ description: "Target agent ID (for list_jobs, create_job, update_job, delete_job, toggle_job_cron)." })),
  job_name: Type.Optional(Type.String({ description: "Job name (for create_job, update_job, delete_job, toggle_job_cron)." })),
  job_config: Type.Optional(Type.String({ description: "JSON object with job fields: cron, cronTimezone, briefing, exclude_briefing, expectations, performance_policy, compaction, nudge, sessionTarget, wakeMode, delivery, failureAlert, model, timeoutSeconds, lightContext, deleteAfterRun (for create_job, update_job)." })),
  job_enabled: Type.Optional(Type.Boolean({ description: "Enable (true) or disable (false) the job cron (for toggle_job_cron)." })),
  cron_job_name: Type.Optional(Type.String({ description: "Cron job name filter (for cron_status). If omitted, returns all project crons." })),
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
      "Read: agent_status, query_audit, refresh_context, list_events, queue_status, dispatch_metrics, list_jobs, cron_status, introspect. " +
      "Write: kill_agent, disable_agent, enable_agent, reassign, trigger_sweep, dispatch_worker, emit_event, enqueue_work, process_events, create_job, update_job, delete_job, toggle_job_cron, allocate_budget. " +
      "Job management: list_jobs (view agent jobs), create_job/update_job/delete_job (manage scoped sessions), toggle_job_cron (enable/disable job cron), cron_status (view cron run state). " +
      "introspect: view your own config, expectations, budget, and SLO status. " +
      "Use emit_event to ingest external events (CI failures, PR opens, etc). " +
      "Use enqueue_work to add tasks to the dispatch queue with priority. " +
      "Use process_events to trigger event processing + dispatch. " +
      "Knowledge lifecycle: flag_knowledge (report wrong knowledge), approve_promotion/dismiss_promotion (manage promotion candidates), resolve_flag/dismiss_flag (manage knowledge corrections), list_candidates/list_flags (view pending items). " +
      "Init flow: init_questions (get setup wizard questions), init_apply (apply answers to scaffold config). ",
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
            const agentId = readStringParam(params, "agent_id", { required: true })!;
            const reason = readStringParam(params, "reason") ?? "Terminated by manager";

            disableAgent(projectId, agentId, reason);

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "disable_agent",
              targetType: "agent",
              targetId: agentId,
              detail: reason,
            });

            return jsonResult({ ok: true, agentId, disabled: true, reason });
          }

          case "enable_agent": {
            const agentId = readStringParam(params, "agent_id", { required: true })!;

            if (!isAgentDisabled(projectId, agentId)) {
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

            return jsonResult({ ok: true, agentId, disabled: false });
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
              detail: JSON.stringify({ taskId, priority: item.priority }),
            });

            return jsonResult({ ok: true, queueItemId: item.id, taskId, priority: item.priority });
          }

          case "queue_status": {
            const status = getQueueStatus(projectId);
            const concurrency = getConcurrencyInfo();

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

            return jsonResult({
              ok: true,
              ...status,
              concurrency,
              alerts: { deadLettersLast1h, stateStuckLast1h },
            });
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

            // Enrich with cron status if service available
            const cronSvc = getCronService();
            let cronStatuses: Record<string, Record<string, unknown>> = {};
            if (cronSvc) {
              try {
                const allCrons = await cronSvc.list({ includeDisabled: true });
                for (const [jobName] of Object.entries(jobs)) {
                  const cronName = `job-${projectId}-${targetAgentId}-${jobName}`;
                  const found = allCrons.find((c) => c.name === cronName);
                  if (found) {
                    cronStatuses[jobName] = {
                      enabled: found.enabled,
                      cronId: found.id,
                      schedule: found.schedule,
                      lastRunStatus: found.state?.lastRunStatus,
                      lastRunAtMs: found.state?.lastRunAtMs,
                      nextRunAtMs: found.state?.nextRunAtMs,
                      consecutiveErrors: found.state?.consecutiveErrors,
                      lastDeliveryStatus: found.state?.lastDeliveryStatus,
                    };
                  }
                }
              } catch (err) {
                safeLog("ops.listJobs.cronStatus", err);
              }
            }

            return jsonResult({ ok: true, agentId: targetAgentId, jobs, cronStatuses });
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

            // Register cron if specified
            let cronRegistered = false;
            if (job.cron) {
              const cronSvc = getCronService();
              if (cronSvc) {
                try {
                  const cronJob = buildJobCronJob(projectId, targetAgentId, jobName, job, job.cron);
                  await cronSvc.add(toCronJobCreate(cronJob));
                  cronRegistered = true;
                } catch (err) {
                  safeLog("ops.createJob.cronRegister", err);
                }
              }
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "create_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName, cron: job.cron, cronRegistered }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              job,
              cronRegistered,
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

            // Re-register cron if schedule changed
            let cronUpdated = false;
            if (updates.cron !== undefined && merged.cron) {
              const cronSvc = getCronService();
              if (cronSvc) {
                try {
                  const cronJob = buildJobCronJob(projectId, targetAgentId, jobName, merged, merged.cron);
                  await cronSvc.add(toCronJobCreate(cronJob));
                  cronUpdated = true;
                } catch (err) {
                  safeLog("ops.updateJob.cronUpdate", err);
                }
              }
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "update_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName, updatedFields: Object.keys(updates), cronUpdated }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              job: merged,
              cronUpdated,
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

            // Disable the cron if it exists
            let cronDisabled = false;
            const cronSvc = getCronService();
            if (cronSvc) {
              try {
                const cronName = `job-${projectId}-${targetAgentId}-${jobName}`;
                const allCrons = await cronSvc.list({ includeDisabled: true });
                const found = allCrons.find((c) => c.name === cronName);
                if (found) {
                  await cronSvc.update(found.id, { enabled: false });
                  cronDisabled = true;
                }
              } catch (err) {
                safeLog("ops.deleteJob.cronDisable", err);
              }
            }

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "delete_job",
              targetType: "agent",
              targetId: targetAgentId,
              detail: JSON.stringify({ jobName, cronDisabled }),
            });

            return jsonResult({
              ok: true,
              agentId: targetAgentId,
              jobName,
              deleted: true,
              cronDisabled,
              note: "Runtime change — will reset on restart. Update project YAML for persistence.",
            });
          }

          case "toggle_job_cron": {
            const targetAgentId = readStringParam(params, "target_agent_id", { required: true })!;
            const jobName = readStringParam(params, "job_name", { required: true })!;
            const enabled = readBooleanParam(params, "job_enabled");

            if (enabled === undefined || enabled === null) {
              return jsonResult({ ok: false, reason: "Missing required parameter: job_enabled (true or false)" });
            }

            const callerSession = getSession(caller);
            const callerAgentId = callerSession?.agentId ?? caller;

            if (!canManageJobs(projectId, callerAgentId, targetAgentId)) {
              return jsonResult({ ok: false, reason: `Not authorized to manage jobs for agent ${targetAgentId}` });
            }

            const cronSvc = getCronService();
            if (!cronSvc) {
              return jsonResult({ ok: false, reason: "Cron service not available" });
            }

            const cronName = `job-${projectId}-${targetAgentId}-${jobName}`;
            try {
              const allCrons = await cronSvc.list({ includeDisabled: true });
              const found = allCrons.find((c) => c.name === cronName);
              if (!found) {
                return jsonResult({ ok: false, reason: `No cron found for job "${jobName}" on agent ${targetAgentId}` });
              }

              await cronSvc.update(found.id, { enabled });

              writeAuditEntry({
                projectId,
                actor: caller,
                action: "toggle_job_cron",
                targetType: "agent",
                targetId: targetAgentId,
                detail: JSON.stringify({ jobName, enabled }),
              });

              return jsonResult({ ok: true, agentId: targetAgentId, jobName, cronEnabled: enabled });
            } catch (err) {
              return jsonResult({ ok: false, reason: `Failed to toggle cron: ${err instanceof Error ? err.message : String(err)}` });
            }
          }

          case "cron_status": {
            const cronSvc = getCronService();
            if (!cronSvc) {
              return jsonResult({ ok: false, reason: "Cron service not available" });
            }

            const targetJobName = readStringParam(params, "cron_job_name");

            try {
              const allCrons = await cronSvc.list({ includeDisabled: true });
              const projectPrefix = `manager-${projectId}`;
              const jobPrefix = `job-${projectId}-`;
              const projectCrons = allCrons.filter(
                (c) => c.name === projectPrefix || c.name.startsWith(jobPrefix),
              );

              if (targetJobName) {
                const found = projectCrons.find((c) => c.name === targetJobName || c.name.endsWith(`-${targetJobName}`));
                if (!found) {
                  return jsonResult({ ok: false, reason: `Cron job not found: ${targetJobName}` });
                }
                return jsonResult({
                  ok: true,
                  job: {
                    id: found.id,
                    name: found.name,
                    enabled: found.enabled,
                    schedule: found.schedule,
                    state: found.state,
                  },
                });
              }

              const summary = projectCrons.map((c) => ({
                id: c.id,
                name: c.name,
                enabled: c.enabled,
                schedule: c.schedule,
                lastRunStatus: c.state?.lastRunStatus,
                lastRunAtMs: c.state?.lastRunAtMs,
                nextRunAtMs: c.state?.nextRunAtMs,
                consecutiveErrors: c.state?.consecutiveErrors,
                lastDeliveryStatus: c.state?.lastDeliveryStatus,
              }));

              return jsonResult({ ok: true, crons: summary, count: summary.length });
            } catch (err) {
              return jsonResult({ ok: false, reason: `Failed to query cron status: ${err instanceof Error ? err.message : String(err)}` });
            }
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
            if (!parentAgentId || !childAgentId || dailyLimitCents == null) {
              return jsonResult({ ok: false, error: "parent_agent_id, child_agent_id, and daily_limit_cents required" });
            }
            const { allocateBudget } = await import("../budget-cascade.js");
            const db = getDb(projectId);
            const result = allocateBudget({ projectId, parentAgentId, childAgentId, dailyLimitCents }, db);
            if (result.ok) {
              writeAuditEntry({ projectId, actor: caller, action: "allocate_budget", targetType: "budget", targetId: childAgentId, detail: JSON.stringify({ parentAgentId, childAgentId, dailyLimitCents }) }, db);
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
