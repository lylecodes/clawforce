# Autonomous Scheduling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Coordination agents plan their own dispatch cadence with dispatch plans, cost forecasting, adaptive wake frequency, and rate-aware slot planning.

**Architecture:** Seven features that ship together as the "autonomous scheduling" story. New `src/scheduling/` module handles cost estimation, dispatch plans, and slot calculation. Existing ops-tool and context assembler get new actions and sources. All features default-on in manager preset.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), vitest, existing Clawforce infrastructure (goals, dispatch, ops-tool, context assembler, profiles, migrations)

**Reference:** Design doc at `docs/plans/2026-03-11-autonomous-scheduling-design.md`

---

### Task 1: Priority on Goals

Add `priority` field (P0-P3, reusing existing `TaskPriority`) to goals. Tasks inherit priority from their linked goal when not explicitly set.

**Files:**
- Modify: `src/types.ts:897-913` (Goal type)
- Modify: `src/migrations.ts:12,38-40,829-831` (V25 migration)
- Modify: `src/goals/ops.ts:18-39,43-55,202-211` (rowToGoal, CreateGoalParams, UpdateGoalParams)
- Modify: `src/tools/goal-tool.ts:30-56,87-108` (schema, create action)
- Modify: `src/dispatch/queue.ts:93-139` (claimNext ordering — goal priority inheritance)
- Create: `test/goals/goal-priority.test.ts`

**Step 1: Write the failing test**

Create `test/goals/goal-priority.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createGoal, getGoal, updateGoal } = await import("../../src/goals/ops.js");

describe("goal priority", () => {
  let db: DatabaseSync;
  const PROJECT = "priority-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a goal with priority", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Urgent fix",
      createdBy: "test",
      priority: "P0",
    }, db);

    expect(goal.priority).toBe("P0");

    const fetched = getGoal(PROJECT, goal.id, db);
    expect(fetched!.priority).toBe("P0");
  });

  it("defaults to no priority when not specified", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Normal goal",
      createdBy: "test",
    }, db);

    expect(goal.priority).toBeUndefined();
  });

  it("updates priority on existing goal", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Reprioritize me",
      createdBy: "test",
    }, db);

    const updated = updateGoal(PROJECT, goal.id, { priority: "P1" }, db);
    expect(updated.priority).toBe("P1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/goals/goal-priority.test.ts`
Expected: FAIL — `priority` not recognized in CreateGoalParams

**Step 3: Add migration V25 — priority column on goals**

In `src/migrations.ts`:

1. Change `SCHEMA_VERSION` from `24` to `25` (line 12)
2. Add migration function after `migrateV24`:

```typescript
function migrateV25(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE goals ADD COLUMN priority TEXT");
}
```

3. Add to MIGRATIONS map: `[25, migrateV25],`

**Step 4: Add priority to Goal type**

In `src/types.ts`, add to the Goal type (after `allocation?: number`):

```typescript
  priority?: TaskPriority;
```

**Step 5: Update goals/ops.ts**

In `src/goals/ops.ts`:

1. Add to `rowToGoal` (after the allocation line):
```typescript
  if (row.priority != null) goal.priority = row.priority as Goal["priority"];
```

2. Add to `CreateGoalParams`:
```typescript
  priority?: Goal["priority"];
```

3. Update `createGoal` INSERT statement — add `priority` column and `params.priority ?? null` value.

4. Add to `UpdateGoalParams`:
```typescript
  priority?: Goal["priority"];
```

5. Add to `updateGoal` dynamic SET clause:
```typescript
  if (updates.priority !== undefined) { sets.push("priority = ?"); params.push(updates.priority); }
```

6. Update the goal return object in `createGoal` to include `priority: params.priority`.

**Step 6: Update goal-tool schema**

In `src/tools/goal-tool.ts`, add to schema (after allocation):

```typescript
  priority: Type.Optional(stringEnum(["P0", "P1", "P2", "P3"], { description: "Goal priority (P0=critical, P3=low). Tasks under this goal inherit its priority." })),
```

Update create action to pass `priority` to `createGoal`.

**Step 7: Run test to verify it passes**

Run: `npx vitest run test/goals/goal-priority.test.ts`
Expected: PASS (3 tests)

**Step 8: Commit**

```bash
git add src/types.ts src/migrations.ts src/goals/ops.ts src/tools/goal-tool.ts test/goals/goal-priority.test.ts
git commit -m "feat: add priority field (P0-P3) to goals"
```

---

### Task 2: Cost Averages Engine

New module that computes session cost estimates with a fallback chain: initiative + agent + model → initiative + model → initiative only → global average → hardcoded default.

**Files:**
- Create: `src/scheduling/cost-engine.ts`
- Create: `test/scheduling/cost-engine.test.ts`

**Step 1: Write the failing test**

Create `test/scheduling/cost-engine.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

function insertGoal(db: DatabaseSync, projectId: string, title: string, allocation?: number): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
    VALUES (?, ?, ?, 'active', 'test', ?, ?)
  `).run(id, projectId, title, now, allocation ?? null);
  return id;
}

function insertTaskWithGoal(db: DatabaseSync, projectId: string, goalId: string, assignedTo: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, goal_id, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
    VALUES (?, ?, 'Test', 'DONE', 'P2', ?, ?, 'test', ?, ?, 0, 3)
  `).run(id, projectId, goalId, assignedTo, now, now);
  return id;
}

function insertCostRecord(db: DatabaseSync, projectId: string, taskId: string, agentId: string, costCents: number, model: string = "claude-sonnet-4-6"): void {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, source, model, created_at)
    VALUES (?, ?, ?, ?, 1000, 500, 0, 0, ?, 'dispatch', ?, ?)
  `).run(id, projectId, agentId, taskId, costCents, model, Date.now());
}

describe("getCostEstimate", () => {
  let db: DatabaseSync;
  const PROJECT = "cost-engine-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns initiative + agent + model average when enough data (high confidence)", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "UI Work", 40);
    // Create 5 sessions for agent-a on sonnet under this initiative
    for (let i = 0; i < 5; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 100 + i * 10, "claude-sonnet-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-a", "claude-sonnet-4-6", db);
    expect(estimate.averageCents).toBeGreaterThan(0);
    expect(estimate.sessionCount).toBe(5);
    expect(estimate.confidence).toBe("medium"); // 5 sessions = medium (need ≥10 for high)
  });

  it("falls back to initiative + model when agent data is sparse", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "UI Work", 40);
    // 5 sessions from agent-a, 0 from agent-b
    for (let i = 0; i < 5; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 200, "claude-opus-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-b", "claude-opus-4-6", db);
    expect(estimate.averageCents).toBe(200); // falls back to initiative + model
    expect(estimate.confidence).toBe("medium");
  });

  it("falls back to global default when no data exists", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "Brand New Initiative", 20);

    const estimate = getCostEstimate(PROJECT, goalId, "agent-x", "claude-sonnet-4-6", db);
    expect(estimate.averageCents).toBe(150); // hardcoded default
    expect(estimate.sessionCount).toBe(0);
    expect(estimate.confidence).toBe("low");
  });

  it("returns high confidence with 10+ sessions at finest granularity", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "Well-known Work", 50);
    for (let i = 0; i < 12; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 150, "claude-sonnet-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-a", "claude-sonnet-4-6", db);
    expect(estimate.confidence).toBe("high");
    expect(estimate.sessionCount).toBe(12);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduling/cost-engine.test.ts`
Expected: FAIL — module `../../src/scheduling/cost-engine.js` not found

**Step 3: Implement cost engine**

Create `src/scheduling/cost-engine.ts`:

```typescript
/**
 * Clawforce — Cost Averages Engine
 *
 * Computes session cost estimates with fallback chain:
 * initiative + agent + model → initiative + model → initiative only → global → hardcoded default.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

const DEFAULT_COST_CENTS = 150;
const MIN_SESSIONS_FOR_ESTIMATE = 3;
const MIN_SESSIONS_FOR_HIGH_CONFIDENCE = 10;

export type CostEstimate = {
  averageCents: number;
  sessionCount: number;
  confidence: "high" | "medium" | "low";
};

/**
 * Collect all goal IDs in a goal tree (BFS from root down through children).
 */
function collectGoalTreeIds(projectId: string, rootGoalId: string, db: DatabaseSync): string[] {
  const ids: string[] = [];
  const queue: string[] = [rootGoalId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ids.push(id);

    const children = db.prepare(
      "SELECT id FROM goals WHERE parent_goal_id = ? AND project_id = ?",
    ).all(id, projectId) as { id: string }[];

    for (const child of children) {
      queue.push(child.id);
    }
  }

  return ids;
}

type AvgRow = { avg_cost: number; session_count: number };

function queryAverage(
  db: DatabaseSync,
  projectId: string,
  goalIds: string[],
  agentId?: string,
  model?: string,
): AvgRow | null {
  if (goalIds.length === 0) return null;

  const placeholders = goalIds.map(() => "?").join(", ");
  let query = `
    SELECT AVG(cr.cost_cents) as avg_cost, COUNT(*) as session_count
    FROM cost_records cr
    INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
    WHERE t.goal_id IN (${placeholders})
      AND cr.project_id = ?
  `;
  const params: (string | number)[] = [...goalIds, projectId];

  if (agentId) {
    query += " AND cr.agent_id = ?";
    params.push(agentId);
  }
  if (model) {
    query += " AND cr.model = ?";
    params.push(model);
  }

  const row = db.prepare(query).get(...params) as AvgRow | undefined;
  if (!row || row.session_count === 0) return null;
  return row;
}

function queryGlobalAverage(db: DatabaseSync, projectId: string): AvgRow | null {
  const row = db.prepare(`
    SELECT AVG(cost_cents) as avg_cost, COUNT(*) as session_count
    FROM cost_records
    WHERE project_id = ?
  `).get(projectId) as AvgRow | undefined;

  if (!row || row.session_count === 0) return null;
  return row;
}

export function getCostEstimate(
  projectId: string,
  initiativeGoalId: string,
  agentId: string,
  model: string,
  dbOverride?: DatabaseSync,
): CostEstimate {
  const db = dbOverride ?? getDb(projectId);
  const goalIds = collectGoalTreeIds(projectId, initiativeGoalId, db);

  // Level 1: initiative + agent + model
  const level1 = queryAverage(db, projectId, goalIds, agentId, model);
  if (level1 && level1.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level1.avg_cost),
      sessionCount: level1.session_count,
      confidence: level1.session_count >= MIN_SESSIONS_FOR_HIGH_CONFIDENCE ? "high" : "medium",
    };
  }

  // Level 2: initiative + model
  const level2 = queryAverage(db, projectId, goalIds, undefined, model);
  if (level2 && level2.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level2.avg_cost),
      sessionCount: level2.session_count,
      confidence: level2.session_count >= MIN_SESSIONS_FOR_HIGH_CONFIDENCE ? "high" : "medium",
    };
  }

  // Level 3: initiative only
  const level3 = queryAverage(db, projectId, goalIds);
  if (level3 && level3.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(level3.avg_cost),
      sessionCount: level3.session_count,
      confidence: "medium",
    };
  }

  // Level 4: global average
  const global = queryGlobalAverage(db, projectId);
  if (global && global.session_count >= MIN_SESSIONS_FOR_ESTIMATE) {
    return {
      averageCents: Math.round(global.avg_cost),
      sessionCount: global.session_count,
      confidence: "low",
    };
  }

  // Level 5: hardcoded default
  return {
    averageCents: DEFAULT_COST_CENTS,
    sessionCount: 0,
    confidence: "low",
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduling/cost-engine.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/scheduling/cost-engine.ts test/scheduling/cost-engine.test.ts
git commit -m "feat: add cost averages engine with fallback chain"
```

---

### Task 3: Dispatch Plans — Migration and Types

Create the `dispatch_plans` table and add TypeScript types.

**Files:**
- Modify: `src/migrations.ts:12,38-40` (add dispatch_plans table to V25)
- Modify: `src/types.ts` (add DispatchPlan, PlannedItem, ActualResult types)

**Step 1: Extend V25 migration to create dispatch_plans table**

In `src/migrations.ts`, update the `migrateV25` function (created in Task 1) to also create the dispatch_plans table:

```typescript
function migrateV25(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE goals ADD COLUMN priority TEXT");

  db.prepare(`
    CREATE TABLE IF NOT EXISTS dispatch_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      planned_items TEXT NOT NULL DEFAULT '[]',
      actual_results TEXT,
      estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
      actual_cost_cents INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_plans_project_agent
    ON dispatch_plans (project_id, agent_id, created_at DESC)
  `).run();
}
```

**Step 2: Add types to src/types.ts**

Add after the Goal type definition:

```typescript
export type PlannedItem = {
  initiativeId?: string;
  agentId: string;
  model?: string;
  taskTitle: string;
  estimatedCostCents: number;
  confidence: "high" | "medium" | "low";
  priority?: TaskPriority;
};

export type ActualResult = {
  plannedIndex: number;
  taskId?: string;
  actualCostCents?: number;
  status: "dispatched" | "skipped" | "failed";
  skipReason?: string;
};

export type DispatchPlanStatus = "planned" | "executing" | "completed" | "abandoned";

export type DispatchPlan = {
  id: string;
  projectId: string;
  agentId: string;
  status: DispatchPlanStatus;
  plannedItems: PlannedItem[];
  actualResults?: ActualResult[];
  estimatedCostCents: number;
  actualCostCents?: number;
  createdAt: number;
  completedAt?: number;
};
```

**Step 3: Write migration test**

Add to existing migration test or create inline: verify that `dispatch_plans` table exists after V25 migration and that both `priority` column on goals and the new table are created.

Run: `npx vitest run test/db-migration.test.ts`
Expected: existing tests pass + verify new table exists

**Step 4: Commit**

```bash
git add src/migrations.ts src/types.ts
git commit -m "feat: add dispatch_plans table and types for autonomous scheduling"
```

---

### Task 4: Dispatch Plan CRUD

New module for creating, executing, completing, and listing dispatch plans.

**Files:**
- Create: `src/scheduling/plans.ts`
- Create: `test/scheduling/plans.test.ts`

**Step 1: Write the failing test**

Create `test/scheduling/plans.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("dispatch plan CRUD", () => {
  let db: DatabaseSync;
  const PROJECT = "plan-test";
  const AGENT = "eng-lead";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a plan with planned items and estimated cost", async () => {
    const { createPlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 210, confidence: "high" as const },
        { agentId: "backend", taskTitle: "API endpoint", estimatedCostCents: 150, confidence: "medium" as const },
      ],
    }, db);

    expect(plan.status).toBe("planned");
    expect(plan.estimatedCostCents).toBe(360);
    expect(plan.plannedItems).toHaveLength(2);

    const fetched = getPlan(PROJECT, plan.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.plannedItems).toHaveLength(2);
  });

  it("transitions plan from planned → executing → completed", async () => {
    const { createPlan, startPlan, completePlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 200, confidence: "high" as const },
      ],
    }, db);

    startPlan(PROJECT, plan.id, db);
    const executing = getPlan(PROJECT, plan.id, db);
    expect(executing!.status).toBe("executing");

    completePlan(PROJECT, plan.id, {
      actualResults: [
        { plannedIndex: 0, taskId: "task-123", actualCostCents: 180, status: "dispatched" as const },
      ],
    }, db);
    const completed = getPlan(PROJECT, plan.id, db);
    expect(completed!.status).toBe("completed");
    expect(completed!.actualCostCents).toBe(180);
    expect(completed!.completedAt).toBeGreaterThan(0);
  });

  it("abandons a plan", async () => {
    const { createPlan, abandonPlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Cancelled work", estimatedCostCents: 100, confidence: "low" as const },
      ],
    }, db);

    abandonPlan(PROJECT, plan.id, db);
    const abandoned = getPlan(PROJECT, plan.id, db);
    expect(abandoned!.status).toBe("abandoned");
  });

  it("lists plans for an agent, most recent first", async () => {
    const { createPlan, listPlans } = await import("../../src/scheduling/plans.js");

    createPlan({ projectId: PROJECT, agentId: AGENT, plannedItems: [{ agentId: "a", taskTitle: "T1", estimatedCostCents: 100, confidence: "low" as const }] }, db);
    createPlan({ projectId: PROJECT, agentId: AGENT, plannedItems: [{ agentId: "a", taskTitle: "T2", estimatedCostCents: 200, confidence: "low" as const }] }, db);
    createPlan({ projectId: PROJECT, agentId: "other-agent", plannedItems: [{ agentId: "a", taskTitle: "T3", estimatedCostCents: 300, confidence: "low" as const }] }, db);

    const plans = listPlans(PROJECT, AGENT, db);
    expect(plans).toHaveLength(2);
    expect(plans[0].plannedItems[0].taskTitle).toBe("T2"); // most recent first
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduling/plans.test.ts`
Expected: FAIL — module not found

**Step 3: Implement dispatch plan CRUD**

Create `src/scheduling/plans.ts`:

```typescript
/**
 * Clawforce — Dispatch Plan CRUD
 *
 * Coordination agents create a plan per wake cycle, track execution,
 * and review actual vs. planned on completion.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ActualResult, DispatchPlan, DispatchPlanStatus, PlannedItem } from "../types.js";

function rowToPlan(row: Record<string, unknown>): DispatchPlan {
  const plan: DispatchPlan = {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    status: row.status as DispatchPlanStatus,
    plannedItems: JSON.parse(row.planned_items as string),
    estimatedCostCents: row.estimated_cost_cents as number,
    createdAt: row.created_at as number,
  };
  if (row.actual_results != null) {
    try { plan.actualResults = JSON.parse(row.actual_results as string); } catch { /* ignore */ }
  }
  if (row.actual_cost_cents != null) plan.actualCostCents = row.actual_cost_cents as number;
  if (row.completed_at != null) plan.completedAt = row.completed_at as number;
  return plan;
}

export type CreatePlanParams = {
  projectId: string;
  agentId: string;
  plannedItems: PlannedItem[];
};

export function createPlan(params: CreatePlanParams, dbOverride?: DatabaseSync): DispatchPlan {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const now = Date.now();
  const estimatedCostCents = params.plannedItems.reduce((sum, item) => sum + item.estimatedCostCents, 0);

  db.prepare(`
    INSERT INTO dispatch_plans (id, project_id, agent_id, status, planned_items, estimated_cost_cents, created_at)
    VALUES (?, ?, ?, 'planned', ?, ?, ?)
  `).run(id, params.projectId, params.agentId, JSON.stringify(params.plannedItems), estimatedCostCents, now);

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    status: "planned",
    plannedItems: params.plannedItems,
    estimatedCostCents,
    createdAt: now,
  };
}

export function getPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): DispatchPlan | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM dispatch_plans WHERE id = ? AND project_id = ?")
    .get(planId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : null;
}

export function startPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE dispatch_plans SET status = 'executing' WHERE id = ? AND project_id = ? AND status = 'planned'")
    .run(planId, projectId);
}

export type CompletePlanParams = {
  actualResults: ActualResult[];
};

export function completePlan(projectId: string, planId: string, params: CompletePlanParams, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const actualCostCents = params.actualResults.reduce((sum, r) => sum + (r.actualCostCents ?? 0), 0);

  db.prepare(`
    UPDATE dispatch_plans
    SET status = 'completed', actual_results = ?, actual_cost_cents = ?, completed_at = ?
    WHERE id = ? AND project_id = ?
  `).run(JSON.stringify(params.actualResults), actualCostCents, now, planId, projectId);
}

export function abandonPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  db.prepare("UPDATE dispatch_plans SET status = 'abandoned', completed_at = ? WHERE id = ? AND project_id = ?")
    .run(now, planId, projectId);
}

export function listPlans(projectId: string, agentId: string, dbOverride?: DatabaseSync, limit: number = 10): DispatchPlan[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM dispatch_plans WHERE project_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(projectId, agentId, limit) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduling/plans.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/scheduling/plans.ts test/scheduling/plans.test.ts
git commit -m "feat: add dispatch plan CRUD for coordination cycles"
```

---

### Task 5: Ops-Tool Plan Actions

Wire dispatch plan CRUD into the ops-tool so coordination agents can create and manage plans.

**Files:**
- Modify: `src/tools/ops-tool.ts:50-57,59-108` (OPS_ACTIONS, schema, handlers)
- Create: `test/tools/ops-plan-actions.test.ts`

**Step 1: Write the failing test**

Create `test/tools/ops-plan-actions.test.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createPlan, getPlan } = await import("../../src/scheduling/plans.js");

describe("ops-tool plan actions", () => {
  let db: DatabaseSync;
  const PROJECT = "ops-plan-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a plan via createPlan and retrieves it", () => {
    const plan = createPlan({
      projectId: PROJECT,
      agentId: "eng-lead",
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 200, confidence: "high" as const },
      ],
    }, db);

    const fetched = getPlan(PROJECT, plan.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("planned");
    expect(fetched!.estimatedCostCents).toBe(200);
  });
});
```

**Step 2: Run test to verify it passes (confirms plan module works)**

Run: `npx vitest run test/tools/ops-plan-actions.test.ts`
Expected: PASS

**Step 3: Add plan actions to ops-tool**

In `src/tools/ops-tool.ts`:

1. Add to OPS_ACTIONS array: `"plan_create", "plan_start", "plan_complete", "plan_abandon", "plan_list"`

2. Add schema params (after `daily_limit_cents`):
```typescript
  planned_items: Type.Optional(Type.String({ description: "JSON array of planned dispatch items." })),
  plan_id: Type.Optional(Type.String({ description: "Dispatch plan ID." })),
  actual_results: Type.Optional(Type.String({ description: "JSON array of actual results for plan completion." })),
```

3. Add case handlers (before the closing default case):

```typescript
case "plan_create": {
  const plannedItemsStr = readStringParam(params, "planned_items");
  if (!plannedItemsStr) return jsonResult({ ok: false, error: "planned_items required (JSON array)" });
  let plannedItems;
  try { plannedItems = JSON.parse(plannedItemsStr); } catch { return jsonResult({ ok: false, error: "planned_items must be valid JSON" }); }
  const { createPlan } = await import("../scheduling/plans.js");
  const plan = createPlan({ projectId, agentId: caller, plannedItems }, getDb(projectId));
  writeAuditEntry(getDb(projectId), projectId, caller, "plan_create", { planId: plan.id, itemCount: plannedItems.length, estimatedCostCents: plan.estimatedCostCents });
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
  writeAuditEntry(getDb(projectId), projectId, caller, "plan_complete", { planId });
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
```

**Step 4: Run full test suite to verify no breakage**

Run: `npx vitest run test/tools/ops-plan-actions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/ops-tool.ts test/tools/ops-plan-actions.test.ts
git commit -m "feat: add dispatch plan actions to ops-tool"
```

---

### Task 6: Adaptive Wake Bounds

Enforce wake frequency bounds when coordination agents update their own cron schedule via `job_update`.

**Files:**
- Modify: `src/tools/ops-tool.ts:757-818` (job_update handler)
- Modify: `src/types.ts` (add SchedulingConfig to AgentConfig)
- Modify: `src/project.ts` (parse scheduling config)
- Create: `test/scheduling/wake-bounds.test.ts`

**Step 1: Write the failing test**

Create `test/scheduling/wake-bounds.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("wake bounds enforcement", () => {
  it("clamps cron expression to fastest bound", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    // */5 is faster than */15 bound → should clamp to */15
    const result = clampCronToWakeBounds("*/5 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/15 * * * *");
  });

  it("clamps cron expression to slowest bound", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    // */180 is slower than */120 bound → should clamp to */120
    const result = clampCronToWakeBounds("*/180 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/120 * * * *");
  });

  it("returns original when within bounds", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/30 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/30 * * * *");
  });

  it("returns original when bounds not provided", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/5 * * * *", undefined);
    expect(result).toBe("*/5 * * * *");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduling/wake-bounds.test.ts`
Expected: FAIL — module not found

**Step 3: Implement wake bounds**

Create `src/scheduling/wake-bounds.ts`:

```typescript
/**
 * Clawforce — Wake Bounds Enforcement
 *
 * Ensures coordination agents can only set their cron frequency
 * within configured bounds [fastest, slowest].
 */

/**
 * Extract minute interval from a simple "star/N * * * *" cron expression.
 * Returns null for complex expressions that can't be compared as intervals.
 */
function extractMinuteInterval(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, ...rest] = parts;
  // Only handle */N patterns where rest is all wildcards
  if (!rest.every((p) => p === "*")) return null;
  const match = minute.match(/^\*\/(\d+)$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Clamp a cron expression to wake bounds [fastest, slowest].
 * Only enforces for simple */N minute-interval patterns.
 * Complex expressions pass through unclamped.
 */
export function clampCronToWakeBounds(
  cron: string,
  wakeBounds?: [string, string],
): string {
  if (!wakeBounds) return cron;

  const interval = extractMinuteInterval(cron);
  if (interval === null) return cron; // complex expression, can't clamp

  const [fastest, slowest] = wakeBounds;
  const fastestInterval = extractMinuteInterval(fastest);
  const slowestInterval = extractMinuteInterval(slowest);

  if (fastestInterval === null || slowestInterval === null) return cron;

  // Lower interval = more frequent (faster)
  if (interval < fastestInterval) return fastest;
  if (interval > slowestInterval) return slowest;

  return cron;
}
```

**Step 4: Add SchedulingConfig to types**

In `src/types.ts`, add (near AgentConfig or WorkforceConfig):

```typescript
export type SchedulingConfig = {
  adaptiveWake?: boolean;
  planning?: boolean;
  wakeBounds?: [string, string];
};
```

Add `scheduling?: SchedulingConfig` to `AgentConfig`.

**Step 5: Parse scheduling config in project.ts**

In `src/project.ts`, within agent config parsing, add:

```typescript
if (raw.scheduling) {
  agent.scheduling = {
    adaptiveWake: typeof raw.scheduling.adaptive_wake === "boolean" ? raw.scheduling.adaptive_wake : undefined,
    planning: typeof raw.scheduling.planning === "boolean" ? raw.scheduling.planning : undefined,
    wakeBounds: Array.isArray(raw.scheduling.wake_bounds) ? raw.scheduling.wake_bounds : undefined,
  };
}
```

**Step 6: Wire bounds enforcement into ops-tool job_update**

In `src/tools/ops-tool.ts`, in the `update_job` case handler, after merging the job config but before calling `upsertJob`, add:

```typescript
// Enforce wake bounds if agent has scheduling config
if (mergedJob.cron) {
  const agentEntry = getAgentConfig(targetAgentId);
  const wakeBounds = agentEntry?.config.scheduling?.wakeBounds;
  if (wakeBounds) {
    const { clampCronToWakeBounds } = await import("../scheduling/wake-bounds.js");
    mergedJob.cron = clampCronToWakeBounds(mergedJob.cron, wakeBounds);
  }
}
```

**Step 7: Run test to verify it passes**

Run: `npx vitest run test/scheduling/wake-bounds.test.ts`
Expected: PASS (4 tests)

**Step 8: Commit**

```bash
git add src/scheduling/wake-bounds.ts src/types.ts src/project.ts src/tools/ops-tool.ts test/scheduling/wake-bounds.test.ts
git commit -m "feat: add adaptive wake bounds enforcement for coordination agents"
```

---

### Task 7: Rate-Aware Slot Calculator

System function that computes available dispatch slots per model based on rate limits and active sessions.

**Files:**
- Create: `src/scheduling/slots.ts`
- Create: `test/scheduling/slots.test.ts`

**Step 1: Write the failing test**

Create `test/scheduling/slots.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("getAvailableSlots", () => {
  it("computes available slots based on rate limits and active sessions", async () => {
    const { computeAvailableSlots } = await import("../../src/scheduling/slots.js");

    const slots = computeAvailableSlots({
      models: {
        "claude-opus-4-6": { rpm: 60, tpm: 200000, costPer1kInput: 15, costPer1kOutput: 75 },
        "claude-sonnet-4-6": { rpm: 120, tpm: 400000, costPer1kInput: 3, costPer1kOutput: 15 },
      },
      activeSessions: {
        "claude-opus-4-6": 4,
        "claude-sonnet-4-6": 2,
      },
      avgTokensPerSession: {
        "claude-opus-4-6": 15000,
        "claude-sonnet-4-6": 8000,
      },
    });

    expect(slots).toHaveLength(2);
    const opus = slots.find((s) => s.model === "claude-opus-4-6")!;
    const sonnet = slots.find((s) => s.model === "claude-sonnet-4-6")!;

    expect(opus.currentActive).toBe(4);
    expect(opus.availableSlots).toBeGreaterThanOrEqual(0);

    expect(sonnet.currentActive).toBe(2);
    expect(sonnet.availableSlots).toBeGreaterThan(opus.availableSlots); // Sonnet has more headroom
  });

  it("returns 0 slots when rate limit is fully utilized", async () => {
    const { computeAvailableSlots } = await import("../../src/scheduling/slots.js");

    const slots = computeAvailableSlots({
      models: {
        "claude-opus-4-6": { rpm: 10, tpm: 50000, costPer1kInput: 15, costPer1kOutput: 75 },
      },
      activeSessions: {
        "claude-opus-4-6": 10,
      },
      avgTokensPerSession: {
        "claude-opus-4-6": 15000,
      },
    });

    const opus = slots.find((s) => s.model === "claude-opus-4-6")!;
    expect(opus.availableSlots).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduling/slots.test.ts`
Expected: FAIL — module not found

**Step 3: Implement slot calculator**

Create `src/scheduling/slots.ts`:

```typescript
/**
 * Clawforce — Rate-Aware Slot Calculator
 *
 * Computes how many concurrent sessions can be started per model
 * given rate limits, active sessions, and average token usage.
 */

export type ModelConfig = {
  rpm: number;
  tpm: number;
  costPer1kInput: number;
  costPer1kOutput: number;
};

export type SlotCalcInput = {
  models: Record<string, ModelConfig>;
  activeSessions: Record<string, number>;
  avgTokensPerSession: Record<string, number>;
};

export type SlotAvailability = {
  model: string;
  availableSlots: number;
  currentActive: number;
  rpmLimit: number;
  rpmUsed: number;
  tpmLimit: number;
  tpmEstimatedUsage: number;
  avgTokensPerSession: number;
};

const DEFAULT_AVG_TOKENS = 10000;
const DEFAULT_RPM_PER_SESSION = 5; // conservative estimate of RPM consumed per active session

export function computeAvailableSlots(input: SlotCalcInput): SlotAvailability[] {
  const results: SlotAvailability[] = [];

  for (const [model, config] of Object.entries(input.models)) {
    const active = input.activeSessions[model] ?? 0;
    const avgTokens = input.avgTokensPerSession[model] ?? DEFAULT_AVG_TOKENS;

    // RPM-based capacity: how many more sessions can we add?
    const rpmUsed = active * DEFAULT_RPM_PER_SESSION;
    const rpmRemaining = Math.max(0, config.rpm - rpmUsed);
    const rpmSlots = Math.floor(rpmRemaining / DEFAULT_RPM_PER_SESSION);

    // TPM-based capacity: total tokens from active sessions vs limit
    const tpmEstimatedUsage = active * avgTokens;
    const tpmRemaining = Math.max(0, config.tpm - tpmEstimatedUsage);
    const tpmSlots = avgTokens > 0 ? Math.floor(tpmRemaining / avgTokens) : 0;

    // Available slots = minimum of RPM and TPM constraints
    const availableSlots = Math.max(0, Math.min(rpmSlots, tpmSlots));

    results.push({
      model,
      availableSlots,
      currentActive: active,
      rpmLimit: config.rpm,
      rpmUsed,
      tpmLimit: config.tpm,
      tpmEstimatedUsage,
      avgTokensPerSession: avgTokens,
    });
  }

  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduling/slots.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/scheduling/slots.ts test/scheduling/slots.test.ts
git commit -m "feat: add rate-aware slot calculator for dispatch planning"
```

---

### Task 8: Cost Forecast Briefing Source

New `cost_forecast` context source showing per-initiative spend, burn rate, and projected exhaustion time.

**Files:**
- Modify: `src/types.ts:200-212` (add "cost_forecast" to ContextSource)
- Modify: `src/context/assembler.ts:102-204,947+` (add case + resolver)
- Modify: `src/project.ts:327-335` (add to VALID_SOURCES)
- Create: `test/context/cost-forecast.test.ts`

**Step 1: Write the failing test**

Create `test/context/cost-forecast.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

function insertGoalWithAllocation(db: DatabaseSync, projectId: string, title: string, allocation: number): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
    VALUES (?, ?, ?, 'active', 'test', ?, ?)
  `).run(id, projectId, title, Date.now(), allocation);
  return id;
}

function insertBudget(db: DatabaseSync, projectId: string, dailyLimitCents: number): void {
  db.prepare(`
    INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(randomUUID(), projectId, dailyLimitCents, Date.now());
}

describe("cost_forecast context source", () => {
  let db: DatabaseSync;
  const PROJECT = "forecast-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("renders forecast table with allocation, spent, remaining, and burn rate", async () => {
    const { resolveCostForecastSource } = await import("../../src/context/assembler.js");

    insertBudget(db, PROJECT, 2000);
    insertGoalWithAllocation(db, PROJECT, "UI Improvements", 40);
    insertGoalWithAllocation(db, PROJECT, "Outreach", 30);

    const result = resolveCostForecastSource(PROJECT, db);
    expect(result).toContain("Cost Forecast");
    expect(result).toContain("UI Improvements");
    expect(result).toContain("Outreach");
    expect(result).toContain("40%");
    expect(result).toContain("30%");
  });

  it("returns message when no initiatives exist", async () => {
    const { resolveCostForecastSource } = await import("../../src/context/assembler.js");

    const result = resolveCostForecastSource(PROJECT, db);
    expect(result).toContain("No initiatives");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/cost-forecast.test.ts`
Expected: FAIL — `resolveCostForecastSource` not exported

**Step 3: Implement cost forecast source**

1. In `src/types.ts`, add `"cost_forecast"` to the ContextSource source union.

2. In `src/project.ts`, add `"cost_forecast"` to VALID_SOURCES array.

3. In `src/context/assembler.ts`:

Add case in resolveSource switch (after "initiative_status"):
```typescript
case "cost_forecast": return resolveCostForecastSource(projectId, dbOverride);
```

Add the resolver function:

```typescript
export function resolveCostForecastSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  const initiatives = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND allocation IS NOT NULL AND status = 'active' ORDER BY allocation DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (initiatives.length === 0) return "No initiatives configured.";

  const budgetRow = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;
  const dailyBudget = budgetRow?.daily_limit_cents ?? 0;

  // Get today's start and hours elapsed
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hoursElapsed = Math.max(0.5, (now.getTime() - todayStart) / (1000 * 60 * 60)); // minimum 0.5h to avoid division by zero

  const lines: string[] = ["## Cost Forecast", ""];
  lines.push(`Daily budget: ${dailyBudget}c | Hours elapsed: ${hoursElapsed.toFixed(1)}h`, "");
  lines.push("| Initiative | Allocation | Budget | Spent | Remaining | Burn Rate | Exhausts At |");
  lines.push("|------------|-----------|--------|-------|-----------|-----------|-------------|");

  let totalAllocation = 0;
  let totalSpent = 0;

  for (const row of initiatives) {
    const title = row.title as string;
    const id = row.id as string;
    const allocationPct = row.allocation as number;
    const allocationCents = Math.floor((allocationPct / 100) * dailyBudget);
    const spent = getInitiativeSpend(projectId, id, db);
    const remaining = allocationCents - spent;
    totalAllocation += allocationPct;
    totalSpent += spent;

    const burnRate = spent > 0 ? spent / hoursElapsed : 0;
    let exhaustsAt = "—";
    if (burnRate > 0 && remaining > 0) {
      const hoursUntilExhausted = remaining / burnRate;
      const exhaustTime = new Date(now.getTime() + hoursUntilExhausted * 60 * 60 * 1000);
      // Only show if before midnight
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      if (exhaustTime.getTime() < midnight) {
        exhaustsAt = `~${exhaustTime.getHours()}:${String(exhaustTime.getMinutes()).padStart(2, "0")}`;
      }
    }

    const status = remaining <= 0 ? " ⛔" : remaining < allocationCents * 0.25 ? " ⚠️" : "";
    lines.push(`| ${title} | ${allocationPct}% | ${allocationCents}c | ${spent}c | ${remaining}c${status} | ${burnRate.toFixed(1)}c/hr | ${exhaustsAt} |`);
  }

  const reservePct = 100 - totalAllocation;
  const reserveCents = dailyBudget - Math.floor((totalAllocation / 100) * dailyBudget);
  lines.push("");
  lines.push(`Reserve: ${reservePct}% (${reserveCents}c) | Total spent: ${totalSpent}c of ${dailyBudget}c`);

  return lines.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/context/cost-forecast.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/types.ts src/project.ts src/context/assembler.ts test/context/cost-forecast.test.ts
git commit -m "feat: add cost_forecast briefing source with burn rate and exhaustion time"
```

---

### Task 9: Available Capacity Briefing Source

New `available_capacity` context source showing per-model slot availability.

**Files:**
- Modify: `src/types.ts:200-212` (add "available_capacity" to ContextSource)
- Modify: `src/context/assembler.ts` (add case + resolver)
- Modify: `src/project.ts:327-335` (add to VALID_SOURCES)
- Create: `test/context/available-capacity.test.ts`

**Step 1: Write the failing test**

Create `test/context/available-capacity.test.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("available_capacity context source", () => {
  let db: DatabaseSync;
  const PROJECT = "capacity-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("renders slot availability from resource config", async () => {
    const { resolveAvailableCapacitySource } = await import("../../src/context/assembler.js");

    // The resolver needs resource config — test with a project that has resources configured
    // For now, test the fallback message when no resources are configured
    const result = resolveAvailableCapacitySource(PROJECT, db);
    expect(result).toContain("capacity");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/available-capacity.test.ts`
Expected: FAIL — function not exported

**Step 3: Implement available capacity source**

1. Add `"available_capacity"` to ContextSource union in `src/types.ts`.
2. Add `"available_capacity"` to VALID_SOURCES in `src/project.ts`.
3. In `src/context/assembler.ts`:

Add case:
```typescript
case "available_capacity": return resolveAvailableCapacitySource(projectId, dbOverride);
```

Add resolver:

```typescript
export function resolveAvailableCapacitySource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  // Try to load resource config from workforce config
  let resourceConfig: Record<string, unknown> | undefined;
  try {
    const configRow = db.prepare(
      "SELECT config FROM projects WHERE id = ?",
    ).get(projectId) as { config: string } | undefined;
    if (configRow) {
      const parsed = JSON.parse(configRow.config);
      resourceConfig = parsed.resources?.models;
    }
  } catch { /* ignore */ }

  if (!resourceConfig || Object.keys(resourceConfig).length === 0) {
    return "## Available Capacity\n\nNo resource/model configuration found. Configure `resources.models` in project.yaml to enable capacity planning.";
  }

  // Count active sessions per model from dispatch queue
  const activeRows = db.prepare(`
    SELECT payload, COUNT(*) as count
    FROM dispatch_queue
    WHERE project_id = ? AND status = 'leased'
    GROUP BY payload
  `).all(projectId) as Record<string, unknown>[];

  const activeSessions: Record<string, number> = {};
  for (const row of activeRows) {
    try {
      const payload = JSON.parse(row.payload as string);
      const model = payload.model ?? "unknown";
      activeSessions[model] = (activeSessions[model] ?? 0) + (row.count as number);
    } catch { /* ignore */ }
  }

  // Get average tokens per session from cost_records
  const tokenRows = db.prepare(`
    SELECT model, AVG(input_tokens + output_tokens) as avg_tokens
    FROM cost_records
    WHERE project_id = ?
    GROUP BY model
  `).all(projectId) as Record<string, unknown>[];

  const avgTokens: Record<string, number> = {};
  for (const row of tokenRows) {
    if (row.model) avgTokens[row.model as string] = Math.round(row.avg_tokens as number);
  }

  // Build slot calc input
  const { computeAvailableSlots } = await import("../scheduling/slots.js") as typeof import("../scheduling/slots.js");
  // Note: this function is sync but the import is async; we'll handle this inline

  const models: Record<string, { rpm: number; tpm: number; costPer1kInput: number; costPer1kOutput: number }> = {};
  for (const [name, config] of Object.entries(resourceConfig)) {
    const c = config as Record<string, number>;
    models[name] = {
      rpm: c.rpm ?? 60,
      tpm: c.tpm ?? 200000,
      costPer1kInput: c.cost_per_1k_input ?? 0,
      costPer1kOutput: c.cost_per_1k_output ?? 0,
    };
  }

  const slots = computeAvailableSlots({ models, activeSessions, avgTokensPerSession: avgTokens });

  const lines: string[] = ["## Available Capacity", ""];
  lines.push("| Model | Available Slots | Active | RPM (used/limit) | Avg Tokens/Session |");
  lines.push("|-------|----------------|--------|-------------------|-------------------|");

  for (const slot of slots) {
    lines.push(`| ${slot.model} | ${slot.availableSlots} | ${slot.currentActive} | ${slot.rpmUsed}/${slot.rpmLimit} | ${slot.avgTokensPerSession.toLocaleString()} |`);
  }

  return lines.join("\n");
}
```

Note: The resolver uses a dynamic `import()` for `slots.ts`. Since the assembler's `resolveSource` may need to be `async` or this can be handled by pre-importing. Check the existing pattern — if `resolveSource` is sync, import `computeAvailableSlots` at the top of the file instead.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/context/available-capacity.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/project.ts src/context/assembler.ts test/context/available-capacity.test.ts
git commit -m "feat: add available_capacity briefing source for rate-aware slot planning"
```

---

### Task 10: Manager Defaults, Skill Topics, and Exports

Wire everything together: update manager preset defaults, skill documentation, and public exports.

**Files:**
- Modify: `src/profiles.ts` (or presets file — add scheduling defaults to manager preset)
- Modify: `src/skills/topics/goals.ts` (add priority + scheduling docs)
- Modify: `src/index.ts` (export new modules)

**Step 1: Update manager preset**

Find the manager preset/profile definition (could be in `src/profiles.ts` or a presets file). Add default scheduling config:

```typescript
scheduling: {
  adaptiveWake: true,
  planning: true,
  wakeBounds: ["*/15 * * * *", "*/120 * * * *"],
},
```

Add `cost_forecast` and `available_capacity` to the manager's default briefing sources.

**Step 2: Update skill topics**

In `src/skills/topics/goals.ts`, add a section after the initiatives section:

```typescript
const priorityDocs = `
## Goal Priority

Goals support priority levels (P0-P3) matching task priorities:
- **P0** — Critical, must be addressed immediately
- **P1** — High priority
- **P2** — Normal priority (default)
- **P3** — Low priority

Tasks linked to a goal inherit its priority when they don't have one set explicitly.

Set priority when creating a goal:
\`\`\`
clawforce_goal create title="Fix production bug" priority="P0" goal_id="parent-123"
\`\`\`
`;

const schedulingDocs = `
## Dispatch Plans

Coordination agents create dispatch plans to structure their wake cycles:

1. **Create plan**: \`clawforce_ops plan_create planned_items='[{"agentId":"frontend","taskTitle":"Fix nav","estimatedCostCents":200,"confidence":"high"}]'\`
2. **Start execution**: \`clawforce_ops plan_start plan_id="..."\`
3. **Complete with results**: \`clawforce_ops plan_complete plan_id="..." actual_results='[{"plannedIndex":0,"taskId":"task-123","actualCostCents":180,"status":"dispatched"}]'\`
4. **List recent plans**: \`clawforce_ops plan_list\`

Plans track estimated vs. actual cost for forecasting accuracy.

## Adaptive Wake

Coordination agents can adjust their own wake frequency:
\`\`\`
clawforce_ops update_job job_name="coordination" job_config='{"cron":"*/30 * * * *"}'
\`\`\`

Frequency is clamped to configured bounds (default: 15min to 120min).

## Briefing Sources

- **cost_forecast** — Per-initiative spend, burn rate, projected exhaustion time
- **available_capacity** — Per-model slot availability based on rate limits
`;
```

Add these to the topic's content string.

**Step 3: Update exports in src/index.ts**

Add a new section:

```typescript
// --- Scheduling ---
export { getCostEstimate } from "./scheduling/cost-engine.js";
export type { CostEstimate } from "./scheduling/cost-engine.js";
export { createPlan, getPlan, startPlan, completePlan, abandonPlan, listPlans } from "./scheduling/plans.js";
export type { CreatePlanParams, CompletePlanParams } from "./scheduling/plans.js";
export { computeAvailableSlots } from "./scheduling/slots.js";
export type { SlotAvailability, SlotCalcInput, ModelConfig } from "./scheduling/slots.js";
export { clampCronToWakeBounds } from "./scheduling/wake-bounds.js";
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (existing 1872+ tests + new tests from this plan)

**Step 5: Commit**

```bash
git add src/profiles.ts src/skills/topics/goals.ts src/index.ts
git commit -m "feat: wire autonomous scheduling into manager defaults, skill docs, and exports"
```

**Step 6: Run full test suite one more time to confirm everything is green**

Run: `npx vitest run`
Expected: ALL PASS
