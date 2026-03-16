import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  attachEvidence,
  createTask,
  getTask,
  getTaskEvidence,
  getTaskTransitions,
  listTasks,
  transitionTask,
} from "../tasks/ops.js";
import {
  addDependency,
  removeDependency,
  getTaskDependencies,
  getTaskDependents,
  getUnresolvedBlockers,
} from "../tasks/deps.js";
import { markWorkerCompliant } from "../tasks/compliance.js";
import { getDb } from "../db.js";
import { getApprovalPolicy } from "../project.js";
import { getProposal } from "../approval/resolve.js";
import { queryMetrics } from "../metrics.js";
import type { MetricType } from "../metrics.js";
import { EVIDENCE_TYPES, TASK_PRIORITIES, TASK_STATES } from "../types.js";
import type { EvidenceType, TaskPriority, TaskState } from "../types.js";
import { getAgentConfig } from "../project.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam, resolveProjectId, safeExecute } from "./common.js";

const TASK_ACTIONS = [
  "create", "transition", "attach_evidence", "get", "list", "history", "fail",
  "get_approval_context", "submit_proposal", "check_proposal", "metrics",
  "bulk_create", "bulk_transition",
  "add_dep", "remove_dep", "list_deps", "list_dependents", "list_blockers",
] as const;

const ClawforceTaskSchema = Type.Object({
  action: stringEnum(TASK_ACTIONS, { description: "Action to perform on the task system." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (for transition/get/attach_evidence/history/fail)." })),
  title: Type.Optional(Type.String({ description: "Task title (for create)." })),
  description: Type.Optional(Type.String({ description: "Task description (for create)." })),
  priority: Type.Optional(Type.String({ description: "Priority: P0, P1, P2, P3 (for create)." })),
  assigned_to: Type.Optional(Type.String({ description: "Agent to assign (for create)." })),
  to_state: Type.Optional(Type.String({ description: "Target state (for transition)." })),
  reason: Type.Optional(Type.String({ description: "Reason for transition or failure." })),
  evidence_id: Type.Optional(Type.String({ description: "Evidence ID to attach to transition." })),
  evidence_type: Type.Optional(Type.String({ description: "Evidence type: output (default), diff, test_result, screenshot, log, custom." })),
  evidence_content: Type.Optional(Type.String({ description: "Evidence content (for attach_evidence/fail)." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for filtering." })),
  max_retries: Type.Optional(Type.Number({ description: "Max retries (for create, default 3)." })),
  deadline: Type.Optional(Type.Number({ description: "Deadline as Unix timestamp ms (for create)." })),
  workflow_id: Type.Optional(Type.String({ description: "Workflow ID (for create/list)." })),
  state: Type.Optional(Type.Array(Type.String(), { description: "Filter by state(s): OPEN, ASSIGNED, IN_PROGRESS, REVIEW, DONE, FAILED, BLOCKED." })),
  goal_id: Type.Optional(Type.String({ description: "Goal ID to link task to (for create)." })),
  department: Type.Optional(Type.String({ description: "Filter by department (for list)." })),
  team: Type.Optional(Type.String({ description: "Filter by team (for list)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for list, default 100)." })),
  proposal_id: Type.Optional(Type.String({ description: "Proposal ID (for submit_proposal)." })),
  type: Type.Optional(Type.String({ description: "Metric type filter: task_cycle, agent_performance, dispatch, sweep, system (for metrics)." })),
  key: Type.Optional(Type.String({ description: "Metric key filter (for metrics)." })),
  since: Type.Optional(Type.Number({ description: "Start timestamp ms (for metrics)." })),
  // dependency params
  depends_on_task_id: Type.Optional(Type.String({ description: "Task ID that this task depends on (for add_dep/remove_dep)." })),
  dep_type: Type.Optional(Type.String({ description: "Dependency type: blocks (hard, default) or soft (advisory)." })),
  // bulk operation params
  tasks: Type.Optional(Type.Array(
    Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
      assigned_to: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      max_retries: Type.Optional(Type.Number()),
      deadline: Type.Optional(Type.Number()),
      workflow_id: Type.Optional(Type.String()),
      goal_id: Type.Optional(Type.String()),
    }),
    { description: "Array of task definitions (for bulk_create)." },
  )),
  transitions: Type.Optional(Type.Array(
    Type.Object({
      task_id: Type.String(),
      to_state: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    { description: "Array of transitions (for bulk_transition)." },
  )),
});

export function createClawforceTaskTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
}) {
  return {
    label: "Work Management",
    name: "clawforce_task",
    description:
      "Manage work assignments. " +
      "CRUD: create, get, list, history, bulk_create. " +
      "Lifecycle: transition, fail, attach_evidence, bulk_transition. " +
      "Dependencies: add_dep, remove_dep, list_deps, list_dependents, list_blockers. " +
      "Approval: get_approval_context, submit_proposal, check_proposal. " +
      "Tasks follow OPEN → ASSIGNED → IN_PROGRESS → REVIEW → DONE lifecycle with mandatory cross-team verification.",
    parameters: ClawforceTaskSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
      const action = readStringParam(params, "action", { required: true })!;
      const resolved = resolveProjectId(params, options?.projectId);
      if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
      const projectId = resolved.projectId!;
      const actor = options?.agentSessionKey ?? "unknown";

      switch (action) {
        case "create": {
          const title = readStringParam(params, "title", { required: true })!;
          const description = readStringParam(params, "description");
          const priorityRaw = readStringParam(params, "priority");
          if (priorityRaw && !TASK_PRIORITIES.includes(priorityRaw as TaskPriority)) {
            return jsonResult({ ok: false, reason: `Invalid priority: ${priorityRaw}. Must be one of: ${TASK_PRIORITIES.join(", ")}` });
          }
          const priority = priorityRaw as TaskPriority | undefined;
          const assignedTo = readStringParam(params, "assigned_to");
          const maxRetries = readNumberParam(params, "max_retries", { integer: true });
          const deadline = readNumberParam(params, "deadline", { integer: true });
          const tags = readStringArrayParam(params, "tags");
          const workflowId = readStringParam(params, "workflow_id");
          const goalId = readStringParam(params, "goal_id");

          const task = createTask({
            projectId,
            title,
            description: description ?? undefined,
            priority: priority ?? undefined,
            assignedTo: assignedTo ?? undefined,
            createdBy: actor,
            maxRetries: maxRetries ?? undefined,
            deadline: deadline ?? undefined,
            tags: tags ?? undefined,
            workflowId: workflowId ?? undefined,
            goalId: goalId ?? undefined,
          });
          const dupWarning = (task as Record<string, unknown>).duplicateWarning as string | undefined;
          const result: Record<string, unknown> = { ok: true, task };
          if (dupWarning) result.warning = dupWarning;
          return jsonResult(result);
        }

        case "transition": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const toStateRaw = readStringParam(params, "to_state", { required: true })!;
          if (!TASK_STATES.includes(toStateRaw as TaskState)) {
            return jsonResult({ ok: false, reason: `Invalid state: ${toStateRaw}. Must be one of: ${TASK_STATES.join(", ")}` });
          }
          const toState = toStateRaw as TaskState;
          const reason = readStringParam(params, "reason");
          const evidenceId = readStringParam(params, "evidence_id");
          const assignedTo = readStringParam(params, "assigned_to");

          const result = transitionTask({
            projectId,
            taskId,
            toState,
            actor,
            reason: reason ?? undefined,
            evidenceId: evidenceId ?? undefined,
            assignedTo: assignedTo ?? undefined,
          });

          // Track compliance: worker called transition on its task
          if (result.ok && options?.agentSessionKey) {
            markWorkerCompliant(options.agentSessionKey);
          }

          return jsonResult(result);
        }

        case "attach_evidence": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const evidenceTypeRaw = readStringParam(params, "evidence_type") ?? "output";
          if (!EVIDENCE_TYPES.includes(evidenceTypeRaw as EvidenceType)) {
            return jsonResult({ ok: false, reason: `Invalid evidence type: ${evidenceTypeRaw}. Must be one of: ${EVIDENCE_TYPES.join(", ")}` });
          }
          const evidenceType = evidenceTypeRaw as EvidenceType;
          const content = readStringParam(params, "evidence_content", { required: true })!;

          const evidence = attachEvidence({
            projectId,
            taskId,
            type: evidenceType,
            content,
            attachedBy: actor,
          });
          return jsonResult({ ok: true, evidence });
        }

        case "get": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const task = getTask(projectId, taskId);
          if (!task) return jsonResult({ ok: false, reason: "Task not found" });
          const evidence = getTaskEvidence(projectId, taskId);
          return jsonResult({ ok: true, task, evidence });
        }

        case "list": {
          const statesRaw = readStringArrayParam(params, "state");
          if (statesRaw) {
            for (const s of statesRaw) {
              if (!TASK_STATES.includes(s as TaskState)) {
                return jsonResult({ ok: false, reason: `Invalid state filter: ${s}. Must be one of: ${TASK_STATES.join(", ")}` });
              }
            }
          }
          const assignedTo = readStringParam(params, "assigned_to");
          const priorityRaw2 = readStringParam(params, "priority");
          if (priorityRaw2 && !TASK_PRIORITIES.includes(priorityRaw2 as TaskPriority)) {
            return jsonResult({ ok: false, reason: `Invalid priority: ${priorityRaw2}. Must be one of: ${TASK_PRIORITIES.join(", ")}` });
          }
          const priority = priorityRaw2 as TaskPriority | undefined;
          const tags = readStringArrayParam(params, "tags");
          const workflowId = readStringParam(params, "workflow_id");
          const limit = readNumberParam(params, "limit", { integer: true });
          let department = readStringParam(params, "department") ?? undefined;
          let team = readStringParam(params, "team") ?? undefined;

          // Auto-inject department filter for non-managers
          const callerEntry = options?.agentSessionKey ? getAgentConfig(actor) : null;
          if (callerEntry && callerEntry.config.extends !== "manager") {
            if (!department && callerEntry.config.department) {
              department = callerEntry.config.department;
            }
            if (!team && callerEntry.config.team) {
              team = callerEntry.config.team;
            }
          }

          const tasks = listTasks(projectId, {
            states: statesRaw && statesRaw.length > 0 ? statesRaw as TaskState[] : undefined,
            assignedTo: assignedTo ?? undefined,
            priority: priority ?? undefined,
            tags: tags ?? undefined,
            workflowId: workflowId ?? undefined,
            department,
            team,
            limit: limit ?? undefined,
          });
          return jsonResult({ ok: true, tasks, count: tasks.length });
        }

        case "history": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const transitions = getTaskTransitions(projectId, taskId);
          return jsonResult({ ok: true, transitions });
        }

        case "fail": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const reason = readStringParam(params, "reason") ?? "Task failed";
          const evidenceContent = readStringParam(params, "evidence_content");

          // Attach failure evidence if provided
          if (evidenceContent) {
            attachEvidence({
              projectId,
              taskId,
              type: "log" as EvidenceType,
              content: evidenceContent,
              attachedBy: actor,
            });
          }

          // Transition to FAILED
          const result = transitionTask({
            projectId,
            taskId,
            toState: "FAILED",
            actor,
            reason,
          });

          // Worker reported failure cooperatively — mark compliant
          if (result.ok && options?.agentSessionKey) {
            markWorkerCompliant(options.agentSessionKey);
          }

          return jsonResult(result);
        }

        case "get_approval_context": {
          const title = readStringParam(params, "title", { required: true })!;
          const description = readStringParam(params, "description");
          const priority = readStringParam(params, "priority");
          const tags = readStringArrayParam(params, "tags");

          // Context at point of decision: return approval policy + pending proposals
          const policy = getApprovalPolicy(projectId);
          const db = getDb(projectId);
          const pendingProposals = db.prepare(
            "SELECT id, title, description, status, created_at FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC",
          ).all(projectId) as { id: string; title: string; description: string | null; status: string; created_at: number }[];

          return jsonResult({
            ok: true,
            proposal_context: {
              approval_policy: policy?.policy ?? "No approval policy configured. All proposals require explicit user approval.",
              pending_proposals: pendingProposals,
              proposed_task: { title, description, priority, tags },
            },
            instructions: "Review the approval policy above. If this task can be auto-approved per the policy, call clawforce_task with action 'create'. If it needs user approval, call clawforce_task with action 'submit_proposal'.",
          });
        }

        case "submit_proposal": {
          const title = readStringParam(params, "title", { required: true })!;
          const description = readStringParam(params, "description");

          const db = getDb(projectId);
          const id = randomUUID();
          const now = Date.now();
          const policy = getApprovalPolicy(projectId);

          db.prepare(`
            INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, approval_policy_snapshot, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(id, projectId, title, description, actor, options?.agentSessionKey ?? null, policy?.policy ?? null, now);

          return jsonResult({
            ok: true,
            proposal: { id, title, description, status: "pending", created_at: now },
            message: "Proposal submitted. Waiting for user approval.",
          });
        }

        case "check_proposal": {
          const proposalId = readStringParam(params, "proposal_id", { required: true })!;
          const proposal = getProposal(projectId, proposalId);
          if (!proposal) return jsonResult({ ok: false, reason: "Proposal not found" });
          return jsonResult({ ok: true, proposal });
        }

        case "metrics": {
          const metricType = readStringParam(params, "type") as MetricType | null;
          const metricKey = readStringParam(params, "key");
          const since = readNumberParam(params, "since", { integer: true });
          const limit = readNumberParam(params, "limit", { integer: true });

          const metrics = queryMetrics({
            projectId,
            type: metricType ?? undefined,
            key: metricKey ?? undefined,
            since: since ?? undefined,
            limit: limit ?? undefined,
          });
          return jsonResult({ ok: true, metrics, count: metrics.length });
        }

        case "bulk_create": {
          const tasksRaw = params.tasks as Array<Record<string, unknown>> | undefined;
          if (!tasksRaw || !Array.isArray(tasksRaw) || tasksRaw.length === 0) {
            return jsonResult({ ok: false, reason: "tasks array is required and must not be empty for bulk_create." });
          }
          if (tasksRaw.length > 50) {
            return jsonResult({ ok: false, reason: "bulk_create supports a maximum of 50 tasks per call." });
          }

          const results: Array<{ ok: boolean; task?: unknown; reason?: string }> = [];
          for (const t of tasksRaw) {
            const title = typeof t.title === "string" ? t.title : "";
            if (!title) {
              results.push({ ok: false, reason: "Missing title" });
              continue;
            }
            const priority = t.priority as TaskPriority | undefined;
            if (priority && !TASK_PRIORITIES.includes(priority)) {
              results.push({ ok: false, reason: `Invalid priority: ${priority}` });
              continue;
            }
            const task = createTask({
              projectId,
              title,
              description: (t.description as string) ?? undefined,
              priority: priority ?? undefined,
              assignedTo: (t.assigned_to as string) ?? undefined,
              createdBy: actor,
              maxRetries: typeof t.max_retries === "number" ? t.max_retries : undefined,
              deadline: typeof t.deadline === "number" ? t.deadline : undefined,
              tags: Array.isArray(t.tags) ? t.tags.map(String) : undefined,
              workflowId: (t.workflow_id as string) ?? undefined,
              goalId: (t.goal_id as string) ?? undefined,
            });
            results.push({ ok: true, task });
          }
          const successCount = results.filter((r) => r.ok).length;
          return jsonResult({ ok: true, created: successCount, total: tasksRaw.length, results });
        }

        case "bulk_transition": {
          const transitionsRaw = params.transitions as Array<Record<string, unknown>> | undefined;
          if (!transitionsRaw || !Array.isArray(transitionsRaw) || transitionsRaw.length === 0) {
            return jsonResult({ ok: false, reason: "transitions array is required and must not be empty for bulk_transition." });
          }
          if (transitionsRaw.length > 50) {
            return jsonResult({ ok: false, reason: "bulk_transition supports a maximum of 50 transitions per call." });
          }

          const results: Array<{ ok: boolean; taskId: string; reason?: string }> = [];
          for (const tr of transitionsRaw) {
            const taskId = tr.task_id as string;
            const toStateRaw = tr.to_state as string;
            if (!taskId || !toStateRaw) {
              results.push({ ok: false, taskId: taskId ?? "unknown", reason: "Missing task_id or to_state" });
              continue;
            }
            if (!TASK_STATES.includes(toStateRaw as TaskState)) {
              results.push({ ok: false, taskId, reason: `Invalid state: ${toStateRaw}` });
              continue;
            }
            const result = transitionTask({
              projectId,
              taskId,
              toState: toStateRaw as TaskState,
              actor,
              reason: (tr.reason as string) ?? undefined,
            });
            if (result.ok) {
              results.push({ ok: true, taskId });
            } else {
              results.push({ ok: false, taskId, reason: result.reason });
            }
          }
          const successCount = results.filter((r) => r.ok).length;
          return jsonResult({ ok: true, transitioned: successCount, total: transitionsRaw.length, results });
        }

        case "add_dep": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const dependsOn = readStringParam(params, "depends_on_task_id", { required: true })!;
          const depTypeRaw = readStringParam(params, "dep_type") ?? "blocks";
          if (depTypeRaw !== "blocks" && depTypeRaw !== "soft") {
            return jsonResult({ ok: false, reason: `Invalid dep_type: ${depTypeRaw}. Must be "blocks" or "soft".` });
          }
          const result = addDependency({
            projectId,
            taskId,
            dependsOnTaskId: dependsOn,
            type: depTypeRaw,
            createdBy: actor,
          });
          return jsonResult(result);
        }

        case "remove_dep": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const dependsOn = readStringParam(params, "depends_on_task_id", { required: true })!;
          const result = removeDependency({ projectId, taskId, dependsOnTaskId: dependsOn });
          return jsonResult(result);
        }

        case "list_deps": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const deps = getTaskDependencies(projectId, taskId);
          return jsonResult({ ok: true, dependencies: deps, count: deps.length });
        }

        case "list_dependents": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const deps = getTaskDependents(projectId, taskId);
          return jsonResult({ ok: true, dependents: deps, count: deps.length });
        }

        case "list_blockers": {
          const taskId = readStringParam(params, "task_id", { required: true })!;
          const blockers = getUnresolvedBlockers(projectId, taskId);
          return jsonResult({ ok: true, blockers, count: blockers.length });
        }

        default:
          return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
      }
      });
    },
  };
}
