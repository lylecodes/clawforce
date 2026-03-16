/**
 * Clawforce SDK — Tasks Namespace
 *
 * Wraps internal task operations with the public SDK vocabulary:
 *   group    → department  (internal)
 *   subgroup → team        (internal)
 *
 * Internal task objects use snake_case DB fields mapped through rowToTask.
 * This layer converts the internal camelCase Task type to the public Task type
 * defined in sdk/types.ts.
 */

import {
  createTask as internalCreateTask,
  getTask as internalGetTask,
  listTasks as internalListTasks,
  transitionTask as internalTransitionTask,
  reassignTask as internalReassignTask,
  getTaskEvidence as internalGetTaskEvidence,
  getTaskTransitions as internalGetTaskTransitions,
} from "../tasks/ops.js";

import type { Task as InternalTask } from "../types.js";
import type { Task, TaskParams, TaskState } from "./types.js";

/** Map internal Task (with snake_case semantics already resolved by rowToTask) to public SDK Task */
function toPublicTask(t: InternalTask): Task {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    state: t.state as TaskState,
    priority: t.priority,
    assignedTo: t.assignedTo,
    group: t.department,
    subgroup: t.team,
    goalId: t.goalId,
    tags: t.tags ?? [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    metadata: t.metadata,
  };
}

export class TasksNamespace {
  constructor(readonly domain: string) {}

  /**
   * Create a new task. Maps `group` → `department`, `subgroup` → `team`.
   * State is determined automatically: ASSIGNED if assignedTo is provided, else OPEN.
   */
  create(params: TaskParams, actor?: string): Task {
    const internal = internalCreateTask({
      projectId: this.domain,
      title: params.title,
      description: params.description,
      priority: params.priority as ("P0" | "P1" | "P2" | "P3") | undefined,
      assignedTo: params.assignedTo,
      createdBy: actor ?? "sdk",
      deadline: params.deadline,
      tags: params.tags,
      department: params.group,
      team: params.subgroup,
      goalId: params.goalId,
      metadata: params.metadata,
    });
    return toPublicTask(internal);
  }

  /** Retrieve a task by ID. Returns undefined if not found. */
  get(taskId: string): Task | undefined {
    const internal = internalGetTask(this.domain, taskId);
    return internal ? toPublicTask(internal) : undefined;
  }

  /**
   * List tasks with optional filters. Maps `group` → `department`, `subgroup` → `team`.
   */
  list(filters?: {
    state?: TaskState;
    assignedTo?: string;
    group?: string;
    subgroup?: string;
    limit?: number;
  }): Task[] {
    const internal = internalListTasks(this.domain, {
      state: filters?.state,
      assignedTo: filters?.assignedTo,
      department: filters?.group,
      team: filters?.subgroup,
      limit: filters?.limit,
    });
    return internal.map(toPublicTask);
  }

  /**
   * Transition a task to a new state. Throws an Error if the transition is rejected.
   * Returns the updated public Task on success.
   */
  transition(
    taskId: string,
    toState: TaskState,
    opts?: { actor?: string; reason?: string },
  ): Task {
    const result = internalTransitionTask({
      projectId: this.domain,
      taskId,
      toState,
      actor: opts?.actor ?? "sdk",
      reason: opts?.reason,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return toPublicTask(result.task);
  }

  /**
   * Reassign a task to a new agent. Throws an Error if reassignment is rejected.
   * Only ASSIGNED or IN_PROGRESS tasks can be reassigned.
   */
  reassign(
    taskId: string,
    newAssignee: string,
    opts?: { actor?: string; reason?: string },
  ): Task {
    const result = internalReassignTask({
      projectId: this.domain,
      taskId,
      newAssignee,
      actor: opts?.actor ?? "sdk",
      reason: opts?.reason,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return toPublicTask(result.task);
  }

  /** Return all evidence attached to a task. */
  evidence(taskId: string): any[] {
    return internalGetTaskEvidence(this.domain, taskId);
  }

  /** Return the full transition history for a task. */
  history(taskId: string): any[] {
    return internalGetTaskTransitions(this.domain, taskId);
  }
}
