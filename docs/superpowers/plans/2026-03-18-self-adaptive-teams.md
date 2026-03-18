# Self-Adaptive Teams Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClawForce a self-adaptive framework where users drop off an idea (DIRECTION.md), a lean agent team builds and ships it, and the team evolves autonomously — hiring specialists, creating skills, and reallocating resources as needed.

**Architecture:** Extends existing SDK with DIRECTION.md loading, per-job tool scoping, an observe pattern for domain specialists, trust-tiered adaptation cards, and an agent-builder employee. The startup template dogfoods ClawForce on itself.

**Tech Stack:** TypeScript, Node 22, SQLite (node:sqlite), vitest, YAML config

**Spec:** `docs/superpowers/specs/2026-03-18-self-adaptive-teams-design.md`

---

## CRITICAL: API Corrections

The code samples in the tasks below reference codebase APIs. The following corrections MUST be applied when implementing — the inline code is wrong in these specific cases:

### Task 6 (`hireAgent`) — `applyProfile()` signature

**Wrong (in plan):** `applyProfile(preset, fullAgentConfig)`
**Correct:** `applyProfile(preset, { briefing, exclude_briefing, expectations, performance_policy })` — it only accepts these 4 fields and returns `{ briefing, expectations, performance_policy }`. Build the full `AgentConfig` manually and call `applyProfile` only for the profile merge, then spread the result:

```typescript
const profileResult = applyProfile(preset, {
  briefing: spec.briefing ?? [],
  exclude_briefing: [],
  expectations: null,
  performance_policy: null,
});

const config: AgentConfig = {
  extends: preset,
  title: spec.title,
  reports_to: spec.reports_to,
  observe: spec.observe,
  tools: spec.tools,
  briefing: profileResult.briefing,
  expectations: profileResult.expectations,
  performance_policy: profileResult.performance_policy,
  jobs: spec.jobs,
};
```

### Task 6 (`hireAgent`) — `registerAgentInProject()` does not exist

The agent config registry is private in `src/project.ts`. Add this export at line ~1085:

```typescript
export function registerAgentInProject(projectId: string, agentId: string, config: AgentConfig, projectDir?: string): void {
  agentConfigRegistry.set(agentId, { projectId, config, projectDir });
}
```

Note: `AgentConfigEntry` requires `projectDir` (optional) — include it in the function signature.

### Task 7 (`budget_reallocate`) — `setBudget()` signature

**Wrong (in plan):** `setBudget(PROJECT, agentId, { daily: { cents: N } }, db)`
**Correct:** `setBudget({ projectId: PROJECT, agentId: "dev-1", config: { daily: { cents: 1000 } } }, db)` — uses a params object.

### Task 7 — `getBudgetLimits()` does not exist

There is no `getBudgetLimits` function. Query the budgets table directly:

```typescript
const row = db.prepare(
  "SELECT daily_limit_cents, hourly_limit_cents, monthly_limit_cents FROM budgets WHERE project_id = ? AND agent_id = ?"
).get(projectId, agentId) as { daily_limit_cents: number | null; hourly_limit_cents: number | null; monthly_limit_cents: number | null } | undefined;
```

### Task 10 (`initializeAutonomy`) — trust overrides are project-scoped, not per-agent

`applyTrustOverride()` takes `{ projectId, category }` — no `agentId` field. Trust overrides apply at the project level. Remove the `agentIds` parameter from `initializeAutonomy` — it's unused. Update the test accordingly.

### Task 12 — `resolveSourceRaw()` is synchronous

**Wrong (in plan):** `await import("./observed-events.js")` inside the case
**Correct:** Use a static import at the top of `assembler.ts`:

```typescript
import { renderObservedEvents } from "./observed-events.js";
```

And the case body:

```typescript
case "observed_events": {
  if (!ctx.projectId) return null;
  const observe = ctx.config.observe ?? [];
  return renderObservedEvents(ctx.projectId, observe, source.since ?? 0);
}
```

Variables: use `ctx.config` (not `agentConfig`) and `ctx.projectId` (not `domain`). These are the `AssemblerContext` fields.

### Task 12 — Add `"observed_events"` to `VALID_SOURCES` in `src/project.ts:348-359`

Without this, YAML configs with `source: observed_events` will be silently replaced with `source: custom`. Add `"observed_events"` to the `VALID_SOURCES` array.

### Task 13 — `recordCost` is in `src/cost.ts`, not `src/budget.ts`

**Wrong import:** `from "../../src/budget.js"`
**Correct import:** `from "../../src/cost.js"`

The `recordCost` signature is:
```typescript
recordCost(params: {
  projectId: string;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  provider?: string;
  source?: string;
}, dbOverride?: DatabaseSync)
```

Add `jobName?: string` to this params type and a `job_name` column to the `cost_records` INSERT. Migration SQL:
```sql
ALTER TABLE cost_records ADD COLUMN job_name TEXT DEFAULT NULL;
```

### Task 14 — `normalizeAgentConfig` is private in `src/project.ts`

It's not exported. The `observe` field needs to be added inside the private function at `src/project.ts:362+`. Test through the public API (call `registerWorkforceConfig` with YAML containing `observe`) rather than importing the private function directly.

### Task 9 — Update `buildConfigFromAnswers` return type

The return type must be explicitly updated to:
```typescript
{ global: Partial<GlobalConfig>; domain: InitDomainOpts; direction?: Direction }
```

And add `import type { Direction } from "../direction.js"` at the top.

### Task 16 (e2e) — Fix `async` on test callback

The `it()` callback that uses `await import()` must be marked `async`.

### Task 17 — Don't use `git add -A`

Use `git add -u` or specific file paths instead.

### Deferred tools

The following tools referenced in the startup template do not have implementation tasks in this plan. They are forward-looking config entries: `org_modify`, `skill_create`, `health_check`, `budget_analyze`, `budget_forecast`. Implementing agents should treat these as tool names that will be resolved in a follow-up plan — the template config is valid, the tools just won't be available yet.

---

## Chunk 1: Foundation — Types, Direction Loading, Job Tool Scoping

### Task 1: Add `tools` field to `JobDefinition` type

**Files:**
- Modify: `src/types.ts:322-357` (JobDefinition type)

- [ ] **Step 1: Write the failing test**

Create `test/jobs/tool-scope.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { resolveEffectiveConfig } = await import("../../src/jobs.js");
import type { AgentConfig } from "../../src/types.js";

const baseConfig: AgentConfig = {
  extends: "manager",
  tools: ["task_assign", "task_create", "budget_check", "message_send", "org_modify"],
  briefing: [{ source: "instructions" }],
  expectations: [],
  performance_policy: { action: "alert" },
  jobs: {
    dispatch: {
      cron: "*/5 * * * *",
      tools: ["task_assign", "task_create"],
    },
    reflect: {
      cron: "0 9 * * MON",
      // no tools field — inherits all agent tools
    },
  },
};

describe("job tool scoping", () => {
  it("narrows agent tools to job-specified subset", () => {
    const effective = resolveEffectiveConfig(baseConfig, "dispatch");
    expect(effective).not.toBeNull();
    expect(effective!.tools).toEqual(["task_assign", "task_create"]);
  });

  it("inherits all agent tools when job has no tools field", () => {
    const effective = resolveEffectiveConfig(baseConfig, "reflect");
    expect(effective).not.toBeNull();
    expect(effective!.tools).toEqual(baseConfig.tools);
  });

  it("returns null for unknown job name", () => {
    const effective = resolveEffectiveConfig(baseConfig, "nonexistent");
    expect(effective).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobs/tool-scope.test.ts`
Expected: FAIL — `tools` doesn't exist on `JobDefinition` (TypeScript error) and the intersection logic isn't implemented.

- [ ] **Step 3: Add `tools` field to `JobDefinition`**

In `src/types.ts`, add to `JobDefinition` (after line 356, before the closing `}`):

```typescript
  /** Tool scope for this job. Intersects with agent's tool list — only these tools are available during this job. If omitted, all agent tools are available. */
  tools?: string[];
```

- [ ] **Step 4: Update `resolveEffectiveConfig` to apply tool scoping**

In `src/jobs.ts`, modify `resolveEffectiveConfig()` (line 49-70). After computing briefing/expectations/performance_policy/compaction, add tool intersection:

```typescript
  // Tool scoping: job.tools narrows the agent's available tools
  const tools = job.tools && base.tools
    ? base.tools.filter(t => job.tools!.includes(t))
    : job.tools ?? base.tools;
```

And include `tools` in the return object:

```typescript
  return {
    ...base,
    briefing,
    expectations,
    performance_policy,
    compaction,
    tools,
    jobs: undefined,
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/jobs/tool-scope.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/jobs.ts test/jobs/tool-scope.test.ts
git commit -m "feat: add per-job tool scoping on JobDefinition"
```

---

### Task 2: Add `observe` field to `AgentConfig` type

**Files:**
- Modify: `src/types.ts:270-319` (AgentConfig type)

- [ ] **Step 1: Add `observe` field to `AgentConfig`**

In `src/types.ts`, add to `AgentConfig` (after `memory` field, before the closing `}`):

```typescript
  /** Event type patterns this agent monitors (e.g. ["budget.*", "task.failed"]). Observed events are injected into briefing at each tick. */
  observe?: string[];
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run test/profiles.test.ts test/context/assembler.test.ts`
Expected: PASS — adding an optional field shouldn't break anything.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add observe field to AgentConfig for event monitoring"
```

---

### Task 3: Add `observed_events` context source

**Files:**
- Modify: `src/types.ts:201-217` (ContextSource type)
- Create: `src/context/observed-events.ts`
- Create: `test/context/observed-events.test.ts`

- [ ] **Step 1: Add `observed_events` to the ContextSource source union**

In `src/types.ts` line 203, add `"observed_events"` to the source union string. Insert it after `"custom_stream"`:

```typescript
  source: "instructions" | "custom" | ... | "custom_stream" | "observed_events";
```

Also add a field for the last-tick timestamp:

```typescript
  /** Timestamp for observed_events source: only show events after this time. */
  since?: number;
```

- [ ] **Step 2: Write the failing test**

Create `test/context/observed-events.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");

let db: ReturnType<typeof getMemoryDb>;
const DOMAIN = "test-observe";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("renderObservedEvents", () => {
  it("returns matching events for exact type patterns", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1", amount: 500 }, { db });
    events.emit("task.completed", { taskId: "t1" }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.exceeded"], 0, db);
    expect(result).toContain("budget.exceeded");
    expect(result).not.toContain("task.completed");
  });

  it("supports wildcard patterns", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1" }, { db });
    events.emit("budget.warning", { agent: "dev-2" }, { db });
    events.emit("task.completed", { taskId: "t1" }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("budget.exceeded");
    expect(result).toContain("budget.warning");
    expect(result).not.toContain("task.completed");
  });

  it("filters by since timestamp", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { old: true }, { db });
    const after = Date.now();
    events.emit("budget.exceeded", { new: true }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], after, db);
    expect(result).toContain("new");
    expect(result).not.toContain("old");
  });

  it("returns empty message when no events match", () => {
    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("No observed events");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/context/observed-events.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `renderObservedEvents`**

Create `src/context/observed-events.ts`:

```typescript
/**
 * Clawforce — Observed Events context source
 *
 * Renders recent events matching an agent's observe patterns
 * as a markdown briefing section.
 */

import type { DatabaseSync } from "node:sqlite";
import { listEvents } from "../events/store.js";

/**
 * Match an event type against a pattern.
 * Supports exact match and wildcard suffix (e.g. "budget.*" matches "budget.exceeded").
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(prefix + ".");
  }
  return eventType === pattern;
}

/**
 * Render observed events matching the given patterns as markdown.
 *
 * @param domain - Project domain
 * @param patterns - Event type patterns to match (supports "*" wildcard suffix)
 * @param since - Only include events created after this timestamp (ms)
 * @param db - Optional DB override for testing
 */
export function renderObservedEvents(
  domain: string,
  patterns: string[],
  since: number,
  db?: DatabaseSync,
): string {
  const allEvents = listEvents(domain, { limit: 200 }, db);

  const matching = allEvents.filter(e =>
    e.createdAt > since &&
    patterns.some(p => matchesPattern(e.type, p))
  );

  if (matching.length === 0) {
    return "## Observed Events\n\nNo observed events since last check.";
  }

  const lines = matching.map(e => {
    const time = new Date(e.createdAt).toISOString();
    const payload = JSON.stringify(e.payload);
    return `- **${e.type}** (${time}): ${payload}`;
  });

  return `## Observed Events\n\n${lines.join("\n")}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/context/observed-events.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/context/observed-events.ts test/context/observed-events.test.ts
git commit -m "feat: observed_events context source for agent event monitoring"
```

---

### Task 4: DIRECTION.md schema and loader

**Files:**
- Create: `src/direction.ts`
- Create: `test/direction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/direction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

const { parseDirection, validateDirection } = await import("../src/direction.js");

describe("parseDirection", () => {
  it("parses minimal direction (vision only)", () => {
    const dir = parseDirection("vision: Build a rental compliance SaaS");
    expect(dir.vision).toBe("Build a rental compliance SaaS");
    expect(dir.constraints).toBeUndefined();
    expect(dir.phases).toBeUndefined();
    expect(dir.autonomy).toBe("low"); // default
  });

  it("parses full direction with all fields", () => {
    const yaml = `
vision: "Build a rental compliance SaaS"
constraints:
  budget_daily_cents: 5000
  tech_stack: [Next.js, Postgres]
  timeline: "MVP in 2 weeks"
phases:
  - name: Foundation
    goals: ["Set up repo", "Auth system"]
  - name: Core
    goals: ["Property tracking"]
autonomy: high
`;
    const dir = parseDirection(yaml);
    expect(dir.vision).toBe("Build a rental compliance SaaS");
    expect(dir.constraints?.budget_daily_cents).toBe(5000);
    expect(dir.constraints?.tech_stack).toEqual(["Next.js", "Postgres"]);
    expect(dir.phases).toHaveLength(2);
    expect(dir.phases![0].name).toBe("Foundation");
    expect(dir.autonomy).toBe("high");
  });

  it("parses plain text as vision-only", () => {
    const dir = parseDirection("Build me an app that tracks rental violations");
    expect(dir.vision).toBe("Build me an app that tracks rental violations");
  });
});

describe("validateDirection", () => {
  it("rejects empty vision", () => {
    const result = validateDirection({ vision: "" });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("vision");
  });

  it("rejects invalid autonomy value", () => {
    const result = validateDirection({ vision: "test", autonomy: "extreme" as any });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("autonomy");
  });

  it("accepts valid minimal direction", () => {
    const result = validateDirection({ vision: "Build something" });
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/direction.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement direction loader**

Create `src/direction.ts`:

```typescript
/**
 * Clawforce — DIRECTION.md schema and loader
 *
 * Parses a DIRECTION.md file (YAML or plain text) into a structured
 * Direction object that drives team setup and manager behavior.
 */

import YAML from "yaml";

export type DirectionConstraints = {
  budget_daily_cents?: number;
  tech_stack?: string[];
  timeline?: string;
  [key: string]: unknown;
};

export type DirectionPhase = {
  name: string;
  goals: string[];
};

export type Autonomy = "low" | "medium" | "high";

export type Direction = {
  vision: string;
  constraints?: DirectionConstraints;
  phases?: DirectionPhase[];
  autonomy: Autonomy;
};

const VALID_AUTONOMY: Set<string> = new Set(["low", "medium", "high"]);

/**
 * Parse a DIRECTION.md string into a Direction object.
 * Accepts YAML or plain text (plain text becomes vision-only).
 */
export function parseDirection(content: string): Direction {
  const trimmed = content.trim();

  // Try YAML first
  try {
    const parsed = YAML.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.vision === "string") {
      return {
        vision: parsed.vision,
        constraints: parsed.constraints,
        phases: parsed.phases,
        autonomy: VALID_AUTONOMY.has(parsed.autonomy) ? parsed.autonomy : "low",
      };
    }
  } catch {
    // Not valid YAML — treat as plain text
  }

  // Plain text fallback: entire content is the vision
  return {
    vision: trimmed,
    autonomy: "low",
  };
}

export type DirectionValidation = {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
};

/**
 * Validate a Direction object.
 */
export function validateDirection(dir: Partial<Direction>): DirectionValidation {
  const errors: DirectionValidation["errors"] = [];

  if (!dir.vision || dir.vision.trim().length === 0) {
    errors.push({ field: "vision", message: "vision is required and must be non-empty" });
  }

  if (dir.autonomy && !VALID_AUTONOMY.has(dir.autonomy)) {
    errors.push({ field: "autonomy", message: `autonomy must be one of: low, medium, high` });
  }

  if (dir.phases) {
    for (let i = 0; i < dir.phases.length; i++) {
      const phase = dir.phases[i];
      if (!phase.name) {
        errors.push({ field: `phases[${i}].name`, message: "phase name is required" });
      }
      if (!Array.isArray(phase.goals) || phase.goals.length === 0) {
        errors.push({ field: `phases[${i}].goals`, message: "phase must have at least one goal" });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/direction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/direction.ts test/direction.test.ts
git commit -m "feat: DIRECTION.md schema, parser, and validator"
```

---

### Task 5: Direction loading in domain config + `direction` field on `DomainConfig`

**Files:**
- Modify: `src/config/schema.ts:33-57` (DomainConfig type)
- Create: `test/config/direction-loading.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/direction-loading.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseDirection } from "../../src/direction.js";
import type { DomainConfig } from "../../src/config/schema.js";

describe("DomainConfig direction field", () => {
  it("accepts direction path in domain config", () => {
    const config: DomainConfig = {
      domain: "test",
      agents: ["lead", "dev-1"],
      direction: "./DIRECTION.md",
    };
    expect(config.direction).toBe("./DIRECTION.md");
  });

  it("accepts template field in domain config", () => {
    const config: DomainConfig = {
      domain: "test",
      agents: ["lead"],
      template: "startup",
    };
    expect(config.template).toBe("startup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/direction-loading.test.ts`
Expected: FAIL — `direction` and `template` don't exist on `DomainConfig`.

- [ ] **Step 3: Add `direction` and `template` fields to `DomainConfig`**

In `src/config/schema.ts`, add to `DomainConfig` (after `domain` field):

```typescript
  /** Path to DIRECTION.md file (relative to domain config or project root). */
  direction?: string;
  /** Template preset name (e.g. "startup"). */
  template?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/direction-loading.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config/direction-loading.test.ts
git commit -m "feat: add direction and template fields to DomainConfig"
```

---

## Chunk 2: Adaptation Tools — Agent Hiring, Budget Reallocation, Org Modification

### Task 6: `agent_hire` action on clawforce_ops tool

This adds the ability for a manager to register a new agent into the running domain config at runtime.

**Files:**
- Create: `src/adaptation/hire.ts`
- Create: `test/adaptation/hire.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/adaptation/hire.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { hireAgent } = await import("../../src/adaptation/hire.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-hire";

// Mock the project registry
const { registerAgentConfig, getAgentConfig, getRegisteredAgentIds } = await import("../../src/project.js");

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("hireAgent", () => {
  it("registers a new agent with the given spec", () => {
    const result = hireAgent(PROJECT, {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Operations Specialist",
      reports_to: "lead",
      observe: ["budget.exceeded", "budget.warning"],
      briefing: [{ source: "instructions" }],
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("budget-ops");
  });

  it("rejects hire if agent already exists", () => {
    hireAgent(PROJECT, {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Ops",
      reports_to: "lead",
    });

    const result = hireAgent(PROJECT, {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Ops Duplicate",
      reports_to: "lead",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects hire if manager is not specified", () => {
    const result = hireAgent(PROJECT, {
      agentId: "orphan",
      extends: "employee",
      title: "Orphan Agent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reports_to");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adaptation/hire.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `hireAgent`**

Create `src/adaptation/hire.ts`:

```typescript
/**
 * Clawforce — Agent Hiring
 *
 * Registers a new agent into the running domain config at runtime.
 * Used by managers during self-adaptation to spin up specialists.
 */

import type { AgentConfig, ContextSource, JobDefinition } from "../types.js";
import { registerAgentInProject, getAgentConfig } from "../project.js";
import { applyProfile } from "../profiles.js";
import { BUILTIN_AGENT_PRESETS } from "../presets.js";

export type HireSpec = {
  agentId: string;
  extends?: string;
  title: string;
  reports_to?: string;
  observe?: string[];
  tools?: string[];
  briefing?: ContextSource[];
  jobs?: Record<string, JobDefinition>;
};

export type HireResult = {
  success: boolean;
  agentId: string;
  error?: string;
};

/**
 * Register a new agent in the domain config at runtime.
 */
export function hireAgent(projectId: string, spec: HireSpec): HireResult {
  // Validate: must have reports_to (no orphan agents)
  if (!spec.reports_to) {
    return { success: false, agentId: spec.agentId, error: "reports_to is required — every hired agent must report to a manager" };
  }

  // Check for duplicates
  const existing = getAgentConfig(spec.agentId);
  if (existing && existing.projectId === projectId) {
    return { success: false, agentId: spec.agentId, error: `Agent "${spec.agentId}" already exists in this domain` };
  }

  // Build the agent config from spec + preset
  const preset = spec.extends ?? "employee";
  const config: AgentConfig = applyProfile(preset, {
    extends: preset,
    title: spec.title,
    reports_to: spec.reports_to,
    observe: spec.observe,
    tools: spec.tools,
    briefing: spec.briefing ?? [],
    expectations: [],
    performance_policy: { action: "retry", max_retries: 3, then: "alert" },
    jobs: spec.jobs,
  });

  // Register in the project
  registerAgentInProject(projectId, spec.agentId, config);

  return { success: true, agentId: spec.agentId };
}
```

**Note:** `registerAgentInProject` may not exist yet. Check `src/project.ts` for the agent registration mechanism and adapt accordingly — the project module uses a module-level `Map` for agent configs. If no public registration function exists, add one:

```typescript
// In src/project.ts — add if not present
export function registerAgentInProject(projectId: string, agentId: string, config: AgentConfig): void {
  agentConfigs.set(agentId, { projectId, config });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adaptation/hire.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adaptation/hire.ts test/adaptation/hire.test.ts src/project.ts
git commit -m "feat: agent hiring — runtime registration of new agents"
```

---

### Task 7: `budget_reallocate` action

**Files:**
- Create: `src/adaptation/budget-reallocate.ts`
- Create: `test/adaptation/budget-reallocate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/adaptation/budget-reallocate.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { reallocateBudget } = await import("../../src/adaptation/budget-reallocate.js");
const { setBudget, getRemainingBudget } = await import("../../src/budget.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-realloc";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
  // Set up initial budgets
  setBudget(PROJECT, "dev-1", { daily: { cents: 1000 } }, db);
  setBudget(PROJECT, "dev-2", { daily: { cents: 500 } }, db);
});

describe("reallocateBudget", () => {
  it("transfers budget from one agent to another", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: 200,
      window: "daily",
      reason: "dev-2 needs more capacity for feature work",
    }, db);

    expect(result.success).toBe(true);
    // dev-1 should now have 800, dev-2 should have 700
  });

  it("rejects if source has insufficient budget", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: 2000,
      window: "daily",
      reason: "too much",
    }, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("insufficient");
  });

  it("rejects negative amount", () => {
    const result = reallocateBudget(PROJECT, {
      from: "dev-1",
      to: "dev-2",
      amount_cents: -100,
      window: "daily",
      reason: "negative",
    }, db);

    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adaptation/budget-reallocate.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement budget reallocation**

Create `src/adaptation/budget-reallocate.ts`:

```typescript
/**
 * Clawforce — Budget Reallocation
 *
 * Shifts budget allocation between agents within a domain.
 * Used by managers to redistribute resources based on workload.
 */

import type { DatabaseSync } from "node:sqlite";
import { setBudget, getBudgetLimits } from "../budget.js";

export type ReallocateParams = {
  from: string;
  to: string;
  amount_cents: number;
  window: "hourly" | "daily" | "monthly";
  reason: string;
};

export type ReallocateResult = {
  success: boolean;
  error?: string;
  from_new_limit?: number;
  to_new_limit?: number;
};

export function reallocateBudget(
  projectId: string,
  params: ReallocateParams,
  db?: DatabaseSync,
): ReallocateResult {
  if (params.amount_cents <= 0) {
    return { success: false, error: "amount_cents must be positive" };
  }

  const fromLimits = getBudgetLimits(projectId, params.from, db);
  const toLimits = getBudgetLimits(projectId, params.to, db);

  if (!fromLimits) {
    return { success: false, error: `No budget found for agent "${params.from}"` };
  }

  const currentFromLimit = fromLimits[params.window]?.cents ?? 0;
  if (currentFromLimit < params.amount_cents) {
    return { success: false, error: `Insufficient budget: "${params.from}" has ${currentFromLimit} cents in ${params.window} window, cannot transfer ${params.amount_cents}` };
  }

  const currentToLimit = toLimits?.[params.window]?.cents ?? 0;
  const newFromLimit = currentFromLimit - params.amount_cents;
  const newToLimit = currentToLimit + params.amount_cents;

  setBudget(projectId, params.from, { [params.window]: { cents: newFromLimit } }, db);
  setBudget(projectId, params.to, { [params.window]: { cents: newToLimit } }, db);

  return {
    success: true,
    from_new_limit: newFromLimit,
    to_new_limit: newToLimit,
  };
}
```

**Note:** Check `src/budget.ts` for exact function signatures of `setBudget` and `getBudgetLimits`. The above assumes a reasonable API — adapt the calls to match the actual budget module interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adaptation/budget-reallocate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adaptation/budget-reallocate.ts test/adaptation/budget-reallocate.test.ts
git commit -m "feat: budget reallocation between agents"
```

---

### Task 8: Adaptation card executor with trust gating

**Files:**
- Create: `src/adaptation/cards.ts`
- Create: `test/adaptation/cards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/adaptation/cards.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { checkAdaptationPermission, ADAPTATION_CARDS } = await import("../../src/adaptation/cards.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("ADAPTATION_CARDS", () => {
  it("defines risk levels for all card types", () => {
    expect(ADAPTATION_CARDS.skill_creation.risk).toBe("low");
    expect(ADAPTATION_CARDS.budget_reallocation.risk).toBe("low");
    expect(ADAPTATION_CARDS.process_change.risk).toBe("medium");
    expect(ADAPTATION_CARDS.agent_hiring.risk).toBe("medium");
    expect(ADAPTATION_CARDS.agent_splitting.risk).toBe("medium");
    expect(ADAPTATION_CARDS.infra_provisioning.risk).toBe("high");
    expect(ADAPTATION_CARDS.escalation.risk).toBe("none");
  });
});

describe("checkAdaptationPermission", () => {
  it("allows escalation at any trust level", () => {
    const result = checkAdaptationPermission("escalation", 0.1);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for all cards at low trust", () => {
    const result = checkAdaptationPermission("skill_creation", 0.2);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("auto-approves low-risk cards at medium trust", () => {
    const result = checkAdaptationPermission("skill_creation", 0.5);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for medium-risk cards at medium trust", () => {
    const result = checkAdaptationPermission("agent_hiring", 0.5);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("auto-approves medium-risk cards at high trust", () => {
    const result = checkAdaptationPermission("agent_hiring", 0.85);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for high-risk cards at high trust", () => {
    const result = checkAdaptationPermission("infra_provisioning", 0.85);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adaptation/cards.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement adaptation cards**

Create `src/adaptation/cards.ts`:

```typescript
/**
 * Clawforce — Adaptation Cards
 *
 * Defines the manager's adaptation toolkit and trust-gated permissions.
 * Each card has a risk level. Trust tier determines whether the card
 * requires human approval or can be auto-approved.
 */

export type CardRisk = "none" | "low" | "medium" | "high";

export type AdaptationCard = {
  name: string;
  description: string;
  risk: CardRisk;
};

export const ADAPTATION_CARDS: Record<string, AdaptationCard> = {
  skill_creation: {
    name: "Skill Creation",
    description: "Create a new skill from repeated patterns",
    risk: "low",
  },
  budget_reallocation: {
    name: "Budget Reallocation",
    description: "Shift budget between agents",
    risk: "low",
  },
  process_change: {
    name: "Process Change",
    description: "Add/remove approval gates, change tick frequency",
    risk: "medium",
  },
  agent_hiring: {
    name: "Agent Hiring",
    description: "Spin up a new specialist agent",
    risk: "medium",
  },
  agent_splitting: {
    name: "Agent Splitting",
    description: "Split an overloaded agent into two focused agents",
    risk: "medium",
  },
  infra_provisioning: {
    name: "Infra Provisioning",
    description: "Set up monitoring, CI/CD, alerting",
    risk: "high",
  },
  escalation: {
    name: "Escalation",
    description: "Flag an issue to the human",
    risk: "none",
  },
};

export type PermissionResult = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

/**
 * Check whether a manager can execute an adaptation card at the given trust score.
 *
 * Trust tiers:
 * - Low (< 0.4): all cards require approval except escalation
 * - Medium (0.4-0.7): low-risk auto-approved, medium/high require approval
 * - High (> 0.7): low+medium auto-approved, high requires approval
 */
export function checkAdaptationPermission(
  cardType: string,
  trustScore: number,
): PermissionResult {
  const card = ADAPTATION_CARDS[cardType];
  if (!card) {
    return { allowed: false, requiresApproval: false, reason: `Unknown card type: ${cardType}` };
  }

  // Escalation is always allowed without approval
  if (card.risk === "none") {
    return { allowed: true, requiresApproval: false };
  }

  // Determine trust tier
  const tier = trustScore > 0.7 ? "high" : trustScore > 0.4 ? "medium" : "low";

  // Low trust: everything needs approval
  if (tier === "low") {
    return { allowed: true, requiresApproval: true, reason: "Low trust — all adaptations require approval" };
  }

  // Medium trust: low-risk auto-approved, rest need approval
  if (tier === "medium") {
    if (card.risk === "low") {
      return { allowed: true, requiresApproval: false };
    }
    return { allowed: true, requiresApproval: true, reason: `Medium trust — ${card.risk}-risk cards require approval` };
  }

  // High trust: low+medium auto-approved, high needs approval
  if (card.risk === "high") {
    return { allowed: true, requiresApproval: true, reason: "High-risk cards always require approval" };
  }
  return { allowed: true, requiresApproval: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adaptation/cards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adaptation/cards.ts test/adaptation/cards.test.ts
git commit -m "feat: adaptation cards with trust-tiered permission gating"
```

---

## Chunk 3: Setup Flow, Template, and Autonomy Initialization

### Task 9: Extend init flow with direction questions

**Files:**
- Modify: `src/config/init-flow.ts:31-94`
- Create: `test/config/init-direction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/init-direction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

const { getInitQuestions, buildConfigFromAnswers } = await import("../../src/config/init-flow.js");
import type { InitAnswers } from "../../src/config/init-flow.js";

describe("direction init questions", () => {
  it("includes vision question", () => {
    const questions = getInitQuestions();
    const visionQ = questions.find(q => q.id === "vision");
    expect(visionQ).toBeDefined();
    expect(visionQ!.type).toBe("text");
  });

  it("includes autonomy question", () => {
    const questions = getInitQuestions();
    const autoQ = questions.find(q => q.id === "autonomy");
    expect(autoQ).toBeDefined();
    expect(autoQ!.choices).toEqual(["low", "medium", "high"]);
  });

  it("includes template question", () => {
    const questions = getInitQuestions();
    const templateQ = questions.find(q => q.id === "template");
    expect(templateQ).toBeDefined();
    expect(templateQ!.choices).toContain("startup");
  });
});

describe("buildConfigFromAnswers with direction", () => {
  it("generates direction content when vision is provided", () => {
    const answers: InitAnswers = {
      domain_name: "test-project",
      mission: "Build something cool",
      agents: [{ name: "lead", title: "Lead" }],
      reporting: {},
      budget_cents: 1000,
      vision: "Build a rental compliance SaaS",
      autonomy: "medium",
      template: "startup",
    };

    const result = buildConfigFromAnswers(answers);
    expect(result.direction).toBeDefined();
    expect(result.direction!.vision).toBe("Build a rental compliance SaaS");
    expect(result.direction!.autonomy).toBe("medium");
    expect(result.domain.template).toBe("startup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/init-direction.test.ts`
Expected: FAIL — `vision`, `autonomy`, `template` fields don't exist on `InitAnswers` or in question list.

- [ ] **Step 3: Extend `InitAnswers` and `getInitQuestions`**

In `src/config/init-flow.ts`:

Add to `InitAnswers` type (line 31-39):
```typescript
  vision?: string;
  autonomy?: "low" | "medium" | "high";
  template?: string;
```

Add questions to `getInitQuestions()` array (insert before the mission question):
```typescript
    {
      id: "template",
      type: "choice",
      prompt: "Pick a team template",
      description: "Templates provide pre-configured team structures. 'startup' is lean (just a lead + devs). 'custom' lets you define everything.",
      choices: ["startup", "custom"],
      default: "startup",
    },
    {
      id: "vision",
      type: "text",
      prompt: "What's the vision? Describe what you want to build.",
      description: "This becomes the DIRECTION.md that guides the team. Can be a sentence or a paragraph.",
    },
    {
      id: "autonomy",
      type: "choice",
      prompt: "How much autonomy should the team have?",
      description: "Low = all adaptations need your approval. Medium = routine changes auto-approved. High = team self-manages within budget.",
      choices: ["low", "medium", "high"],
      default: "low",
    },
```

Update `buildConfigFromAnswers` to include direction in the return:
```typescript
  // Build direction if vision was provided
  const direction = answers.vision ? {
    vision: answers.vision,
    autonomy: (answers.autonomy ?? "low") as "low" | "medium" | "high",
  } : undefined;

  const domain: InitDomainOpts = {
    name: answers.domain_name,
    agents: agentNames,
    template: answers.template,
  };

  // ...existing code...

  return { global, domain, direction };
```

Also update `InitDomainOpts` in `src/config/wizard.ts` to accept `template`:
```typescript
  template?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/init-direction.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing init-flow tests to check for regressions**

Run: `npx vitest run test/config/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/init-flow.ts src/config/wizard.ts test/config/init-direction.test.ts
git commit -m "feat: extend init flow with vision, autonomy, and template questions"
```

---

### Task 10: Autonomy initialization via trust overrides

**Files:**
- Create: `src/adaptation/autonomy-init.ts`
- Create: `test/adaptation/autonomy-init.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/adaptation/autonomy-init.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { initializeAutonomy } = await import("../../src/adaptation/autonomy-init.js");
const { getActiveTrustOverrides } = await import("../../src/trust/tracker.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-autonomy";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("initializeAutonomy", () => {
  it("creates no overrides for low autonomy (default)", () => {
    initializeAutonomy(PROJECT, "low", ["lead", "dev-1"], db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides).toHaveLength(0);
  });

  it("creates medium-tier overrides for medium autonomy", () => {
    initializeAutonomy(PROJECT, "medium", ["lead", "dev-1"], db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides.every((o: any) => o.override_tier === "medium")).toBe(true);
  });

  it("creates high-tier overrides for high autonomy", () => {
    initializeAutonomy(PROJECT, "high", ["lead"], db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides.every((o: any) => o.override_tier === "high")).toBe(true);
  });

  it("sets overrides to decay after 14 days", () => {
    initializeAutonomy(PROJECT, "high", ["lead"], db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides[0].decay_after_days).toBe(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adaptation/autonomy-init.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement autonomy initialization**

Create `src/adaptation/autonomy-init.ts`:

```typescript
/**
 * Clawforce — Autonomy Initialization
 *
 * Seeds trust overrides based on the autonomy level in DIRECTION.md.
 * Overrides decay naturally as real trust decisions accumulate.
 */

import type { DatabaseSync } from "node:sqlite";
import { applyTrustOverride } from "../trust/tracker.js";
import type { Autonomy } from "../direction.js";

/** Categories that get overridden at init based on autonomy level. */
const ADAPTATION_CATEGORIES = [
  "adaptation:skill_creation",
  "adaptation:budget_reallocation",
  "adaptation:process_change",
  "adaptation:agent_hiring",
  "adaptation:agent_splitting",
  "adaptation:infra_provisioning",
];

/**
 * Initialize trust overrides for all agents based on DIRECTION.md autonomy level.
 *
 * - low: no overrides (default zero-trust start)
 * - medium: override all adaptation categories to medium tier
 * - high: override all adaptation categories to high tier
 *
 * All overrides decay after 14 days, allowing real trust data to take over.
 */
export function initializeAutonomy(
  projectId: string,
  autonomy: Autonomy,
  agentIds: string[],
  db?: DatabaseSync,
): void {
  if (autonomy === "low") return; // No overrides for low autonomy

  const overrideTier = autonomy; // "medium" or "high"

  for (const category of ADAPTATION_CATEGORIES) {
    applyTrustOverride({
      projectId,
      category,
      originalTier: "low",
      overrideTier,
      reason: `Initialized from DIRECTION.md autonomy: ${autonomy}`,
      decayAfterDays: 14,
    }, db);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adaptation/autonomy-init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adaptation/autonomy-init.ts test/adaptation/autonomy-init.test.ts
git commit -m "feat: autonomy initialization via trust overrides with 14-day decay"
```

---

### Task 11: Startup template definition

**Files:**
- Create: `src/templates/startup.ts`
- Create: `test/templates/startup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/templates/startup.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

const { getTemplate, STARTUP_TEMPLATE } = await import("../../src/templates/startup.js");

describe("startup template", () => {
  it("defines a lead manager agent", () => {
    expect(STARTUP_TEMPLATE.agents.lead).toBeDefined();
    expect(STARTUP_TEMPLATE.agents.lead.extends).toBe("manager");
  });

  it("defines a dev-1 employee agent", () => {
    expect(STARTUP_TEMPLATE.agents["dev-1"]).toBeDefined();
    expect(STARTUP_TEMPLATE.agents["dev-1"].extends).toBe("employee");
    expect(STARTUP_TEMPLATE.agents["dev-1"].reports_to).toBe("lead");
  });

  it("defines an agent-builder employee", () => {
    expect(STARTUP_TEMPLATE.agents["agent-builder"]).toBeDefined();
    expect(STARTUP_TEMPLATE.agents["agent-builder"].extends).toBe("employee");
    expect(STARTUP_TEMPLATE.agents["agent-builder"].reports_to).toBe("lead");
  });

  it("defines manager jobs with tool scoping", () => {
    const jobs = STARTUP_TEMPLATE.agents.lead.jobs;
    expect(jobs).toBeDefined();
    expect(jobs!.dispatch.cron).toBe("*/5 * * * *");
    expect(jobs!.dispatch.tools).toBeDefined();
    expect(jobs!.reflect.cron).toBe("0 9 * * MON");
    expect(jobs!.reflect.tools).toContain("agent_hire");
  });

  it("getTemplate returns null for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });

  it("getTemplate returns startup template", () => {
    const t = getTemplate("startup");
    expect(t).toBe(STARTUP_TEMPLATE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/templates/startup.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement startup template**

Create `src/templates/startup.ts`:

```typescript
/**
 * Clawforce — Startup Template
 *
 * The lean, dogfood-first template. Ships with:
 * - lead (manager) with dispatch/reflect/ops jobs
 * - dev-1 (employee)
 * - agent-builder (employee) for self-adaptation
 *
 * The manager discovers what else it needs through experience.
 */

import type { AgentConfig, JobDefinition } from "../types.js";

export type TemplateDefinition = {
  name: string;
  description: string;
  agents: Record<string, Partial<AgentConfig> & { extends: string }>;
  budgets?: {
    project?: { daily: { cents: number } };
  };
};

export const STARTUP_TEMPLATE: TemplateDefinition = {
  name: "startup",
  description: "Lean team: manager + dev(s) + agent-builder. Self-adapts as needed.",
  agents: {
    lead: {
      extends: "manager",
      title: "Team Lead",
      jobs: {
        dispatch: {
          cron: "*/5 * * * *",
          tools: ["task_assign", "task_create", "budget_check", "message_send"],
          briefing: [
            { source: "instructions" },
            { source: "task_board" },
            { source: "pending_messages" },
          ],
        },
        reflect: {
          cron: "0 9 * * MON",
          tools: ["org_modify", "skill_create", "budget_reallocate", "agent_hire"],
          briefing: [
            { source: "instructions" },
            { source: "velocity" },
            { source: "trust_scores" },
            { source: "cost_summary" },
            { source: "cost_forecast" },
            { source: "team_performance" },
          ],
        },
        ops: {
          cron: "0 * * * *",
          tools: ["health_check", "message_send"],
          briefing: [
            { source: "instructions" },
            { source: "health_status" },
          ],
        },
      },
    },
    "dev-1": {
      extends: "employee",
      title: "Developer",
      reports_to: "lead",
    },
    "agent-builder": {
      extends: "employee",
      title: "Agent Builder",
      reports_to: "lead",
    },
  },
  budgets: {
    project: { daily: { cents: 3000 } },
  },
};

const TEMPLATES: Record<string, TemplateDefinition> = {
  startup: STARTUP_TEMPLATE,
};

/**
 * Get a template by name. Returns null if not found.
 */
export function getTemplate(name: string): TemplateDefinition | null {
  return TEMPLATES[name] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/templates/startup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/templates/startup.ts test/templates/startup.test.ts
git commit -m "feat: startup template — lean team with agent-builder for self-adaptation"
```

---

## Chunk 4: SDK Integration — Wiring It All Together

### Task 12: Wire `observed_events` into context assembler

**Files:**
- Modify: `src/context/assembler.ts` (add observed_events case)
- Create: `test/context/assembler-observe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/context/assembler-observe.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");

let db: ReturnType<typeof getMemoryDb>;
const DOMAIN = "test-assemble-observe";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("observed_events in assembler", () => {
  it("renders observed events section when observe patterns match", () => {
    // This test verifies the renderObservedEvents function works
    // as it will be called from the assembler
    const { EventsNamespace } = await import("../../src/sdk/events.js");
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1", overage: 200 }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("## Observed Events");
    expect(result).toContain("budget.exceeded");
    expect(result).toContain("dev-1");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/context/assembler-observe.test.ts`
Expected: PASS (the source module already exists from Task 3).

- [ ] **Step 3: Add `observed_events` case to context assembler**

In `src/context/assembler.ts`, find the switch/if-else chain that handles different `source` values and add:

```typescript
case "observed_events": {
  const { renderObservedEvents } = await import("./observed-events.js");
  const observe = agentConfig.observe ?? [];
  const since = source.since ?? 0;
  return renderObservedEvents(domain, observe, since);
}
```

The exact integration depends on how `assembleContext` is structured — it may be a loop over briefing sources with a switch statement or a map of source renderers. Read the file and integrate accordingly.

- [ ] **Step 4: Run all context assembler tests**

Run: `npx vitest run test/context/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/assembler.ts test/context/assembler-observe.test.ts
git commit -m "feat: wire observed_events into context assembler"
```

---

### Task 13: Per-job budget tracking — add `job_name` to cost recording

**Files:**
- Modify: `src/budget.ts` or `src/cost.ts` (wherever `recordCost` lives)
- Modify: `src/jobs.ts` (pass job name through effective config)
- Create: `test/budget/job-cost.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/budget/job-cost.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-job-cost";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("per-job cost tracking", () => {
  it("records cost with job_name when provided", async () => {
    // Import the cost recording function (adapt to actual module path)
    const { recordCost, getCostSummary } = await import("../../src/budget.js");

    recordCost(PROJECT, "lead", { cents: 50, tokens: 1000, requests: 1 }, { jobName: "dispatch" }, db);
    recordCost(PROJECT, "lead", { cents: 100, tokens: 2000, requests: 1 }, { jobName: "reflect" }, db);
    recordCost(PROJECT, "lead", { cents: 30, tokens: 500, requests: 1 }, {}, db);

    // Verify costs can be queried with job grouping
    const summary = getCostSummary(PROJECT, "lead", { groupByJob: true }, db);
    expect(summary.dispatch?.cents).toBe(50);
    expect(summary.reflect?.cents).toBe(100);
  });
});
```

**Note:** The exact function signatures will need to be adapted to match the existing budget/cost module API. Read `src/budget.ts` and related files first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget/job-cost.test.ts`
Expected: FAIL — `jobName` param not supported.

- [ ] **Step 3: Add `job_name` column to cost table**

Add a migration or modify the cost recording SQL to include an optional `job_name` column. Add it to the `recordCost` function signature as an optional param.

- [ ] **Step 4: Update `resolveEffectiveConfig` to propagate job name**

In `src/jobs.ts`, add a `_jobName` field to the effective config so downstream code knows which job is running:

```typescript
return {
  ...base,
  briefing,
  expectations,
  performance_policy,
  compaction,
  tools,
  jobs: undefined,
  _jobName: jobName, // internal metadata for cost tracking
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/budget/job-cost.test.ts`
Expected: PASS

- [ ] **Step 6: Run existing budget tests to check for regressions**

Run: `npx vitest run test/budget-session.test.ts test/budget-parser.test.ts test/dispatch/budget-gate.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/budget.ts src/jobs.ts src/migrations.ts test/budget/job-cost.test.ts
git commit -m "feat: per-job budget tracking with job_name cost attribution"
```

---

### Task 14: Observe pattern — config normalization for `observe` field

**Files:**
- Modify: `src/project.ts` (normalize observe field when parsing agent config)
- Create: `test/config/observe-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/observe-normalize.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

// Test that observe field is properly parsed from YAML config
describe("observe field normalization", () => {
  it("parses observe as string array from YAML", async () => {
    const { normalizeAgentConfig } = await import("../../src/project.js");

    const raw = {
      role: "employee",
      title: "Budget Ops",
      reports_to: "lead",
      observe: ["budget.exceeded", "budget.warning"],
    };

    // normalizeAgentConfig or the equivalent function should preserve observe
    const config = normalizeAgentConfig(raw);
    expect(config.observe).toEqual(["budget.exceeded", "budget.warning"]);
  });

  it("handles missing observe field", async () => {
    const { normalizeAgentConfig } = await import("../../src/project.js");

    const raw = {
      role: "employee",
      title: "Dev",
      reports_to: "lead",
    };

    const config = normalizeAgentConfig(raw);
    expect(config.observe).toBeUndefined();
  });
});
```

**Note:** The exact function name for agent config normalization needs to be verified — it may be `normalizeAgentConfig` in `src/project.ts` or in `src/config/aliases.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/observe-normalize.test.ts`
Expected: FAIL — `observe` field is not preserved during normalization.

- [ ] **Step 3: Add `observe` field normalization**

In the agent config normalization code (likely `normalizeAgentConfig` in `src/project.ts`), add:

```typescript
if (Array.isArray(raw.observe)) {
  config.observe = raw.observe as string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/observe-normalize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/project.ts test/config/observe-normalize.test.ts
git commit -m "feat: normalize observe field in agent config parsing"
```

---

### Task 15: Export adaptation modules from SDK index

**Files:**
- Modify: `src/index.ts` (add exports for adaptation modules)

- [ ] **Step 1: Add exports to main index**

In `src/index.ts`, add exports for the new modules:

```typescript
// Adaptation
export { hireAgent } from "./adaptation/hire.js";
export type { HireSpec, HireResult } from "./adaptation/hire.js";
export { reallocateBudget } from "./adaptation/budget-reallocate.js";
export type { ReallocateParams, ReallocateResult } from "./adaptation/budget-reallocate.js";
export { checkAdaptationPermission, ADAPTATION_CARDS } from "./adaptation/cards.js";
export type { AdaptationCard, CardRisk, PermissionResult } from "./adaptation/cards.js";
export { initializeAutonomy } from "./adaptation/autonomy-init.js";

// Direction
export { parseDirection, validateDirection } from "./direction.js";
export type { Direction, DirectionPhase, DirectionConstraints, Autonomy } from "./direction.js";

// Templates
export { getTemplate } from "./templates/startup.js";
export type { TemplateDefinition } from "./templates/startup.js";

// Context
export { renderObservedEvents } from "./context/observed-events.js";
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all existing + new tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: export adaptation, direction, templates, and observed-events modules"
```

---

## Chunk 5: Integration Test — End-to-End Self-Adaptation Flow

### Task 16: End-to-end self-adaptation test

**Files:**
- Create: `test/e2e/self-adaptation.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/e2e/self-adaptation.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { parseDirection } = await import("../../src/direction.js");
const { initializeAutonomy } = await import("../../src/adaptation/autonomy-init.js");
const { checkAdaptationPermission } = await import("../../src/adaptation/cards.js");
const { hireAgent } = await import("../../src/adaptation/hire.js");
const { getTemplate } = await import("../../src/templates/startup.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");
const { TrustNamespace } = await import("../../src/sdk/trust.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "e2e-adapt";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("self-adaptation e2e flow", () => {
  it("full lifecycle: direction → template → autonomy → adaptation → hire", () => {
    // 1. Parse direction
    const direction = parseDirection(`
vision: "Ship ClawForce v1"
autonomy: medium
    `);
    expect(direction.vision).toBe("Ship ClawForce v1");
    expect(direction.autonomy).toBe("medium");

    // 2. Load template
    const template = getTemplate("startup");
    expect(template).not.toBeNull();
    expect(template!.agents.lead.extends).toBe("manager");

    // 3. Initialize autonomy
    const agentIds = Object.keys(template!.agents);
    initializeAutonomy(PROJECT, direction.autonomy, agentIds, db);

    // 4. Check adaptation permissions at medium trust
    // At medium autonomy, low-risk cards should be auto-approved
    const skillPerm = checkAdaptationPermission("skill_creation", 0.55);
    expect(skillPerm.allowed).toBe(true);
    expect(skillPerm.requiresApproval).toBe(false);

    // Medium-risk cards should still require approval
    const hirePerm = checkAdaptationPermission("agent_hiring", 0.55);
    expect(hirePerm.allowed).toBe(true);
    expect(hirePerm.requiresApproval).toBe(true);

    // 5. Manager hires a budget specialist
    const hireResult = hireAgent(PROJECT, {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Operations Specialist",
      reports_to: "lead",
      observe: ["budget.exceeded", "budget.warning"],
    });
    expect(hireResult.success).toBe(true);

    // 6. Budget events flow to the observer's briefing
    const events = new EventsNamespace(PROJECT);
    events.emit("budget.exceeded", { agent: "dev-1", overage: 200 }, { db });

    const briefing = renderObservedEvents(PROJECT, ["budget.*"], 0, db);
    expect(briefing).toContain("budget.exceeded");
    expect(briefing).toContain("dev-1");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `npx vitest run test/e2e/self-adaptation.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/e2e/self-adaptation.test.ts
git commit -m "test: end-to-end self-adaptation flow integration test"
```

---

### Task 17: Full regression check

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address regressions from self-adaptation implementation"
```

---

## Summary

| Chunk | Tasks | What it delivers |
|-------|-------|-----------------|
| **1: Foundation** | 1-5 | Types (job tools, observe, observed_events), direction loader, DomainConfig extensions |
| **2: Adaptation Tools** | 6-8 | Agent hiring, budget reallocation, trust-gated adaptation cards |
| **3: Setup + Template** | 9-11 | Extended init flow, autonomy initialization, startup template |
| **4: SDK Integration** | 12-15 | Observed events in assembler, per-job cost tracking, observe normalization, exports |
| **5: E2E Validation** | 16-17 | Integration test, full regression suite |

**Parallelization opportunities for subagents:**
- Chunk 1 tasks 1-4 are independent (different files)
- Chunk 2 tasks 6-8 are independent
- Chunk 3 tasks 10-11 are independent
- Chunk 4 tasks 12-14 are independent
