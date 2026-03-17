# Vocabulary Generalization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize Clawforce's corporate vocabulary (manager/employee, department/team) into abstract orchestration primitives (coordinator/worker, group/subgroup) with user-definable presets, unlocking non-corporate use cases (games, research swarms, simulations).

**Architecture:** Four layers, each independently shippable. Layer 1 adds config aliases so both vocabularies work. Layer 2 makes the UI display preset names instead of hardcoded strings. Layer 3 makes presets user-definable with capability-based checks. Layer 4 adds multi-group support. Each layer builds on the previous but ships independently.

**Tech Stack:** TypeScript, SQLite (migrations), React (dashboard components), Vitest

---

## Chunk 1: Config Aliases & Normalization

Accept `group`/`subgroup`/`role` alongside `department`/`team`/`extends` in config. Existing configs don't break. New vocabulary works immediately.

### Task 1: Add alias types and normalization function

**Files:**
- Modify: `src/types.ts`
- Create: `src/config/aliases.ts`
- Test: `test/config/aliases.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/config/aliases.test.ts
import { describe, it, expect } from "vitest";
import { normalizeAgentConfig } from "../src/config/aliases.js";

describe("config aliases", () => {
  it("maps group → department", () => {
    const config = { group: "neighborhood", subgroup: "household", role: "coordinator" };
    const result = normalizeAgentConfig(config);
    expect(result.department).toBe("neighborhood");
    expect(result.team).toBe("household");
    expect(result.extends).toBe("coordinator");
  });

  it("preserves canonical names when no aliases used", () => {
    const config = { department: "engineering", team: "backend", extends: "manager" };
    const result = normalizeAgentConfig(config);
    expect(result.department).toBe("engineering");
    expect(result.team).toBe("backend");
    expect(result.extends).toBe("manager");
  });

  it("canonical names take precedence over aliases", () => {
    const config = { department: "eng", group: "neighborhood" };
    const result = normalizeAgentConfig(config);
    expect(result.department).toBe("eng");
  });

  it("handles missing fields gracefully", () => {
    const config = {};
    const result = normalizeAgentConfig(config);
    expect(result.department).toBeUndefined();
    expect(result.extends).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/aliases.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the normalization module**

```typescript
// src/config/aliases.ts

/** Alias mappings: new name → canonical name */
const FIELD_ALIASES: Record<string, string> = {
  group: "department",
  subgroup: "team",
  role: "extends",
};

/**
 * Normalize agent config by resolving aliases to canonical field names.
 * Canonical names take precedence if both are set.
 */
export function normalizeAgentConfig<T extends Record<string, unknown>>(config: T): T {
  const result = { ...config };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (alias in result && !(canonical in result)) {
      (result as Record<string, unknown>)[canonical] = result[alias];
    }
    delete (result as Record<string, unknown>)[alias];
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/aliases.test.ts`
Expected: PASS

- [ ] **Step 5: Add alias fields to AgentConfig type**

In `src/types.ts`, add optional alias fields to `AgentConfig`:

```typescript
// Add alongside existing fields:
group?: string;     // Alias for department
subgroup?: string;  // Alias for team
role?: string;      // Alias for extends
```

- [ ] **Step 6: Commit**

```bash
git add src/config/aliases.ts src/types.ts test/config/aliases.test.ts
git commit -m "feat: add config alias normalization (group→department, subgroup→team, role→extends)"
```

### Task 2: Wire normalization into config loading

**Files:**
- Modify: `src/project.ts` (where agent configs are loaded/resolved)
- Modify: `src/config/loader.ts` (if config parsing happens here)

- [ ] **Step 1: Find where agent configs are parsed**

Read `src/project.ts` and `src/config/loader.ts` to find where raw YAML config objects become `AgentConfig`. This is where `normalizeAgentConfig` needs to be called.

- [ ] **Step 2: Add normalization call at the config loading boundary**

Import `normalizeAgentConfig` and call it on each agent config object right after it's parsed from YAML, before it enters the rest of the system. This ensures aliases are resolved once at the boundary.

- [ ] **Step 3: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass — normalization is additive, no existing behavior changes

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: wire alias normalization into config loading pipeline"
```

### Task 3: Return alias fields in API responses

**Files:**
- Modify: `src/dashboard/queries.ts` (agent list, detail, org, config responses)
- Modify: `dashboard/src/api/types.ts` (add alias fields to frontend types)

- [ ] **Step 1: Add alias fields to frontend types**

In `dashboard/src/api/types.ts`, add optional `group`, `subgroup`, `role` fields to `Agent`, `AgentDetail`, `OrgAgent`, and `AgentConfig` types. These are read-only convenience aliases.

- [ ] **Step 2: Include alias fields in query responses**

In `src/dashboard/queries.ts`, wherever `department` and `team` are returned, also include `group: agent.department` and `subgroup: agent.team` as aliases.

- [ ] **Step 3: Run tests and build dashboard**

Run: `npx tsc --noEmit && npx vitest run && cd dashboard && npm run build`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: return group/subgroup/role aliases in API responses"
```

---

## Chunk 2: UI Generalization

Replace hardcoded "Manager"/"Employee" display strings with the actual preset/extends value. The org chart and roster should show whatever the config says, not assume corporate roles.

### Task 4: Generalize agent badges and display strings

**Files:**
- Modify: `dashboard/src/components/AgentNode.tsx` (~line 42, 93)
- Modify: `dashboard/src/components/AgentRoster.tsx` (~line 81, 86)
- Modify: `dashboard/src/hooks/useComms.ts` (~line 71, 75)

- [ ] **Step 1: Replace hardcoded badge text in AgentNode**

Change from:
```tsx
{isManager ? "Manager" : "Employee"}
```
To:
```tsx
{agent.extends ? agent.extends.charAt(0).toUpperCase() + agent.extends.slice(1) : "Agent"}
```

This shows "Manager", "Employee", "Coordinator", "Observer", or whatever the preset is — capitalized.

- [ ] **Step 2: Replace abbreviated badge in AgentRoster**

Change from:
```tsx
agent.extends === "manager" ? "MGR" : "EMP"
```
To:
```tsx
(agent.extends ?? "agent").slice(0, 3).toUpperCase()
```

Shows "MAN", "EMP", "COO", "WOR", etc. — first 3 chars of the preset.

- [ ] **Step 3: Generalize message role in useComms**

Change from checking `extends === "manager"` to derive role from the extends value. If `extends` contains "manager" or the agent has `coordination.enabled`, use "coordinator" role; otherwise use the extends value or "agent".

- [ ] **Step 4: Update MessageRole type**

In `dashboard/src/api/types.ts`, change:
```typescript
export type MessageRole = "manager" | "employee" | "user";
```
To:
```typescript
export type MessageRole = string; // Preset name or "user"
```

- [ ] **Step 5: Build dashboard and verify**

Run: `cd dashboard && npm run build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: UI shows actual preset names instead of hardcoded Manager/Employee"
```

---

## Chunk 3: User-Definable Presets with Capability-Based Checks

This is the core unlock. Instead of checking `extends === "manager"`, code checks capabilities. Users can define custom presets in their domain config.

### Task 5: Define capability system and refactor preset definitions

**Files:**
- Modify: `src/presets.ts`
- Modify: `src/types.ts`
- Test: `test/presets.test.ts` (update existing)

- [ ] **Step 1: Add capabilities to preset type**

In `src/types.ts`, add:
```typescript
export type AgentCapability =
  | "coordinate"      // Run coordination cron, manage team
  | "create_tasks"    // Create and assign tasks to others
  | "execute_tasks"   // Work on assigned tasks
  | "run_meetings"    // Start and facilitate meetings
  | "review_work"     // Review and approve other agents' work
  | "monitor"         // Observe without acting
  | "report_status"   // Report on own progress
  | "escalate";       // Escalate issues up the hierarchy

export interface PresetDefinition {
  title?: string;
  capabilities: AgentCapability[];
  coordination?: { enabled: boolean; schedule?: string };
  briefing?: ContextSource[];
  expectations?: Expectation[];
  performance_policy?: Record<string, unknown>;
  action_scopes?: Record<string, string | string[]>;
}
```

- [ ] **Step 2: Refactor BUILTIN_AGENT_PRESETS to use capabilities**

In `src/presets.ts`, add a `capabilities` array to each existing preset:

```typescript
manager: {
  capabilities: ["coordinate", "create_tasks", "run_meetings", "review_work", "escalate"],
  // ... existing fields unchanged
}
employee: {
  capabilities: ["execute_tasks", "report_status"],
  // ... existing fields unchanged
}
assistant: {
  capabilities: ["monitor", "report_status"],
  // ... existing fields unchanged
}
```

- [ ] **Step 3: Add capability resolver function**

```typescript
// src/presets.ts
export function getAgentCapabilities(agentConfig: AgentConfig): AgentCapability[] {
  const preset = BUILTIN_AGENT_PRESETS[agentConfig.extends ?? "employee"];
  const builtinCaps = preset?.capabilities ?? ["execute_tasks", "report_status"];
  const userCaps = agentConfig.capabilities ?? [];
  // User-defined capabilities extend (not replace) preset capabilities
  return [...new Set([...builtinCaps, ...userCaps])];
}

export function hasCapability(agentConfig: AgentConfig, cap: AgentCapability): boolean {
  return getAgentCapabilities(agentConfig).includes(cap);
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass (additive change, nothing uses capabilities yet)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add capability system to presets (coordinate, create_tasks, execute_tasks, etc.)"
```

### Task 6: Replace extends === "manager" checks with capability checks

**Files to modify (all runtime checks from the audit):**
- `src/config/init.ts` (~line 203)
- `src/config-validator.ts` (~lines 472, 554, 557)
- `src/agent-sync.ts` (~line 75)
- `src/assignment/engine.ts` (~line 113)
- `src/events/actions.ts` (~line 212)
- `src/profiles/operational.ts` (~line 173)
- `src/tools/task-tool.ts` (~line 230)
- `src/tools/setup-tool.ts` (~line 105)
- `src/tools/context-tool.ts` (~line 53)
- `src/context/assembler.ts` (~lines 215, 222)
- `src/scope.ts` (~line 70)

- [ ] **Step 1: Replace each check, file by file**

For each file, replace the pattern. Examples:

```typescript
// BEFORE (src/config/init.ts:203)
Object.keys(agents).find(id => agents[id]?.extends === "manager")

// AFTER
Object.keys(agents).find(id => hasCapability(agents[id], "coordinate"))
```

```typescript
// BEFORE (src/assignment/engine.ts:113)
entry.config.extends === "manager" || entry.config.coordination?.enabled

// AFTER
hasCapability(entry.config, "coordinate")
```

```typescript
// BEFORE (src/tools/task-tool.ts:230)
callerEntry.config.extends !== "manager"

// AFTER
!hasCapability(callerEntry.config, "create_tasks")
```

```typescript
// BEFORE (src/profiles/operational.ts:173)
const isManager = agentDef.extends === "manager"

// AFTER
const isCoordinator = hasCapability(agentDef, "coordinate")
```

The pattern is: identify what CAPABILITY the check is actually testing for, and use `hasCapability()` instead of string comparison.

- [ ] **Step 2: Update action scopes to use capabilities**

In `src/profiles.ts`, change `DEFAULT_ACTION_SCOPES` keys from `"manager"/"employee"` to be resolved by capability. Agents with `"coordinate"` capability get the full scope; others get the restricted scope.

- [ ] **Step 3: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass — `hasCapability` resolves through the existing preset system, so `extends: "manager"` still grants coordinate capability.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: replace extends==='manager' checks with capability-based hasCapability()"
```

### Task 7: Support user-defined presets in domain config

**Files:**
- Modify: `src/presets.ts` (merge user presets with builtins)
- Modify: `src/types.ts` (add presets to domain config type)
- Test: `test/presets.test.ts`

- [ ] **Step 1: Write test for user-defined preset**

```typescript
it("resolves user-defined preset from domain config", () => {
  const userPresets = {
    observer: {
      capabilities: ["monitor", "report_status"],
      coordination: { enabled: false },
      briefing: [{ source: "team_status" }],
    }
  };
  const agentConfig = { extends: "observer" };
  const caps = getAgentCapabilities(agentConfig, userPresets);
  expect(caps).toContain("monitor");
  expect(caps).not.toContain("coordinate");
});
```

- [ ] **Step 2: Update getAgentCapabilities to accept user presets**

```typescript
export function getAgentCapabilities(
  agentConfig: AgentConfig,
  userPresets?: Record<string, PresetDefinition>,
): AgentCapability[] {
  const presetName = agentConfig.extends ?? "employee";
  const preset = userPresets?.[presetName] ?? BUILTIN_AGENT_PRESETS[presetName];
  const builtinCaps = preset?.capabilities ?? ["execute_tasks", "report_status"];
  const userCaps = agentConfig.capabilities ?? [];
  return [...new Set([...builtinCaps, ...userCaps])];
}
```

- [ ] **Step 3: Add presets section to domain config type**

In `src/types.ts`, add to the domain/workforce config type:
```typescript
presets?: Record<string, PresetDefinition>;
```

- [ ] **Step 4: Wire user presets through the system**

Update callers of `hasCapability` and `getAgentCapabilities` to pass the domain's user presets. This typically means reading from the extended project config.

- [ ] **Step 5: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: support user-defined presets in domain config with custom capabilities"
```

---

## Chunk 4: Multi-Group Support & Rename Manager Cron

### Task 8: Rename manager cron to coordinator cron

**Files:**
- Modify: `src/manager-cron.ts` (rename types, functions, comments)
- Modify: `src/agent-sync.ts` (update import/call names)
- Modify: `src/config/init.ts` (update references)

- [ ] **Step 1: Rename in manager-cron.ts**

- `ManagerCronJob` → `CoordinatorCronJob`
- `registerManagerCron` → `registerCoordinatorCron`
- `buildManagerCronJob` → `buildCoordinatorCronJob`
- Job name: `manager-${projectId}` → `coordinator-${projectId}`
- Update comments and JSDoc

- [ ] **Step 2: Update all callers**

Update imports and function calls in `src/agent-sync.ts`, `src/config/init.ts`, and any other files that reference the old names.

- [ ] **Step 3: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: rename manager cron to coordinator cron"
```

### Task 9: Add multi-group support

**Files:**
- Modify: `src/types.ts` (add `groups?: string[]`)
- Modify: `src/config/aliases.ts` (normalize groups)
- Modify: `src/org.ts` (support array-based group lookup)
- Test: `test/config/aliases.test.ts`

- [ ] **Step 1: Write test for multi-group normalization**

```typescript
it("normalizes groups array alongside department", () => {
  const config = { groups: ["neighborhood", "book-club"], department: "neighborhood" };
  const result = normalizeAgentConfig(config);
  expect(result.department).toBe("neighborhood"); // primary group
  expect(result.groups).toEqual(["neighborhood", "book-club"]);
});

it("creates groups array from department if not set", () => {
  const config = { department: "engineering" };
  const result = normalizeAgentConfig(config);
  expect(result.groups).toEqual(["engineering"]);
});
```

- [ ] **Step 2: Add groups field to AgentConfig**

In `src/types.ts`:
```typescript
groups?: string[];  // All groups this agent belongs to (department is primary)
```

- [ ] **Step 3: Update normalization to handle groups**

In `src/config/aliases.ts`, add logic: if `groups` is set, use first as `department` (primary group) unless `department` is explicitly set. If only `department` is set, create `groups: [department]`.

- [ ] **Step 4: Update org queries to check groups array**

In `src/org.ts`, update `getDepartmentAgents()` to also match agents where `groups` contains the target group.

- [ ] **Step 5: Run full test suite and build**

Run: `npx tsc --noEmit && npx vitest run && cd dashboard && npm run build`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: add multi-group support (agents can belong to multiple groups)"
```

---

## Final Verification

- [ ] **Step 1: Run full test suite**

```bash
cd ~/workplace/openclaw-agentops && npx tsc --noEmit && npx vitest run
```

- [ ] **Step 2: Build dashboard**

```bash
cd ~/workplace/openclaw-agentops/dashboard && npm run build
```

- [ ] **Step 3: Restart gateway and verify**

```bash
openclaw gateway restart
```

Verify: existing `content-agency` domain still works with `extends: "manager"` config. All endpoints return correct data. Dashboard renders correctly.

- [ ] **Step 4: Test with alias vocabulary**

Create a test config using the new vocabulary (`group`, `subgroup`, `role: "coordinator"`) and verify it works identically to the canonical names.
