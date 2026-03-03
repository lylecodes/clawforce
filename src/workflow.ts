/**
 * Clawforce — Workflow management
 *
 * Phased execution with auto-gating: all tasks in a phase must
 * reach DONE before the next phase unlocks.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { writeAuditEntry } from "./audit.js";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { getTask, listTasks } from "./tasks/ops.js";
import type { Task, Workflow, WorkflowPhase } from "./types.js";

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    phases: JSON.parse(row.phases as string) as WorkflowPhase[],
    currentPhase: row.current_phase as number,
    state: row.state as "active" | "completed" | "failed",
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function createWorkflow(
  params: {
    projectId: string;
    name: string;
    phases: Omit<WorkflowPhase, "taskIds">[];
    createdBy: string;
  },
  dbOverride?: DatabaseSync,
): Workflow {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  const phases: WorkflowPhase[] = params.phases.map((p) => ({
    ...p,
    taskIds: [],
    gateCondition: p.gateCondition ?? "all_done",
  }));

  db.prepare(`
    INSERT INTO workflows (id, project_id, name, phases, current_phase, state, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'active', ?, ?, ?)
  `).run(id, params.projectId, params.name, JSON.stringify(phases), params.createdBy, now, now);

  return {
    id,
    projectId: params.projectId,
    name: params.name,
    phases,
    currentPhase: 0,
    state: "active",
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function getWorkflow(projectId: string, workflowId: string, dbOverride?: DatabaseSync): Workflow | undefined {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as Record<string, unknown> | undefined;
  return row ? rowToWorkflow(row) : undefined;
}

export function addTaskToPhase(
  params: {
    projectId: string;
    workflowId: string;
    phase: number;
    taskId: string;
  },
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(params.projectId);
  const workflow = getWorkflow(params.projectId, params.workflowId, db);
  if (!workflow) return false;
  if (params.phase < 0 || params.phase >= workflow.phases.length) return false;

  // Dedup: don't add the same task twice to a phase
  if (workflow.phases[params.phase]!.taskIds.includes(params.taskId)) {
    return true; // Already present — idempotent success
  }
  workflow.phases[params.phase]!.taskIds.push(params.taskId);

  db.prepare("UPDATE workflows SET phases = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(workflow.phases), Date.now(), params.workflowId);

  // Also update the task's workflow reference
  db.prepare("UPDATE tasks SET workflow_id = ?, workflow_phase = ?, updated_at = ? WHERE id = ?")
    .run(params.workflowId, params.phase, Date.now(), params.taskId);

  return true;
}

export type PhaseStatus = {
  phase: number;
  name: string;
  gateCondition: "all_done" | "any_done" | "all_resolved" | "any_resolved";
  tasks: Task[];
  completed: number;
  failed: number;
  resolved: number;
  total: number;
  ready: boolean;
};

export function getPhaseStatus(projectId: string, workflowId: string, phase: number, dbOverride?: DatabaseSync): PhaseStatus | null {
  const db = dbOverride ?? getDb(projectId);
  const workflow = getWorkflow(projectId, workflowId, db);
  if (!workflow || phase < 0 || phase >= workflow.phases.length) return null;

  const phaseSpec = workflow.phases[phase]!;
  const tasks: Task[] = [];
  for (const taskId of phaseSpec.taskIds) {
    const task = getTask(projectId, taskId, db);
    if (task) tasks.push(task);
  }

  const completed = tasks.filter((t) => t.state === "DONE").length;
  const failed = tasks.filter((t) => t.state === "FAILED").length;
  const resolved = completed + failed;
  const total = tasks.length;
  const gate = phaseSpec.gateCondition ?? "all_done";

  let ready: boolean;
  switch (gate) {
    case "all_done":
      ready = completed === total && total > 0;
      break;
    case "any_done":
      ready = completed > 0;
      break;
    case "all_resolved":
      ready = resolved === total && total > 0 && completed > 0;
      break;
    case "any_resolved":
      ready = resolved > 0 && completed > 0;
      break;
  }

  return {
    phase,
    name: phaseSpec.name,
    gateCondition: gate,
    tasks,
    completed,
    failed,
    resolved,
    total,
    ready,
  };
}

/**
 * Advance workflow to the next phase if the current phase gate is satisfied.
 * Returns the new current phase, or null if not advanced.
 */
export function advanceWorkflow(projectId: string, workflowId: string, dbOverride?: DatabaseSync): number | null {
  const db = dbOverride ?? getDb(projectId);
  const workflow = getWorkflow(projectId, workflowId, db);
  if (!workflow || workflow.state !== "active") return null;

  const status = getPhaseStatus(projectId, workflowId, workflow.currentPhase, db);
  if (!status || !status.ready) return null;

  const nextPhase = workflow.currentPhase + 1;

  if (nextPhase >= workflow.phases.length) {
    // All phases complete — mark workflow as completed
    db.prepare("UPDATE workflows SET state = 'completed', current_phase = ?, updated_at = ? WHERE id = ?")
      .run(workflow.currentPhase, Date.now(), workflowId);
    return workflow.currentPhase;
  }

  db.prepare("UPDATE workflows SET current_phase = ?, updated_at = ? WHERE id = ?")
    .run(nextPhase, Date.now(), workflowId);

  return nextPhase;
}

/**
 * Force-advance workflow to the next phase regardless of gate conditions.
 * Used to recover from stalled workflows. Records an audit entry.
 * Returns the new current phase, or null if the workflow can't be advanced.
 */
export function forceAdvanceWorkflow(
  projectId: string,
  workflowId: string,
  actor: string,
  dbOverride?: DatabaseSync,
): number | null {
  const db = dbOverride ?? getDb(projectId);
  const workflow = getWorkflow(projectId, workflowId, db);
  if (!workflow || workflow.state !== "active") return null;

  const nextPhase = workflow.currentPhase + 1;

  if (nextPhase >= workflow.phases.length) {
    // All phases complete — mark workflow as completed
    db.prepare("UPDATE workflows SET state = 'completed', current_phase = ?, updated_at = ? WHERE id = ?")
      .run(workflow.currentPhase, Date.now(), workflowId);
    return workflow.currentPhase;
  }

  db.prepare("UPDATE workflows SET current_phase = ?, updated_at = ? WHERE id = ?")
    .run(nextPhase, Date.now(), workflowId);

  // Audit the forced advance
  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "workflow.force_advance",
      targetType: "workflow",
      targetId: workflowId,
      detail: `Forced advance from phase ${workflow.currentPhase} to ${nextPhase}`,
    }, db);
  } catch (err) {
    safeLog("workflow.forceAdvance.audit", err);
  }

  return nextPhase;
}

/**
 * Check if a task belongs to a workflow phase that hasn't been reached yet.
 * Returns { blocked: true, reason } if the task's phase is ahead of the workflow's current phase.
 */
export function isTaskInFuturePhase(
  task: { workflowId?: string; workflowPhase?: number; projectId: string },
  dbOverride?: DatabaseSync,
): { blocked: boolean; reason?: string } {
  if (!task.workflowId || task.workflowPhase == null) return { blocked: false };
  const workflow = getWorkflow(task.projectId, task.workflowId, dbOverride);
  if (!workflow || workflow.state !== "active") return { blocked: false };
  if (task.workflowPhase <= workflow.currentPhase) return { blocked: false };
  return {
    blocked: true,
    reason: `Task is in workflow phase ${task.workflowPhase} ("${workflow.phases[task.workflowPhase]?.name ?? "?"}") but workflow is on phase ${workflow.currentPhase} ("${workflow.phases[workflow.currentPhase]?.name ?? "?"}"). Phase ${task.workflowPhase} has not been reached yet.`,
  };
}

export function listWorkflows(projectId: string, dbOverride?: DatabaseSync): Workflow[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToWorkflow);
}
