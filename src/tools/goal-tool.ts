/**
 * Clawforce — Goal management tool
 *
 * Provides agents with goal hierarchy management: create, decompose,
 * track status, achieve, and abandon goals.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema-helpers.js";
import {
  createGoal,
  getGoal,
  listGoals,
  achieveGoal,
  abandonGoal,
  getChildGoals,
  getGoalTasks,
  getInitiativeSpend,
} from "../goals/ops.js";
import { computeGoalProgress } from "../goals/cascade.js";
import { ingestEvent } from "../events/store.js";
import { getDb } from "../db.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, readNumberParam, resolveProjectId, safeExecute } from "./common.js";

const GOAL_ACTIONS = [
  "create", "decompose", "status", "achieve", "abandon", "list", "get",
] as const;

const ClawforceGoalSchema = Type.Object({
  action: stringEnum(GOAL_ACTIONS, { description: "Action to perform on the goal system." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  goal_id: Type.Optional(Type.String({ description: "Goal ID (for status/achieve/abandon/get/decompose)." })),
  title: Type.Optional(Type.String({ description: "Goal title (for create)." })),
  description: Type.Optional(Type.String({ description: "Goal description (for create)." })),
  acceptance_criteria: Type.Optional(Type.String({ description: "Criteria for considering the goal achieved." })),
  parent_goal_id: Type.Optional(Type.String({ description: "Parent goal ID (for create — nests under parent)." })),
  owner_agent_id: Type.Optional(Type.String({ description: "Agent who owns this goal." })),
  department: Type.Optional(Type.String({ description: "Department this goal belongs to." })),
  team: Type.Optional(Type.String({ description: "Team within the department." })),
  reason: Type.Optional(Type.String({ description: "Reason for abandoning a goal." })),
  allocation: Type.Optional(Type.Number({ description: "Budget allocation as percentage of project daily budget (0-100). Makes this goal an initiative." })),
  status_filter: Type.Optional(Type.String({ description: "Filter by status: active, achieved, abandoned (for list)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for list, default 100)." })),
  sub_goals: Type.Optional(Type.Array(
    Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      acceptance_criteria: Type.Optional(Type.String()),
      owner_agent_id: Type.Optional(Type.String()),
      department: Type.Optional(Type.String()),
      team: Type.Optional(Type.String()),
    }),
    { description: "Array of sub-goal definitions (for decompose)." },
  )),
});

export function createClawforceGoalTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
}) {
  return {
    label: "Goal Management",
    name: "clawforce_goal",
    description: [
      "Manage project goals: create, decompose into sub-goals, track status, achieve, or abandon.",
      "",
      "Actions:",
      "  create — Create a new goal (optionally under a parent goal)",
      "  decompose — Break a goal into sub-goals (provide sub_goals array)",
      "  status — Get goal with progress (child goals + linked tasks)",
      "  achieve — Mark a goal as achieved",
      "  abandon — Mark a goal as abandoned",
      "  list — List goals with optional filters",
      "  get — Get goal details with linked tasks",
    ].join("\n"),
    parameters: ClawforceGoalSchema,
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
            const description = readStringParam(params, "description") ?? undefined;
            const acceptanceCriteria = readStringParam(params, "acceptance_criteria") ?? undefined;
            const parentGoalId = readStringParam(params, "parent_goal_id") ?? undefined;
            const ownerAgentId = readStringParam(params, "owner_agent_id") ?? undefined;
            const department = readStringParam(params, "department") ?? undefined;
            const team = readStringParam(params, "team") ?? undefined;
            const allocation = readNumberParam(params, "allocation") ?? undefined;

            if (allocation != null && (allocation < 0 || allocation > 100)) {
              return jsonResult({ ok: false, error: "allocation must be 0-100" });
            }

            const goal = createGoal({
              projectId, title, description, acceptanceCriteria,
              parentGoalId, ownerAgentId, department, team,
              createdBy: actor, allocation,
            });

            return jsonResult({ ok: true, goal });
          }

          case "decompose": {
            const goalId = readStringParam(params, "goal_id", { required: true })!;
            const subGoals = params.sub_goals as Array<Record<string, unknown>> | undefined;
            if (!subGoals || !Array.isArray(subGoals) || subGoals.length === 0) {
              return jsonResult({ ok: false, reason: "sub_goals array is required for decompose action" });
            }

            const parent = getGoal(projectId, goalId);
            if (!parent) return jsonResult({ ok: false, reason: `Goal not found: ${goalId}` });
            if (parent.status !== "active") return jsonResult({ ok: false, reason: `Cannot decompose goal in status: ${parent.status}` });

            const children = [];
            for (const sg of subGoals) {
              const child = createGoal({
                projectId,
                title: String(sg.title),
                description: sg.description ? String(sg.description) : undefined,
                acceptanceCriteria: sg.acceptance_criteria ? String(sg.acceptance_criteria) : undefined,
                parentGoalId: goalId,
                ownerAgentId: sg.owner_agent_id ? String(sg.owner_agent_id) : undefined,
                department: sg.department ? String(sg.department) : parent.department,
                team: sg.team ? String(sg.team) : parent.team,
                createdBy: actor,
              });
              children.push(child);
            }

            return jsonResult({ ok: true, parent, children, count: children.length });
          }

          case "status": {
            const goalId = readStringParam(params, "goal_id", { required: true })!;
            const db = getDb(projectId);
            const goal = getGoal(projectId, goalId);
            if (!goal) return jsonResult({ ok: false, reason: `Goal not found: ${goalId}` });

            const progress = computeGoalProgress(projectId, goalId);
            const childGoals = getChildGoals(projectId, goalId);

            let budget: Record<string, unknown> | undefined;
            if (goal.allocation != null) {
              const projectBudget = db.prepare(
                "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
              ).get(projectId) as { daily_limit_cents: number } | undefined;
              const dailyBudget = projectBudget?.daily_limit_cents ?? 0;
              const allocationCents = Math.floor((goal.allocation / 100) * dailyBudget);
              const spentCents = getInitiativeSpend(projectId, goal.id);
              budget = {
                allocationPercent: goal.allocation,
                allocationCents,
                spentCents,
                remainingCents: allocationCents - spentCents,
              };
            }

            return jsonResult({ ok: true, goal, progress, childGoals, budget });
          }

          case "achieve": {
            const goalId = readStringParam(params, "goal_id", { required: true })!;
            const goal = achieveGoal(projectId, goalId, actor);
            return jsonResult({ ok: true, goal });
          }

          case "abandon": {
            const goalId = readStringParam(params, "goal_id", { required: true })!;
            const reason = readStringParam(params, "reason") ?? undefined;
            const goal = abandonGoal(projectId, goalId, actor, reason);
            return jsonResult({ ok: true, goal });
          }

          case "list": {
            const statusFilter = readStringParam(params, "status_filter") as "active" | "achieved" | "abandoned" | null;
            const ownerAgentId = readStringParam(params, "owner_agent_id") ?? undefined;
            const department = readStringParam(params, "department") ?? undefined;
            const team = readStringParam(params, "team") ?? undefined;
            const parentGoalId = readStringParam(params, "parent_goal_id");
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 100;

            const goals = listGoals(projectId, {
              status: statusFilter ?? undefined,
              ownerAgentId,
              department,
              team,
              parentGoalId: parentGoalId === "none" ? null : (parentGoalId ?? undefined),
              limit,
            });

            return jsonResult({ ok: true, goals, count: goals.length });
          }

          case "get": {
            const goalId = readStringParam(params, "goal_id", { required: true })!;
            const goal = getGoal(projectId, goalId);
            if (!goal) return jsonResult({ ok: false, reason: `Goal not found: ${goalId}` });

            const childGoals = getChildGoals(projectId, goalId);
            const tasks = getGoalTasks(projectId, goalId);

            return jsonResult({ ok: true, goal, childGoals, tasks });
          }

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}
