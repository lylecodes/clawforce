/**
 * Clawforce — Auto-assignment engine
 *
 * Assigns OPEN tasks to eligible agents based on configurable strategies:
 * - workload_balanced: agent with fewest active tasks (default)
 * - round_robin: rotate through agents
 * - skill_matched: match task tags to agent tools
 */

import type { DatabaseSync } from "node:sqlite";
import { checkBudget } from "../budget.js";
import { safeLog } from "../diagnostics.js";
import { isAgentDisabled } from "../enforcement/disabled-store.js";
import { recordMetric } from "../metrics.js";
import { getAgentConfig, getRegisteredAgentIds } from "../project.js";
import { getTask, listTasks, transitionTask } from "../tasks/ops.js";
import type { AssignmentConfig, Task } from "../types.js";

export type AssignmentResult = {
  assigned: boolean;
  agentId?: string;
  reason?: string;
};

/**
 * Auto-assign a task to an eligible agent based on the configured strategy.
 * Only assigns tasks in OPEN state. Calls transitionTask() on success,
 * which emits task_assigned → triggers auto-dispatch.
 */
export function autoAssign(
  projectId: string,
  taskId: string,
  config: AssignmentConfig,
  db: DatabaseSync,
): AssignmentResult {
  if (!config.enabled) {
    return { assigned: false, reason: "Auto-assignment disabled" };
  }

  const task = getTask(projectId, taskId, db);
  if (!task) return { assigned: false, reason: "Task not found" };
  if (task.state !== "OPEN") return { assigned: false, reason: `Task not in OPEN state (${task.state})` };
  if (task.assignedTo) return { assigned: false, reason: "Task already assigned" };

  const eligible = getEligibleAgents(projectId, task, db);
  if (eligible.length === 0) {
    return { assigned: false, reason: "No eligible agents" };
  }

  let selectedAgent: string | undefined;

  switch (config.strategy) {
    case "round_robin":
      selectedAgent = selectRoundRobin(eligible, projectId, db);
      break;
    case "skill_matched":
      selectedAgent = selectSkillMatched(eligible, task, projectId, db);
      break;
    case "workload_balanced":
    default:
      selectedAgent = selectWorkloadBalanced(eligible, projectId, db);
      break;
  }

  if (!selectedAgent) {
    return { assigned: false, reason: "No agent selected by strategy" };
  }

  const result = transitionTask({
    projectId,
    taskId,
    toState: "ASSIGNED",
    actor: "system:auto-assign",
    assignedTo: selectedAgent,
    reason: `Auto-assigned via ${config.strategy} strategy`,
  }, db);

  if (!result.ok) {
    return { assigned: false, reason: result.reason };
  }

  try {
    recordMetric({
      projectId,
      type: "assignment",
      subject: taskId,
      key: "auto_assigned",
      value: 1,
      tags: { agentId: selectedAgent, strategy: config.strategy },
    }, db);
  } catch (err) { safeLog("assignment.metric", err); }

  return { assigned: true, agentId: selectedAgent };
}

/**
 * Get agents eligible for assignment.
 * Filters: registered for project, employee role, not disabled, budget OK, department match.
 */
function getEligibleAgents(
  projectId: string,
  task: Task,
  db: DatabaseSync,
): string[] {
  const allAgentIds = getRegisteredAgentIds();
  const eligible: string[] = [];

  for (const agentId of allAgentIds) {
    const entry = getAgentConfig(agentId);
    if (!entry || entry.projectId !== projectId) continue;

    // Only employees can be auto-assigned (managers/coordinators are excluded)
    if (entry.config.extends === "manager" || entry.config.coordination?.enabled) continue;

    // Check disabled
    if (isAgentDisabled(projectId, agentId, db)) continue;

    // Check budget
    try {
      const budget = checkBudget({ projectId, agentId }, db);
      if (!budget.ok) continue;
    } catch {
      // Budget check failure — skip this agent
      continue;
    }

    // Department filter: if task has a department, agent must match (or have no department)
    if (task.department && entry.config.department && entry.config.department !== task.department) {
      continue;
    }

    // Team filter: if task has a team, agent must match (or have no team)
    if (task.team && entry.config.team && entry.config.team !== task.team) {
      continue;
    }

    eligible.push(agentId);
  }

  return eligible;
}

/**
 * Workload balanced: pick the agent with the fewest active (non-terminal) tasks.
 */
function selectWorkloadBalanced(
  eligible: string[],
  projectId: string,
  db: DatabaseSync,
): string | undefined {
  let bestAgent: string | undefined;
  let lowestLoad = Infinity;

  for (const agentId of eligible) {
    const activeTasks = listTasks(projectId, {
      assignedTo: agentId,
      states: ["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW", "BLOCKED"],
    }, db);

    if (activeTasks.length < lowestLoad) {
      lowestLoad = activeTasks.length;
      bestAgent = agentId;
    }
  }

  return bestAgent;
}

/**
 * Round robin: rotate through agents using a counter persisted in the DB.
 */
function selectRoundRobin(
  eligible: string[],
  projectId: string,
  db: DatabaseSync,
): string | undefined {
  if (eligible.length === 0) return undefined;

  // Sort for deterministic ordering
  const sorted = [...eligible].sort();

  // Read current counter from metrics (lightweight persistence)
  let counter = 0;
  try {
    const row = db.prepare(
      `SELECT value FROM metrics
       WHERE project_id = ? AND key = 'round_robin_counter'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(projectId) as Record<string, unknown> | undefined;
    if (row) counter = (row.value as number) ?? 0;
  } catch { /* no counter yet */ }

  const idx = counter % sorted.length;
  const selected = sorted[idx]!;

  // Persist the incremented counter
  try {
    recordMetric({
      projectId,
      type: "assignment",
      subject: projectId,
      key: "round_robin_counter",
      value: counter + 1,
    }, db);
  } catch (err) { safeLog("assignment.roundRobin.counter", err); }

  return selected;
}

/**
 * Skill matched: match task tags against agent tools list.
 * Score = number of overlapping tags. Highest score wins (tie-break by workload).
 * Falls back to workload_balanced if no tags or no matches.
 */
function selectSkillMatched(
  eligible: string[],
  task: Task,
  projectId: string,
  db: DatabaseSync,
): string | undefined {
  const taskTags = task.tags;
  if (!taskTags || taskTags.length === 0) {
    return selectWorkloadBalanced(eligible, projectId, db);
  }

  const tagSet = new Set(taskTags.map((t) => t.toLowerCase()));
  let bestAgent: string | undefined;
  let bestScore = 0;
  let bestLoad = Infinity;

  for (const agentId of eligible) {
    const entry = getAgentConfig(agentId);
    const tools = entry?.config.tools;
    if (!tools || tools.length === 0) continue;

    // Score: count overlapping tags
    let score = 0;
    for (const tool of tools) {
      if (tagSet.has(tool.toLowerCase())) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestAgent = agentId;

      const activeTasks = listTasks(projectId, {
        assignedTo: agentId,
        states: ["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW", "BLOCKED"],
      }, db);
      bestLoad = activeTasks.length;
    } else if (score === bestScore && score > 0) {
      // Tie-break by workload
      const activeTasks = listTasks(projectId, {
        assignedTo: agentId,
        states: ["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW", "BLOCKED"],
      }, db);
      if (activeTasks.length < bestLoad) {
        bestLoad = activeTasks.length;
        bestAgent = agentId;
      }
    }
  }

  // Fall back to workload_balanced if no matches
  if (!bestAgent || bestScore === 0) {
    return selectWorkloadBalanced(eligible, projectId, db);
  }

  return bestAgent;
}
