# Memory Governance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add structured memory governance to Clawforce: role-based memory instructions, memory compliance expectations, and a daily memory review job that extracts learnings from session transcripts.

**Architecture:** Three layers — (1) `memory_instructions` briefing source with role-specific defaults, (2) `memory_search` expectation on manager preset with config-driven stripping, (3) `memory_review` built-in job preset with a `memory_review_context` source that assembles session transcripts. All wired through existing preset/profile/assembler infrastructure.

**Tech Stack:** TypeScript, Vitest, node:fs, node:path

**Design spec:** `docs/plans/2026-03-14-memory-governance-design.md`

---

### Task 1: Types + Config Parsing

Add `MemoryGovernanceConfig` type and parse the `memory` field in `normalizeAgentConfig`.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/project.ts`
- Test: `test/memory/governance-config.test.ts`

**Step 1: Write the failing test**

```typescript
// test/memory/governance-config.test.ts
import { describe, expect, it, vi } from "vitest";

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

describe("MemoryGovernanceConfig parsing", () => {
  it("parses memory.instructions = true", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    // We test normalizeAgentConfig indirectly via loadWorkforceConfig
    // But normalizeAgentConfig is not exported — test the type shape instead
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: true,
    };
    expect(config.instructions).toBe(true);
  });

  it("parses memory.instructions = custom string", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: "Custom instructions here",
    };
    expect(config.instructions).toBe("Custom instructions here");
  });

  it("parses memory.instructions = false", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: false,
    };
    expect(config.instructions).toBe(false);
  });

  it("parses memory.expectations = false", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      expectations: false,
    };
    expect(config.expectations).toBe(false);
  });

  it("parses full memory.review config", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: true,
      expectations: true,
      review: {
        enabled: true,
        cron: "0 18 * * *",
        model: "anthropic/claude-sonnet-4-6",
        aggressiveness: "medium",
        scope: "reports",
      },
    };
    expect(config.review?.enabled).toBe(true);
    expect(config.review?.aggressiveness).toBe("medium");
    expect(config.review?.scope).toBe("reports");
  });

  it("normalizeAgentConfig passes memory field through to AgentConfig", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            instructions: true,
            expectations: true,
            review: {
              enabled: true,
              cron: "0 18 * * *",
              aggressiveness: "high",
              scope: "reports",
            },
          },
        },
      },
    });

    // Write temp file, load, check
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.lead;
      expect(agent).toBeDefined();
      expect(agent.memory).toBeDefined();
      expect(agent.memory?.instructions).toBe(true);
      expect(agent.memory?.expectations).toBe(true);
      expect(agent.memory?.review?.enabled).toBe(true);
      expect(agent.memory?.review?.aggressiveness).toBe("high");
      expect(agent.memory?.review?.scope).toBe("reports");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("normalizeAgentConfig defaults memory to undefined when not specified", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        worker: {
          extends: "employee",
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.worker;
      expect(agent.memory).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: FAIL — `MemoryGovernanceConfig` type not found, `memory` field not on `AgentConfig`

**Step 3: Add MemoryGovernanceConfig type to src/types.ts**

Add after the `KnowledgeConfig` type (around line 1015):

```typescript
// --- Memory Governance types ---

export type MemoryGovernanceConfig = {
  instructions?: boolean | string;  // true = role default, string = custom, false = disable
  expectations?: boolean;           // true = role default expectations, false = none
  review?: {
    enabled?: boolean;
    cron?: string;
    model?: string;
    aggressiveness?: "low" | "medium" | "high";
    scope?: "self" | "reports" | "all";
  };
};
```

Add `memory?: MemoryGovernanceConfig;` field to the `AgentConfig` type (after `skillCap?: number;` at line 309):

```typescript
  /** Memory governance configuration. */
  memory?: MemoryGovernanceConfig;
```

**Step 4: Add memory config parsing to normalizeAgentConfig in src/project.ts**

Add `MemoryGovernanceConfig` to the import statement from `./types.js`.

Add a `normalizeMemoryConfig` function after `normalizeCompactionConfig` (around line 601):

```typescript
function normalizeMemoryConfig(raw: unknown): MemoryGovernanceConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const result: MemoryGovernanceConfig = {};

  if (r.instructions !== undefined) {
    if (typeof r.instructions === "boolean") {
      result.instructions = r.instructions;
    } else if (typeof r.instructions === "string" && r.instructions.trim()) {
      result.instructions = r.instructions.trim();
    }
  }

  if (typeof r.expectations === "boolean") {
    result.expectations = r.expectations;
  }

  if (typeof r.review === "object" && r.review !== null) {
    const rv = r.review as Record<string, unknown>;
    const review: NonNullable<MemoryGovernanceConfig["review"]> = {};
    if (typeof rv.enabled === "boolean") review.enabled = rv.enabled;
    if (typeof rv.cron === "string" && rv.cron.trim()) review.cron = rv.cron.trim();
    if (typeof rv.model === "string" && rv.model.trim()) review.model = rv.model.trim();
    if (typeof rv.aggressiveness === "string" && ["low", "medium", "high"].includes(rv.aggressiveness)) {
      review.aggressiveness = rv.aggressiveness as "low" | "medium" | "high";
    }
    if (typeof rv.scope === "string" && ["self", "reports", "all"].includes(rv.scope)) {
      review.scope = rv.scope as "self" | "reports" | "all";
    }
    if (Object.keys(review).length > 0) result.review = review;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
```

In `normalizeAgentConfig`, after the `scheduling` block (around line 472), add:

```typescript
  const memory = normalizeMemoryConfig(raw.memory);
```

In the return statement of `normalizeAgentConfig` (around line 493), add `memory` to the returned object:

```typescript
    scheduling,
    skillCap,
    memory,
  };
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: PASS

**Step 6: Run existing tests to verify no regressions**

Run: `npx vitest run test/profiles.test.ts test/context/assembler.test.ts test/orchestrator-config.test.ts`
Expected: PASS

---

### Task 2: Memory Instructions Source

Create the `memory_instructions` briefing source with role-based defaults. Register it in the assembler and stream catalog. Replace `"memory"` with `"memory_instructions"` in preset briefing arrays.

**Files:**
- Create: `src/context/sources/memory-instructions.ts`
- Modify: `src/context/assembler.ts`
- Modify: `src/presets.ts`
- Modify: `src/types.ts` (ContextSource union)
- Modify: `src/project.ts` (VALID_SOURCES)
- Modify: `src/config-validator.ts` (VALID_SOURCES)
- Modify: `src/streams/builtin-manifest.ts`
- Test: `test/context/memory-instructions.test.ts`

**Step 1: Write the failing test**

```typescript
// test/context/memory-instructions.test.ts
import { describe, expect, it, vi } from "vitest";

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

describe("memory-instructions source", () => {
  it("returns manager default when instructions=true and extends=manager", async () => {
    const { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: true }, "manager");
    expect(result).toBe(MANAGER_MEMORY_INSTRUCTIONS);
    expect(result).toContain("Search memory at the START");
  });

  it("returns employee default when instructions=true and extends=employee", async () => {
    const { resolveMemoryInstructions, EMPLOYEE_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: true }, "employee");
    expect(result).toBe(EMPLOYEE_MEMORY_INSTRUCTIONS);
    expect(result).toContain("Your knowledge comes through skills");
  });

  it("returns custom string when instructions is a string", async () => {
    const { resolveMemoryInstructions } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: "My custom memory rules" }, "manager");
    expect(result).toBe("## Memory Protocol\n\nMy custom memory rules");
  });

  it("returns null when instructions=false", async () => {
    const { resolveMemoryInstructions } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: false }, "manager");
    expect(result).toBeNull();
  });

  it("returns role default when memory config is undefined (backwards compat)", async () => {
    const { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions(undefined, "manager");
    expect(result).toBe(MANAGER_MEMORY_INSTRUCTIONS);
  });

  it("uses employee default for assistant preset", async () => {
    const { resolveMemoryInstructions, EMPLOYEE_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions(undefined, "assistant");
    expect(result).toBe(EMPLOYEE_MEMORY_INSTRUCTIONS);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/memory-instructions.test.ts`
Expected: FAIL — module not found

**Step 3: Create the memory-instructions source**

```typescript
// src/context/sources/memory-instructions.ts
/**
 * Clawforce — Memory Instructions Source
 *
 * Role-based memory protocol instructions.
 * Tells agents how to use OpenClaw's memory tools correctly.
 */

import type { MemoryGovernanceConfig } from "../../types.js";

export const MANAGER_MEMORY_INSTRUCTIONS = `## Memory Protocol

- Search memory at the START of every coordination cycle for relevant strategic context
- Before making decisions, check if similar situations have been handled before
- Write strategic decisions, rationale, and observations to memory using memory tools
- IMPORTANT: Save memories to the persistent RAG store using the appropriate memory write tools. Do NOT write to memory.md — that file gets truncated on compaction. The persistent memory store is accessed via memory tools.
- Your memory review job will extract learnings from your reports' sessions — review promotion candidates in your briefing`;

export const EMPLOYEE_MEMORY_INSTRUCTIONS = `## Memory Protocol

- Your knowledge comes through skills and curated context — check your skill documentation first
- If you discover something reusable during your task, write it to memory using memory tools (NOT memory.md)
- memory.md gets truncated on compaction. Use the memory tools for persistent storage.
- Your learnings will be automatically extracted and reviewed by your manager`;

const MANAGER_PRESETS = new Set(["manager"]);

/**
 * Resolve memory instructions content for an agent.
 *
 * @param memoryConfig — the agent's memory governance config (may be undefined)
 * @param extendsFrom — the preset the agent extends ("manager", "employee", "assistant", etc.)
 * @returns markdown string to inject, or null if disabled
 */
export function resolveMemoryInstructions(
  memoryConfig: MemoryGovernanceConfig | undefined,
  extendsFrom: string,
): string | null {
  const instructions = memoryConfig?.instructions;

  // Explicitly disabled
  if (instructions === false) return null;

  // Custom string
  if (typeof instructions === "string") {
    return `## Memory Protocol\n\n${instructions}`;
  }

  // true or undefined → use role default
  if (MANAGER_PRESETS.has(extendsFrom)) {
    return MANAGER_MEMORY_INSTRUCTIONS;
  }
  return EMPLOYEE_MEMORY_INSTRUCTIONS;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/context/memory-instructions.test.ts`
Expected: PASS

**Step 5: Register the new source types**

Add `"memory_instructions"` and `"memory_review_context"` to the `ContextSource["source"]` union in `src/types.ts` (line 202). Find the existing `"memory"` entry and add both after it:

```
| "memory" | "memory_instructions" | "memory_review_context"
```

Add both to `VALID_SOURCES` in `src/project.ts` (around line 346). After `"memory"` in the array:

```
"memory", "memory_instructions", "memory_review_context",
```

Add both to `VALID_SOURCES` in `src/config-validator.ts` (around line 562). After `"memory"` in the array:

```
"memory", "memory_instructions", "memory_review_context",
```

**Step 6: Add source case to assembler**

In `src/context/assembler.ts`, add import at the top:

```typescript
import { resolveMemoryInstructions } from "./sources/memory-instructions.js";
```

Add a new case in `resolveSource` switch (after the existing `"memory"` case at line 170):

```typescript
    case "memory_instructions":
      return resolveMemoryInstructions(ctx.config.memory, ctx.config.extends ?? "employee");
```

**Step 7: Replace "memory" with "memory_instructions" in presets**

In `src/presets.ts`, in the `manager` preset briefing array (line 132), replace `"memory"` with `"memory_instructions"`:

```typescript
      "pending_messages", "channel_messages", "memory_instructions", "skill",
```

In the `employee` preset briefing array (line 151), replace `"memory"` with `"memory_instructions"`:

```typescript
      "soul", "tools_reference", "assigned_task", "pending_messages",
      "channel_messages", "memory_instructions", "skill",
```

In the `assistant` preset briefing array (line 167), replace `"memory"` with `"memory_instructions"`:

```typescript
      "soul", "tools_reference", "pending_messages", "channel_messages",
      "memory_instructions", "skill", "preferences",
```

**Step 8: Register in stream catalog**

In `src/streams/builtin-manifest.ts`, add after the existing `"memory"` registration (line 24):

```typescript
  registerStream({ name: "memory_instructions", description: "Role-based memory protocol instructions (replaces memory)", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "memory_review_context", description: "Session transcripts and context for memory review job", builtIn: true, outputTargets: ["briefing"] });
```

**Step 9: Run full test suite for regressions**

Run: `npx vitest run test/context/assembler.test.ts test/profiles.test.ts test/context/memory-instructions.test.ts`
Expected: PASS. If assembler tests reference `"memory"` in preset arrays, they may need updating to `"memory_instructions"`.

---

### Task 3: Memory Expectations

Add `memory_search` expectation to the manager preset. Implement config-driven stripping in `normalizeAgentConfig` when `memory.expectations === false`.

**Files:**
- Modify: `src/presets.ts`
- Modify: `src/project.ts`
- Test: `test/memory/governance-config.test.ts` (extend)

**Step 1: Write the failing test**

Add to `test/memory/governance-config.test.ts`:

```typescript
describe("memory expectations stripping", () => {
  it("manager preset includes memory_search expectation by default", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const managerExpectations = BUILTIN_AGENT_PRESETS.manager.expectations as Array<{ tool: string }>;
    expect(managerExpectations.some((e) => e.tool === "memory_search")).toBe(true);
  });

  it("memory_search expectation is stripped when memory.expectations=false", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            expectations: false,
          },
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.lead;
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      expect(hasMemoryExpectation).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("memory_search expectation is preserved when memory.expectations=true", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            expectations: true,
          },
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.lead;
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      expect(hasMemoryExpectation).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("employee preset does NOT include memory_search expectation", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const employeeExpectations = BUILTIN_AGENT_PRESETS.employee.expectations as Array<{ tool: string }>;
    expect(employeeExpectations.some((e) => e.tool === "memory_search")).toBe(false);
  });

  it("employee does not gain memory_search expectation when memory.expectations=true", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        worker: {
          extends: "employee",
          memory: {
            expectations: true,
          },
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.worker;
      // Employee preset doesn't have memory_search, so expectations=true has no effect
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      expect(hasMemoryExpectation).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: FAIL — manager preset missing memory_search expectation

**Step 3: Add memory_search expectation to manager preset**

In `src/presets.ts`, add to the `manager` preset's `expectations` array (after line 138):

```typescript
    expectations: [
      { tool: "clawforce_log", action: "write", min_calls: 1 },
      { tool: "clawforce_compact", action: "update_doc", min_calls: 1 },
      { tool: "memory_search", action: "search", min_calls: 1 },
    ],
```

**Step 4: Add memory expectation stripping to normalizeAgentConfig**

In `src/project.ts`, in `normalizeAgentConfig`, after the compaction expectation stripping block (around line 445), add:

```typescript
  // When memory.expectations is explicitly false, strip the memory_search
  // expectation that may have been inherited from the manager profile
  // (unless user explicitly set expectations)
  if (memory?.expectations === false && !hasExplicitExpectations) {
    merged.expectations = merged.expectations.filter(
      (r) => r.tool !== "memory_search",
    );
  }
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: PASS

**Step 6: Run broader test suite for regressions**

Run: `npx vitest run test/profiles.test.ts test/context/assembler.test.ts test/orchestrator-config.test.ts`
Expected: PASS — may need to update tests that assert exact expectation counts for manager preset

---

### Task 4: Memory Review Job Preset

Add the `memory_review` built-in job preset and the `memory_review_context` source resolver.

**Files:**
- Modify: `src/presets.ts`
- Create: `src/memory/review-context.ts`
- Modify: `src/context/assembler.ts`
- Test: `test/memory/review-context.test.ts`

**Step 1: Write the failing test**

```typescript
// test/memory/review-context.test.ts
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

describe("memory_review job preset", () => {
  it("exists in BUILTIN_JOB_PRESETS", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    expect(BUILTIN_JOB_PRESETS.memory_review).toBeDefined();
    expect(BUILTIN_JOB_PRESETS.memory_review.cron).toBe("0 18 * * *");
    expect(BUILTIN_JOB_PRESETS.memory_review.nudge).toContain("session transcripts");
  });

  it("memory_review preset has memory_review_context in briefing", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_JOB_PRESETS.memory_review.briefing as string[];
    expect(briefing).toContain("memory_review_context");
  });

  it("memory_review preset has memory_search expectation", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    const expectations = BUILTIN_JOB_PRESETS.memory_review.expectations as Array<{ tool: string }>;
    expect(expectations.some((e) => e.tool === "memory_search")).toBe(true);
  });
});

describe("review-context source", () => {
  it("buildReviewContext returns summary when no transcripts exist", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("Memory Review");
      expect(result).toContain("No session transcripts found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext includes aggressiveness guidance", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));

    try {
      const resultLow = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "low",
        projectDir: tmpDir,
      });
      expect(resultLow).toContain("explicit decisions");

      const resultHigh = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "high",
        projectDir: tmpDir,
      });
      expect(resultHigh).toContain("Everything potentially useful");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext reads JSONL transcript files", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const sessionsDir = path.join(tmpDir, "agents", "lead", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a fake transcript JSONL file modified "today"
    const transcriptFile = path.join(sessionsDir, "session-001.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Fix the login bug" }),
      JSON.stringify({ role: "assistant", content: "I found the issue in auth.ts" }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("Fix the login bug");
      expect(result).toContain("auth.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext includes SOUL.md content when available", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const agentDir = path.join(tmpDir, "agents", "lead");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "SOUL.md"), "I am a careful engineer who values testing.");

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("careful engineer");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext truncates long transcripts", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const sessionsDir = path.join(tmpDir, "agents", "lead", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a large transcript
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ role: "user", content: `Message ${i}: ${"x".repeat(200)}` }));
    }
    fs.writeFileSync(path.join(sessionsDir, "session-big.jsonl"), lines.join("\n"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
        maxTranscriptChars: 5000,
      });
      // Should be truncated
      expect(result.length).toBeLessThan(10000);
      expect(result).toContain("truncated");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/review-context.test.ts`
Expected: FAIL — `memory_review` not in presets, `review-context.ts` not found

**Step 3: Add memory_review job preset**

In `src/presets.ts`, add to `BUILTIN_JOB_PRESETS` (after the `triage` entry, around line 194):

```typescript
  memory_review: {
    cron: "0 18 * * *",
    model: "anthropic/claude-sonnet-4-6",
    sessionTarget: "isolated",
    briefing: ["memory_review_context"],
    expectations: [
      { tool: "memory_search", action: "search", min_calls: 1 },
    ],
    nudge: "Review today's session transcripts. Extract key learnings, decisions, patterns, and reusable knowledge. Search existing memory to avoid duplicates. Write valuable findings to memory using memory tools.",
    performance_policy: { action: "alert" },
  },
```

**Step 4: Create review-context source**

```typescript
// src/memory/review-context.ts
/**
 * Clawforce — Memory Review Context Source
 *
 * Assembles session transcripts and agent identity context
 * for the memory review job. Reads JSONL transcript files
 * from the agent's session directory.
 */

import fs from "node:fs";
import path from "node:path";

export type ReviewContextOpts = {
  agentId: string;
  scope: "self" | "reports" | "all";
  aggressiveness: "low" | "medium" | "high";
  projectDir: string;
  /** Target agent IDs when scope is "reports" or "all". */
  targetAgentIds?: string[];
  /** Max total characters for transcript content. Default 50_000. */
  maxTranscriptChars?: number;
};

const AGGRESSIVENESS_GUIDANCE: Record<string, string> = {
  low: "Extract only explicit decisions, error resolutions, and task outcomes. Skip opinions, hunches, and partial insights.",
  medium: "Extract learnings, patterns, reusable context, observations, and notable decisions. Skip trivial chatter.",
  high: "Extract Everything potentially useful including hunches, partial insights, patterns, preferences, and context that might help in future sessions.",
};

/**
 * Build the full review context for the memory review job.
 */
export function buildReviewContext(opts: ReviewContextOpts): string {
  const maxChars = opts.maxTranscriptChars ?? 50_000;
  const sections: string[] = [];

  // Header
  sections.push("## Memory Review Session");
  sections.push("");
  sections.push(`**Scope:** ${opts.scope} | **Aggressiveness:** ${opts.aggressiveness}`);
  sections.push("");

  // Aggressiveness guidance
  sections.push("### Extraction Guidance");
  sections.push("");
  sections.push(AGGRESSIVENESS_GUIDANCE[opts.aggressiveness] ?? AGGRESSIVENESS_GUIDANCE.medium);
  sections.push("");

  // SOUL.md for identity context
  const soulContent = readSoulDoc(opts.agentId, opts.projectDir);
  if (soulContent) {
    sections.push("### Agent Identity");
    sections.push("");
    sections.push(soulContent);
    sections.push("");
  }

  // Resolve which agent IDs to review
  const agentIds = resolveTargetAgents(opts);

  // Session transcripts
  let totalTranscriptChars = 0;
  let hasAnyTranscripts = false;

  for (const agentId of agentIds) {
    const transcripts = readSessionTranscripts(agentId, opts.projectDir);
    if (transcripts.length === 0) continue;

    hasAnyTranscripts = true;

    for (const transcript of transcripts) {
      if (totalTranscriptChars >= maxChars) {
        sections.push("...(remaining transcripts truncated for context budget)");
        break;
      }

      const remaining = maxChars - totalTranscriptChars;
      let content = transcript.content;
      if (content.length > remaining) {
        content = content.slice(0, remaining) + "\n...(truncated)";
      }

      sections.push(`### Session: ${transcript.filename} (agent: ${agentId})`);
      sections.push("");
      sections.push(content);
      sections.push("");
      totalTranscriptChars += content.length;
    }

    if (totalTranscriptChars >= maxChars) break;
  }

  if (!hasAnyTranscripts) {
    sections.push("### Session Transcripts");
    sections.push("");
    sections.push("No session transcripts found for the review period.");
  }

  return sections.join("\n");
}

type TranscriptFile = {
  filename: string;
  content: string;
  modifiedAt: number;
};

/**
 * Resolve which agent IDs to include based on scope.
 */
function resolveTargetAgents(opts: ReviewContextOpts): string[] {
  switch (opts.scope) {
    case "self":
      return [opts.agentId];
    case "reports":
    case "all":
      return opts.targetAgentIds && opts.targetAgentIds.length > 0
        ? [opts.agentId, ...opts.targetAgentIds]
        : [opts.agentId];
    default:
      return [opts.agentId];
  }
}

/**
 * Read session transcript JSONL files from an agent's sessions directory.
 * Only includes files modified today (since midnight).
 */
function readSessionTranscripts(agentId: string, projectDir: string): TranscriptFile[] {
  const sessionsDir = path.join(projectDir, "agents", agentId, "sessions");

  try {
    if (!fs.existsSync(sessionsDir)) return [];
  } catch {
    return [];
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const results: TranscriptFile[] = [];

  try {
    const files = fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"));

    for (const filename of files) {
      const filePath = path.join(sessionsDir, filename);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < todayMs) continue; // Skip old files

        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) continue;

        const content = parseTranscriptJsonl(raw);
        if (content) {
          results.push({
            filename,
            content,
            modifiedAt: stat.mtimeMs,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Sessions dir unreadable
  }

  // Sort by most recent first (priority for context budget)
  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results;
}

/**
 * Parse a JSONL transcript file into readable text.
 */
function parseTranscriptJsonl(raw: string): string | null {
  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { role?: string; content?: string };
      if (parsed.role && parsed.content) {
        // Truncate individual messages to 500 chars
        const content = parsed.content.length > 500
          ? parsed.content.slice(0, 500) + "..."
          : parsed.content;
        messages.push(`**${parsed.role}**: ${content}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.length > 0 ? messages.join("\n") : null;
}

/**
 * Read SOUL.md for an agent.
 */
function readSoulDoc(agentId: string, projectDir: string): string | null {
  const soulPath = path.join(projectDir, "agents", agentId, "SOUL.md");
  try {
    if (!fs.existsSync(soulPath)) return null;
    const content = fs.readFileSync(soulPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
```

**Step 5: Wire the source into the assembler**

In `src/context/assembler.ts`, add import:

```typescript
import { buildReviewContext } from "../memory/review-context.js";
```

Add a new case in `resolveSource` switch (after the `memory_instructions` case):

```typescript
    case "memory_review_context": {
      if (!ctx.projectDir) return null;
      const memoryConfig = ctx.config.memory;
      return buildReviewContext({
        agentId: ctx.agentId,
        scope: memoryConfig?.review?.scope ?? "self",
        aggressiveness: memoryConfig?.review?.aggressiveness ?? "medium",
        projectDir: ctx.projectDir,
      });
    }
```

**Step 6: Run tests**

Run: `npx vitest run test/memory/review-context.test.ts`
Expected: PASS

---

### Task 5: Config Validation

Add validation for the `memory` governance config fields.

**Files:**
- Modify: `src/config-validator.ts`
- Test: `test/memory/governance-config.test.ts` (extend)

**Step 1: Write the failing test**

Add to `test/memory/governance-config.test.ts`:

```typescript
describe("memory config validation", () => {
  it("warns when memory.review.cron format is unrecognized", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [{ source: "soul" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          memory: {
            review: {
              enabled: true,
              cron: "badcron",
              aggressiveness: "invalid_level",
            },
          },
        } as any,
      },
    };

    const warnings = validateWorkforceConfig(config);
    const memoryWarnings = warnings.filter((w) => w.message.includes("memory"));
    expect(memoryWarnings.length).toBeGreaterThan(0);
  });

  it("accepts valid memory governance config without warnings", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [{ source: "soul" }],
          expectations: [
            { tool: "clawforce_log", action: "write", min_calls: 1 },
            { tool: "memory_search", action: "search", min_calls: 1 },
          ],
          performance_policy: { action: "alert" },
          memory: {
            instructions: true,
            expectations: true,
            review: {
              enabled: true,
              cron: "0 18 * * *",
              aggressiveness: "medium",
              scope: "reports",
            },
          },
        } as any,
      },
    };

    const warnings = validateWorkforceConfig(config);
    const memoryErrors = warnings.filter((w) => w.level === "error" && w.message.includes("memory"));
    expect(memoryErrors).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: FAIL — no memory validation exists

**Step 3: Add memory config validation to config-validator.ts**

In `src/config-validator.ts`, in the `validateAgentConfig` function, add after the compaction validation block (around line 679):

```typescript
  // Validate memory governance config
  if (raw.memory !== undefined) {
    const mem = raw.memory as Record<string, unknown> | undefined;
    if (typeof mem === "object" && mem !== null) {
      if (mem.instructions !== undefined) {
        if (typeof mem.instructions !== "boolean" && typeof mem.instructions !== "string") {
          warnings.push({
            level: "error",
            agentId,
            message: "memory.instructions must be a boolean or string.",
          });
        }
      }

      if (mem.expectations !== undefined && typeof mem.expectations !== "boolean") {
        warnings.push({
          level: "error",
          agentId,
          message: "memory.expectations must be a boolean.",
        });
      }

      if (mem.review !== undefined && typeof mem.review === "object" && mem.review !== null) {
        const rv = mem.review as Record<string, unknown>;

        if (rv.aggressiveness !== undefined) {
          if (typeof rv.aggressiveness !== "string" || !["low", "medium", "high"].includes(rv.aggressiveness)) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.aggressiveness must be "low", "medium", or "high" — got "${rv.aggressiveness}".`,
            });
          }
        }

        if (rv.scope !== undefined) {
          if (typeof rv.scope !== "string" || !["self", "reports", "all"].includes(rv.scope)) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.scope must be "self", "reports", or "all" — got "${rv.scope}".`,
            });
          }
        }

        if (rv.cron !== undefined && typeof rv.cron === "string") {
          const isInterval = /^(\d+[smhd]|\d+|every:\d+)$/.test(rv.cron);
          const isCronExpr = rv.cron.trim().split(/\s+/).length >= 5 || rv.cron.startsWith("cron:");
          const isOneShot = rv.cron.startsWith("at:") || /^\d{4}-\d{2}-\d{2}T/.test(rv.cron);
          if (!isInterval && !isCronExpr && !isOneShot) {
            warnings.push({
              level: "warn",
              agentId,
              message: `memory.review.cron has unrecognized format "${rv.cron}" — will default to daily 6pm.`,
            });
          }
        }
      }
    }
  }
```

**Step 4: Run test**

Run: `npx vitest run test/memory/governance-config.test.ts`
Expected: PASS

---

### Task 6: Exports + Integration Tests

Export new types and modules from `src/index.ts`. Run full test suite.

**Files:**
- Modify: `src/index.ts`
- Test: `test/memory/governance-integration.test.ts`

**Step 1: Write the integration test**

```typescript
// test/memory/governance-integration.test.ts
import { describe, expect, it, vi } from "vitest";

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

describe("memory governance integration", () => {
  it("assembleContext resolves memory_instructions for a manager", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: true },
    };

    const result = assembleContext("lead", config);
    expect(result).toContain("Search memory at the START");
  });

  it("assembleContext resolves memory_instructions with custom text", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "employee",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: "Always search memory before writing code" },
    };

    const result = assembleContext("worker", config);
    expect(result).toContain("Always search memory before writing code");
  });

  it("assembleContext resolves memory_instructions as null when disabled", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: false },
    };

    const result = assembleContext("lead", config);
    // memory_instructions returns null, so section is skipped — result should be empty or not contain Memory Protocol
    expect(result).not.toContain("Memory Protocol");
  });

  it("full manager preset has memory_instructions in briefing (not memory)", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_AGENT_PRESETS.manager.briefing as string[];
    expect(briefing).toContain("memory_instructions");
    expect(briefing).not.toContain("memory");
  });

  it("full employee preset has memory_instructions in briefing (not memory)", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_AGENT_PRESETS.employee.briefing as string[];
    expect(briefing).toContain("memory_instructions");
    expect(briefing).not.toContain("memory");
  });

  it("MemoryGovernanceConfig type is exported from index", async () => {
    const index = await import("../../src/index.js");
    // Type-only exports won't appear at runtime, but BUILTIN_JOB_PRESETS should have memory_review
    expect(index.BUILTIN_JOB_PRESETS.memory_review).toBeDefined();
  });

  it("resolveMemoryInstructions is exported from index", async () => {
    const index = await import("../../src/index.js");
    expect(typeof index.resolveMemoryInstructions).toBe("function");
  });

  it("buildReviewContext is exported from index", async () => {
    const index = await import("../../src/index.js");
    expect(typeof index.buildReviewContext).toBe("function");
  });

  it("memory_review_context resolves in assembler without crashing", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_review_context" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: {
        review: {
          scope: "self",
          aggressiveness: "medium",
        },
      },
    };

    // Without projectDir, should return empty/null gracefully
    const result = assembleContext("lead", config);
    // Should not crash — may be empty since no projectDir
    expect(typeof result).toBe("string");
  });
});
```

**Step 2: Add exports to src/index.ts**

In the `// --- Memory (Ghost Turn + Flush) ---` section (around line 153), add:

```typescript
// --- Memory Governance ---
export { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS, EMPLOYEE_MEMORY_INSTRUCTIONS } from "./context/sources/memory-instructions.js";
export { buildReviewContext } from "./memory/review-context.js";
export type { ReviewContextOpts } from "./memory/review-context.js";
```

In the `// --- Types ---` section at the bottom, add `MemoryGovernanceConfig` to the type exports:

```typescript
  MemoryGovernanceConfig,
```

**Step 3: Run integration tests**

Run: `npx vitest run test/memory/governance-integration.test.ts`
Expected: PASS

**Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests should continue to pass. If any tests assert on exact preset briefing arrays (checking for `"memory"` instead of `"memory_instructions"`), update those tests.

---

## Summary of All File Changes

### Create
| File | Purpose |
|------|---------|
| `src/context/sources/memory-instructions.ts` | Role-based memory instruction source resolver |
| `src/memory/review-context.ts` | Session transcript assembly for memory review job |
| `test/memory/governance-config.test.ts` | Type, parsing, and expectation stripping tests |
| `test/context/memory-instructions.test.ts` | Memory instructions source unit tests |
| `test/memory/review-context.test.ts` | Review context source and job preset tests |
| `test/memory/governance-integration.test.ts` | End-to-end integration tests |

### Modify
| File | Changes |
|------|---------|
| `src/types.ts` | Add `MemoryGovernanceConfig` type, add `memory?` to `AgentConfig`, add `"memory_instructions"` and `"memory_review_context"` to `ContextSource` union |
| `src/presets.ts` | Replace `"memory"` with `"memory_instructions"` in all 3 preset briefing arrays, add `memory_search` expectation to manager, add `memory_review` job preset |
| `src/project.ts` | Add `"memory_instructions"` and `"memory_review_context"` to `VALID_SOURCES`, add `normalizeMemoryConfig()`, parse and return `memory` field, add memory expectation stripping |
| `src/config-validator.ts` | Add `"memory_instructions"` and `"memory_review_context"` to `VALID_SOURCES`, add memory config validation |
| `src/context/assembler.ts` | Import and wire `memory_instructions` and `memory_review_context` source cases |
| `src/streams/builtin-manifest.ts` | Register `memory_instructions` and `memory_review_context` streams |
| `src/index.ts` | Export `resolveMemoryInstructions`, `buildReviewContext`, `MemoryGovernanceConfig` type |
