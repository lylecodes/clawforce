# Config Inheritance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hardcoded role enum with a config inheritance system where agents and jobs use `extends:` to inherit from builtin or user-defined presets.

**Architecture:** New `src/presets.ts` module handles config resolution — walks `extends` chains, deep-merges objects, supports `+`/`-` array merge operators, detects cycles. Builtin presets (`manager`, `employee`, `reflect`, `triage`) ship as code. The `AgentRole` type and `role` field are deleted entirely. Every `if (role === "manager")` check is replaced with config-driven behavior (e.g., `config.coordination?.enabled`).

**Tech Stack:** TypeScript, Vitest, Node 22, ESM (.js imports)

**Design doc:** `docs/plans/2026-03-09-role-simplification-design.md`

---

### Task 1: Preset Resolution Engine

**Files:**
- Create: `src/presets.ts`
- Create: `test/presets.test.ts`

**Context:** This is the foundation. A pure function that takes a config with `extends: "something"`, walks the chain, and returns a fully resolved config. No dependencies on existing code — just merge logic.

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  mergeArrayWithOperators,
  detectCycle,
} from "../src/presets.js";

describe("preset resolution engine", () => {
  describe("mergeArrayWithOperators", () => {
    it("plain array replaces parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["x", "y"],
      );
      expect(result).toEqual(["x", "y"]);
    });

    it("+ operator appends to parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["+d", "+e"],
      );
      expect(result).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("- operator removes from parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["-b"],
      );
      expect(result).toEqual(["a", "c"]);
    });

    it("mixed + and - operators", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["+d", "-b"],
      );
      expect(result).toEqual(["a", "c", "d"]);
    });

    it("no parent array treats + items as plain", () => {
      const result = mergeArrayWithOperators(undefined, ["+a", "+b"]);
      expect(result).toEqual(["a", "b"]);
    });
  });

  describe("detectCycle", () => {
    it("returns null for no cycle", () => {
      const lookup = (name: string) => {
        if (name === "a") return { extends: "b" };
        if (name === "b") return { extends: "c" };
        if (name === "c") return {};
        return undefined;
      };
      expect(detectCycle("a", lookup)).toBeNull();
    });

    it("returns cycle path when cycle exists", () => {
      const lookup = (name: string) => {
        if (name === "a") return { extends: "b" };
        if (name === "b") return { extends: "a" };
        return undefined;
      };
      const cycle = detectCycle("a", lookup);
      expect(cycle).toBeDefined();
      expect(cycle).toContain("a");
      expect(cycle).toContain("b");
    });
  });

  describe("resolveConfig", () => {
    const presets = {
      base: {
        compaction: false,
        briefing: ["soul", "tools_reference"],
        expectations: [
          { tool: "clawforce_log", action: "write", min_calls: 1 },
        ],
        performance_policy: { action: "retry" as const, max_retries: 3 },
      },
      manager: {
        extends: "base",
        compaction: true,
        briefing: ["soul", "tools_reference", "task_board", "escalations"],
        coordination: { enabled: true, schedule: "*/30 * * * *" },
      },
    };

    it("resolves single-level extends", () => {
      const config = { extends: "base", title: "My Agent" };
      const resolved = resolveConfig(config, presets);
      expect(resolved.compaction).toBe(false);
      expect(resolved.briefing).toEqual(["soul", "tools_reference"]);
      expect(resolved.title).toBe("My Agent");
    });

    it("resolves chained extends", () => {
      const config = { extends: "manager", title: "Eng Lead" };
      const resolved = resolveConfig(config, presets);
      // manager overrides base
      expect(resolved.compaction).toBe(true);
      expect(resolved.coordination).toEqual({ enabled: true, schedule: "*/30 * * * *" });
      // child overrides
      expect(resolved.title).toBe("Eng Lead");
    });

    it("child scalar overrides parent", () => {
      const config = { extends: "manager", compaction: false };
      const resolved = resolveConfig(config, presets);
      expect(resolved.compaction).toBe(false);
    });

    it("child array with operators merges with parent", () => {
      const config = {
        extends: "manager",
        briefing: ["+cost_summary", "-escalations"],
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.briefing).toContain("soul");
      expect(resolved.briefing).toContain("cost_summary");
      expect(resolved.briefing).not.toContain("escalations");
    });

    it("child plain array replaces parent", () => {
      const config = {
        extends: "manager",
        briefing: ["soul", "assigned_task"],
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.briefing).toEqual(["soul", "assigned_task"]);
    });

    it("deep merges objects", () => {
      const config = {
        extends: "manager",
        coordination: { schedule: "0 9 * * MON" },
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.coordination).toEqual({
        enabled: true,            // from parent
        schedule: "0 9 * * MON",  // overridden by child
      });
    });

    it("throws on cycle", () => {
      const cyclicPresets = {
        a: { extends: "b" },
        b: { extends: "a" },
      };
      expect(() => resolveConfig({ extends: "a" }, cyclicPresets)).toThrow(
        /circular/i,
      );
    });

    it("throws on unknown preset", () => {
      expect(() => resolveConfig({ extends: "nonexistent" }, {})).toThrow(
        /not found/i,
      );
    });

    it("returns config as-is when no extends", () => {
      const config = { title: "Solo Agent", compaction: true };
      const resolved = resolveConfig(config, {});
      expect(resolved).toEqual(config);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presets.test.ts`
Expected: FAIL — module `../src/presets.js` not found

**Step 3: Implement the preset resolution engine**

```typescript
/**
 * Clawforce — Config Inheritance / Preset Resolution
 *
 * Walks `extends` chains, deep-merges configs, supports +/- array operators.
 */

/**
 * Check whether an array uses merge operators (every item starts with + or -).
 */
function hasMergeOperators(arr: string[]): boolean {
  return arr.length > 0 && arr.every((item) => item.startsWith("+") || item.startsWith("-"));
}

/**
 * Merge a child array into a parent array using +/- operators.
 * - Plain array (no operators) = full replace
 * - "+item" = append to parent
 * - "-item" = remove from parent
 */
export function mergeArrayWithOperators(
  parent: string[] | undefined,
  child: string[],
): string[] {
  if (!hasMergeOperators(child)) return child;

  const result = [...(parent ?? [])];
  for (const item of child) {
    if (item.startsWith("+")) {
      const value = item.slice(1);
      if (!result.includes(value)) result.push(value);
    } else if (item.startsWith("-")) {
      const value = item.slice(1);
      const idx = result.indexOf(value);
      if (idx !== -1) result.splice(idx, 1);
    }
  }
  return result;
}

/**
 * Deep merge two plain objects. Child values override parent.
 * Arrays use merge operators if present, otherwise replace.
 */
function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parent };
  for (const key of Object.keys(child)) {
    const pVal = parent[key];
    const cVal = child[key];

    if (Array.isArray(cVal)) {
      result[key] = mergeArrayWithOperators(
        Array.isArray(pVal) ? (pVal as string[]) : undefined,
        cVal as string[],
      );
    } else if (
      cVal !== null &&
      typeof cVal === "object" &&
      !Array.isArray(cVal) &&
      pVal !== null &&
      typeof pVal === "object" &&
      !Array.isArray(pVal)
    ) {
      result[key] = deepMerge(
        pVal as Record<string, unknown>,
        cVal as Record<string, unknown>,
      );
    } else {
      result[key] = cVal;
    }
  }
  return result;
}

type PresetLookup = (name: string) => Record<string, unknown> | undefined;

/**
 * Detect circular extends chains.
 * Returns the cycle path as a string if found, null otherwise.
 */
export function detectCycle(
  startName: string,
  lookup: PresetLookup,
): string | null {
  const visited: string[] = [];
  let current: string | undefined = startName;
  while (current) {
    if (visited.includes(current)) {
      return [...visited, current].join(" → ");
    }
    visited.push(current);
    const preset = lookup(current);
    current = preset?.extends as string | undefined;
  }
  return null;
}

/**
 * Resolve a config through its extends chain.
 * Walks from the root preset to the leaf config, merging at each level.
 */
export function resolveConfig<T extends Record<string, unknown>>(
  config: T & { extends?: string },
  presets: Record<string, Record<string, unknown>>,
): T {
  if (!config.extends) {
    return { ...config };
  }

  const lookup: PresetLookup = (name) => presets[name];

  // Detect cycles
  const cycle = detectCycle(config.extends, lookup);
  if (cycle) {
    throw new Error(`Circular extends chain detected: ${cycle}`);
  }

  // Build chain from root to leaf
  const chain: Record<string, unknown>[] = [];
  let current: string | undefined = config.extends;
  while (current) {
    const preset = presets[current];
    if (!preset) {
      throw new Error(`Preset "${current}" not found`);
    }
    chain.unshift(preset);
    current = preset.extends as string | undefined;
  }

  // Merge chain: root → ... → parent → child config
  let resolved: Record<string, unknown> = {};
  for (const layer of chain) {
    const { extends: _, ...rest } = layer;
    resolved = deepMerge(resolved, rest);
  }

  // Apply child config (remove extends key)
  const { extends: __, ...childRest } = config;
  resolved = deepMerge(resolved, childRest);

  return resolved as T;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presets.test.ts`
Expected: All 12 tests PASS

**Step 5: Commit**

```bash
git add src/presets.ts test/presets.test.ts
git commit -m "feat: preset resolution engine — extends chains, merge operators, cycle detection"
```

---

### Task 2: Builtin Agent & Job Presets

**Files:**
- Modify: `src/presets.ts`
- Modify: `test/presets.test.ts`

**Context:** Define the two builtin agent presets (`manager`, `employee`) and two builtin job presets (`reflect`, `triage`). These are the config bundles that replace the old BUILTIN_PROFILES. Export them so other modules can reference them.

**Step 1: Write the failing tests**

Add to `test/presets.test.ts`:

```typescript
import {
  BUILTIN_AGENT_PRESETS,
  BUILTIN_JOB_PRESETS,
} from "../src/presets.js";

describe("builtin agent presets", () => {
  it("manager preset has coordination enabled", () => {
    const mgr = BUILTIN_AGENT_PRESETS.manager;
    expect(mgr.coordination).toEqual({ enabled: true, schedule: "*/30 * * * *" });
    expect(mgr.compaction).toBe(true);
  });

  it("manager preset has full operational briefing", () => {
    const mgr = BUILTIN_AGENT_PRESETS.manager;
    expect(mgr.briefing).toContain("soul");
    expect(mgr.briefing).toContain("task_board");
    expect(mgr.briefing).toContain("escalations");
    expect(mgr.briefing).toContain("cost_summary");
    expect(mgr.briefing).toContain("resources");
  });

  it("employee preset has task-focused briefing", () => {
    const emp = BUILTIN_AGENT_PRESETS.employee;
    expect(emp.briefing).toContain("soul");
    expect(emp.briefing).toContain("assigned_task");
    expect(emp.briefing).not.toContain("task_board");
    expect(emp.coordination?.enabled).toBe(false);
    expect(emp.compaction).toBe(false);
  });

  it("employee preset has retry performance policy", () => {
    const emp = BUILTIN_AGENT_PRESETS.employee;
    expect(emp.performance_policy.action).toBe("retry");
    expect(emp.performance_policy.max_retries).toBe(3);
  });

  it("only manager and employee presets exist", () => {
    expect(Object.keys(BUILTIN_AGENT_PRESETS)).toEqual(["manager", "employee"]);
  });
});

describe("builtin job presets", () => {
  it("reflect preset has weekly cron and strategic briefing", () => {
    const reflect = BUILTIN_JOB_PRESETS.reflect;
    expect(reflect.cron).toBe("0 9 * * MON");
    expect(reflect.briefing).toContain("team_performance");
    expect(reflect.briefing).toContain("cost_summary");
    expect(reflect.nudge).toContain("Review");
  });

  it("triage preset has frequent cron and operational briefing", () => {
    const triage = BUILTIN_JOB_PRESETS.triage;
    expect(triage.cron).toBe("*/30 * * * *");
    expect(triage.briefing).toContain("task_board");
    expect(triage.briefing).toContain("escalations");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presets.test.ts`
Expected: FAIL — exports not found

**Step 3: Add builtin presets to `src/presets.ts`**

Add to the bottom of `src/presets.ts`:

```typescript
/* ── Builtin Agent Presets ── */

export const BUILTIN_AGENT_PRESETS: Record<string, Record<string, unknown>> = {
  manager: {
    title: "Manager",
    persona: "You are a manager agent responsible for coordinating your team, delegating tasks, and reviewing results.",
    briefing: [
      "soul", "tools_reference", "project_md", "task_board", "goal_hierarchy",
      "escalations", "team_status", "trust_scores", "cost_summary", "resources",
      "pending_messages", "channel_messages", "memory", "skill",
      "policy_status", "initiative_progress", "preferences",
    ],
    expectations: [
      { tool: "clawforce_log", action: "write", min_calls: 1 },
      { tool: "clawforce_compact", action: "update_doc", min_calls: 1 },
    ],
    performance_policy: { action: "alert" },
    compaction: true,
    coordination: { enabled: true, schedule: "*/30 * * * *" },
  },
  employee: {
    title: "Employee",
    persona: "You are an employee agent responsible for executing assigned tasks and reporting results.",
    briefing: [
      "soul", "tools_reference", "assigned_task", "pending_messages",
      "channel_messages", "memory", "skill",
    ],
    expectations: [
      { tool: "clawforce_task", action: "transition", min_calls: 1 },
      { tool: "clawforce_log", action: "write", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 3, then: "alert" },
    compaction: false,
    coordination: { enabled: false },
  },
};

/* ── Builtin Job Presets ── */

export const BUILTIN_JOB_PRESETS: Record<string, Record<string, unknown>> = {
  reflect: {
    cron: "0 9 * * MON",
    briefing: ["team_performance", "cost_summary", "velocity", "trust_scores"],
    nudge: "Review team performance. Consider: budget rebalancing, agent hiring/splitting, skill gaps, initiative reprioritization.",
    performance_policy: { action: "alert" },
  },
  triage: {
    cron: "*/30 * * * *",
    briefing: ["task_board", "escalations", "pending_messages"],
    nudge: "Check on your team. Reassign stuck tasks, handle escalations.",
    performance_policy: { action: "alert" },
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presets.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/presets.ts test/presets.test.ts
git commit -m "feat: builtin agent presets (manager, employee) and job presets (reflect, triage)"
```

---

### Task 3: Type System Migration

**Files:**
- Modify: `src/types.ts:195,250-293`
- Create: `test/types-extends.test.ts`

**Context:** Delete the `AgentRole` type. Replace `role: AgentRole` with `extends?: string` in `AgentConfig`. Add `coordination` field. Add `PresetConfig` and `ResolvedAgentConfig` types. This will cause type errors across the codebase — subsequent tasks fix them.

**Step 1: Write a test that validates the new type shape**

```typescript
import { describe, it, expect } from "vitest";
import type { AgentConfig } from "../src/types.js";

describe("AgentConfig type migration", () => {
  it("accepts extends field instead of role", () => {
    const config: AgentConfig = {
      extends: "manager",
      title: "Test Manager",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: false,
    };
    expect(config.extends).toBe("manager");
    // @ts-expect-error — role field should not exist
    expect(config.role).toBeUndefined();
  });

  it("extends is optional for fully inline config", () => {
    const config: AgentConfig = {
      title: "Inline Agent",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: false,
    };
    expect(config.extends).toBeUndefined();
  });

  it("supports coordination field", () => {
    const config: AgentConfig = {
      extends: "manager",
      title: "Coordinator",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: true,
      coordination: { enabled: true, schedule: "*/30 * * * *" },
    };
    expect(config.coordination?.enabled).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/types-extends.test.ts`
Expected: FAIL — type errors

**Step 3: Update `src/types.ts`**

Changes:
1. Delete `export type AgentRole = "manager" | "employee" | "scheduled" | "assistant";` (line 195)
2. In `AgentConfig` interface (line 251): replace `role: AgentRole;` with `extends?: string;`
3. Add coordination type:
```typescript
export type CoordinationConfig = {
  enabled: boolean;
  schedule?: string;
};
```
4. Add `coordination?: CoordinationConfig;` to `AgentConfig`
5. Add `extends?: string;` to `JobDefinition` type (for job preset inheritance)

**Important:** Do NOT fix type errors in other files in this task. Those are fixed in subsequent tasks. The goal is to update the type definitions only.

**Step 4: Run the type test**

Run: `npx vitest run test/types-extends.test.ts`
Expected: PASS (this test specifically)

**Step 5: Commit**

```bash
git add src/types.ts test/types-extends.test.ts
git commit -m "feat: replace AgentRole enum with extends field and coordination config"
```

**Note:** After this commit, `npx vitest run` will show type errors in many files. This is expected — subsequent tasks fix them one module at a time.

---

### Task 4: Profile System Refactor

**Files:**
- Modify: `src/profiles.ts:28-331`
- Modify: `test/profiles.test.ts`

**Context:** The current `BUILTIN_PROFILES` is keyed by `AgentRole`. `applyProfile()` and `generateDefaultScopePolicies()` use `config.role`. Rewrite these to use the preset resolution engine from Task 1. Delete `ROLE_DEFAULTS` and role-keyed `DEFAULT_ACTION_SCOPES`. Replace with a function that derives defaults from resolved config.

**Step 1: Update profile tests**

Rewrite `test/profiles.test.ts` to test the new API. Key tests:
- `applyProfile` with `extends: "manager"` produces correct defaults
- `applyProfile` with `extends: "employee"` produces correct defaults
- `applyProfile` with user preset chain resolves correctly
- `generateDefaultScopePolicies` works with extends-based configs
- Custom preset with `extends: "employee"` + overrides merges correctly

Replace all `role: "manager"` etc. with `extends: "manager"` in test fixtures.

**Step 2: Rewrite `src/profiles.ts`**

Key changes:
1. Delete `BUILTIN_PROFILES` (lines 28-113) — replaced by `BUILTIN_AGENT_PRESETS` in presets.ts
2. Delete `ROLE_DEFAULTS` (lines 122-139) — title/persona now live in the builtin presets
3. Refactor `DEFAULT_ACTION_SCOPES` (lines 158-213) — derive from coordination/compaction config instead of role enum
4. Rewrite `applyProfile()` (lines 285-331):
   - Call `resolveConfig(agentConfig, { ...BUILTIN_AGENT_PRESETS, ...userPresets })`
   - Return the resolved config with defaults filled in
5. Rewrite `generateDefaultScopePolicies()` (lines 245-276):
   - Instead of `agentConfig.role` lookup, check `resolvedConfig.coordination?.enabled` for manager-like scope, otherwise employee-like scope

**Step 3: Run tests**

Run: `npx vitest run test/profiles.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/profiles.ts test/profiles.test.ts
git commit -m "refactor: profiles use preset resolution instead of role enum"
```

---

### Task 5: Config Loading Refactor (project.ts)

**Files:**
- Modify: `src/project.ts:299-429`
- Modify: `test/project/project.test.ts`

**Context:** `normalizeAgentConfig()` currently validates the `role` field, looks up `ROLE_ALIASES`, falls back to `"employee"`. Rewrite to handle `extends` field. Config validator should error if `role:` is present (migration enforcement).

**Step 1: Update project tests**

Replace all `role: "manager"` with `extends: "manager"` in test fixtures. Add test:
- Config with `role:` field emits error diagnostic
- Config with `extends: "manager"` normalizes correctly
- Config with `extends: "my-custom-preset"` resolves against user presets
- Config without `extends` defaults to `extends: "employee"`

**Step 2: Rewrite config normalization in `src/project.ts`**

Key changes (lines 299-429):
1. Delete `ROLE_ALIASES` (line 299-303)
2. Delete `VALID_ROLES` (line 305)
3. Replace role normalization (lines 317-329) with:
   - If `raw.role` exists → emit error diagnostic: `"role" is deprecated. Use "extends: ${raw.role}" instead.`
   - If `raw.extends` exists → use it
   - If neither → default to `extends: "employee"`
4. Replace `BUILTIN_PROFILES[role].compaction` (line 382) with resolved config lookup
5. Add user presets support: `normalizeAgentConfig` takes `userPresets` parameter
6. Support `presets:` block in project config — parse and pass to resolution

**Step 3: Run tests**

Run: `npx vitest run test/project/project.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/project.ts test/project/project.test.ts
git commit -m "refactor: config loading uses extends instead of role, errors on deprecated role field"
```

---

### Task 6: Context Assembler Refactor

**Files:**
- Modify: `src/context/assembler.ts:162,236-246,563,723-744`
- Modify: `test/context/orchestrator.test.ts`

**Context:** The assembler has 4 places that check `config.role`. Replace each with config-driven logic.

**Step 1: Update context tests**

Replace all `role:` in test fixtures with `extends:`. Add specific tests:
- Manager-like agent (coordination enabled) sees full task board
- Employee-like agent sees scoped task board
- Agent with custom briefing gets correct sources regardless of extends

**Step 2: Replace role checks in assembler**

| Line | Current | Replacement |
|------|---------|-------------|
| 162 | `resolveSkillSource(ctx.config.role, ...)` | `resolveSkillSource(ctx.config.extends ?? "employee", ...)` or pass resolved config |
| 236-246 | `if (ctx.config.role === "manager")` | `if (ctx.config.coordination?.enabled)` |
| 563 | `ROLE_DEFAULTS[config.role]?.title` | `config.title` (already resolved from preset) |
| 723-744 | `const isManager = ctx.config.role === "manager"` | `const isManager = ctx.config.coordination?.enabled === true` |

**Step 3: Run tests**

Run: `npx vitest run test/context/orchestrator.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/context/assembler.ts test/context/orchestrator.test.ts
git commit -m "refactor: context assembler uses config fields instead of role checks"
```

---

### Task 7: Config Validator Refactor

**Files:**
- Modify: `src/config-validator.ts:303-320,358,402,450,457,568`
- Modify: `test/config/enforcement-config.test.ts`

**Context:** The validator checks role in 6 places. Replace with config-driven checks.

**Step 1: Update validator tests**

Replace all `role:` in test fixtures with `extends:`. Update assertions that reference role.

**Step 2: Replace role checks in validator**

| Lines | Current | Replacement |
|-------|---------|-------------|
| 303-320 | Filter by `c.role === "manager"` for approval policy | Filter by `c.coordination?.enabled` |
| 358 | `config.role !== "assistant"` for expectations warning | `config.expectations.length === 0` is valid if explicitly set (no warning) |
| 402 | `config.role === "scheduled"` for log outcome check | Remove — scheduled role no longer exists. Job-level expectations handle this. |
| 450 | `CRITICAL_SOURCES[config.role]` | Define critical sources based on config shape: coordination enabled → needs task_board; has assigned_task in briefing → needs assigned_task |
| 568 | `config.role !== "assistant"` for compact output check | `config.compaction === true` implies compact tool needed |

**Step 3: Run tests**

Run: `npx vitest run test/config/enforcement-config.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/config-validator.ts test/config/enforcement-config.test.ts
git commit -m "refactor: config validator uses config shape instead of role enum"
```

---

### Task 8: Jobs, Manager Cron, and Adapter

**Files:**
- Modify: `src/jobs.ts:78-87`
- Modify: `src/manager-cron.ts`
- Modify: `adapters/openclaw.ts:461`
- Modify: `test/jobs/resolve.test.ts`
- Modify: `test/adapters/openclaw.test.ts`

**Context:** Three smaller files that reference roles. Fix them all in one task.

**Step 1: Update tests**

- `test/jobs/resolve.test.ts`: Replace `role:` with `extends:` in fixtures. Update `canManageJobs` test to check coordination config instead of role.
- `test/adapters/openclaw.test.ts`: Replace `role:` with `extends:` in fixtures.

**Step 2: Fix `src/jobs.ts` — canManageJobs**

Line 83: Replace `if (callerEntry.config.role !== "manager") return false;` with:
```typescript
if (!callerEntry.config.coordination?.enabled) return false;
```

**Step 3: Fix `src/manager-cron.ts`**

Update any remaining role references to use coordination config. The cron registration should check `config.coordination?.enabled` to decide whether to register manager nudge crons.

**Step 4: Fix `adapters/openclaw.ts`**

Line 461: Replace `const isCron = config.role === "scheduled";` with a check based on whether the session is a job execution (check for job tag in payload, not role). For example:
```typescript
const isCron = !!resolveJobName(payload);
```

**Step 5: Run tests**

Run: `npx vitest run test/jobs/resolve.test.ts test/adapters/openclaw.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/jobs.ts src/manager-cron.ts adapters/openclaw.ts test/jobs/resolve.test.ts test/adapters/openclaw.test.ts
git commit -m "refactor: jobs, cron, and adapter use config checks instead of role enum"
```

---

### Task 9: Skills, Tools, and Documentation

**Files:**
- Modify: `src/skills/topics/roles.ts:1-93`
- Modify: `src/tools/setup-tool.ts:103-106,130-135,272-275,337-349`
- Modify: `test/tools/setup-tool.test.ts`
- Modify: `test/skills/registry.test.ts`

**Context:** The roles skill topic generates documentation from the role enum. Setup tool displays and validates roles. Update both.

**Step 1: Rewrite `src/skills/topics/roles.ts`**

Replace the role enum iteration with preset-based documentation:
- Import `BUILTIN_AGENT_PRESETS` and `BUILTIN_JOB_PRESETS` from presets.ts
- Generate documentation showing each preset's defaults
- Rename from "roles" to "presets" conceptually in the output
- Show how `extends:` works, with merge operator examples

**Step 2: Update `src/tools/setup-tool.ts`**

- `explain` action (lines 103-106): Use `config.extends` instead of `config.role` for skill source lookup
- `status` action (lines 130-135): Show `extends` instead of `role` in agent listing
- `validate` action (lines 272-275): Show `extends` in preview
- `activate` action (lines 337-349): Pass resolved configs to scope policy generation

**Step 3: Update tests**

Replace all `role:` in test fixtures with `extends:`. Update assertions that check role display.

**Step 4: Run tests**

Run: `npx vitest run test/tools/setup-tool.test.ts test/skills/registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/skills/topics/roles.ts src/tools/setup-tool.ts test/tools/setup-tool.test.ts test/skills/registry.test.ts
git commit -m "refactor: skill topics and tools use preset system instead of role enum"
```

---

### Task 10: Remaining Test Migration & Full Verification

**Files:**
- Modify: ~30 test files that reference `role:` in fixtures

**Context:** Many test files create mock `AgentConfig` objects with `role: "manager"` etc. Update all of them to use `extends:`. This is mechanical — find/replace `role:` with `extends:` in test fixtures, then fix any type errors.

**Step 1: Find all remaining test files with role references**

```bash
grep -rl 'role:.*"manager"\|role:.*"employee"\|role:.*"scheduled"\|role:.*"assistant"' test/
```

**Step 2: Update each file**

For each file:
1. Replace `role: "manager"` → `extends: "manager"` in all mock configs
2. Replace `role: "employee"` → `extends: "employee"` in all mock configs
3. Replace `role: "scheduled"` → `extends: "employee"` (scheduled is gone)
4. Replace `role: "assistant"` → `extends: "employee"` with appropriate overrides
5. Fix any assertions that check `.role` — change to `.extends`

Known files to update (from research):
- `test/adapters/openclaw.test.ts` (if not already done in Task 8)
- `test/enforcement/check.test.ts`
- `test/enforcement/compliance-success.test.ts`
- `test/enforcement/actions.test.ts`
- `test/enforcement/tracker.test.ts`
- `test/enforcement/session-persistence.test.ts`
- `test/config/safety-config.test.ts`
- `test/config/channels-config.test.ts`
- `test/config/event-handlers-config.test.ts`
- `test/config/tool-gates-config.test.ts`
- `test/profiles/assistant-profile.test.ts`
- `test/scope/scope.test.ts`
- `test/assignment/engine.test.ts`
- `test/dispatch/concurrency.test.ts`
- `test/agent-sync.test.ts`
- `test/review/review-config.test.ts`
- `test/review/review-escalation.test.ts`
- `test/events/auto-dispatch.test.ts`
- `test/context/pending-messages.test.ts`
- `test/context/protocol-messages.test.ts`
- `test/context/file-glob.test.ts`
- `test/dashboard/routes.test.ts`
- `test/dashboard/queries.test.ts`
- `test/memory/ghost-turn.test.ts`
- `test/tools/ops-job-management.test.ts`
- `test/skills/skill-packs.test.ts`

**Step 3: Update `src/index.ts` exports**

- Remove `AgentRole` type export
- Add exports: `resolveConfig`, `mergeArrayWithOperators`, `BUILTIN_AGENT_PRESETS`, `BUILTIN_JOB_PRESETS` from presets.ts
- Add `CoordinationConfig` type export

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass (1834+ tests across 150+ files)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: complete migration from role enum to extends-based config inheritance"
```
