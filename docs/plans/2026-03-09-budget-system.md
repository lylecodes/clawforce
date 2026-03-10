# Budget System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a comprehensive budget and resource tracking system that auto-captures token usage from OpenClaw hooks, tracks multi-window budgets (hourly/daily/monthly), monitors provider rate limits, and injects capacity planning context into manager briefings.

**Architecture:** Replace the hardcoded cost tracking with a hook-driven auto-capture pipeline. Every LLM call flows through `llm_output` hook → `recordCost()` with dynamic pricing from OpenClaw's model registry. A new rate limit tracker queries `ProviderUsageSnapshot` data. A capacity planner combines budget remaining + rate limit headroom into a manager-facing `resources` context source. Budget enforcement expands from daily-only to multi-window with circuit breakers.

**Tech Stack:** TypeScript, Node 22 `node:sqlite`, OpenClaw plugin SDK hooks (`llm_output`, `session_end`), OpenClaw `ModelDefinitionConfig` for pricing, `ProviderUsageSnapshot` for rate limits.

---

### Task 1: Dynamic Pricing Loader

Replace hardcoded `MODEL_PRICING` dict with a system that loads pricing from OpenClaw's model registry at runtime, with fallback to hardcoded defaults.

**Files:**
- Create: `src/pricing.ts`
- Modify: `src/cost.ts` (remove `MODEL_PRICING`, use new loader)
- Test: `test/pricing.test.ts`

**Step 1: Write the failing test**

```typescript
// test/pricing.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getPricing,
  registerModelPricing,
  clearPricingCache,
} from "../src/pricing.js";

describe("pricing", () => {
  beforeEach(() => clearPricingCache());

  it("returns default pricing for unknown model", () => {
    const p = getPricing("unknown-model");
    expect(p.inputPerM).toBeGreaterThan(0);
    expect(p.outputPerM).toBeGreaterThan(0);
  });

  it("returns registered pricing for known model", () => {
    registerModelPricing("test-model", {
      inputPerM: 100,
      outputPerM: 500,
      cacheReadPerM: 10,
      cacheWritePerM: 50,
    });
    const p = getPricing("test-model");
    expect(p.inputPerM).toBe(100);
    expect(p.outputPerM).toBe(500);
  });

  it("loads pricing from OpenClaw ModelDefinitionConfig format", () => {
    // OpenClaw uses cost per 1M tokens as raw numbers
    registerModelPricingFromConfig("oc-model", {
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    });
    const p = getPricing("oc-model");
    // Converted to cents per M tokens
    expect(p.inputPerM).toBe(1500);
    expect(p.outputPerM).toBe(7500);
  });

  it("registerBulk registers multiple models at once", () => {
    registerBulkPricing([
      { id: "model-a", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      { id: "model-b", cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
    ]);
    expect(getPricing("model-a").inputPerM).toBe(300);
    expect(getPricing("model-b").inputPerM).toBe(80);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/pricing.test.ts`
Expected: FAIL — module `../src/pricing.js` does not exist

**Step 3: Write minimal implementation**

```typescript
// src/pricing.ts
/**
 * Clawforce — Dynamic pricing
 *
 * Loads model pricing from OpenClaw's ModelDefinitionConfig at runtime.
 * Falls back to hardcoded defaults for offline/unknown models.
 */

export type ModelPricing = {
  inputPerM: number;    // cents per 1M input tokens
  outputPerM: number;   // cents per 1M output tokens
  cacheReadPerM: number;
  cacheWritePerM: number;
};

/** Hardcoded fallback pricing (Sonnet-level as safe middle ground). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 300,
  outputPerM: 1500,
  cacheReadPerM: 30,
  cacheWritePerM: 375,
};

/** Hardcoded baseline for known Claude models. */
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":   { inputPerM: 1500, outputPerM: 7500, cacheReadPerM: 150,  cacheWritePerM: 1875 },
  "claude-sonnet-4-6": { inputPerM: 300,  outputPerM: 1500, cacheReadPerM: 30,   cacheWritePerM: 375  },
  "claude-haiku-4-5":  { inputPerM: 80,   outputPerM: 400,  cacheReadPerM: 8,    cacheWritePerM: 100  },
};

const dynamicPricing = new Map<string, ModelPricing>();

export function getPricing(model: string): ModelPricing {
  return dynamicPricing.get(model)
    ?? BUILTIN_PRICING[model]
    ?? DEFAULT_PRICING;
}

export function registerModelPricing(model: string, pricing: ModelPricing): void {
  dynamicPricing.set(model, pricing);
}

/**
 * Register pricing from OpenClaw's ModelDefinitionConfig.cost format.
 * OpenClaw costs are in dollars per 1M tokens. We store cents per 1M tokens.
 */
export function registerModelPricingFromConfig(
  model: string,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  dynamicPricing.set(model, {
    inputPerM: Math.round(cost.input * 100),
    outputPerM: Math.round(cost.output * 100),
    cacheReadPerM: Math.round(cost.cacheRead * 100),
    cacheWritePerM: Math.round(cost.cacheWrite * 100),
  });
}

/**
 * Bulk register from OpenClaw model registry.
 */
export function registerBulkPricing(
  models: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }>,
): void {
  for (const m of models) {
    registerModelPricingFromConfig(m.id, m.cost);
  }
}

export function clearPricingCache(): void {
  dynamicPricing.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/pricing.test.ts`
Expected: PASS

**Step 5: Update `src/cost.ts` to use dynamic pricing**

In `src/cost.ts`, replace the `MODEL_PRICING` dict and `DEFAULT_PRICING` with imports from `src/pricing.ts`:

- Remove: the `MODEL_PRICING` const and `DEFAULT_PRICING` const (lines 19-30)
- Change `calculateCostCents()` to call `getPricing(params.model ?? "")` instead of indexing `MODEL_PRICING`

```typescript
// In calculateCostCents:
import { getPricing } from "./pricing.js";

export function calculateCostCents(params: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}): number {
  const pricing = getPricing(params.model ?? "");
  // ... rest stays the same
}
```

**Step 6: Run existing cost tests to verify no regression**

Run: `npx vitest run test/ --reporter=verbose 2>&1 | grep -E "cost|budget|PASS|FAIL"`
Expected: All existing tests still PASS

**Step 7: Commit**

```bash
git add src/pricing.ts test/pricing.test.ts src/cost.ts
git commit -m "feat: dynamic pricing loader — replace hardcoded MODEL_PRICING with runtime registry"
```

---

### Task 2: Add Provider Field to Cost Records

Add `provider` column to `cost_records` so we can track Anthropic vs. OpenAI spending separately.

**Files:**
- Modify: `src/migrations.ts` (add migration V22)
- Modify: `src/cost.ts` (add `provider` param to `recordCost`)
- Modify: `src/types.ts` (add `provider` to `CostRecord`)
- Test: `test/cost-provider.test.ts`

**Step 1: Write the failing test**

```typescript
// test/cost-provider.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { recordCost, getCostSummary } from "../src/cost.js";
import { getDb, closeDb } from "../src/db.js";

describe("cost — provider tracking", () => {
  const projectId = "test-provider-cost";

  beforeEach(() => {
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
  });

  it("records provider on cost entry", () => {
    const record = recordCost({
      projectId,
      agentId: "agent-1",
      inputTokens: 1000,
      outputTokens: 500,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    expect(record.provider).toBe("anthropic");
  });

  it("getCostSummary can filter by provider", () => {
    recordCost({ projectId, agentId: "a", inputTokens: 1000, outputTokens: 500, provider: "anthropic" });
    recordCost({ projectId, agentId: "a", inputTokens: 1000, outputTokens: 500, provider: "openai" });

    const anthropicCost = getCostSummary({ projectId, provider: "anthropic" });
    const openaiCost = getCostSummary({ projectId, provider: "openai" });
    const totalCost = getCostSummary({ projectId });

    expect(anthropicCost.recordCount).toBe(1);
    expect(openaiCost.recordCount).toBe(1);
    expect(totalCost.recordCount).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/cost-provider.test.ts`
Expected: FAIL — `provider` not recognized

**Step 3: Add migration V22**

In `src/migrations.ts`, increment `SCHEMA_VERSION` to 22, add `migrateV22`:

```typescript
function migrateV22(db: DatabaseSync): void {
  db.exec(`ALTER TABLE cost_records ADD COLUMN provider TEXT`);
}
```

Add to migrations record: `22: migrateV22`.

**Step 4: Update types**

In `src/types.ts`, add `provider?: string` to `CostRecord`:

```typescript
export type CostRecord = {
  // ... existing fields
  provider?: string;
};
```

**Step 5: Update `recordCost` and `getCostSummary`**

In `src/cost.ts`:
- Add `provider?: string` to `recordCost` params
- Include `provider` in INSERT statement
- Include `provider` in returned CostRecord
- Add `provider?: string` to `getCostSummary` params
- Add WHERE clause for provider filter when specified

**Step 6: Run tests**

Run: `npx vitest run test/cost-provider.test.ts`
Expected: PASS

**Step 7: Run full test suite for regressions**

Run: `npx vitest run`
Expected: All PASS

**Step 8: Commit**

```bash
git add src/migrations.ts src/cost.ts src/types.ts test/cost-provider.test.ts
git commit -m "feat: add provider field to cost records for per-provider spend tracking"
```

---

### Task 3: Auto-Capture Costs via `llm_output` Hook

Wire the adapter to automatically record costs on every LLM call. This is the critical integration — no more manual `recordCost()` calls.

**Files:**
- Modify: `adapters/openclaw.ts` (register `llm_output` hook)
- Modify: `adapters/openclaw.ts` (load model pricing from OpenClaw config at init)
- Test: `test/adapters/cost-capture.test.ts`

**Step 1: Write the failing test**

```typescript
// test/adapters/cost-capture.test.ts
import { describe, it, expect } from "vitest";
import { recordCostFromLlmOutput } from "../src/cost.js";
import { registerModelPricingFromConfig, clearPricingCache } from "../src/pricing.js";
import { getDb } from "../src/db.js";

describe("cost auto-capture", () => {
  const projectId = "test-auto-capture";

  it("recordCostFromLlmOutput creates a cost record from hook event data", () => {
    clearPricingCache();
    registerModelPricingFromConfig("claude-sonnet-4-6", {
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    });

    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);

    const record = recordCostFromLlmOutput({
      projectId,
      agentId: "test-agent",
      sessionKey: "sess-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 5000, output: 1000, cacheRead: 2000, cacheWrite: 0 },
    });

    expect(record.inputTokens).toBe(5000);
    expect(record.outputTokens).toBe(1000);
    expect(record.cacheReadTokens).toBe(2000);
    expect(record.provider).toBe("anthropic");
    expect(record.source).toBe("llm_output");
    expect(record.costCents).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/cost-capture.test.ts`
Expected: FAIL — `recordCostFromLlmOutput` does not exist

**Step 3: Add `recordCostFromLlmOutput` to `src/cost.ts`**

```typescript
/**
 * Record cost from an OpenClaw llm_output hook event.
 * Convenience wrapper that maps hook event fields to recordCost params.
 */
export function recordCostFromLlmOutput(params: {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): CostRecord {
  return recordCost({
    projectId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    provider: params.provider,
    model: params.model,
    inputTokens: params.usage.input ?? 0,
    outputTokens: params.usage.output ?? 0,
    cacheReadTokens: params.usage.cacheRead ?? 0,
    cacheWriteTokens: params.usage.cacheWrite ?? 0,
    source: "llm_output",
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/cost-capture.test.ts`
Expected: PASS

**Step 5: Register `llm_output` hook in adapter**

In `adapters/openclaw.ts`, after the existing hook registrations, add:

```typescript
// --- Auto-capture costs via llm_output ---
api.on("llm_output", async (event, ctx) => {
  if (!ctx.agentId || !ctx.sessionKey) return;

  const entry = getAgentConfig(ctx.agentId);
  if (!entry) return;

  // Resolve task ID from tracked session dispatch context
  const session = getSession(ctx.sessionKey);
  const taskId = session?.dispatchContext?.taskId;

  try {
    recordCostFromLlmOutput({
      projectId: entry.projectId,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      taskId,
      provider: event.provider,
      model: event.model,
      usage: event.usage ?? {},
    });
  } catch (err) {
    api.logger.warn(`Clawforce: cost capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
```

**Step 6: Load model pricing from OpenClaw config at init**

In the adapter's init function, after clawforce initialization, load model pricing from the OpenClaw config:

```typescript
// Load model pricing from OpenClaw's model registry
try {
  const config = api.config;
  const providers = config.models?.providers;
  if (providers) {
    const pricingEntries: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = [];
    for (const provider of Object.values(providers) as Array<{ models?: Array<{ id?: string; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }> }>) {
      for (const model of provider.models ?? []) {
        if (model.id && model.cost) {
          pricingEntries.push({
            id: model.id,
            cost: {
              input: model.cost.input ?? 0,
              output: model.cost.output ?? 0,
              cacheRead: model.cost.cacheRead ?? 0,
              cacheWrite: model.cost.cacheWrite ?? 0,
            },
          });
        }
      }
    }
    if (pricingEntries.length > 0) {
      registerBulkPricing(pricingEntries);
      api.logger.info(`Clawforce: loaded pricing for ${pricingEntries.length} models from OpenClaw config`);
    }
  }
} catch (err) {
  api.logger.warn(`Clawforce: failed to load model pricing from config: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Step 7: Commit**

```bash
git add src/cost.ts adapters/openclaw.ts test/adapters/cost-capture.test.ts
git commit -m "feat: auto-capture costs via llm_output hook with dynamic pricing"
```

---

### Task 4: Multi-Window Budget Tracking

Expand budget enforcement from daily-only to hourly + daily + monthly windows. Add budget alerts at configurable thresholds.

**Files:**
- Create: `src/budget-windows.ts`
- Modify: `src/types.ts` (expand `BudgetConfig`)
- Modify: `src/migrations.ts` (V23: add `hourly_limit_cents`, `monthly_limit_cents` to budgets)
- Test: `test/budget-windows.test.ts`

**Step 1: Write the failing test**

```typescript
// test/budget-windows.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { checkMultiWindowBudget, getBudgetStatus } from "../src/budget-windows.js";
import { recordCost } from "../src/cost.js";
import { getDb } from "../src/db.js";

describe("multi-window budget", () => {
  const projectId = "test-multi-budget";

  beforeEach(() => {
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("getBudgetStatus returns remaining for each window", () => {
    const db = getDb(projectId);
    // Insert budget with all three windows
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 500, 50000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Record some cost
    recordCost({ projectId, agentId: "a1", inputTokens: 10000, outputTokens: 5000, model: "claude-sonnet-4-6" });

    const status = getBudgetStatus(projectId);
    expect(status.daily).toBeDefined();
    expect(status.daily!.limitCents).toBe(2000);
    expect(status.daily!.spentCents).toBeGreaterThan(0);
    expect(status.daily!.remainingCents).toBeLessThan(2000);
    expect(status.daily!.usedPercent).toBeGreaterThan(0);
    expect(status.hourly).toBeDefined();
    expect(status.monthly).toBeDefined();
  });

  it("checkMultiWindowBudget blocks when any window exceeded", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', ?, NULL, 100000, 1, 100000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Exceed hourly (1 cent limit)
    recordCost({ projectId, agentId: "a1", inputTokens: 100000, outputTokens: 50000, model: "claude-opus-4-6" });

    const result = checkMultiWindowBudget({ projectId });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Hourly");
  });

  it("returns alert thresholds when approaching limit", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b3', ?, NULL, 100, NULL, NULL, 75, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    const status = getBudgetStatus(projectId);
    expect(status.daily!.usedPercent).toBe(75);
    expect(status.alerts).toContain("Daily budget 75% consumed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget-windows.test.ts`
Expected: FAIL — module does not exist

**Step 3: Add migration V23**

In `src/migrations.ts`:

```typescript
function migrateV23(db: DatabaseSync): void {
  db.exec(`ALTER TABLE budgets ADD COLUMN hourly_limit_cents INTEGER`);
  db.exec(`ALTER TABLE budgets ADD COLUMN monthly_limit_cents INTEGER`);
}
```

Increment `SCHEMA_VERSION` to 23, add `23: migrateV23`.

**Step 4: Write implementation**

```typescript
// src/budget-windows.ts
/**
 * Clawforce — Multi-window budget tracking
 *
 * Extends budget enforcement to hourly, daily, and monthly windows.
 * Provides budget status with remaining capacity and alert thresholds.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import type { BudgetCheckResult } from "./types.js";

export type WindowStatus = {
  window: "hourly" | "daily" | "monthly";
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  usedPercent: number;
};

export type BudgetStatus = {
  hourly?: WindowStatus;
  daily?: WindowStatus;
  monthly?: WindowStatus;
  alerts: string[];
};

const ALERT_THRESHOLD = 75; // percent

function getWindowStart(window: "hourly" | "daily" | "monthly", now: number): number {
  const d = new Date(now);
  if (window === "hourly") {
    d.setMinutes(0, 0, 0);
  } else if (window === "daily") {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function getSpentInWindow(
  projectId: string,
  agentId: string | undefined,
  windowStart: number,
  db: DatabaseSync,
): number {
  let sql = "SELECT COALESCE(SUM(cost_cents), 0) as spent FROM cost_records WHERE project_id = ? AND created_at >= ?";
  const params: (string | number)[] = [projectId, windowStart];
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  const row = db.prepare(sql).get(...params) as Record<string, unknown>;
  return row.spent as number;
}

export function getBudgetStatus(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): BudgetStatus {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const alerts: string[] = [];

  const budget = db.prepare(
    agentId
      ? "SELECT * FROM budgets WHERE project_id = ? AND agent_id = ?"
      : "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(...(agentId ? [projectId, agentId] : [projectId])) as Record<string, unknown> | undefined;

  if (!budget) return { alerts };

  const result: BudgetStatus = { alerts };

  const windows: Array<{ key: "hourly" | "daily" | "monthly"; limitCol: string }> = [
    { key: "hourly", limitCol: "hourly_limit_cents" },
    { key: "daily", limitCol: "daily_limit_cents" },
    { key: "monthly", limitCol: "monthly_limit_cents" },
  ];

  for (const w of windows) {
    const limit = budget[w.limitCol] as number | null;
    if (limit == null) continue;

    const windowStart = getWindowStart(w.key, now);
    const spent = w.key === "daily"
      ? (budget.daily_spent_cents as number)  // use tracked counter for daily
      : getSpentInWindow(projectId, agentId, windowStart, db);

    const remaining = Math.max(0, limit - spent);
    const pct = Math.round((spent / limit) * 100);

    result[w.key] = { window: w.key, limitCents: limit, spentCents: spent, remainingCents: remaining, usedPercent: pct };

    if (pct >= ALERT_THRESHOLD) {
      alerts.push(`${w.key.charAt(0).toUpperCase() + w.key.slice(1)} budget ${pct}% consumed`);
    }
  }

  return result;
}

export function checkMultiWindowBudget(
  params: { projectId: string; agentId?: string },
  dbOverride?: DatabaseSync,
): BudgetCheckResult {
  const status = getBudgetStatus(params.projectId, params.agentId, dbOverride);

  for (const w of [status.hourly, status.daily, status.monthly]) {
    if (w && w.remainingCents <= 0) {
      return {
        ok: false,
        remaining: 0,
        reason: `${w.window.charAt(0).toUpperCase() + w.window.slice(1)} budget exceeded: spent ${w.spentCents} cents of ${w.limitCents} cents limit`,
      };
    }
  }

  const minRemaining = [status.hourly, status.daily, status.monthly]
    .filter(Boolean)
    .map(w => w!.remainingCents);

  return {
    ok: true,
    remaining: minRemaining.length > 0 ? Math.min(...minRemaining) : undefined,
  };
}
```

**Step 5: Update `BudgetConfig` type**

In `src/types.ts`:

```typescript
export type BudgetConfig = {
  hourlyLimitCents?: number;
  dailyLimitCents?: number;
  monthlyLimitCents?: number;
  sessionLimitCents?: number;
  taskLimitCents?: number;
};
```

**Step 6: Run tests**

Run: `npx vitest run test/budget-windows.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/budget-windows.ts src/migrations.ts src/types.ts test/budget-windows.test.ts
git commit -m "feat: multi-window budget tracking — hourly, daily, monthly with alert thresholds"
```

---

### Task 5: Rate Limit Tracker

Track provider rate limit status. For now, store rate limit data reported by the adapter (which reads it from OpenClaw's `ProviderUsageSnapshot`). Expose a query API for the capacity planner.

**Files:**
- Create: `src/rate-limits.ts`
- Test: `test/rate-limits.test.ts`

**Step 1: Write the failing test**

```typescript
// test/rate-limits.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  updateProviderUsage,
  getProviderUsage,
  getAllProviderUsage,
  isProviderThrottled,
  clearAllUsage,
} from "../src/rate-limits.js";

describe("rate limit tracker", () => {
  beforeEach(() => clearAllUsage());

  it("stores and retrieves provider usage", () => {
    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 45 },
        { label: "TPM", usedPercent: 72 },
      ],
      plan: "tier-4",
    });

    const usage = getProviderUsage("anthropic");
    expect(usage).toBeDefined();
    expect(usage!.windows).toHaveLength(2);
    expect(usage!.windows[0].usedPercent).toBe(45);
    expect(usage!.plan).toBe("tier-4");
  });

  it("isProviderThrottled returns true when any window above threshold", () => {
    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 92 },
        { label: "TPM", usedPercent: 30 },
      ],
    });

    expect(isProviderThrottled("anthropic", 90)).toBe(true);
    expect(isProviderThrottled("anthropic", 95)).toBe(false);
  });

  it("getAllProviderUsage returns all providers", () => {
    updateProviderUsage("anthropic", { windows: [{ label: "RPM", usedPercent: 50 }] });
    updateProviderUsage("openai", { windows: [{ label: "RPM", usedPercent: 30 }] });

    const all = getAllProviderUsage();
    expect(all).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/rate-limits.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/rate-limits.ts
/**
 * Clawforce — Rate limit tracker
 *
 * In-memory store for provider rate limit status.
 * Updated from OpenClaw's ProviderUsageSnapshot data.
 * Queried by capacity planner and dispatch gate.
 */

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsage = {
  provider: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
  updatedAt: number;
};

const store = new Map<string, ProviderUsage>();

export function updateProviderUsage(
  provider: string,
  data: { windows: UsageWindow[]; plan?: string; error?: string },
): void {
  store.set(provider, {
    provider,
    windows: data.windows,
    plan: data.plan,
    error: data.error,
    updatedAt: Date.now(),
  });
}

export function getProviderUsage(provider: string): ProviderUsage | undefined {
  return store.get(provider);
}

export function getAllProviderUsage(): ProviderUsage[] {
  return [...store.values()];
}

/**
 * Check if any rate limit window for a provider exceeds the threshold.
 */
export function isProviderThrottled(provider: string, thresholdPercent: number = 90): boolean {
  const usage = store.get(provider);
  if (!usage) return false;
  return usage.windows.some(w => w.usedPercent >= thresholdPercent);
}

/** Get the highest used percent across all windows for a provider. */
export function getMaxUsagePercent(provider: string): number {
  const usage = store.get(provider);
  if (!usage || usage.windows.length === 0) return 0;
  return Math.max(...usage.windows.map(w => w.usedPercent));
}

export function clearAllUsage(): void {
  store.clear();
}
```

**Step 4: Run tests**

Run: `npx vitest run test/rate-limits.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/rate-limits.ts test/rate-limits.test.ts
git commit -m "feat: rate limit tracker — in-memory store for provider usage snapshots"
```

---

### Task 6: Capacity Planner

Combines budget remaining + rate limit status + historical cost data into a forward-looking capacity assessment. This is what the manager sees.

**Files:**
- Create: `src/capacity.ts`
- Test: `test/capacity.test.ts`

**Step 1: Write the failing test**

```typescript
// test/capacity.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getCapacityReport } from "../src/capacity.js";
import { updateProviderUsage, clearAllUsage } from "../src/rate-limits.js";
import { getDb } from "../src/db.js";
import { recordCost } from "../src/cost.js";

describe("capacity planner", () => {
  const projectId = "test-capacity";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("returns capacity report with budget and rate limit status", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 800, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 25 },
        { label: "TPM", usedPercent: 40 },
      ],
      plan: "tier-4",
    });

    const report = getCapacityReport(projectId);
    expect(report.budget.daily).toBeDefined();
    expect(report.budget.daily!.remainingCents).toBe(1200);
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0].provider).toBe("anthropic");
    expect(report.throttleRisk).toBe("none");
  });

  it("detects throttle risk when provider approaching limits", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 88 }],
    });

    const report = getCapacityReport(projectId);
    expect(report.throttleRisk).toBe("warning");
  });

  it("estimates remaining sessions from historical cost", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', ?, NULL, 2000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Simulate 5 past sessions averaging 100 cents each
    for (let i = 0; i < 5; i++) {
      recordCost({ projectId, agentId: "worker", inputTokens: 50000, outputTokens: 10000, model: "claude-sonnet-4-6", source: "llm_output" });
    }

    const report = getCapacityReport(projectId);
    expect(report.estimatedRemainingSessions).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/capacity.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/capacity.ts
/**
 * Clawforce — Capacity planner
 *
 * Combines budget status + rate limit data + historical cost
 * into a forward-looking capacity report for manager briefing.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { getBudgetStatus, type BudgetStatus } from "./budget-windows.js";
import { getAllProviderUsage, type ProviderUsage } from "./rate-limits.js";

export type ThrottleRisk = "none" | "warning" | "critical";

export type CapacityReport = {
  budget: BudgetStatus;
  providers: ProviderUsage[];
  throttleRisk: ThrottleRisk;
  estimatedRemainingSessions?: number;
  avgSessionCostCents?: number;
};

/**
 * Build a capacity report for a project.
 */
export function getCapacityReport(
  projectId: string,
  dbOverride?: DatabaseSync,
): CapacityReport {
  const db = dbOverride ?? getDb(projectId);
  const budget = getBudgetStatus(projectId, undefined, db);
  const providers = getAllProviderUsage();

  // Determine throttle risk from provider usage
  let throttleRisk: ThrottleRisk = "none";
  for (const p of providers) {
    for (const w of p.windows) {
      if (w.usedPercent >= 95) {
        throttleRisk = "critical";
        break;
      }
      if (w.usedPercent >= 80) {
        throttleRisk = "warning";
      }
    }
    if (throttleRisk === "critical") break;
  }

  // Estimate remaining sessions from historical average
  const avgCost = getAverageSessionCost(projectId, db);
  let estimatedRemainingSessions: number | undefined;
  if (avgCost > 0 && budget.daily?.remainingCents) {
    estimatedRemainingSessions = Math.floor(budget.daily.remainingCents / avgCost);
  }

  return {
    budget,
    providers,
    throttleRisk,
    estimatedRemainingSessions,
    avgSessionCostCents: avgCost > 0 ? avgCost : undefined,
  };
}

/**
 * Calculate average cost per dispatch session from recent history.
 * Uses last 24 hours of llm_output records, grouped by session.
 */
function getAverageSessionCost(
  projectId: string,
  db: DatabaseSync,
): number {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_key) as sessions, COALESCE(SUM(cost_cents), 0) as total
    FROM cost_records
    WHERE project_id = ? AND created_at >= ? AND session_key IS NOT NULL
  `).get(projectId, since) as Record<string, unknown>;

  const sessions = row.sessions as number;
  const total = row.total as number;
  if (sessions === 0) return 0;
  return Math.round(total / sessions);
}
```

**Step 4: Run tests**

Run: `npx vitest run test/capacity.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/capacity.ts test/capacity.test.ts
git commit -m "feat: capacity planner — combines budget, rate limits, and historical cost"
```

---

### Task 7: Resources Context Source

New context source that renders the capacity report as markdown for manager briefing. This is how managers see budget/rate limit/capacity data.

**Files:**
- Create: `src/context/sources/resources.ts`
- Modify: `src/context/assembler.ts` (add `resources` source type)
- Modify: `src/types.ts` (add `"resources"` to `ContextSource.source` union)
- Modify: `src/profiles.ts` (add `resources` to manager default briefing)
- Test: `test/context/resources.test.ts`

**Step 1: Write the failing test**

```typescript
// test/context/resources.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildResourcesContext } from "../src/context/sources/resources.js";
import { updateProviderUsage, clearAllUsage } from "../src/rate-limits.js";
import { getDb } from "../src/db.js";

describe("resources context source", () => {
  const projectId = "test-resources-ctx";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("renders budget status as markdown", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 800, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    const md = buildResourcesContext(projectId);
    expect(md).toContain("## Resource Capacity");
    expect(md).toContain("$12.00 remaining");
    expect(md).toContain("$20.00");
  });

  it("includes provider rate limit status", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', ?, NULL, 2000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 25 },
        { label: "TPM", usedPercent: 40 },
      ],
      plan: "tier-4",
    });

    const md = buildResourcesContext(projectId);
    expect(md).toContain("anthropic");
    expect(md).toContain("RPM");
    expect(md).toContain("25%");
  });

  it("shows throttle risk warning", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 92 }],
    });

    const md = buildResourcesContext(projectId);
    expect(md).toContain("WARNING");
  });

  it("shows estimated remaining sessions", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b3', ?, NULL, 2000, 500, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Insert historical session data
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO cost_records (id, project_id, agent_id, session_key, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_cents, source, created_at)
        VALUES (?, ?, 'worker', ?, 50000, 10000, 0, 0, 100, 'llm_output', ?)
      `).run(`cr-${i}`, projectId, `sess-${i}`, Date.now() - i * 3600000);
    }

    const md = buildResourcesContext(projectId);
    expect(md).toContain("remaining sessions");
  });

  it("returns null when no budget configured", () => {
    const md = buildResourcesContext(projectId);
    expect(md).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/resources.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/context/sources/resources.ts
/**
 * Clawforce — Resources context source
 *
 * Renders capacity report (budget + rate limits + projections)
 * as markdown for manager briefing.
 */

import type { DatabaseSync } from "node:sqlite";
import { getCapacityReport } from "../../capacity.js";

export function buildResourcesContext(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): string | null {
  const report = getCapacityReport(projectId, dbOverride);

  // Don't render if no budget data
  if (!report.budget.daily && !report.budget.hourly && !report.budget.monthly) {
    return null;
  }

  const lines = ["## Resource Capacity\n"];

  // Budget windows
  for (const w of [report.budget.hourly, report.budget.daily, report.budget.monthly]) {
    if (!w) continue;
    const label = w.window.charAt(0).toUpperCase() + w.window.slice(1);
    lines.push(
      `**${label}:** $${(w.remainingCents / 100).toFixed(2)} remaining of $${(w.limitCents / 100).toFixed(2)} (${w.usedPercent}% used)`,
    );
  }

  // Estimated remaining sessions
  if (report.estimatedRemainingSessions != null) {
    lines.push(
      `**Projected capacity:** ~${report.estimatedRemainingSessions} remaining sessions (avg $${((report.avgSessionCostCents ?? 0) / 100).toFixed(2)}/session)`,
    );
  }

  // Provider rate limits
  if (report.providers.length > 0) {
    lines.push("", "### Provider Rate Limits");
    for (const p of report.providers) {
      const windowStr = p.windows.map(w => `${w.label}: ${w.usedPercent}%`).join(", ");
      const planStr = p.plan ? ` (${p.plan})` : "";
      lines.push(`- **${p.provider}**${planStr}: ${windowStr}`);
    }
  }

  // Throttle risk
  if (report.throttleRisk === "critical") {
    lines.push("", "**THROTTLE RISK: CRITICAL** — Rate limits nearly exhausted. Reduce dispatch concurrency.");
  } else if (report.throttleRisk === "warning") {
    lines.push("", "**THROTTLE RISK: WARNING** — Approaching rate limits. Consider spacing dispatches.");
  }

  // Budget alerts
  if (report.budget.alerts.length > 0) {
    lines.push("", "### Budget Alerts");
    for (const alert of report.budget.alerts) {
      lines.push(`- ${alert}`);
    }
  }

  return lines.join("\n");
}
```

**Step 4: Wire into context assembler**

In `src/context/assembler.ts`:
- Add import: `import { buildResourcesContext } from "./sources/resources.js";`
- Add case in the source switch: `case "resources": return resolveResourcesSource(ctx);`
- Add resolver function:
  ```typescript
  function resolveResourcesSource(ctx: AssemblerContext): string | null {
    if (!ctx.projectId) return null;
    try {
      return buildResourcesContext(ctx.projectId, ctx.agentId);
    } catch {
      return null;
    }
  }
  ```

In `src/types.ts`, add `"resources"` to the `ContextSource.source` union type.

In `src/profiles.ts`, add `{ source: "resources" }` to the manager default briefing (after `cost_summary`).

**Step 5: Run tests**

Run: `npx vitest run test/context/resources.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/context/sources/resources.ts src/context/assembler.ts src/types.ts src/profiles.ts test/context/resources.test.ts
git commit -m "feat: resources context source — budget, rate limits, and capacity in manager briefing"
```

---

### Task 8: Wire Rate Limit Updates into Adapter

The adapter needs to periodically update the rate limit tracker with data from OpenClaw's provider usage system. This connects Task 5 to the OpenClaw runtime.

**Files:**
- Modify: `adapters/openclaw.ts` (query provider usage on `before_prompt_build`, update rate limit store)
- Modify: `src/index.ts` (export new modules)

**Step 1: Update adapter to refresh rate limits**

In `adapters/openclaw.ts`, inside the `before_prompt_build` hook (where context is assembled), add a rate limit refresh before context assembly:

```typescript
// Refresh provider rate limits (non-blocking, best-effort)
try {
  // Access OpenClaw's usage summary if available via runtime
  const usageSummary = api.runtime?.system?.getProviderUsageSummary?.();
  if (usageSummary?.providers) {
    for (const snapshot of usageSummary.providers) {
      updateProviderUsage(snapshot.provider, {
        windows: snapshot.windows,
        plan: snapshot.plan,
        error: snapshot.error,
      });
    }
  }
} catch {
  // Non-fatal — rate limit data is advisory
}
```

Add imports at top of adapter:
```typescript
import { updateProviderUsage } from "../src/rate-limits.js";
import { recordCostFromLlmOutput } from "../src/cost.js";
import { registerBulkPricing } from "../src/pricing.js";
```

**Step 2: Update dispatch gate to check rate limits**

In the dispatch flow (wherever `checkBudget` is called before dispatching), also check rate limits:

```typescript
import { isProviderThrottled } from "../src/rate-limits.js";
import { checkMultiWindowBudget } from "../src/budget-windows.js";

// Before dispatch:
// 1. Check multi-window budget (replaces old checkBudget for project-level)
const budgetResult = checkMultiWindowBudget({ projectId, agentId });
if (!budgetResult.ok) {
  // Block dispatch — budget exceeded
}

// 2. Check rate limits for the agent's provider
const agentModel = agentConfig.model ?? "claude-sonnet-4-6";
const provider = agentConfig.provider ?? "anthropic";
if (isProviderThrottled(provider, 95)) {
  // Block dispatch — rate limited
}
```

**Step 3: Export new modules from index**

In `src/index.ts`, add exports:

```typescript
// --- Pricing ---
export { getPricing, registerModelPricing, registerModelPricingFromConfig, registerBulkPricing } from "./pricing.js";
export type { ModelPricing } from "./pricing.js";

// --- Rate Limits ---
export { updateProviderUsage, getProviderUsage, getAllProviderUsage, isProviderThrottled, getMaxUsagePercent } from "./rate-limits.js";
export type { ProviderUsage, UsageWindow } from "./rate-limits.js";

// --- Multi-Window Budget ---
export { getBudgetStatus, checkMultiWindowBudget } from "./budget-windows.js";
export type { BudgetStatus, WindowStatus } from "./budget-windows.js";

// --- Capacity ---
export { getCapacityReport } from "./capacity.js";
export type { CapacityReport, ThrottleRisk } from "./capacity.js";

// --- Resources Context ---
export { buildResourcesContext } from "./context/sources/resources.js";
```

**Step 4: Commit**

```bash
git add adapters/openclaw.ts src/index.ts
git commit -m "feat: wire rate limit updates and cost auto-capture into OpenClaw adapter"
```

---

### Task 9: Budget Shorthand Config

Support the simple `budget: $20/day` shorthand in project config, parsed into the full budget structure.

**Files:**
- Create: `src/budget-parser.ts`
- Test: `test/budget-parser.test.ts`

**Step 1: Write the failing test**

```typescript
// test/budget-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseBudgetShorthand } from "../src/budget-parser.js";

describe("budget parser", () => {
  it("parses $20/day", () => {
    const result = parseBudgetShorthand("$20/day");
    expect(result).toEqual({ dailyLimitCents: 2000 });
  });

  it("parses $5/hour", () => {
    const result = parseBudgetShorthand("$5/hour");
    expect(result).toEqual({ hourlyLimitCents: 500 });
  });

  it("parses $500/month", () => {
    const result = parseBudgetShorthand("$500/month");
    expect(result).toEqual({ monthlyLimitCents: 50000 });
  });

  it("parses $20/day with cents", () => {
    const result = parseBudgetShorthand("$20.50/day");
    expect(result).toEqual({ dailyLimitCents: 2050 });
  });

  it("returns null for invalid format", () => {
    expect(parseBudgetShorthand("twenty bucks")).toBeNull();
    expect(parseBudgetShorthand("")).toBeNull();
  });

  it("parses numeric-only as daily cents", () => {
    const result = parseBudgetShorthand("2000");
    expect(result).toEqual({ dailyLimitCents: 2000 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget-parser.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/budget-parser.ts
/**
 * Clawforce — Budget shorthand parser
 *
 * Parses "$20/day", "$5/hour", "$500/month" into BudgetConfig.
 */

import type { BudgetConfig } from "./types.js";

const SHORTHAND_RE = /^\$?([\d.]+)\s*\/\s*(hour|day|month)$/i;

export function parseBudgetShorthand(input: string): Partial<BudgetConfig> | null {
  if (!input || input.trim().length === 0) return null;

  const trimmed = input.trim();

  // Numeric-only: treat as daily limit in cents
  if (/^\d+$/.test(trimmed)) {
    return { dailyLimitCents: parseInt(trimmed, 10) };
  }

  const match = trimmed.match(SHORTHAND_RE);
  if (!match) return null;

  const dollars = parseFloat(match[1]);
  const cents = Math.round(dollars * 100);
  const window = match[2].toLowerCase();

  switch (window) {
    case "hour":
      return { hourlyLimitCents: cents };
    case "day":
      return { dailyLimitCents: cents };
    case "month":
      return { monthlyLimitCents: cents };
    default:
      return null;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run test/budget-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/budget-parser.ts test/budget-parser.test.ts
git commit -m "feat: budget shorthand parser — supports $20/day, $5/hour, $500/month"
```

---

### Task 10: Integration — Dispatch Gate with Multi-Window Budget + Rate Limits

Update the dispatcher to use the new multi-window budget check and rate limit check as pre-dispatch gates.

**Files:**
- Modify: `src/dispatch/dispatcher.ts` (add rate limit + multi-window budget checks)
- Test: `test/dispatch/budget-gate.test.ts`

**Step 1: Write the failing test**

```typescript
// test/dispatch/budget-gate.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { shouldDispatch } from "../src/dispatch/dispatcher.js";
import { updateProviderUsage, clearAllUsage } from "../src/rate-limits.js";
import { getDb } from "../src/db.js";

describe("dispatch gate — budget + rate limits", () => {
  const projectId = "test-dispatch-gate";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("blocks dispatch when provider rate limited", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 98 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("rate limit");
  });

  it("allows dispatch when within budget and rate limits", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 30 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Implement `shouldDispatch` gate function**

In `src/dispatch/dispatcher.ts`, add or refactor the pre-dispatch check to combine:
1. Existing `checkBudget()` (keep for session/task limits)
2. New `checkMultiWindowBudget()` (for hourly/daily/monthly)
3. New `isProviderThrottled()` (for rate limits)

```typescript
import { checkMultiWindowBudget } from "../budget-windows.js";
import { isProviderThrottled } from "../rate-limits.js";

export function shouldDispatch(
  projectId: string,
  agentId: string,
  provider: string = "anthropic",
): { ok: true } | { ok: false; reason: string } {
  // Check multi-window budget
  const budgetResult = checkMultiWindowBudget({ projectId, agentId });
  if (!budgetResult.ok) {
    return { ok: false, reason: budgetResult.reason! };
  }

  // Check rate limits
  if (isProviderThrottled(provider, 95)) {
    return { ok: false, reason: `Provider ${provider} rate limit exceeded (>95% used)` };
  }

  return { ok: true };
}
```

**Step 3: Run tests**

Run: `npx vitest run test/dispatch/budget-gate.test.ts`
Expected: PASS

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/dispatch/dispatcher.ts test/dispatch/budget-gate.test.ts
git commit -m "feat: dispatch gate combines multi-window budget + rate limit checks"
```

---

## Summary

| Task | What it does | Depends on |
|------|-------------|------------|
| 1 | Dynamic pricing loader (replace hardcoded prices) | — |
| 2 | Add provider field to cost records | — |
| 3 | Auto-capture costs via `llm_output` hook | 1, 2 |
| 4 | Multi-window budget tracking (hourly/daily/monthly) | — |
| 5 | Rate limit tracker (in-memory provider usage store) | — |
| 6 | Capacity planner (budget + rate limits → projections) | 4, 5 |
| 7 | Resources context source (manager briefing) | 6 |
| 8 | Wire rate limits + cost capture into adapter | 3, 5, 7 |
| 9 | Budget shorthand parser (`$20/day`) | 4 |
| 10 | Dispatch gate with multi-window budget + rate limits | 4, 5 |

Tasks 1, 2, 4, 5 can run in parallel (no dependencies). Tasks 3, 6, 9 depend on earlier tasks. Tasks 7, 8, 10 tie everything together.
