/**
 * Clawforce SDK — Goals Namespace
 *
 * Wraps internal goal operations with the public SDK vocabulary:
 *   group → department  (internal)
 *
 * Internal goal objects use the Goal type from src/types.ts.
 * This layer converts that to the public Goal type defined in sdk/types.ts.
 */

import {
  createGoal as internalCreateGoal,
  getGoal as internalGetGoal,
  listGoals as internalListGoals,
  updateGoal as internalUpdateGoal,
  achieveGoal as internalAchieveGoal,
  abandonGoal as internalAbandonGoal,
  linkTaskToGoal as internalLinkTaskToGoal,
  unlinkTaskFromGoal as internalUnlinkTaskFromGoal,
  getGoalTasks as internalGetGoalTasks,
  getChildGoals as internalGetChildGoals,
  findRootInitiative as internalFindRootInitiative,
  getInitiativeSpend as internalGetInitiativeSpend,
} from "../goals/ops.js";

import type { Goal as InternalGoal } from "../types.js";
import type { Goal, GoalParams } from "./types.js";

/** Map internal Goal to public SDK Goal (department → group) */
function toPublicGoal(g: InternalGoal): Goal {
  const pub: Goal = {
    id: g.id,
    title: g.title,
    description: g.description,
    status: g.status as Goal["status"],
    group: g.department,
    owner: g.ownerAgentId,
    priority: g.priority ?? "medium",
    entityId: g.entityId,
    entityType: g.entityType,
    createdAt: g.createdAt,
  };
  // deadline is stored in metadata when provided via GoalParams, not a first-class DB column
  if (g.metadata?.deadline != null) {
    pub.deadline = g.metadata.deadline as number;
  }
  return pub;
}

export class GoalsNamespace {
  constructor(readonly domain: string) {}

  /**
   * Create a new goal. Maps `group` → `department`.
   */
  create(params: GoalParams, actor?: string): Goal {
    const internal = internalCreateGoal({
      projectId: this.domain,
      title: params.title,
      description: params.description,
      department: params.group,
      ownerAgentId: params.owner,
      priority: params.priority as InternalGoal["priority"] | undefined,
      parentGoalId: params.parentGoalId,
      entityId: params.entityId,
      entityType: params.entityType,
      metadata: params.metadata,
      createdBy: actor ?? "sdk",
    });
    return toPublicGoal(internal);
  }

  /**
   * Retrieve a goal by ID. Returns undefined if not found.
   */
  get(goalId: string): Goal | undefined {
    const internal = internalGetGoal(this.domain, goalId);
    return internal ? toPublicGoal(internal) : undefined;
  }

  /**
   * List goals with optional filters. Maps `group` → `department`, `owner` → `ownerAgentId`.
   */
  list(filters?: {
    status?: Goal["status"];
    group?: string;
    owner?: string;
    entityId?: string;
    entityType?: string;
    limit?: number;
  }): Goal[] {
    const internal = internalListGoals(this.domain, {
      status: filters?.status,
      department: filters?.group,
      ownerAgentId: filters?.owner,
      entityId: filters?.entityId,
      entityType: filters?.entityType,
      limit: filters?.limit,
    });
    return internal.map(toPublicGoal);
  }

  /**
   * Update a goal's properties. Maps `group` → `department`, `owner` → `ownerAgentId`.
   */
  update(goalId: string, updates: Partial<GoalParams>): Goal {
    const internal = internalUpdateGoal(this.domain, goalId, {
      title: updates.title,
      description: updates.description,
      department: updates.group,
      ownerAgentId: updates.owner,
      priority: updates.priority as InternalGoal["priority"] | undefined,
      entityId: updates.entityId,
      entityType: updates.entityType,
      metadata: updates.metadata,
    });
    return toPublicGoal(internal);
  }

  /**
   * Mark a goal as achieved. Throws if the goal is not in active status.
   */
  achieve(goalId: string, actor?: string): Goal {
    const internal = internalAchieveGoal(this.domain, goalId, actor ?? "sdk");
    return toPublicGoal(internal);
  }

  /**
   * Mark a goal as abandoned with an optional reason. Throws if the goal is not active.
   */
  abandon(goalId: string, actor?: string, reason?: string): Goal {
    const internal = internalAbandonGoal(this.domain, goalId, actor ?? "sdk", reason);
    return toPublicGoal(internal);
  }

  /**
   * Link a task to a goal. Throws if either the goal or task is not found.
   */
  linkTask(taskId: string, goalId: string): void {
    internalLinkTaskToGoal(this.domain, taskId, goalId);
  }

  /**
   * Unlink a task from its goal (sets goal_id to NULL).
   */
  unlinkTask(taskId: string): void {
    internalUnlinkTaskFromGoal(this.domain, taskId);
  }

  /**
   * Return all tasks linked to a goal.
   */
  tasks(goalId: string): any[] {
    return internalGetGoalTasks(this.domain, goalId);
  }

  /**
   * Return all direct child goals for a given goal.
   */
  children(goalId: string): Goal[] {
    const internal = internalGetChildGoals(this.domain, goalId);
    return internal.map(toPublicGoal);
  }

  /**
   * Return the root initiative goal that has a budget allocation for this goal tree.
   * Returns undefined if no ancestor (including the goal itself) has an allocation.
   */
  rootInitiative(goalId: string): Goal | undefined {
    const internal = internalFindRootInitiative(this.domain, goalId);
    return internal ? toPublicGoal(internal) : undefined;
  }

  /**
   * Return today's total spend in cents for all tasks under the goal tree rooted at goalId.
   */
  spend(goalId: string): number {
    return internalGetInitiativeSpend(this.domain, goalId);
  }
}
