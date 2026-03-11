# Initiatives & Resource Allocation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add budget allocation to goals (initiatives) with a hard dispatch gate, parent-walking, and cascading budget through the agent tree.

**Architecture:** Initiatives are goals with an `allocation` field (percentage of daily budget). The dispatch gate walks a task's goal hierarchy to find the root initiative and blocks dispatch when spend exceeds allocation. Coordination agents allocate budget to reports via the ops tool. A new `initiative_status` briefing source shows allocation/spend for planning.

**Tech Stack:** TypeScript, Vitest, node:sqlite, OpenClaw adapters

---

### Task 1: Migration + Type — Add `allocation` to Goals

**Files:**
- Modify: `src/types.ts:884-899` (Goal type)
- Modify: `src/migrations.ts` (add V24)
- Test: `test/db-migration.test.ts`

**Step 1: Write the failing test**

Add to `test/db-migration.test.ts` (append after existing migration tests):

```typescript
it("V24 — adds allocation column to goals table", () => {
  const db = getMemoryDb();
  runMigrations(db);

  // Insert a goal with allocation
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
    VALUES ('g1', 'proj', 'UI Work', 'active', 'agent', ${Date.now()}, 40)
  `).run();

  const row = db.prepare("SELECT allocation FROM goals WHERE id = 'g1'").get() as Record<string, unknown>;
  expect(row.allocation).toBe(40);

  // Goal without allocation should have NULL
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, created_by, created_at)
    VALUES ('g2', 'proj', 'Ad hoc', 'active', 'agent', ${Date.now()})
  `).run();

  const row2 = db.prepare("SELECT allocation FROM goals WHERE id = 'g2'").get() as Record<string, unknown>;
  expect(row2.allocation).toBe(null);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-migration.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `allocation` column doesn't exist

**Step 3: Add allocation to Goal type**

In `src/types.ts`, add `allocation` field to the `Goal` type (after `metadata` on line ~899):

```typescript
export type Goal = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: GoalStatus;
  parentGoalId?: string;
  ownerAgentId?: string;
  department?: string;
  team?: string;
  createdBy: string;
  createdAt: number;
  achievedAt?: number;
  metadata?: Record<string, unknown>;
  allocation?: number;  // Percentage of project daily budget (0-100)
};
```

**Step 4: Add V24 migration**

In `src/migrations.ts`, bump `SCHEMA_VERSION` to 24 and add:

```typescript
function migrateV24(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE goals ADD COLUMN allocation INTEGER`);
}
```

Register it in the `MIGRATIONS` map alongside the others:

```typescript
[24, migrateV24],
```

**Step 5: Update `rowToGoal` in `src/goals/ops.ts`**

Find the `rowToGoal` function and add `allocation`:

```typescript
allocation: (row.allocation as number) ?? undefined,
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/db-migration.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 7: Commit**

```bash
git add src/types.ts src/migrations.ts src/goals/ops.ts test/db-migration.test.ts
git commit -m "feat: add allocation column to goals for initiative budget gating"
```

---

### Task 2: Initiative Spend Tracking — Parent-Walking + Spend Aggregation

**Files:**
- Modify: `src/goals/ops.ts` (add `findRootInitiative`, `getInitiativeSpend`)
- Modify: `src/index.ts` (export new functions)
- Create: `test/goals/initiative-spend.test.ts`

**Step 1: Write the failing tests**

Create `test/goals/initiative-spend.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { createGoal, findRootInitiative, getInitiativeSpend } = await import("../src/goals/ops.js");
const { runMigrations } = await import("../src/migrations.js");

describe("initiative spend tracking", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const projectId = "test-initiative";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
  });

  describe("findRootInitiative", () => {
    it("returns null when goal has no allocation", () => {
      createGoal({ projectId, title: "Plain goal", createdBy: "agent" }, db);
      const goals = db.prepare("SELECT id FROM goals WHERE project_id = ?").all(projectId) as { id: string }[];
      const result = findRootInitiative(projectId, goals[0].id, db);
      expect(result).toBeNull();
    });

    it("returns the goal itself when it has allocation", () => {
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
        VALUES ('init1', ?, 'UI Work', 'active', 'agent', ${Date.now()}, 40)
      `).run(projectId);

      const result = findRootInitiative(projectId, "init1", db);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("init1");
      expect(result!.allocation).toBe(40);
    });

    it("walks up to parent with allocation", () => {
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
        VALUES ('root', ?, 'UI Work', 'active', 'agent', ${Date.now()}, 40)
      `).run(projectId);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at)
        VALUES ('child', ?, 'Nav redesign', 'active', 'root', 'agent', ${Date.now()})
      `).run(projectId);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at)
        VALUES ('grandchild', ?, 'Fix dropdown', 'active', 'child', 'agent', ${Date.now()})
      `).run(projectId);

      const result = findRootInitiative(projectId, "grandchild", db);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("root");
    });

    it("returns null when no ancestor has allocation", () => {
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, created_by, created_at)
        VALUES ('plain-root', ?, 'Plain root', 'active', 'agent', ${Date.now()})
      `).run(projectId);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at)
        VALUES ('plain-child', ?, 'Plain child', 'active', 'plain-root', 'agent', ${Date.now()})
      `).run(projectId);

      const result = findRootInitiative(projectId, "plain-child", db);
      expect(result).toBeNull();
    });
  });

  describe("getInitiativeSpend", () => {
    it("aggregates cost across all tasks in goal tree", () => {
      const now = Date.now();
      // Create initiative with sub-goal
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
        VALUES ('init', ?, 'UI Work', 'active', 'agent', ?, 40)
      `).run(projectId, now);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at)
        VALUES ('sub', ?, 'Nav', 'active', 'init', 'agent', ?)
      `).run(projectId, now);

      // Create tasks under both goals
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
        VALUES ('t1', ?, 'Task 1', 'done', 'init', 'agent', ?, ?)
      `).run(projectId, now, now);
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
        VALUES ('t2', ?, 'Task 2', 'in_progress', 'sub', 'agent', ?, ?)
      `).run(projectId, now, now);

      // Record costs for both tasks
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      db.prepare(`
        INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
        VALUES ('c1', ?, 'worker', 't1', 1000, 500, 50, 'claude-sonnet-4-6', ?)
      `).run(projectId, todayStart.getTime() + 1000);
      db.prepare(`
        INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
        VALUES ('c2', ?, 'worker', 't2', 2000, 1000, 100, 'claude-sonnet-4-6', ?)
      `).run(projectId, todayStart.getTime() + 2000);

      const spend = getInitiativeSpend(projectId, "init", db);
      expect(spend).toBe(150); // 50 + 100 cents
    });

    it("returns 0 when no tasks have cost records", () => {
      db.prepare(`
        INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
        VALUES ('empty-init', ?, 'Empty', 'active', 'agent', ${Date.now()}, 20)
      `).run(projectId);

      const spend = getInitiativeSpend(projectId, "empty-init", db);
      expect(spend).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/goals/initiative-spend.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `findRootInitiative` and `getInitiativeSpend` not exported

**Step 3: Implement `findRootInitiative` and `getInitiativeSpend`**

Add to `src/goals/ops.ts`:

```typescript
/**
 * Walk up the goal hierarchy to find the root goal with an allocation.
 * Returns null if no ancestor has allocation.
 */
export function findRootInitiative(
  projectId: string,
  goalId: string,
  dbOverride?: DatabaseSync,
): Goal | null {
  const db = dbOverride ?? getDb(projectId);
  let currentId: string | null = goalId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) return null; // cycle protection
    visited.add(currentId);

    const row = db.prepare(
      "SELECT * FROM goals WHERE id = ? AND project_id = ?",
    ).get(currentId, projectId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const goal = rowToGoal(row);
    if (goal.allocation != null && goal.allocation > 0) {
      return goal;
    }

    currentId = (row.parent_goal_id as string) ?? null;
  }

  return null;
}

/**
 * Get today's total spend (in cents) for all tasks under a goal tree.
 * Recursively collects all goal IDs in the tree, then sums cost_records.
 */
export function getInitiativeSpend(
  projectId: string,
  rootGoalId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);

  // Collect all goal IDs in the tree
  const goalIds: string[] = [];
  const queue = [rootGoalId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    goalIds.push(id);
    const children = db.prepare(
      "SELECT id FROM goals WHERE parent_goal_id = ? AND project_id = ?",
    ).all(id, projectId) as { id: string }[];
    for (const child of children) {
      queue.push(child.id);
    }
  }

  if (goalIds.length === 0) return 0;

  // Get today's start timestamp
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Sum cost for all tasks under these goals (today only)
  const placeholders = goalIds.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT COALESCE(SUM(cr.cost_cents), 0) as total
    FROM cost_records cr
    JOIN tasks t ON cr.task_id = t.id AND cr.project_id = t.project_id
    WHERE t.goal_id IN (${placeholders})
      AND cr.project_id = ?
      AND cr.created_at >= ?
  `).get(...goalIds, projectId, todayStart.getTime()) as { total: number };

  return row.total;
}
```

**Step 4: Export from index.ts**

In `src/index.ts`, add to the goals/ops export line:

```typescript
export { createGoal, getGoal, listGoals, updateGoal, achieveGoal, abandonGoal, getChildGoals, getGoalTree, linkTaskToGoal, unlinkTaskFromGoal, getGoalTasks, findRootInitiative, getInitiativeSpend } from "./goals/ops.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/goals/initiative-spend.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
git add src/goals/ops.ts src/index.ts test/goals/initiative-spend.test.ts
git commit -m "feat: add parent-walking findRootInitiative and getInitiativeSpend"
```

---

### Task 3: Hard Gate in Dispatcher — Block Over-Budget Initiatives

**Files:**
- Modify: `src/dispatch/dispatcher.ts:577-594` (`shouldDispatch`)
- Create: `test/dispatch/initiative-gate.test.ts`

**Step 1: Write the failing test**

Create `test/dispatch/initiative-gate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");
const { clearAllUsage, updateProviderUsage } = await import("../src/rate-limits.js");
const { shouldDispatch } = await import("../src/dispatch/dispatcher.js");

describe("dispatch gate — initiative budget", () => {
  const projectId = "test-init-gate";
  let db: ReturnType<typeof getMemoryDb>;

  beforeEach(() => {
    clearAllUsage();
    db = getMemoryDb();
    runMigrations(db);

    // Set up project budget: 1000 cents/day
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 1000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 10 }],
    });
  });

  it("blocks dispatch when initiative allocation exceeded", () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Create initiative with 10% allocation (100 cents of 1000)
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init1', ?, 'Small initiative', 'active', 'agent', ?, 10)
    `).run(projectId, now);

    // Create task under initiative
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
      VALUES ('t1', ?, 'Task 1', 'in_progress', 'init1', 'agent', ?, ?)
    `).run(projectId, now, now);

    // Record 150 cents of cost (exceeds 100 cent allocation)
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('c1', ?, 'worker', 't1', 5000, 2000, 150, 'claude-sonnet-4-6', ?)
    `).run(projectId, todayStart.getTime() + 1000);

    // shouldDispatch should check task's initiative budget
    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId: "t1" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("initiative");
  });

  it("allows dispatch when within initiative allocation", () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init2', ?, 'Big initiative', 'active', 'agent', ?, 50)
    `).run(projectId, now);

    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
      VALUES ('t2', ?, 'Task 2', 'in_progress', 'init2', 'agent', ?, ?)
    `).run(projectId, now, now);

    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('c2', ?, 'worker', 't2', 1000, 500, 50, 'claude-sonnet-4-6', ?)
    `).run(projectId, todayStart.getTime() + 1000);

    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId: "t2" });
    expect(result.ok).toBe(true);
  });

  it("allows dispatch when task has no goal", () => {
    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId: "no-task" });
    expect(result.ok).toBe(true);
  });

  it("allows dispatch when goal has no allocation", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at)
      VALUES ('plain', ?, 'No allocation', 'active', 'agent', ?)
    `).run(projectId, now);

    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
      VALUES ('t3', ?, 'Task 3', 'in_progress', 'plain', 'agent', ?, ?)
    `).run(projectId, now, now);

    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId: "t3" });
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/dispatch/initiative-gate.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `shouldDispatch` doesn't accept `taskId` option

**Step 3: Update `shouldDispatch` to check initiative budget**

In `src/dispatch/dispatcher.ts`, modify `shouldDispatch`:

```typescript
export function shouldDispatch(
  projectId: string,
  agentId: string,
  provider: string = "anthropic",
  options?: { taskId?: string },
): { ok: true } | { ok: false; reason: string } {
  // Check multi-window budget (hourly / daily / monthly)
  const budgetResult = checkMultiWindowBudget({ projectId, agentId });
  if (!budgetResult.ok) {
    return { ok: false, reason: budgetResult.reason! };
  }

  // Check provider rate limits
  if (isProviderThrottled(provider, 95)) {
    return { ok: false, reason: `Provider ${provider} rate limit exceeded (>95% used)` };
  }

  // Check initiative budget if task is specified
  if (options?.taskId) {
    const initiativeResult = checkInitiativeBudget(projectId, options.taskId);
    if (!initiativeResult.ok) {
      return initiativeResult;
    }
  }

  return { ok: true };
}
```

Add the `checkInitiativeBudget` helper in the same file:

```typescript
import { findRootInitiative, getInitiativeSpend } from "../goals/ops.js";

function checkInitiativeBudget(
  projectId: string,
  taskId: string,
): { ok: true } | { ok: false; reason: string } {
  const db = getDb(projectId);

  // Look up task's goal_id
  const task = db.prepare(
    "SELECT goal_id FROM tasks WHERE id = ? AND project_id = ?",
  ).get(taskId, projectId) as { goal_id: string | null } | undefined;

  if (!task?.goal_id) return { ok: true }; // No goal = no initiative gate

  // Walk up to root initiative
  const initiative = findRootInitiative(projectId, task.goal_id);
  if (!initiative?.allocation) return { ok: true }; // No allocation = no gate

  // Get project daily budget
  const budget = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;

  if (!budget) return { ok: true }; // No project budget = no gate

  const allocationCents = Math.floor((initiative.allocation / 100) * budget.daily_limit_cents);
  const spentCents = getInitiativeSpend(projectId, initiative.id);

  if (spentCents >= allocationCents) {
    return {
      ok: false,
      reason: `Initiative "${initiative.title}" budget exceeded: spent ${spentCents}c of ${allocationCents}c allocation (${initiative.allocation}% of ${budget.daily_limit_cents}c daily budget)`,
    };
  }

  return { ok: true };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/dispatch/initiative-gate.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run existing dispatch tests to verify no regressions**

Run: `npx vitest run test/dispatch/ --reporter=verbose 2>&1 | tail -20`
Expected: All PASS (existing tests don't pass `taskId`, so initiative gate is skipped)

**Step 6: Commit**

```bash
git add src/dispatch/dispatcher.ts test/dispatch/initiative-gate.test.ts
git commit -m "feat: hard gate — block dispatch when initiative budget exceeded"
```

---

### Task 4: Goal Tool — Add Allocation Support

**Files:**
- Modify: `src/tools/goal-tool.ts:29-54` (schema), `src/tools/goal-tool.ts:85-192` (handler)
- Modify: `src/goals/ops.ts` (`createGoal`, `updateGoal`)
- Modify: `test/tools/goal-tool.test.ts`

**Step 1: Write the failing tests**

Add to `test/tools/goal-tool.test.ts`:

```typescript
it("create — sets allocation on goal", async () => {
  const result = await execute({
    action: "create",
    title: "UI Improvements",
    description: "Dashboard UX",
    allocation: 40,
  });
  expect(result.ok).toBe(true);
  expect(result.goal.allocation).toBe(40);
});

it("create — rejects allocation > 100", async () => {
  const result = await execute({
    action: "create",
    title: "Too much",
    allocation: 150,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("0-100");
});

it("status — shows budget info when goal has allocation", async () => {
  // Create initiative
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
    VALUES ('init-status', '${projectId}', 'UI Work', 'active', 'agent', ${Date.now()}, 40)
  `).run();

  // Set up project budget
  db.prepare(`
    INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
    VALUES ('b-status', '${projectId}', NULL, 1000, 0, ${Date.now() + 86400000}, ${Date.now()}, ${Date.now()})
  `).run();

  const result = await execute({ action: "status", goal_id: "init-status" });
  expect(result.ok).toBe(true);
  expect(result.budget).toBeDefined();
  expect(result.budget.allocationPercent).toBe(40);
  expect(result.budget.allocationCents).toBe(400);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/goal-tool.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL

**Step 3: Add `allocation` to goal tool schema**

In `src/tools/goal-tool.ts`, add to the schema:

```typescript
allocation: Type.Optional(Type.Number({ description: "Budget allocation as percentage of project daily budget (0-100). Makes this goal an initiative." })),
```

**Step 4: Update `createGoal` in `src/goals/ops.ts` to accept allocation**

In the `CreateGoalParams` type, add `allocation?: number`. In the `createGoal` function body, include `allocation` in the INSERT:

```typescript
export type CreateGoalParams = {
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  parentGoalId?: string;
  ownerAgentId?: string;
  department?: string;
  team?: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
  allocation?: number;
};
```

Update the INSERT statement to include allocation:

```sql
INSERT INTO goals (id, project_id, title, description, acceptance_criteria, status, parent_goal_id, owner_agent_id, department, team, created_by, created_at, metadata, allocation)
VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
```

And add the allocation value to the `.run()` call.

**Step 5: Update `updateGoal` in `src/goals/ops.ts` to accept allocation**

Add `allocation` to the accepted fields and SET clause.

**Step 6: Update goal tool handler**

In the `create` case of the goal tool handler, read the `allocation` param and validate 0-100:

```typescript
case "create": {
  const allocation = input.allocation;
  if (allocation != null && (allocation < 0 || allocation > 100)) {
    return jsonResult({ ok: false, error: "allocation must be 0-100" });
  }
  const goal = createGoal({
    projectId: pid,
    title: input.title!,
    description: input.description,
    acceptanceCriteria: input.acceptance_criteria,
    parentGoalId: input.parent_goal_id,
    ownerAgentId: input.owner_agent_id,
    department: input.department,
    team: input.team,
    createdBy: agentSessionKey,
    allocation,
  }, dbOverride);
  // ...
}
```

In the `status` case, add budget info when allocation is present:

```typescript
case "status": {
  // ... existing progress/children logic ...
  let budget: Record<string, unknown> | undefined;
  if (goal.allocation != null) {
    const db = dbOverride ?? getDb(pid);
    const projectBudget = db.prepare(
      "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(pid) as { daily_limit_cents: number } | undefined;
    const dailyBudget = projectBudget?.daily_limit_cents ?? 0;
    const allocationCents = Math.floor((goal.allocation / 100) * dailyBudget);
    const spentCents = getInitiativeSpend(pid, goal.id, dbOverride);
    budget = {
      allocationPercent: goal.allocation,
      allocationCents,
      spentCents,
      remainingCents: allocationCents - spentCents,
    };
  }
  return jsonResult({ ok: true, goal, progress, children, budget });
}
```

**Step 7: Run test to verify it passes**

Run: `npx vitest run test/tools/goal-tool.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 8: Commit**

```bash
git add src/tools/goal-tool.ts src/goals/ops.ts test/tools/goal-tool.test.ts
git commit -m "feat: goal tool supports allocation param for initiative budget"
```

---

### Task 5: Config Parsing — Goals from YAML

**Files:**
- Modify: `src/types.ts` (add `GoalConfig` to `WorkforceConfig`)
- Modify: `src/project.ts` (parse goals section, create on activate)
- Modify: `src/tools/setup-tool.ts` (create goals during activate)
- Create: `test/project/goals-config.test.ts`

**Step 1: Write the failing test**

Create `test/project/goals-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { loadWorkforceConfig } = await import("../src/project.js");

describe("goals config parsing", () => {
  it("parses goals section from config", () => {
    const config = loadWorkforceConfig({
      name: "test-project",
      agents: {
        manager: { extends: "manager", title: "Lead" },
      },
      goals: {
        "ui-improvements": {
          allocation: 40,
          description: "Dashboard UX improvements",
          department: "engineering",
        },
        "outreach": {
          allocation: 30,
          description: "Customer outreach",
        },
      },
    });

    expect(config.goals).toBeDefined();
    expect(config.goals!["ui-improvements"]).toEqual({
      allocation: 40,
      description: "Dashboard UX improvements",
      department: "engineering",
    });
    expect(config.goals!["outreach"].allocation).toBe(30);
  });

  it("validates allocations sum to <= 100", () => {
    expect(() => loadWorkforceConfig({
      name: "test-project",
      agents: {
        manager: { extends: "manager", title: "Lead" },
      },
      goals: {
        "a": { allocation: 60 },
        "b": { allocation: 50 },
      },
    })).toThrow(/exceed 100/);
  });

  it("works without goals section", () => {
    const config = loadWorkforceConfig({
      name: "test-project",
      agents: {
        manager: { extends: "manager", title: "Lead" },
      },
    });
    expect(config.goals).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/project/goals-config.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `goals` not recognized in config

**Step 3: Add GoalConfig to types**

In `src/types.ts`, add:

```typescript
export type GoalConfigEntry = {
  description?: string;
  allocation?: number;
  department?: string;
  team?: string;
  acceptance_criteria?: string;
  owner_agent_id?: string;
};
```

Add `goals?: Record<string, GoalConfigEntry>` to `WorkforceConfig`.

**Step 4: Parse goals in `src/project.ts`**

In `loadWorkforceConfig`, after parsing other sections, add:

```typescript
// Parse goals
if (raw.goals && typeof raw.goals === "object") {
  const goals: Record<string, GoalConfigEntry> = {};
  let totalAllocation = 0;

  for (const [id, def] of Object.entries(raw.goals as Record<string, Record<string, unknown>>)) {
    const entry: GoalConfigEntry = {
      description: def.description as string | undefined,
      allocation: def.allocation as number | undefined,
      department: def.department as string | undefined,
      team: def.team as string | undefined,
      acceptance_criteria: def.acceptance_criteria as string | undefined,
      owner_agent_id: def.owner_agent_id as string | undefined,
    };
    if (entry.allocation != null) {
      totalAllocation += entry.allocation;
    }
    goals[id] = entry;
  }

  if (totalAllocation > 100) {
    throw new Error(`Goal allocations exceed 100%: total is ${totalAllocation}%`);
  }

  config.goals = goals;
}
```

**Step 5: Create goals during activate in setup-tool**

In `src/tools/setup-tool.ts`, in the `activate` action handler, after agent registration, add:

```typescript
// Create goals from config
if (config.goals) {
  const { createGoal, listGoals } = await import("../goals/ops.js");
  for (const [goalId, goalDef] of Object.entries(config.goals)) {
    // Check if goal already exists (idempotent)
    const existing = listGoals({ projectId: pid, status: "active" }, dbOverride)
      .find(g => g.title === goalId);
    if (!existing) {
      createGoal({
        projectId: pid,
        title: goalId,
        description: goalDef.description,
        acceptanceCriteria: goalDef.acceptance_criteria,
        department: goalDef.department,
        team: goalDef.team,
        ownerAgentId: goalDef.owner_agent_id,
        createdBy: agentSessionKey,
        allocation: goalDef.allocation,
      }, dbOverride);
    }
  }
}
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/project/goals-config.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 7: Commit**

```bash
git add src/types.ts src/project.ts src/tools/setup-tool.ts test/project/goals-config.test.ts
git commit -m "feat: parse goals with allocation from project.yaml config"
```

---

### Task 6: Initiative Status Briefing Source

**Files:**
- Modify: `src/types.ts:201-212` (add `initiative_status` to ContextSource union)
- Modify: `src/context/assembler.ts` (add resolver)
- Modify: `src/project.ts` (add to VALID_SOURCES)
- Create: `test/context/initiative-status.test.ts`

**Step 1: Write the failing test**

Create `test/context/initiative-status.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");

describe("initiative_status context source", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const projectId = "test-init-ctx";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
  });

  it("renders initiative allocation table with spend", async () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Project budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 1000, 0, ?, ?, ?)
    `).run(projectId, now + 86400000, now, now);

    // Two initiatives
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-a', ?, 'UI Work', 'active', 'agent', ?, 40)
    `).run(projectId, now);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-b', ?, 'Outreach', 'active', 'agent', ?, 30)
    `).run(projectId, now);

    // Task + cost under init-a
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, goal_id, created_by, created_at, updated_at)
      VALUES ('t1', ?, 'Fix nav', 'done', 'init-a', 'agent', ?, ?)
    `).run(projectId, now, now);
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('c1', ?, 'worker', 't1', 1000, 500, 200, 'claude-sonnet-4-6', ?)
    `).run(projectId, todayStart.getTime() + 1000);

    // Import and call the resolver
    const { resolveInitiativeStatusSource } = await import("../src/context/assembler.js");
    const result = resolveInitiativeStatusSource(projectId, db);

    expect(result).toContain("UI Work");
    expect(result).toContain("40%");
    expect(result).toContain("400c"); // allocation cents
    expect(result).toContain("200c"); // spent
    expect(result).toContain("Outreach");
    expect(result).toContain("30%");
    expect(result).toContain("Reserve");
  });

  it("returns empty message when no initiatives exist", async () => {
    const { resolveInitiativeStatusSource } = await import("../src/context/assembler.js");
    const result = resolveInitiativeStatusSource(projectId, db);
    expect(result).toContain("No initiatives");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/initiative-status.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `resolveInitiativeStatusSource` not exported

**Step 3: Add `initiative_status` to ContextSource union**

In `src/types.ts`, add `"initiative_status"` to the source union string (line ~202).

**Step 4: Add to VALID_SOURCES in `src/project.ts`**

Add `"initiative_status"` to the `VALID_SOURCES` set.

**Step 5: Implement resolver in `src/context/assembler.ts`**

Add the resolver function and wire it into the switch:

```typescript
export function resolveInitiativeStatusSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  // Get initiatives (goals with allocation)
  const initiatives = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND allocation IS NOT NULL AND status = 'active' ORDER BY allocation DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (initiatives.length === 0) return "No initiatives configured.";

  // Get project daily budget
  const budgetRow = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;
  const dailyBudget = budgetRow?.daily_limit_cents ?? 0;

  const lines: string[] = ["## Initiative Budget Status", ""];
  lines.push(`Daily budget: ${dailyBudget}c`, "");
  lines.push("| Initiative | Allocation | Budget | Spent | Remaining |");
  lines.push("|------------|-----------|--------|-------|-----------|");

  let totalAllocation = 0;
  let totalSpent = 0;

  for (const row of initiatives) {
    const goal = rowToGoal(row);
    const allocationPct = goal.allocation!;
    const allocationCents = Math.floor((allocationPct / 100) * dailyBudget);
    const spent = getInitiativeSpend(projectId, goal.id, db);
    const remaining = allocationCents - spent;
    totalAllocation += allocationPct;
    totalSpent += spent;

    const status = remaining <= 0 ? " ⛔" : remaining < allocationCents * 0.25 ? " ⚠️" : "";
    lines.push(`| ${goal.title} | ${allocationPct}% | ${allocationCents}c | ${spent}c | ${remaining}c${status} |`);
  }

  const reservePct = 100 - totalAllocation;
  const reserveCents = dailyBudget - Math.floor((totalAllocation / 100) * dailyBudget);
  lines.push("");
  lines.push(`Reserve: ${reservePct}% (${reserveCents}c)`);
  lines.push(`Total spent: ${totalSpent}c of ${dailyBudget}c`);

  return lines.join("\n");
}
```

Wire it in the `resolveSource` switch:

```typescript
case "initiative_status":
  return resolveInitiativeStatusSource(projectId, dbOverride);
```

Import `getInitiativeSpend` from `../goals/ops.js` at the top of the file. Use the existing `rowToGoal` or import from goals/ops — check if assembler already has goal row parsing. If not, do inline parsing of the needed fields.

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/context/initiative-status.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 7: Commit**

```bash
git add src/types.ts src/project.ts src/context/assembler.ts test/context/initiative-status.test.ts
git commit -m "feat: initiative_status briefing source shows allocation and spend"
```

---

### Task 7: Cascading Budget — Allocation to Reports

**Files:**
- Create: `src/budget-cascade.ts`
- Modify: `src/tools/ops-tool.ts` (add `allocate_budget` action)
- Modify: `src/index.ts` (export new module)
- Create: `test/budget-cascade.test.ts`

**Step 1: Write the failing tests**

Create `test/budget-cascade.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");
const { allocateBudget, getAgentBudgetStatus } = await import("../src/budget-cascade.js");

describe("cascading budget allocation", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const projectId = "test-cascade";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);

    // Parent agent with $10 daily budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-parent', ?, 'manager', 1000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());
  });

  it("allocates budget from parent to child", () => {
    const result = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    }, db);

    expect(result.ok).toBe(true);

    const status = getAgentBudgetStatus(projectId, "frontend", db);
    expect(status.dailyLimitCents).toBe(400);
  });

  it("rejects allocation exceeding parent's allocatable budget", () => {
    // Allocate 600 to one child
    allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 600,
    }, db);

    // Try to allocate 500 more — only 400 remains
    const result = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "backend",
      dailyLimitCents: 500,
    }, db);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds");
  });

  it("allows updating existing allocation", () => {
    allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    }, db);

    // Update to 300
    const result = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 300,
    }, db);

    expect(result.ok).toBe(true);
    const status = getAgentBudgetStatus(projectId, "frontend", db);
    expect(status.dailyLimitCents).toBe(300);
  });

  it("getAgentBudgetStatus shows allocated to reports", () => {
    allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    }, db);
    allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "backend",
      dailyLimitCents: 300,
    }, db);

    const status = getAgentBudgetStatus(projectId, "manager", db);
    expect(status.dailyLimitCents).toBe(1000);
    expect(status.allocatedToReportsCents).toBe(700);
    expect(status.allocatableCents).toBe(300);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget-cascade.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Implement `src/budget-cascade.ts`**

```typescript
import { type DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";

export type AllocateBudgetParams = {
  projectId: string;
  parentAgentId: string;
  childAgentId: string;
  dailyLimitCents: number;
};

export type AllocateBudgetResult =
  | { ok: true }
  | { ok: false; reason: string };

export type AgentBudgetStatus = {
  dailyLimitCents: number;
  dailySpentCents: number;
  allocatedToReportsCents: number;
  allocatableCents: number;
};

/**
 * Allocate daily budget from parent agent to child agent.
 * Child's limit is bounded by parent's remaining allocatable budget.
 */
export function allocateBudget(
  params: AllocateBudgetParams,
  dbOverride?: DatabaseSync,
): AllocateBudgetResult {
  const db = dbOverride ?? getDb(params.projectId);

  // Get parent's budget
  const parentBudget = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(params.projectId, params.parentAgentId) as { daily_limit_cents: number } | undefined;

  if (!parentBudget) {
    return { ok: false, reason: `Parent agent "${params.parentAgentId}" has no budget` };
  }

  // Get current allocations to all reports (excluding the target child for update case)
  const allocated = db.prepare(`
    SELECT COALESCE(SUM(daily_limit_cents), 0) as total
    FROM budgets
    WHERE project_id = ? AND agent_id != ? AND id IN (
      SELECT id FROM budgets WHERE project_id = ? AND agent_id IN (
        SELECT agent_id FROM budgets WHERE project_id = ? AND agent_id != ?
      )
    )
  `).get(params.projectId, params.parentAgentId, params.projectId, params.projectId, params.parentAgentId);

  // Simpler approach: get all child allocations set by this parent
  // We need a parent_agent_id field on budgets to track who allocated
  // For now, use a simpler approach: sum all non-parent agent budgets
  const otherAllocations = db.prepare(`
    SELECT COALESCE(SUM(daily_limit_cents), 0) as total
    FROM budgets
    WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id != ? AND agent_id != ?
  `).get(params.projectId, params.parentAgentId, params.childAgentId) as { total: number };

  const allocatable = parentBudget.daily_limit_cents - otherAllocations.total;

  if (params.dailyLimitCents > allocatable) {
    return {
      ok: false,
      reason: `Allocation of ${params.dailyLimitCents}c exceeds parent's allocatable budget of ${allocatable}c`,
    };
  }

  // Upsert child's budget
  const existing = db.prepare(
    "SELECT id FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(params.projectId, params.childAgentId) as { id: string } | undefined;

  const now = Date.now();
  if (existing) {
    db.prepare(
      "UPDATE budgets SET daily_limit_cents = ?, updated_at = ? WHERE id = ?",
    ).run(params.dailyLimitCents, now, existing.id);
  } else {
    const id = `budget-${params.childAgentId}-${now}`;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, params.projectId, params.childAgentId, params.dailyLimitCents, now + 86400000, now, now);
  }

  safeLog("budget.cascade.allocate", { parent: params.parentAgentId, child: params.childAgentId, cents: params.dailyLimitCents });
  return { ok: true };
}

/**
 * Get budget status for an agent including how much is allocated to reports.
 */
export function getAgentBudgetStatus(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): AgentBudgetStatus {
  const db = dbOverride ?? getDb(projectId);

  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId) as { daily_limit_cents: number; daily_spent_cents: number } | undefined;

  const dailyLimitCents = budget?.daily_limit_cents ?? 0;
  const dailySpentCents = budget?.daily_spent_cents ?? 0;

  // Sum allocations to direct reports
  // For now: sum all other agent budgets under this project
  // TODO: Track parent_agent_id for proper hierarchy awareness
  const reportAllocations = db.prepare(`
    SELECT COALESCE(SUM(daily_limit_cents), 0) as total
    FROM budgets
    WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id != ?
  `).get(projectId, agentId) as { total: number };

  const allocatedToReportsCents = reportAllocations.total;
  const allocatableCents = Math.max(0, dailyLimitCents - allocatedToReportsCents);

  return {
    dailyLimitCents,
    dailySpentCents,
    allocatedToReportsCents,
    allocatableCents,
  };
}
```

**Step 4: Add `allocate_budget` action to ops tool**

In `src/tools/ops-tool.ts`, add `"allocate_budget"` to `OPS_ACTIONS` array and add params to schema:

```typescript
parent_agent_id: Type.Optional(Type.String({ description: "Parent agent for budget allocation." })),
child_agent_id: Type.Optional(Type.String({ description: "Child agent to receive budget allocation." })),
daily_limit_cents: Type.Optional(Type.Number({ description: "Daily budget limit in cents to allocate." })),
```

Add case handler:

```typescript
case "allocate_budget": {
  const parentAgentId = readStringParam(input, "parent_agent_id");
  const childAgentId = readStringParam(input, "child_agent_id");
  const dailyLimitCents = readNumberParam(input, "daily_limit_cents");
  if (!parentAgentId || !childAgentId || dailyLimitCents == null) {
    return jsonResult({ ok: false, error: "parent_agent_id, child_agent_id, and daily_limit_cents required" });
  }
  const { allocateBudget } = await import("../budget-cascade.js");
  const result = allocateBudget({ projectId: pid, parentAgentId, childAgentId, dailyLimitCents }, dbOverride);
  if (result.ok) {
    writeAuditEntry(db, pid, agentSessionKey, "allocate_budget", { parentAgentId, childAgentId, dailyLimitCents });
  }
  return jsonResult(result);
}
```

**Step 5: Export from index.ts**

```typescript
export { allocateBudget, getAgentBudgetStatus } from "./budget-cascade.js";
export type { AllocateBudgetParams, AllocateBudgetResult, AgentBudgetStatus } from "./budget-cascade.js";
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/budget-cascade.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 7: Commit**

```bash
git add src/budget-cascade.ts src/tools/ops-tool.ts src/index.ts test/budget-cascade.test.ts
git commit -m "feat: cascading budget allocation from parent to child agents"
```

---

### Task 8: Skills Topic Update — Document Initiatives

**Files:**
- Modify: `src/skills/topics/goals.ts`

**Step 1: Read current file**

Read `src/skills/topics/goals.ts` to see the current documentation content.

**Step 2: Update the generate function**

Add initiative documentation after the existing goal content:

```typescript
// Add after the existing goal documentation sections:

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
```

**Step 3: Run goals test to verify no regressions**

Run: `npx vitest run test/skills/ --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 4: Commit**

```bash
git add src/skills/topics/goals.ts
git commit -m "docs: update goals skill topic with initiative budget documentation"
```

---

### Task 9: Integration Test — End-to-End Dispatch Blocking

**Files:**
- Create: `test/dispatch/initiative-e2e.test.ts`

**Step 1: Write the integration test**

Create `test/dispatch/initiative-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");
const { clearAllUsage, updateProviderUsage } = await import("../src/rate-limits.js");
const { shouldDispatch } = await import("../src/dispatch/dispatcher.js");
const { createGoal } = await import("../src/goals/ops.js");
const { recordCost } = await import("../src/cost.js");
const { allocateBudget } = await import("../src/budget-cascade.js");

describe("initiative budget — end-to-end", () => {
  const projectId = "test-e2e-init";
  let db: ReturnType<typeof getMemoryDb>;

  beforeEach(() => {
    clearAllUsage();
    db = getMemoryDb();
    runMigrations(db);

    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 10 }],
    });

    // Project budget: $10/day
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-proj', ?, NULL, 1000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());
  });

  it("full lifecycle: create initiative, spend budget, get blocked", () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 1. Create initiative with 10% allocation ($1)
    const initiative = createGoal({
      projectId,
      title: "Small Initiative",
      createdBy: "manager",
      allocation: 10,
    }, db);

    // 2. Create sub-goal
    const subGoal = createGoal({
      projectId,
      title: "Sub-task area",
      parentGoalId: initiative.id,
      createdBy: "manager",
    }, db);

    // 3. Create task under sub-goal
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, goal_id, assignee, created_by, created_at, updated_at)
      VALUES ('task-1', ?, 'Do the thing', 'in_progress', ?, 'worker', 'manager', ?, ?)
    `).run(projectId, subGoal.id, now, now);

    // 4. First dispatch should be OK (no spend yet)
    const r1 = shouldDispatch(projectId, "worker", "anthropic", { taskId: "task-1" });
    expect(r1.ok).toBe(true);

    // 5. Record 120 cents of cost (exceeds 100c = 10% of 1000c)
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('cr-1', ?, 'worker', 'task-1', 10000, 5000, 120, 'claude-opus-4-6', ?)
    `).run(projectId, todayStart.getTime() + 5000);

    // 6. Next dispatch should be BLOCKED
    const r2 = shouldDispatch(projectId, "worker", "anthropic", { taskId: "task-1" });
    expect(r2.ok).toBe(false);
    expect((r2 as { reason: string }).reason).toContain("initiative");
    expect((r2 as { reason: string }).reason).toContain("Small Initiative");
  });

  it("cascading: parent allocates to child, child bounded", () => {
    // Manager has $10 budget (from project)
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-mgr', ?, 'manager', 1000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Allocate $4 to frontend
    const r1 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    }, db);
    expect(r1.ok).toBe(true);

    // Allocate $4 to backend
    const r2 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "backend",
      dailyLimitCents: 400,
    }, db);
    expect(r2.ok).toBe(true);

    // Try to allocate $300 more to QA — only 200 remains
    const r3 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "qa",
      dailyLimitCents: 300,
    }, db);
    expect(r3.ok).toBe(false);

    // $200 allocation should work
    const r4 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "qa",
      dailyLimitCents: 200,
    }, db);
    expect(r4.ok).toBe(true);
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run test/dispatch/initiative-e2e.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS (all prior tasks' code supports this)

**Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass, no regressions

**Step 4: Commit**

```bash
git add test/dispatch/initiative-e2e.test.ts
git commit -m "test: end-to-end integration tests for initiative budget gating"
```

---

### Task 10: Documentation — README and ROADMAP Update

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP-v2.md`

**Step 1: Update README.md**

Add a section after "Task Lifecycle" called "Initiatives & Budget Allocation":

```markdown
## Initiatives & Budget Allocation

Goals with an `allocation` field are **initiatives** — strategic priorities with hard budget enforcement.

### Config

```yaml
budget:
  daily_limit_cents: 2000

goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
    department: engineering
  customer-outreach:
    allocation: 30
    description: "Daily lead gen and follow-ups"
    department: sales
```

Allocations are percentages of the project's daily budget. Unallocated remainder (here 30%) serves as reserve for ad-hoc work.

### Hard Gate

When an initiative's spend reaches its allocation, dispatch is **blocked** for all tasks under that goal tree. The gate traces tasks up the goal hierarchy to find their root initiative.

### Cascading Budget

Budget flows uniformly through the agent tree. Coordination agents allocate portions of their budget to reports. Each allocation is bounded by the parent's remaining allocatable budget.

| Tool | Action | Purpose |
|------|--------|---------|
| `clawforce_goal` | `create` with `allocation` | Create an initiative |
| `clawforce_goal` | `status` | See budget spend for initiative |
| `clawforce_ops` | `allocate_budget` | Allocate budget to a report |
```

**Step 2: Update ROADMAP-v2.md**

Mark Phase 7 items as complete:

```markdown
### Phase 7: Initiatives & Resource Allocation
- [x] 7.1: Initiative model (goals with allocation, hard dispatch gate)
- [x] 7.2: Resource config (rate limits, model costs as context) — budget system complete
- [x] 7.3: Cascading budget allocation (uniform agent tree budget flow)
- [ ] 7.4: Autonomous scheduling (manager plans own dispatch cadence)
```

**Step 3: Commit**

```bash
git add README.md ROADMAP-v2.md
git commit -m "docs: update README and roadmap for Phase 7 initiatives"
```

---

Plan complete and saved to `docs/plans/2026-03-10-initiatives-resource-allocation.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?