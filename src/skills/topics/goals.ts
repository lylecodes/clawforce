/**
 * Clawforce skill topic — Goals
 *
 * Documents goal hierarchy, lifecycle, and cascade rules.
 */

export function generate(): string {
  return `# Goal Hierarchy

## Overview

Goals provide strategic direction for the project. They form a tree:
- **Project goals** — top-level objectives (no parent)
- **Department goals** — decomposed from project goals, assigned to department heads
- **Team goals** — further decomposition, assigned to team leads
- Tasks and workflows connect to goals via \`goal_id\`

## Goal Statuses

| Status | Description |
|--------|------------|
| \`active\` | Goal is being worked on |
| \`achieved\` | Goal has been completed |
| \`abandoned\` | Goal was dropped (with reason) |

## Completion Cascade

When **all** child goals of a parent are achieved (none active), the parent
is automatically marked achieved. This cascades upward through the hierarchy.

- Abandoned children are ignored (not required for cascade)
- At least one child must be achieved (all-abandoned does not trigger cascade)
- The sweep system checks for cascades periodically

## Tool: clawforce_goal

| Action | Description |
|--------|------------|
| \`create\` | Create a goal (optionally under a parent) |
| \`decompose\` | Break a goal into sub-goals (provide \`sub_goals\` array) |
| \`status\` | Get goal with progress (child counts + linked task counts) |
| \`achieve\` | Mark a goal as achieved |
| \`abandon\` | Mark a goal as abandoned (with optional \`reason\`) |
| \`list\` | List goals with filters (\`status_filter\`, \`department\`, \`team\`, \`owner_agent_id\`) |
| \`get\` | Get goal details with child goals and linked tasks |

### Examples

Create a project goal:
\`\`\`
clawforce_goal create title="Ship v2.0 by Q2" acceptance_criteria="All features deployed and QA passed"
\`\`\`

Decompose into department goals:
\`\`\`
clawforce_goal decompose goal_id=<id> sub_goals=[
  { "title": "Complete API layer", "owner_agent_id": "eng-lead", "department": "engineering" },
  { "title": "Finalize UI design", "owner_agent_id": "design-lead", "department": "design" }
]
\`\`\`

Check progress:
\`\`\`
clawforce_goal status goal_id=<id>
\`\`\`

## Context Source: goal_hierarchy

Managers automatically see the goal tree in their briefing. Shows:
- All project goals with status
- Sub-goal counts and progress
- Department/team ownership

## Initiatives (Budget-Gated Goals)

A goal with an \`allocation\` field is an **initiative** — a strategic priority with budget enforcement.

### Creating Initiatives

\`\`\`json
{ "action": "create", "title": "UI Improvements", "allocation": 40, "description": "Dashboard UX work", "department": "engineering" }
\`\`\`

The \`allocation\` is a percentage of the project's daily budget. If the project budget is $10/day and an initiative has allocation: 40, it gets $4/day.

### Budget Enforcement

When an initiative's allocation is spent, dispatch is **blocked** for tasks under that goal tree. This is a hard gate — agents cannot overspend.

### Checking Initiative Status

\`\`\`json
{ "action": "status", "goal_id": "init-id" }
\`\`\`

Returns budget info: allocation percentage, allocated cents, spent today, remaining.

### Budget Allocation to Reports

Coordination agents can allocate budget to their reports:

\`\`\`json
{ "tool": "clawforce_ops", "action": "allocate_budget", "parent_agent_id": "manager", "child_agent_id": "frontend", "daily_limit_cents": 400 }
\`\`\`

Budget cascades down the agent tree. Each allocation is bounded by the parent's remaining allocatable budget.

## Goal Priority

Goals support priority levels (P0-P3) matching task priorities:
- **P0** — Critical, must be addressed immediately
- **P1** — High priority
- **P2** — Normal priority (default)
- **P3** — Low priority

Tasks linked to a goal inherit its priority when they don't have one set explicitly.

Set priority when creating a goal:
\`\`\`
clawforce_goal create title="Fix production bug" priority="P0"
\`\`\`

## Dispatch Plans

Coordination agents create dispatch plans to structure their wake cycles:

1. **Create plan**: \`clawforce_ops plan_create planned_items='[{"agentId":"frontend","taskTitle":"Fix nav","estimatedCostCents":200,"confidence":"high"}]'\`
2. **Start execution**: \`clawforce_ops plan_start plan_id="..."\`
3. **Complete with results**: \`clawforce_ops plan_complete plan_id="..." actual_results='[{"plannedIndex":0,"taskId":"task-123","actualCostCents":180,"status":"dispatched"}]'\`
4. **List recent plans**: \`clawforce_ops plan_list\`
5. **Abandon plan**: \`clawforce_ops plan_abandon plan_id="..."\`

Plans track estimated vs. actual cost for forecasting accuracy.

## Adaptive Wake Frequency

Coordination agents can adjust their own wake frequency within configured bounds:

\`\`\`
clawforce_ops update_job job_name="coordination" job_config='{"cron":"*/30 * * * *"}'
\`\`\`

Frequency is clamped to configured bounds (default: 15min fastest, 120min slowest).
- Wake more frequently when there are many pending tasks or P0/P1 items
- Wake less frequently when idle or budget is low

## Scheduling Briefing Sources

- **cost_forecast** — Per-initiative spend, burn rate, projected exhaustion time
- **available_capacity** — Per-model slot availability based on rate limits and active sessions

Both are included in the manager preset by default.
`;
}
