/**
 * Clawforce — Ops tool
 *
 * Runtime observability and control for manager agents.
 * Provides agent status, kill/disable/enable, reassign, audit queries, and sweep trigger.
 */

import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import { getActiveSessions, getSession } from "../enforcement/tracker.js";
import { listDisabledAgents, disableAgent, enableAgent, isAgentDisabled } from "../enforcement/disabled-store.js";
import { countRecentRetries } from "../enforcement/retry-store.js";
import { detectStuckAgents } from "../audit/stuck-detector.js";
import { killStuckAgent } from "../audit/auto-kill.js";
import { writeAuditEntry, queryAuditLog } from "../audit.js";
import { getDb } from "../db.js";
import { getTask, reassignTask } from "../tasks/ops.js";
import { sweep } from "../sweep/actions.js";
import { dispatchAndTransition } from "../dispatch/spawn.js";
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
import { safeLog } from "../diagnostics.js";
import type { ToolResult } from "./common.js";
import {
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
  readStringArrayParam,
  safeExecute,
} from "./common.js";

const OPS_ACTIONS = [
  "agent_status", "kill_agent", "disable_agent", "enable_agent",
  "reassign", "query_audit", "trigger_sweep", "dispatch_worker",
  "refresh_context", "emit_event", "list_events", "enqueue_work",
  "queue_status", "process_events", "dispatch_metrics",
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
});

export function createClawforceOpsTool(options?: {
  agentSessionKey?: string;
}) {
  return {
    label: "Team Operations",
    name: "clawforce_ops",
    description:
      "Team observability and control. " +
      "Read: agent_status, query_audit, refresh_context, list_events, queue_status, dispatch_metrics. " +
      "Write: kill_agent, disable_agent, enable_agent, reassign, trigger_sweep, dispatch_worker, emit_event, enqueue_work, process_events. " +
      "Use emit_event to ingest external events (CI failures, PR opens, etc). " +
      "Use enqueue_work to add tasks to the dispatch queue with priority. " +
      "Use process_events to trigger event processing + dispatch. " +
      "Use queue_status to see dispatch queue depth and recent items. " +
      "Use dispatch_metrics for a health dashboard of the dispatch system.",
    parameters: ClawforceOpsSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const projectId = readStringParam(params, "project_id", { required: true })!;
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
            const projectDir = readStringParam(params, "project_dir", { required: true })!;
            const prompt = readStringParam(params, "prompt", { required: true })!;
            const profile = readStringParam(params, "profile");
            const model = readStringParam(params, "model");
            const timeoutMs = readNumberParam(params, "timeout_ms", { integer: true });
            const allowedTools = readStringArrayParam(params, "allowed_tools");
            const maxTurns = readNumberParam(params, "max_turns", { integer: true });

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

            const dispatchResult = await dispatchAndTransition({
              task,
              projectDir,
              prompt,
              profile: profile ?? undefined,
              model: model ?? undefined,
              timeoutMs: timeoutMs ?? undefined,
              allowedTools: allowedTools ?? undefined,
              maxTurns: maxTurns ?? undefined,
            });

            writeAuditEntry({
              projectId,
              actor: caller,
              action: "dispatch_worker",
              targetType: "task",
              targetId: taskId,
              detail: JSON.stringify({
                ok: dispatchResult.ok,
                exitCode: dispatchResult.exitCode,
                durationMs: dispatchResult.durationMs,
                evidenceId: dispatchResult.evidenceId,
              }),
            });

            return jsonResult({
              ok: dispatchResult.ok,
              taskId,
              exitCode: dispatchResult.exitCode,
              durationMs: dispatchResult.durationMs,
              evidenceId: dispatchResult.evidenceId,
              stderr: dispatchResult.ok ? undefined : dispatchResult.stderr.slice(0, 500),
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
              eventType as import("../types.js").EventType,
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

            const events = listEvents(projectId, {
              status: status as import("../types.js").EventStatus | undefined,
              type: type as import("../types.js").EventType | undefined,
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

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}
