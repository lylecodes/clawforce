# Phase 9 Completion — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete remaining Phase 9 UX Overhaul: role inference, interactive setup, budget guidance, data streams (catalog, params, custom SQL, routing), and human onboarding.

**Architecture:** New `src/config/inference.ts`, `src/config/init-flow.ts`, `src/config/budget-guide.ts` for config UX. New `src/streams/` module for data streams. New `src/context/sources/onboarding.ts` for human onboarding. All integrate with existing assembler, ops-tool, and profile systems.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), vitest, filtrex (condition eval), existing Clawforce infrastructure

**Reference:** Design spec at `docs/plans/2026-03-13-phase9-completion-design.md`

---

## Chunk 1: Minimal Config + Budget Guide + Interactive Setup

### Task 1: Role Inference (9.1)

**Files:**
- Modify: `src/config/schema.ts:12-19` (make `extends` optional)
- Create: `src/config/inference.ts`
- Modify: `src/config/init.ts:93-116` (wire inference into `buildWorkforceConfig`)
- Test: `test/config/inference.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/inference.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { inferPreset } from "../../src/config/inference.js";
import type { GlobalAgentDef } from "../../src/config/schema.js";

describe("inferPreset", () => {
  it("infers manager when other agents report to this one", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    expect(inferPreset("lead", agents)).toBe("manager");
  });

  it("infers employee when agent reports to someone", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    expect(inferPreset("worker", agents)).toBe("employee");
  });

  it("infers employee for standalone agent with no reports_to", () => {
    const agents: Record<string, GlobalAgentDef> = {
      solo: { title: "Solo Worker" },
    };
    expect(inferPreset("solo", agents)).toBe("employee");
  });

  it("infers manager for deeply nested reporting chain root", () => {
    const agents: Record<string, GlobalAgentDef> = {
      ceo: { title: "CEO" },
      vp: { title: "VP", reports_to: "ceo" },
      dev: { title: "Dev", reports_to: "vp" },
    };
    expect(inferPreset("ceo", agents)).toBe("manager");
    expect(inferPreset("vp", agents)).toBe("manager");
    expect(inferPreset("dev", agents)).toBe("employee");
  });

  it("does not infer for agents with explicit extends", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { extends: "employee", title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    // inferPreset should still return manager based on structure,
    // but the caller skips calling it when extends is set
    expect(inferPreset("lead", agents)).toBe("manager");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/inference.test.ts`
Expected: FAIL — module `../../src/config/inference.js` not found

- [ ] **Step 3: Make `extends` optional in GlobalAgentDef**

Modify `src/config/schema.ts:12-19`:

```typescript
export type GlobalAgentDef = {
  extends?: string;
  model?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  [key: string]: unknown;
};
```

- [ ] **Step 4: Create inference module**

Create `src/config/inference.ts`:

```typescript
/**
 * Clawforce — Role inference from org structure
 *
 * Scans the agent map to determine preset when none is specified.
 * If any other agent has reports_to pointing at this agent → manager.
 * If this agent has reports_to set → employee.
 * Default → employee.
 */

import type { GlobalAgentDef } from "./schema.js";

/** Track which agents had their preset inferred (not injected into config). */
const inferredAgents = new Map<string, boolean>();

export function inferPreset(
  agentId: string,
  allAgents: Record<string, GlobalAgentDef>,
): "manager" | "employee" {
  // Check if any other agent reports to this one
  for (const [otherId, otherDef] of Object.entries(allAgents)) {
    if (otherId === agentId) continue;
    if (otherDef.reports_to === agentId) {
      return "manager";
    }
  }

  return "employee";
}

export function markInferred(agentId: string): void {
  inferredAgents.set(agentId, true);
}

export function wasInferred(agentId: string): boolean {
  return inferredAgents.get(agentId) === true;
}

export function clearInferenceState(): void {
  inferredAgents.clear();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/config/inference.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 6: Wire inference into buildWorkforceConfig**

Modify `src/config/init.ts`. Add import at top:

```typescript
import { inferPreset, markInferred } from "./inference.js";
```

In `buildWorkforceConfig()`, add inference loop before the existing `for (const agentId of domain.agents)` loop (before line 99). Note: we only scan agents assigned to this domain, and we clone the def to avoid mutating the shared global object:

```typescript
  // Build domain-scoped agent map for inference
  const domainAgentDefs: Record<string, GlobalAgentDef> = {};
  for (const agentId of domain.agents) {
    const def = global.agents[agentId];
    if (def) domainAgentDefs[agentId] = def;
  }

  // Infer preset for agents without explicit extends (domain-scoped)
  for (const agentId of domain.agents) {
    const globalDef = global.agents[agentId];
    if (globalDef && !globalDef.extends) {
      // Clone to avoid mutating shared global config across domains
      global.agents[agentId] = { ...globalDef, extends: inferPreset(agentId, domainAgentDefs) };
      markInferred(agentId);
    }
  }
```

- [ ] **Step 7: Write integration test for inference in init**

Add to `test/config/init.test.ts`:

```typescript
  it("infers roles when extends is omitted", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  lead:",
        "    title: Engineering Lead",
        "  worker:",
        "    reports_to: lead",
        "    title: Developer",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      ["domain: testdomain", "agents:", "  - lead", "  - worker"].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.domains).toContain("testdomain");

    // getAgentConfig takes 1 arg (agentId), returns { projectId, config } | null
    const leadEntry = getAgentConfig("lead");
    const workerEntry = getAgentConfig("worker");
    expect(leadEntry?.config.extends).toBe("manager");
    expect(workerEntry?.config.extends).toBe("employee");
  });
```

- [ ] **Step 8: Run integration test**

Run: `npx vitest run test/config/init.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/config/schema.ts src/config/inference.ts src/config/init.ts test/config/inference.test.ts test/config/init.test.ts
git commit -m "feat(phase9): add role inference from org structure (9.1)"
```

---

### Task 2: Budget Guide — Init-Time (9.4 partial)

**Files:**
- Create: `src/config/budget-guide.ts`
- Test: `test/config/budget-guide.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/budget-guide.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { estimateBudget, MODEL_COSTS } from "../../src/config/budget-guide.js";

describe("estimateBudget", () => {
  it("estimates budget for a simple team", () => {
    const result = estimateBudget([
      { agentId: "lead", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "dev1", model: "anthropic/claude-sonnet-4-6", role: "employee" },
      { agentId: "dev2", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    expect(result.recommended).toBeGreaterThan(0);
    expect(result.low).toBeLessThan(result.recommended);
    expect(result.high).toBeGreaterThan(result.recommended);
    expect(result.breakdown).toHaveLength(3);
  });

  it("provides per-agent breakdown", () => {
    const result = estimateBudget([
      { agentId: "mgr", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "worker", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    const mgrBreakdown = result.breakdown.find((b) => b.agentId === "mgr")!;
    expect(mgrBreakdown.sessionsPerDay).toBe(6);
    expect(mgrBreakdown.model).toBe("anthropic/claude-opus-4-6");

    const workerBreakdown = result.breakdown.find((b) => b.agentId === "worker")!;
    expect(workerBreakdown.sessionsPerDay).toBe(4);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    const result = estimateBudget([
      { agentId: "x", model: "custom/unknown-model", role: "employee" },
    ]);

    const sonnetCost = MODEL_COSTS["anthropic/claude-sonnet-4-6"];
    const breakdown = result.breakdown[0];
    expect(breakdown.costPerSession).toBe(sonnetCost);
  });

  it("uses overridden model costs when provided", () => {
    const overrides = { "custom/cheap": 50 };
    const result = estimateBudget(
      [{ agentId: "x", model: "custom/cheap", role: "employee" }],
      overrides,
    );

    expect(result.breakdown[0].costPerSession).toBe(50);
  });

  it("formats budget summary text", async () => {
    const { formatBudgetSummary } = await import("../../src/config/budget-guide.js");
    const result = estimateBudget([
      { agentId: "lead", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "dev", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    const summary = formatBudgetSummary(result);
    expect(summary).toContain("Recommended");
    expect(summary).toContain("lead");
    expect(summary).toContain("dev");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/budget-guide.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create budget guide module**

Create `src/config/budget-guide.ts`:

```typescript
/**
 * Clawforce — Budget Guidance
 *
 * Estimates daily budget based on team composition and model costs.
 * Provides per-agent cost breakdowns for init wizard and runtime guidance.
 */

export type AgentBudgetInput = {
  agentId: string;
  model: string;
  role: "manager" | "employee";
};

export type AgentCostEstimate = {
  agentId: string;
  model: string;
  sessionsPerDay: number;
  costPerSession: number;
  dailyCost: number;
};

export type BudgetEstimate = {
  recommended: number;
  low: number;
  high: number;
  breakdown: AgentCostEstimate[];
};

/** Default cost per session in cents, keyed by model identifier. */
export const MODEL_COSTS: Record<string, number> = {
  "anthropic/claude-opus-4-6": 150,
  "anthropic/claude-sonnet-4-6": 30,
  "anthropic/claude-haiku-4-5": 8,
  "claude-opus-4-6": 150,
  "claude-sonnet-4-6": 30,
  "claude-haiku-4-5": 8,
};

const DEFAULT_SESSIONS: Record<string, number> = {
  manager: 6,
  employee: 4,
};

const FALLBACK_COST = MODEL_COSTS["anthropic/claude-sonnet-4-6"];

export function estimateBudget(
  agents: AgentBudgetInput[],
  modelCostOverrides?: Record<string, number>,
): BudgetEstimate {
  const breakdown: AgentCostEstimate[] = agents.map((agent) => {
    const costPerSession =
      modelCostOverrides?.[agent.model] ??
      MODEL_COSTS[agent.model] ??
      FALLBACK_COST;
    const sessionsPerDay = DEFAULT_SESSIONS[agent.role] ?? 4;
    const dailyCost = costPerSession * sessionsPerDay;

    return {
      agentId: agent.agentId,
      model: agent.model,
      sessionsPerDay,
      costPerSession,
      dailyCost,
    };
  });

  const recommended = breakdown.reduce((sum, b) => sum + b.dailyCost, 0);
  const low = Math.round(recommended * 0.6);
  const high = Math.round(recommended * 1.6);

  return { recommended, low, high, breakdown };
}

export function formatBudgetSummary(estimate: BudgetEstimate): string {
  const lines = [
    `Recommended: $${(estimate.recommended / 100).toFixed(2)}/day ($${(estimate.low / 100).toFixed(2)} low / $${(estimate.high / 100).toFixed(2)} comfortable)`,
    "",
    "Per-agent breakdown:",
  ];

  for (const b of estimate.breakdown) {
    const model = b.model.split("/").pop() ?? b.model;
    lines.push(
      `  ${b.agentId} (${model}, ~${b.sessionsPerDay} sessions): $${(b.dailyCost / 100).toFixed(2)}/day`,
    );
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/budget-guide.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/budget-guide.ts test/config/budget-guide.test.ts
git commit -m "feat(phase9): add budget estimation for init wizard (9.4)"
```

---

### Task 3: Interactive Setup (9.2)

**Files:**
- Create: `src/config/init-flow.ts`
- Modify: `src/tools/ops-tool.ts:50-59,61-122` (add init_questions, init_apply actions)
- Test: `test/config/init-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/init-flow.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getInitQuestions, buildConfigFromAnswers } from "../../src/config/init-flow.js";
import type { InitAnswers } from "../../src/config/init-flow.js";

describe("init flow", () => {
  describe("getInitQuestions", () => {
    it("returns a sequence of questions", () => {
      const questions = getInitQuestions();
      expect(questions.length).toBeGreaterThanOrEqual(4);
      expect(questions[0].id).toBe("domain_name");
      expect(questions.every((q) => q.id && q.prompt && q.type)).toBe(true);
    });
  });

  describe("buildConfigFromAnswers", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-initflow-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("builds config from minimal answers", () => {
      const answers: InitAnswers = {
        domain_name: "myproject",
        mission: "Build a SaaS dashboard",
        agents: [
          { name: "lead", title: "Engineering Lead" },
          { name: "dev", title: "Frontend Dev" },
        ],
        reporting: { dev: "lead" },
        budget_cents: 2000,
      };

      const result = buildConfigFromAnswers(answers);

      // Global config has both agents
      expect(Object.keys(result.global.agents!)).toEqual(["lead", "dev"]);
      expect(result.global.agents!.lead.title).toBe("Engineering Lead");
      expect(result.global.agents!.dev.reports_to).toBe("lead");

      // Domain opts matches InitDomainOpts shape
      expect(result.domain.name).toBe("myproject");
      expect(result.domain.agents).toEqual(["lead", "dev"]);
    });

    it("omits reporting structure when single agent", () => {
      const answers: InitAnswers = {
        domain_name: "solo",
        mission: "Do tasks",
        agents: [{ name: "worker", title: "Worker" }],
        reporting: {},
        budget_cents: 1000,
      };

      const result = buildConfigFromAnswers(answers);
      expect(Object.keys(result.global.agents!)).toEqual(["worker"]);
      expect(result.global.agents!.worker.reports_to).toBeUndefined();
    });

    it("includes model override when specified", () => {
      const answers: InitAnswers = {
        domain_name: "custom",
        mission: "Custom models",
        agents: [{ name: "agent", title: "Agent", model: "anthropic/claude-haiku-4-5" }],
        reporting: {},
        budget_cents: 500,
      };

      const result = buildConfigFromAnswers(answers);
      expect(result.global.agents!.agent.model).toBe("anthropic/claude-haiku-4-5");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/init-flow.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create init flow module**

Create `src/config/init-flow.ts`:

```typescript
/**
 * Clawforce — Interactive Init Flow
 *
 * Structured question sequence and config builder for agent-driven setup.
 * The agent asks questions, collects answers, then calls buildConfigFromAnswers()
 * to generate config objects that feed into the existing wizard API.
 */

import type { GlobalAgentDef, GlobalConfig } from "./schema.js";
import type { InitDomainOpts } from "./wizard.js";
import { estimateBudget, formatBudgetSummary } from "./budget-guide.js";

export type QuestionType = "text" | "choice" | "number" | "structured";

export type InitQuestion = {
  id: string;
  type: QuestionType;
  prompt: string;
  description?: string;
  default?: unknown;
  choices?: string[];
  skip?: (answers: Partial<InitAnswers>) => boolean;
};

export type AgentAnswer = {
  name: string;
  title: string;
  model?: string;
};

export type InitAnswers = {
  domain_name: string;
  mission: string;
  agents: AgentAnswer[];
  reporting: Record<string, string>;
  budget_cents: number;
  model_preference?: string;
};

export function getInitQuestions(): InitQuestion[] {
  return [
    {
      id: "domain_name",
      type: "text",
      prompt: "What should this domain be called?",
      description: "A short identifier like 'rentright' or 'sales-team'.",
      default: "my-project",
    },
    {
      id: "mission",
      type: "text",
      prompt: "What's the mission? One sentence.",
      description: "This becomes the project charter that guides all agents.",
    },
    {
      id: "agents",
      type: "structured",
      prompt: "Who's on the team? Give me names and titles.",
      description:
        "List each agent with a short ID and job title. Example: lead (Engineering Lead), frontend (Frontend Dev), backend (Backend Dev).",
    },
    {
      id: "reporting",
      type: "structured",
      prompt: "Who reports to whom?",
      description:
        "For each agent, specify their manager. Agents without a manager are standalone. Roles are auto-detected from this structure.",
      skip: (answers) => (answers.agents?.length ?? 0) <= 1,
    },
    {
      id: "budget_cents",
      type: "number",
      prompt: "Daily budget in dollars?",
      description:
        "How much to spend per day across all agents. We'll show a recommendation based on your team size.",
    },
    {
      id: "model_preference",
      type: "choice",
      prompt:
        "Use recommended models (Opus for managers, Sonnet for workers) or override?",
      choices: ["recommended", "override"],
      default: "recommended",
    },
  ];
}

export function getBudgetGuidance(answers: Partial<InitAnswers>): string | null {
  if (!answers.agents || answers.agents.length === 0) return null;

  const agentInputs = answers.agents.map((a) => {
    const isManager = Object.values(answers.reporting ?? {}).includes(a.name);
    return {
      agentId: a.name,
      model: a.model ?? (isManager ? "anthropic/claude-opus-4-6" : "anthropic/claude-sonnet-4-6"),
      role: isManager ? ("manager" as const) : ("employee" as const),
    };
  });

  const estimate = estimateBudget(agentInputs);
  return formatBudgetSummary(estimate);
}

export function buildConfigFromAnswers(answers: InitAnswers): {
  global: Partial<GlobalConfig>;
  domain: InitDomainOpts;
} {
  const agents: Record<string, GlobalAgentDef> = {};
  const agentNames: string[] = [];

  for (const agent of answers.agents) {
    const def: GlobalAgentDef = { title: agent.title };
    if (agent.model) def.model = agent.model;
    if (answers.reporting[agent.name]) {
      def.reports_to = answers.reporting[agent.name];
    }
    agents[agent.name] = def;
    agentNames.push(agent.name);
  }

  const global: Partial<GlobalConfig> = { agents };
  const domain: InitDomainOpts = {
    name: answers.domain_name,
    agents: agentNames,
  };

  return { global, domain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/init-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Add ops-tool actions for init_questions and init_apply**

Modify `src/tools/ops-tool.ts`.

Add `"init_questions"` and `"init_apply"` to the `OPS_ACTIONS` array (line 50-59):

```typescript
const OPS_ACTIONS = [
  "agent_status", "kill_agent", "disable_agent", "enable_agent",
  "reassign", "query_audit", "trigger_sweep", "dispatch_worker",
  "refresh_context", "emit_event", "list_events", "enqueue_work",
  "queue_status", "process_events", "dispatch_metrics",
  "list_jobs", "create_job", "update_job", "delete_job", "toggle_job_cron",
  "cron_status", "introspect", "allocate_budget",
  "plan_create", "plan_start", "plan_complete", "plan_abandon", "plan_list",
  "flag_knowledge", "approve_promotion", "dismiss_promotion", "resolve_flag", "dismiss_flag", "list_candidates", "list_flags",
  "init_questions", "init_apply",
] as const;
```

Add schema params after the knowledge lifecycle params (after line 121):

```typescript
  // init flow params
  init_answers: Type.Optional(Type.String({ description: "JSON object with init answers: domain_name, mission, agents, reporting, budget_cents (for init_apply)." })),
  config_dir: Type.Optional(Type.String({ description: "Config directory path (for init_apply, defaults to ~/.clawforce)." })),
```

Add import at top of file:

```typescript
import { getInitQuestions, buildConfigFromAnswers, getBudgetGuidance } from "../config/init-flow.js";
import { scaffoldConfigDir, initDomain } from "../config/wizard.js";
```

Add handler cases in the main action switch (find the pattern from existing handlers):

```typescript
    case "init_questions": {
      const questions = getInitQuestions();
      return jsonResult({ questions });
    }

    case "init_apply": {
      const answersJson = readStringParam(input, "init_answers");
      if (!answersJson) return jsonResult({ error: "init_answers is required" });

      let answers;
      try {
        answers = JSON.parse(answersJson);
      } catch {
        return jsonResult({ error: "init_answers must be valid JSON" });
      }

      const configDir = readStringParam(input, "config_dir") ??
        path.join(process.env.HOME ?? "/tmp", ".clawforce");

      const { global, domain } = buildConfigFromAnswers(answers);

      // Scaffold directory and write configs
      scaffoldConfigDir(configDir);

      // Write agents to global config
      if (global.agents) {
        const { loadGlobalConfig } = await import("../config/loader.js");
        const existing = loadGlobalConfig(configDir);
        Object.assign(existing.agents, global.agents);
        const YAML = await import("yaml");
        const configPath = path.join(configDir, "config.yaml");
        fs.writeFileSync(configPath, YAML.stringify(existing), "utf-8");
      }

      // Create domain
      initDomain(configDir, domain);

      // Get budget guidance
      const guidance = getBudgetGuidance(answers);

      return jsonResult({
        success: true,
        domain: domain.name,
        agents: domain.agents,
        config_dir: configDir,
        budget_guidance: guidance,
      });
    }
```

Add the missing imports at top:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
```

- [ ] **Step 6: Run all config tests to verify nothing is broken**

Run: `npx vitest run test/config/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config/init-flow.ts src/tools/ops-tool.ts test/config/init-flow.test.ts
git commit -m "feat(phase9): add interactive init flow and ops-tool actions (9.2)"
```

---

## Chunk 2: Stream Catalog + Parameterized Sources + Custom Streams

### Task 4: Stream Catalog (9.8.1)

**Files:**
- Create: `src/streams/catalog.ts`
- Create: `src/streams/builtin-manifest.ts`
- Test: `test/streams/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/streams/catalog.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";

describe("stream catalog", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("registers and retrieves a stream", async () => {
    const { registerStream, getStream } = await import("../../src/streams/catalog.js");
    registerStream({
      name: "test_stream",
      description: "A test stream",
      builtIn: true,
      outputTargets: ["briefing"],
    });

    const stream = getStream("test_stream");
    expect(stream).toBeDefined();
    expect(stream!.name).toBe("test_stream");
    expect(stream!.builtIn).toBe(true);
  });

  it("lists all registered streams", async () => {
    const { registerStream, listStreams } = await import("../../src/streams/catalog.js");
    registerStream({ name: "a", description: "A", builtIn: true, outputTargets: ["briefing"] });
    registerStream({ name: "b", description: "B", builtIn: false, outputTargets: ["webhook"] });

    const streams = listStreams();
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("returns undefined for unknown stream", async () => {
    const { getStream } = await import("../../src/streams/catalog.js");
    expect(getStream("nonexistent")).toBeUndefined();
  });

  it("registers stream with parameter schema", async () => {
    const { registerStream, getStream } = await import("../../src/streams/catalog.js");
    registerStream({
      name: "parameterized",
      description: "Has params",
      builtIn: true,
      outputTargets: ["briefing"],
      params: [
        { name: "horizon", type: "string", description: "Time horizon", default: "24h" },
        { name: "limit", type: "number", description: "Max results", required: true },
      ],
    });

    const stream = getStream("parameterized")!;
    expect(stream.params).toHaveLength(2);
    expect(stream.params![0].name).toBe("horizon");
  });

  it("prevents duplicate registration", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    registerStream({ name: "dup", description: "First", builtIn: true, outputTargets: [] });
    registerStream({ name: "dup", description: "Second", builtIn: true, outputTargets: [] });

    const { getStream } = await import("../../src/streams/catalog.js");
    // Second registration overwrites
    expect(getStream("dup")!.description).toBe("Second");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/streams/catalog.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the catalog module**

Create `src/streams/catalog.ts`:

```typescript
/**
 * Clawforce — Stream Catalog
 *
 * Registry for all data streams (built-in context sources and user-defined custom streams).
 * Provides discoverability via listStreams() and parameter schema for validation.
 */

export type OutputTarget = "briefing" | "telegram" | "webhook" | "log";

export type ParamSchema = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  default?: unknown;
  required?: boolean;
};

export type StreamDefinition = {
  name: string;
  description: string;
  params?: ParamSchema[];
  sampleOutput?: string;
  builtIn: boolean;
  outputTargets: OutputTarget[];
};

const catalog = new Map<string, StreamDefinition>();

export function registerStream(def: StreamDefinition): void {
  catalog.set(def.name, def);
}

export function getStream(name: string): StreamDefinition | undefined {
  return catalog.get(name);
}

export function listStreams(): StreamDefinition[] {
  return Array.from(catalog.values());
}

export function clearCatalog(): void {
  catalog.clear();
}

export function formatStreamCatalog(): string {
  const streams = listStreams();
  if (streams.length === 0) return "No streams registered.";

  const lines = [`## Available Streams (${streams.length})`, ""];
  for (const s of streams) {
    const tag = s.builtIn ? "built-in" : "custom";
    lines.push(`- **${s.name}** (${tag}): ${s.description}`);
    if (s.params && s.params.length > 0) {
      for (const p of s.params) {
        const req = p.required ? " (required)" : "";
        const def = p.default !== undefined ? ` [default: ${JSON.stringify(p.default)}]` : "";
        lines.push(`  - \`${p.name}\` (${p.type}${req}${def}): ${p.description}`);
      }
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/streams/catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Create the built-in manifest**

Create `src/streams/builtin-manifest.ts`:

```typescript
/**
 * Clawforce — Built-in Stream Manifest
 *
 * Registers all existing context sources in the stream catalog.
 * Resolution logic stays in the assembler; this provides metadata only.
 */

import { registerStream } from "./catalog.js";

export function registerBuiltinStreams(): void {
  registerStream({ name: "instructions", description: "Auto-generated instructions from agent expectations", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "custom", description: "Raw markdown content injected directly", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "project_md", description: "PROJECT.md charter file content", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "task_board", description: "Current task board with status, priority, and assignee", builtIn: true, outputTargets: ["briefing", "webhook"],
    params: [
      { name: "status", type: "string[]", description: "Filter by task status", default: undefined },
      { name: "limit", type: "number", description: "Max tasks to show", default: 50 },
    ],
  });
  registerStream({ name: "assigned_task", description: "The specific task assigned to this agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "knowledge", description: "Searchable knowledge base entries", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "file", description: "Raw file content from a path", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "skill", description: "Agent skill pack documentation", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "memory", description: "Memory search instructions for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "escalations", description: "Pending and recent escalation events", builtIn: true, outputTargets: ["briefing", "telegram"] });
  registerStream({ name: "workflows", description: "Active workflow phases and progress", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "activity", description: "Recent agent activity log", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "sweep_status", description: "Automated sweep findings and status", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "proposals", description: "Pending approval proposals", builtIn: true, outputTargets: ["briefing", "telegram"] });
  registerStream({ name: "agent_status", description: "Status of all agents in the team", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "cost_summary", description: "Cost tracking summary for the project", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "policy_status", description: "Compliance policy enforcement status", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "health_status", description: "System health indicators", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "team_status", description: "Team member availability and workload", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "team_performance", description: "Performance metrics per team member", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "soul", description: "Agent SOUL.md identity document", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "tools_reference", description: "Available tools documentation for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "pending_messages", description: "Unread messages for the agent", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "goal_hierarchy", description: "Goal tree with completion status", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "channel_messages", description: "Recent messages in agent channels", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "planning_delta", description: "Changes since last planning cycle", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "velocity", description: "Task completion velocity and trends", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "preferences", description: "User preference store entries", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "trust_scores", description: "Trust evolution scores per action category", builtIn: true, outputTargets: ["briefing", "webhook"] });
  registerStream({ name: "resources", description: "Model rate limits and capacity information", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "initiative_status", description: "Initiative allocation vs spend breakdown", builtIn: true, outputTargets: ["briefing", "webhook"],
    params: [
      { name: "granularity", type: "string", description: "Detail level: summary or detailed", default: "summary" },
    ],
  });
  registerStream({ name: "cost_forecast", description: "Budget exhaustion projection", builtIn: true, outputTargets: ["briefing", "telegram", "webhook"],
    params: [
      { name: "horizon", type: "string", description: "Forecast time horizon", default: "24h" },
      { name: "granularity", type: "string", description: "per_initiative or aggregate", default: "aggregate" },
    ],
  });
  registerStream({ name: "available_capacity", description: "Current rate limit headroom and concurrent slot availability", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "knowledge_candidates", description: "Memory entries flagged for promotion to structured knowledge", builtIn: true, outputTargets: ["briefing"] });
}
```

- [ ] **Step 6: Write manifest test**

Add to `test/streams/catalog.test.ts`:

```typescript
describe("builtin manifest", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("registers all built-in sources", async () => {
    const { registerBuiltinStreams } = await import("../../src/streams/builtin-manifest.js");
    const { listStreams } = await import("../../src/streams/catalog.js");

    registerBuiltinStreams();
    const streams = listStreams();

    // Should have all 33 built-in sources
    expect(streams.length).toBeGreaterThanOrEqual(29);
    expect(streams.every((s) => s.builtIn)).toBe(true);

    // Spot check key sources
    const names = streams.map((s) => s.name);
    expect(names).toContain("task_board");
    expect(names).toContain("cost_forecast");
    expect(names).toContain("knowledge_candidates");
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/streams/catalog.test.ts`
Expected: PASS

- [ ] **Step 8: Add streams action to ops-tool**

Add `"streams"` to `OPS_ACTIONS` in `src/tools/ops-tool.ts`:

```typescript
  "init_questions", "init_apply", "streams",
```

Add handler case:

```typescript
    case "streams": {
      const { listStreams, formatStreamCatalog } = await import("../streams/catalog.js");
      const streams = listStreams();
      if (streams.length === 0) {
        // Register builtins on demand
        const { registerBuiltinStreams } = await import("../streams/builtin-manifest.js");
        registerBuiltinStreams();
      }
      return jsonResult({ catalog: formatStreamCatalog(), count: listStreams().length });
    }
```

- [ ] **Step 9: Commit**

```bash
git add src/streams/catalog.ts src/streams/builtin-manifest.ts src/tools/ops-tool.ts test/streams/catalog.test.ts
git commit -m "feat(phase9): add stream catalog with built-in manifest (9.8.1)"
```

---

### Task 5: Parameterized Sources + VALID_SOURCES Fix (9.8.2)

**Files:**
- Modify: `src/types.ts:200-212` (add `params`, `streamName`, `"custom"` to ContextSource)
- Create: `src/streams/params.ts`
- Modify: `src/context/assembler.ts:103-214` (pass params to resolvers)
- Modify: `src/config-validator.ts:520-526` (fix VALID_SOURCES)
- Test: `test/streams/params.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/streams/params.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";

describe("stream params validation", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("validates params against schema", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    const { validateStreamParams } = await import("../../src/streams/params.js");

    registerStream({
      name: "test",
      description: "Test",
      builtIn: true,
      outputTargets: ["briefing"],
      params: [
        { name: "limit", type: "number", description: "Max", required: true },
        { name: "format", type: "string", description: "Output format", default: "table" },
      ],
    });

    // Valid: required param provided
    expect(validateStreamParams("test", { limit: 10 }).valid).toBe(true);

    // Valid: optional param omitted
    expect(validateStreamParams("test", { limit: 5 }).valid).toBe(true);

    // Invalid: required param missing
    const missing = validateStreamParams("test", {});
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]).toContain("limit");

    // Invalid: wrong type
    const wrongType = validateStreamParams("test", { limit: "abc" });
    expect(wrongType.valid).toBe(false);
  });

  it("returns valid for stream with no param schema", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    const { validateStreamParams } = await import("../../src/streams/params.js");

    registerStream({ name: "simple", description: "No params", builtIn: true, outputTargets: [] });
    expect(validateStreamParams("simple", { anything: true }).valid).toBe(true);
  });

  it("returns valid for unknown stream", async () => {
    const { validateStreamParams } = await import("../../src/streams/params.js");
    expect(validateStreamParams("unknown", {}).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/streams/params.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Update ContextSource type**

Modify `src/types.ts:200-212`. Replace the `ContextSource` type:

```typescript
/** A context source to inject at session start. */
export type ContextSource = {
  source: "instructions" | "custom" | "project_md" | "task_board" | "assigned_task" | "knowledge" | "file" | "skill" | "memory" | "escalations" | "workflows" | "activity" | "sweep_status" | "proposals" | "agent_status" | "cost_summary" | "policy_status" | "health_status" | "team_status" | "team_performance" | "soul" | "tools_reference" | "pending_messages" | "goal_hierarchy" | "channel_messages" | "planning_delta" | "velocity" | "preferences" | "trust_scores" | "resources" | "initiative_status" | "cost_forecast" | "available_capacity" | "knowledge_candidates" | "budget_guidance" | "onboarding_welcome" | "weekly_digest" | "intervention_suggestions" | "custom_stream";
  /** Raw markdown content (for source: "custom"). */
  content?: string;
  /** File path (for source: "file"). */
  path?: string;
  /** Knowledge filter (for source: "knowledge"). */
  filter?: {
    category?: string[];
    tags?: string[];
  };
  /** Stream parameters (for parameterized sources). */
  params?: Record<string, unknown>;
  /** Custom stream name (for source: "custom_stream"). */
  streamName?: string;
};
```

Note: Using `"custom_stream"` instead of `"custom"` to avoid collision with the existing `"custom"` source (which is for raw markdown content).

- [ ] **Step 4: Create params validation module**

Create `src/streams/params.ts`:

```typescript
/**
 * Clawforce — Stream Parameter Validation
 *
 * Validates user-supplied params against a stream's parameter schema.
 */

import { getStream } from "./catalog.js";

export type ParamValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateStreamParams(
  streamName: string,
  params: Record<string, unknown>,
): ParamValidationResult {
  const stream = getStream(streamName);
  if (!stream || !stream.params || stream.params.length === 0) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  for (const schema of stream.params) {
    const value = params[schema.name];

    if (value === undefined || value === null) {
      if (schema.required) {
        errors.push(`Required parameter "${schema.name}" is missing for stream "${streamName}"`);
      }
      continue;
    }

    // Type check
    switch (schema.type) {
      case "string":
        if (typeof value !== "string") {
          errors.push(`Parameter "${schema.name}" must be a string, got ${typeof value}`);
        }
        break;
      case "number":
        if (typeof value !== "number") {
          errors.push(`Parameter "${schema.name}" must be a number, got ${typeof value}`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          errors.push(`Parameter "${schema.name}" must be a boolean, got ${typeof value}`);
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          errors.push(`Parameter "${schema.name}" must be a string array`);
        }
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run params test to verify it passes**

Run: `npx vitest run test/streams/params.test.ts`
Expected: PASS

- [ ] **Step 6: Fix VALID_SOURCES in config-validator.ts AND project.ts**

Modify `src/config-validator.ts:520-526`. Replace the VALID_SOURCES array:

```typescript
    const VALID_SOURCES: ContextSource["source"][] = [
      "instructions", "custom", "project_md", "task_board",
      "assigned_task", "knowledge", "file", "skill", "memory",
      "escalations", "workflows", "activity", "sweep_status",
      "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
      "team_status", "team_performance", "soul", "tools_reference",
      "pending_messages", "goal_hierarchy", "channel_messages", "planning_delta",
      "velocity", "preferences", "trust_scores", "resources",
      "initiative_status", "cost_forecast", "available_capacity", "knowledge_candidates",
      "budget_guidance", "onboarding_welcome", "weekly_digest", "intervention_suggestions",
      "custom_stream",
    ];
```

Also modify `src/project.ts:346-355`. Add the new sources to the VALID_SOURCES array there too:

```typescript
const VALID_SOURCES: ContextSource["source"][] = [
  "instructions", "custom", "project_md", "task_board",
  "assigned_task", "knowledge", "file", "skill", "memory",
  "escalations", "workflows", "activity", "sweep_status",
  "proposals", "agent_status", "cost_summary", "policy_status", "health_status",
  "team_status", "team_performance", "soul", "tools_reference",
  "channel_messages", "pending_messages", "goal_hierarchy", "planning_delta",
  "velocity", "preferences", "trust_scores", "resources", "initiative_status",
  "cost_forecast", "available_capacity", "knowledge_candidates",
  "budget_guidance", "onboarding_welcome", "weekly_digest", "intervention_suggestions",
  "custom_stream",
];
```

Also update `normalizeContextSources()` in `src/project.ts:524-535` to pass through `params` and `streamName`:

```typescript
      const result: ContextSource = { source };
      if (typeof item.content === "string") result.content = item.content;
      if (typeof item.path === "string") result.path = item.path;
      if (item.params !== undefined && typeof item.params === "object") {
        result.params = item.params as Record<string, unknown>;
      }
      if (typeof item.streamName === "string") result.streamName = item.streamName;
      if (typeof item.filter === "object" && item.filter !== null) {
```

- [ ] **Step 7: Update assembler to pass source.params through**

Modify `src/context/assembler.ts`. The existing resolver functions for `cost_forecast`, `available_capacity`, `initiative_status`, and `knowledge_candidates` already accept a second parameter (currently passed as `undefined`). Update them to pass `source.params` instead:

```typescript
    case "cost_forecast":
      return resolveCostForecastSource(ctx.projectId ?? "", source.params);

    case "available_capacity":
      return resolveAvailableCapacitySource(ctx.projectId ?? "", source.params);

    case "initiative_status":
      return resolveInitiativeStatusSource(ctx.projectId ?? "", source.params);

    case "knowledge_candidates":
      return resolveKnowledgeCandidatesSource(ctx.projectId ?? "", source.params);
```

Note: The `custom_stream` assembler case is deferred to Task 6 when the custom stream module exists.

- [ ] **Step 8: Run full test suite to verify no regressions**

Run: `npx vitest run test/config/ test/streams/`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/streams/params.ts src/config-validator.ts src/context/assembler.ts test/streams/params.test.ts
git commit -m "feat(phase9): add parameterized sources and fix VALID_SOURCES (9.8.2)"
```

---

### Task 6: Custom Computed Streams (9.8.3)

**Files:**
- Create: `src/streams/custom.ts`
- Modify: `src/context/assembler.ts` (wire custom_stream handler fully)
- Test: `test/streams/custom.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/streams/custom.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("custom streams", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-custom-stream-"));
    dbPath = path.join(tmpDir, "test.db");

    // Create a test database with sample data
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, status TEXT, created_at INTEGER);
      INSERT INTO items VALUES ('1', 'Task A', 'OPEN', ${Date.now() - 100000000});
      INSERT INTO items VALUES ('2', 'Task B', 'DONE', ${Date.now()});
      INSERT INTO items VALUES ('3', 'Task C', 'OPEN', ${Date.now() - 200000000});
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes a read-only SELECT query", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "open_items",
      query: "SELECT id, name FROM items WHERE status = 'OPEN'",
      format: "table",
    });

    expect(result.text).toContain("Task A");
    expect(result.text).toContain("Task C");
    expect(result.rows).toHaveLength(2);
  });

  it("rejects mutation queries", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");

    expect(() =>
      executeCustomStream(dbPath, {
        name: "evil",
        query: "DELETE FROM items",
        format: "table",
      }),
    ).toThrow();
  });

  it("rejects DROP queries", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");

    expect(() =>
      executeCustomStream(dbPath, {
        name: "evil",
        query: "DROP TABLE items",
        format: "table",
      }),
    ).toThrow();
  });

  it("formats as JSON", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id, name FROM items LIMIT 1",
      format: "json",
    });

    expect(result.json).toBeDefined();
    expect(result.json![0].id).toBe("1");
  });

  it("formats as summary", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id FROM items",
      format: "summary",
    });

    expect(result.text).toContain("3");
  });

  it("appends LIMIT when none present", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(dbPath, {
      name: "test",
      query: "SELECT id FROM items",
      format: "table",
    });

    // Should succeed — LIMIT 10000 appended internally
    expect(result.rows.length).toBeLessThanOrEqual(10000);
  });

  it("supports SQL parameter bindings", async () => {
    const { executeCustomStream } = await import("../../src/streams/custom.js");
    const result = executeCustomStream(
      dbPath,
      {
        name: "test",
        query: "SELECT id, name FROM items WHERE status = ?",
        format: "table",
      },
      { 1: "DONE" },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.text).toContain("Task B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/streams/custom.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the custom stream module**

Create `src/streams/custom.ts`:

```typescript
/**
 * Clawforce — Custom Computed Streams
 *
 * Executes user-defined SQL queries against a read-only DB connection.
 * Results formatted as table, JSON, or summary for briefing/webhook use.
 */

import { DatabaseSync } from "node:sqlite";

export type CustomStreamDef = {
  name: string;
  query: string;
  format: "table" | "json" | "summary";
  description?: string;
};

export type StreamResult = {
  text: string;
  rows: Record<string, unknown>[];
  json?: Record<string, unknown>[];
};

const DEFAULT_LIMIT = 10000;

export function executeCustomStream(
  dbPath: string,
  streamDef: CustomStreamDef,
  params?: Record<string, unknown>,
): StreamResult {
  // Open a read-only connection — kernel-level enforcement
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    let query = streamDef.query.trim();

    // Append LIMIT if none present
    if (!/\bLIMIT\b/i.test(query)) {
      // Remove trailing semicolon if present
      if (query.endsWith(";")) query = query.slice(0, -1);
      query = `${query} LIMIT ${DEFAULT_LIMIT}`;
    }

    // Build bindings array from params
    const bindings: unknown[] = [];
    if (params) {
      // Support positional params (keys are "1", "2", etc.)
      const keys = Object.keys(params).sort((a, b) => Number(a) - Number(b));
      for (const key of keys) {
        bindings.push(params[key]);
      }
    }

    const stmt = db.prepare(query);
    const rows = (bindings.length > 0 ? stmt.all(...bindings) : stmt.all()) as Record<string, unknown>[];

    return {
      text: formatResult(streamDef.name, rows, streamDef.format),
      rows,
      json: streamDef.format === "json" ? rows : undefined,
    };
  } finally {
    db.close();
  }
}

function formatResult(
  name: string,
  rows: Record<string, unknown>[],
  format: "table" | "json" | "summary",
): string {
  if (rows.length === 0) return `## ${name}\n\nNo results.`;

  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);

    case "summary":
      return `## ${name}\n\n${rows.length} result(s).`;

    case "table": {
      const columns = Object.keys(rows[0]);
      const header = `| ${columns.join(" | ")} |`;
      const separator = `| ${columns.map(() => "---").join(" | ")} |`;
      const body = rows
        .slice(0, 100) // Cap table display at 100 rows
        .map((row) => `| ${columns.map((c) => String(row[c] ?? "")).join(" | ")} |`)
        .join("\n");

      const truncated = rows.length > 100 ? `\n\n...and ${rows.length - 100} more rows.` : "";
      return `## ${name}\n\n${header}\n${separator}\n${body}${truncated}`;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/streams/custom.test.ts`
Expected: PASS

- [ ] **Step 5: Wire custom_stream handler in assembler**

Add `custom_stream` case to `resolveSource()` in `src/context/assembler.ts`. Add static import at top of file:

```typescript
import { getStream } from "../streams/catalog.js";
```

Add case before `default`:

```typescript
    case "custom_stream": {
      if (!source.streamName || !ctx.projectId) return null;
      const streamDef = getStream(source.streamName);
      if (!streamDef) return null;
      // Custom streams with queries are resolved through the router.
      // In briefing context, show the stream description as a reference.
      return `## ${source.streamName}\n\n${streamDef.description}`;
    }
```

Note: `resolveSource()` is synchronous, so all imports must be static at the top of the file. No dynamic `await import()` allowed.

- [ ] **Step 6: Commit**

```bash
git add src/streams/custom.ts src/context/assembler.ts test/streams/custom.test.ts
git commit -m "feat(phase9): add custom SQL streams with read-only enforcement (9.8.3)"
```

---

## Chunk 3: Budget Runtime + Onboarding + Routing

### Task 7: Budget Guidance Runtime Source (9.4 complete)

**Files:**
- Modify: `src/context/assembler.ts` (add `budget_guidance` case)
- Modify: `src/presets.ts` (add to manager preset briefing)
- Test: `test/context/budget-guidance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/context/budget-guidance.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("budget_guidance briefing source", () => {
  it("returns budget guidance text when projectId is set", async () => {
    const { resolveBudgetGuidanceSource } = await import("../../src/context/sources/budget-guidance.js");

    // Without historical data, falls back to model-cost estimates
    const result = resolveBudgetGuidanceSource("test-project", undefined);
    expect(result).toBeNull(); // No config data to work with returns null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/budget-guidance.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create budget guidance source**

Create `src/context/sources/budget-guidance.ts`:

```typescript
/**
 * Clawforce — Budget Guidance Briefing Source
 *
 * Runtime budget guidance injected into manager reflection.
 * Uses historical cost data when available, model estimates when fresh.
 */

import { getDb } from "../../db.js";
import { safeLog } from "../../diagnostics.js";

export function resolveBudgetGuidanceSource(
  projectId: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (!projectId) return null;

  try {
    const db = getDb(projectId);

    // Get today's spend
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const spendRow = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as spent
      FROM cost_records
      WHERE project_id = ? AND created_at >= ?
    `).get(projectId, todayMs) as { spent: number } | undefined;

    const spent = spendRow?.spent ?? 0;

    // Get daily budget from budgets table (project-level = agent_id IS NULL)
    const budgetRow = db.prepare(
      `SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL`,
    ).get(projectId) as { daily_limit_cents: number } | undefined;

    if (!budgetRow) return null;
    const dailyBudget = budgetRow.daily_limit_cents;
    if (!dailyBudget || dailyBudget <= 0) return null;

    const utilization = Math.round((spent / dailyBudget) * 100);
    const remaining = dailyBudget - spent;

    // Estimate sessions remaining based on average session cost
    const avgRow = db.prepare(`
      SELECT COALESCE(AVG(cost_cents), 0) as avg_cost, COUNT(*) as count
      FROM cost_records
      WHERE project_id = ? AND created_at >= ? AND cost_cents > 0
    `).get(projectId, todayMs) as { avg_cost: number; count: number } | undefined;

    const avgCost = avgRow?.avg_cost ?? 0;
    const sessionsRemaining = avgCost > 0 ? Math.floor(remaining / avgCost) : 0;

    // Estimate exhaustion time
    let exhaustionNote = "";
    if (avgRow && avgRow.count >= 2 && avgCost > 0) {
      const hoursElapsed = (Date.now() - todayMs) / 3600000;
      if (hoursElapsed > 0) {
        const burnRate = spent / hoursElapsed;
        if (burnRate > 0) {
          const hoursRemaining = remaining / burnRate;
          const exhaustionHour = new Date(Date.now() + hoursRemaining * 3600000);
          exhaustionNote = ` At current velocity, exhausts by ${exhaustionHour.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
        }
      }
    }

    const lines = [
      "## Budget Guidance",
      "",
      `Budget utilization: ${utilization}% ($${(spent / 100).toFixed(2)} of $${(dailyBudget / 100).toFixed(2)}).${exhaustionNote}`,
    ];

    if (sessionsRemaining > 0) {
      lines.push(`Estimated sessions remaining: ~${sessionsRemaining}.`);
    }

    return lines.join("\n");
  } catch (err) {
    safeLog("budget-guidance", `Failed to generate budget guidance: ${err}`);
    return null;
  }
}
```

- [ ] **Step 4: Wire into assembler**

Add static import at top of `src/context/assembler.ts`:

```typescript
import { resolveBudgetGuidanceSource } from "./sources/budget-guidance.js";
```

Add case to `resolveSource()` (before the `default` case):

```typescript
    case "budget_guidance":
      return resolveBudgetGuidanceSource(ctx.projectId ?? "", source.params);
```

- [ ] **Step 5: Add to manager preset briefing**

In `src/presets.ts`, find the manager preset's briefing array (line 128-133) and add `"budget_guidance"` as a plain string (the preset uses strings, not objects — `applyProfile()` in `profiles.ts` converts them to `ContextSource` objects):

```typescript
    briefing: [
      "soul", "tools_reference", "project_md", "task_board", "goal_hierarchy",
      "escalations", "team_status", "trust_scores", "cost_summary", "resources",
      "pending_messages", "channel_messages", "memory", "skill",
      "policy_status", "preferences", "cost_forecast", "available_capacity",
      "knowledge_candidates", "budget_guidance",
    ],
```

- [ ] **Step 6: Register in catalog**

In `src/streams/builtin-manifest.ts`, add:

```typescript
  registerStream({ name: "budget_guidance", description: "Budget utilization, remaining sessions, and exhaustion forecast", builtIn: true, outputTargets: ["briefing", "telegram"] });
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/context/budget-guidance.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/context/sources/budget-guidance.ts src/context/assembler.ts src/presets.ts src/streams/builtin-manifest.ts src/project.ts test/context/budget-guidance.test.ts
git commit -m "feat(phase9): add budget guidance runtime briefing source (9.4)"
```

---

### Task 8: Human Onboarding (9.9)

**Files:**
- Modify: `src/migrations.ts:12,927` (V27 migration)
- Create: `src/context/sources/onboarding-sources.ts`
- Modify: `src/context/assembler.ts` (add 3 new cases)
- Modify: `src/presets.ts` (add onboarding sources to manager briefing)
- Modify: `src/streams/builtin-manifest.ts` (register)
- Test: `test/context/onboarding-sources.test.ts`

- [ ] **Step 1: Add V27 migration**

Modify `src/migrations.ts`. Update `SCHEMA_VERSION` to 27:

```typescript
export const SCHEMA_VERSION = 27;
```

Add migration function after `migrateV26`:

```typescript
// --- Migration V27: Onboarding state + audit index ---

function migrateV27(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_audit_runs_agent_ended
    ON audit_runs(agent_id, ended_at)
  `).run();
}
```

Add `27: migrateV27` to the migrations map (find the existing map that maps version numbers to functions).

- [ ] **Step 2: Run migration test to verify schema version**

Run: `npx vitest run test/migrations.test.ts` (if exists) or verify manually that the migration is well-formed.

- [ ] **Step 3: Write the failing test**

Create `test/context/onboarding-sources.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("onboarding sources", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE onboarding_state (
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, key)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        state TEXT,
        assigned_to TEXT,
        priority TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE cost_records (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT,
        cost_cents INTEGER,
        created_at INTEGER
      );
      CREATE TABLE audit_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT,
        session_key TEXT,
        status TEXT,
        ended_at INTEGER
      );
      CREATE INDEX idx_audit_runs_agent_ended ON audit_runs(agent_id, ended_at);
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe("welcome source", () => {
    it("returns welcome content for fresh domain", async () => {
      const { resolveWelcomeSource } = await import("../../src/context/sources/onboarding-sources.js");

      const result = resolveWelcomeSource("test-project", db, {
        agentCount: 3,
        domainName: "test-project",
      });

      expect(result).toContain("Welcome");
      expect(result).toContain("3 agents");
    });

    it("returns null after welcome has been delivered", async () => {
      const { resolveWelcomeSource } = await import("../../src/context/sources/onboarding-sources.js");

      // Mark welcome as delivered
      db.prepare(`
        INSERT INTO onboarding_state (project_id, key, value, updated_at)
        VALUES ('test-project', 'welcome_delivered', 'true', ?)
      `).run(Date.now());

      const result = resolveWelcomeSource("test-project", db, {
        agentCount: 3,
        domainName: "test-project",
      });

      expect(result).toBeNull();
    });
  });

  describe("intervention source", () => {
    it("detects idle agents", async () => {
      const { resolveInterventionSource } = await import("../../src/context/sources/onboarding-sources.js");

      // Agent with no completions in 48h
      const twoDaysAgo = Date.now() - 48 * 3600 * 1000 - 1;
      db.prepare(`INSERT INTO tasks (id, project_id, title, state, assigned_to, priority, created_at, updated_at) VALUES ('t1', 'test-project', 'Old task', 'ASSIGNED', 'idle-agent', 'P2', ?, ?)`).run(twoDaysAgo, twoDaysAgo);

      const result = resolveInterventionSource("test-project", db, ["idle-agent"]);
      expect(result).toContain("idle");
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/context/onboarding-sources.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Create onboarding sources module**

Create `src/context/sources/onboarding-sources.ts`:

```typescript
/**
 * Clawforce — Human Onboarding Briefing Sources
 *
 * Three sources for manager reflection:
 * - onboarding_welcome: first-day orientation
 * - weekly_digest: periodic performance summary
 * - intervention_suggestions: pattern-detected recommendations
 */

import type { DatabaseSync } from "node:sqlite";
import { safeLog } from "../../diagnostics.js";

type WelcomeContext = {
  agentCount: number;
  domainName: string;
};

// --- Welcome ---

export function resolveWelcomeSource(
  projectId: string,
  db: DatabaseSync,
  ctx: WelcomeContext,
): string | null {
  try {
    const delivered = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'welcome_delivered'`,
    ).get(projectId) as { value: string } | undefined;

    if (delivered) return null;

    // Mark as delivered
    db.prepare(`
      INSERT OR REPLACE INTO onboarding_state (project_id, key, value, updated_at)
      VALUES (?, 'welcome_delivered', 'true', ?)
    `).run(projectId, Date.now());

    return [
      "## Welcome — First Coordination Cycle",
      "",
      `Domain "${ctx.domainName}" is now active with ${ctx.agentCount} agents.`,
      "",
      "First-cycle checklist:",
      "- [ ] Verify agent configs are correct (roles, tools, skills)",
      "- [ ] Run a test task to confirm dispatch works",
      "- [ ] Confirm channel routing (Telegram/Slack) is delivering messages",
      "- [ ] Review budget allocation across agents",
      "",
      "Communicate status to the human via your configured channel.",
    ].join("\n");
  } catch (err) {
    safeLog("onboarding", `Welcome source error: ${err}`);
    return null;
  }
}

// --- Weekly Digest ---

export function resolveWeeklyDigestSource(
  projectId: string,
  db: DatabaseSync,
): string | null {
  try {
    const lastDigest = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'last_digest_at'`,
    ).get(projectId) as { value: string } | undefined;

    const lastDigestAt = lastDigest ? Number(lastDigest.value) : 0;
    const oneWeekMs = 7 * 24 * 3600 * 1000;
    const now = Date.now();

    if (lastDigestAt > 0 && now - lastDigestAt < oneWeekMs) {
      return null; // Not time yet
    }

    const periodStart = lastDigestAt || now - oneWeekMs;

    // Aggregate task stats
    const taskStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'DONE' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN state = 'BLOCKED' THEN 1 ELSE 0 END) as blocked
      FROM tasks WHERE project_id = ? AND updated_at >= ?
    `).get(projectId, periodStart) as {
      total: number; completed: number; failed: number; blocked: number;
    } | undefined;

    // Aggregate cost
    const costStats = db.prepare(`
      SELECT COALESCE(SUM(total_cost_cents), 0) as total_spend
      FROM cost_records WHERE project_id = ? AND created_at >= ?
    `).get(projectId, periodStart) as { total_spend: number } | undefined;

    // Update last digest timestamp
    db.prepare(`
      INSERT OR REPLACE INTO onboarding_state (project_id, key, value, updated_at)
      VALUES (?, 'last_digest_at', ?, ?)
    `).run(projectId, String(now), now);

    const isFirstWeek = lastDigestAt === 0;
    const header = isFirstWeek ? "## Week 1 Summary" : "## Weekly Digest";

    const lines = [
      header,
      "",
      `**Tasks:** ${taskStats?.completed ?? 0} completed, ${taskStats?.failed ?? 0} failed, ${taskStats?.blocked ?? 0} blocked (${taskStats?.total ?? 0} total)`,
      `**Cost:** $${((costStats?.total_spend ?? 0) / 100).toFixed(2)}`,
    ];

    if (isFirstWeek) {
      lines.push(
        "",
        "**First-week tips:**",
        "- Consider adding skills to agents that struggled with tasks",
        "- Agents with no completions may need task reassignment or config adjustment",
        "- Review the cost breakdown per agent to optimize model choices",
      );
    }

    lines.push("", "Summarize this digest and share with the human via your configured channel.");

    return lines.join("\n");
  } catch (err) {
    safeLog("onboarding", `Weekly digest error: ${err}`);
    return null;
  }
}

// --- Intervention Suggestions ---

export function resolveInterventionSource(
  projectId: string,
  db: DatabaseSync,
  agentIds: string[],
): string | null {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const suggestions: string[] = [];

    // Check dismissed interventions
    const dismissedRow = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'dismissed_interventions'`,
    ).get(projectId) as { value: string } | undefined;
    const dismissed = new Set<string>(
      dismissedRow ? JSON.parse(dismissedRow.value) : [],
    );

    for (const agentId of agentIds) {
      // Pattern 1: Idle agent — no task completions in 48h
      if (!dismissed.has(`idle:${agentId}`)) {
        const recent = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state = 'DONE'
            AND updated_at >= ?
        `).get(projectId, agentId, Date.now() - 48 * 3600 * 1000) as { count: number };

        const assigned = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state IN ('ASSIGNED', 'IN_PROGRESS')
        `).get(projectId, agentId) as { count: number };

        if (recent.count === 0 && assigned.count > 0) {
          suggestions.push(
            `- **${agentId} is idle**: has ${assigned.count} assigned task(s) but no completions in 48h. Options: reassign tasks, add skills, or check for blockers. (dismiss: idle:${agentId})`,
          );
        }
      }

      // Pattern 2: Repeated failure
      if (!dismissed.has(`failure:${agentId}`)) {
        const failures = db.prepare(`
          SELECT COUNT(*) as count FROM audit_runs
          WHERE project_id = ? AND agent_id = ? AND status = 'failed'
            AND ended_at >= ?
        `).get(projectId, agentId, sevenDaysAgo) as { count: number };

        if (failures.count >= 3) {
          suggestions.push(
            `- **${agentId} has ${failures.count} failures** in the past 7 days. Options: add relevant skills, split responsibilities, or downgrade task complexity. (dismiss: failure:${agentId})`,
          );
        }
      }
    }

    if (suggestions.length === 0) return null;

    return [
      "## Intervention Suggestions",
      "",
      ...suggestions,
      "",
      "Use `clawforce_ops dismiss_intervention` with the dismiss key to stop seeing a suggestion.",
    ].join("\n");
  } catch (err) {
    safeLog("onboarding", `Intervention source error: ${err}`);
    return null;
  }
}
```

- [ ] **Step 6: Wire into assembler**

Add static imports at top of `src/context/assembler.ts` (note: `getDb` and `getRegisteredAgentIds` are already imported in assembler — check and add only if missing):

```typescript
import { resolveWelcomeSource, resolveWeeklyDigestSource, resolveInterventionSource } from "./sources/onboarding-sources.js";
```

Add three new cases to `resolveSource()` (before `default`). Note: `resolveSource()` is synchronous — all imports must be static at the top. `getRegisteredAgentIds()` takes no arguments and returns all agent IDs:

```typescript
    case "onboarding_welcome": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        const agents = getRegisteredAgentIds();
        return resolveWelcomeSource(ctx.projectId, db, {
          agentCount: agents.length,
          domainName: ctx.projectId,
        });
      } catch { return null; }
    }

    case "weekly_digest": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        return resolveWeeklyDigestSource(ctx.projectId, db);
      } catch { return null; }
    }

    case "intervention_suggestions": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        const agents = getRegisteredAgentIds();
        return resolveInterventionSource(ctx.projectId, db, agents);
      } catch { return null; }
    }
```

- [ ] **Step 7: Add to manager preset briefing**

In `src/presets.ts`, the manager preset's briefing array was updated in Task 7. Add three more plain strings to it:

```typescript
      "knowledge_candidates", "budget_guidance",
      "onboarding_welcome", "weekly_digest", "intervention_suggestions",
```

- [ ] **Step 8: Register in catalog**

In `src/streams/builtin-manifest.ts`, add:

```typescript
  registerStream({ name: "onboarding_welcome", description: "First-day orientation checklist for fresh domains", builtIn: true, outputTargets: ["briefing"] });
  registerStream({ name: "weekly_digest", description: "Weekly performance summary with task, cost, and agent metrics", builtIn: true, outputTargets: ["briefing", "telegram"] });
  registerStream({ name: "intervention_suggestions", description: "Pattern-detected recommendations for struggling agents or initiatives", builtIn: true, outputTargets: ["briefing"] });
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run test/context/onboarding-sources.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/migrations.ts src/context/sources/onboarding-sources.ts src/context/assembler.ts src/presets.ts src/streams/builtin-manifest.ts test/context/onboarding-sources.test.ts
git commit -m "feat(phase9): add human onboarding briefing sources (9.9)"
```

---

### Task 9: Multi-Output Routing (9.8.4)

**Files:**
- Install: `filtrex` dependency
- Create: `src/streams/conditions.ts`
- Create: `src/streams/router.ts`
- Modify: `src/tools/ops-tool.ts` (add `route` action)
- Test: `test/streams/conditions.test.ts`
- Test: `test/streams/router.test.ts`

- [ ] **Step 1: Install filtrex**

Run: `npm install --save-exact filtrex`

- [ ] **Step 2: Write the conditions test**

Create `test/streams/conditions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/streams/conditions.js";

describe("condition evaluation", () => {
  it("evaluates simple comparison", () => {
    expect(evaluateCondition("value < 10", { value: 5 })).toBe(true);
    expect(evaluateCondition("value < 10", { value: 15 })).toBe(false);
  });

  it("evaluates equality", () => {
    expect(evaluateCondition('status == "OPEN"', { status: "OPEN" })).toBe(true);
    expect(evaluateCondition('status == "DONE"', { status: "OPEN" })).toBe(false);
  });

  it("evaluates boolean operators", () => {
    expect(evaluateCondition("a > 0 and b > 0", { a: 1, b: 2 })).toBe(true);
    expect(evaluateCondition("a > 0 and b > 0", { a: 1, b: -1 })).toBe(false);
    expect(evaluateCondition("a > 0 or b > 0", { a: -1, b: 2 })).toBe(true);
  });

  it("evaluates arithmetic", () => {
    expect(evaluateCondition("a + b > 10", { a: 5, b: 7 })).toBe(true);
  });

  it("returns false for invalid expressions", () => {
    expect(evaluateCondition("", { a: 1 })).toBe(false);
  });

  it("handles missing variables gracefully", () => {
    // filtrex returns 0 for missing vars by default
    expect(evaluateCondition("missing > 5", {})).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/streams/conditions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Create conditions module**

Create `src/streams/conditions.ts`:

```typescript
/**
 * Clawforce — Safe Condition Evaluation
 *
 * Uses filtrex for safe expression evaluation with a strict whitelist.
 * No access to globals, prototypes, or arbitrary code execution.
 */

import { compileExpression } from "filtrex";

export function evaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  if (!expression || expression.trim().length === 0) return false;

  try {
    const fn = compileExpression(expression);
    const result = fn(context as Record<string, number | string | boolean>);
    return Boolean(result);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run conditions test**

Run: `npx vitest run test/streams/conditions.test.ts`
Expected: PASS

- [ ] **Step 6: Write the router test**

Create `test/streams/router.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("stream router", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("evaluates a route with passing condition", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "test-route",
        source: "cost_forecast",
        condition: "hours_remaining < 4",
        outputs: [{ target: "log" as const }],
      },
      { hours_remaining: 2, total_spend: 1500 },
    );

    expect(result.matched).toBe(true);
    expect(result.outputs).toHaveLength(1);
  });

  it("skips route when condition fails", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "test-route",
        source: "cost_forecast",
        condition: "hours_remaining < 4",
        outputs: [{ target: "log" as const }],
      },
      { hours_remaining: 10 },
    );

    expect(result.matched).toBe(false);
  });

  it("matches when no condition specified", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "always-route",
        source: "task_board",
        outputs: [{ target: "log" as const }],
      },
      { tasks: 5 },
    );

    expect(result.matched).toBe(true);
  });

  it("delivers to log output adapter", async () => {
    const { deliverToOutput } = await import("../../src/streams/router.js");

    // Log adapter should not throw
    const result = await deliverToOutput(
      { target: "log" as const },
      "test-route",
      "Some content to log",
      "test-project",
    );

    expect(result.delivered).toBe(true);
  });

  it("delivers to webhook output adapter", async () => {
    const { deliverToOutput } = await import("../../src/streams/router.js");

    // Webhook to invalid URL should fail gracefully
    const result = await deliverToOutput(
      { target: "webhook" as const, url: "http://localhost:99999/invalid" },
      "test-route",
      "payload",
      "test-project",
    );

    expect(result.delivered).toBe(false);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/streams/router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 8: Create router module**

Create `src/streams/router.ts`:

```typescript
/**
 * Clawforce — Multi-Output Stream Router
 *
 * Evaluates routing rules: condition check → fan out to output adapters.
 */

import { evaluateCondition } from "./conditions.js";
import { safeLog } from "../diagnostics.js";
import type { OutputTarget } from "./catalog.js";

export type RouteOutput = {
  target: OutputTarget;
  channel?: string;
  url?: string;
};

export type RouteDefinition = {
  name: string;
  source: string;
  params?: Record<string, unknown>;
  condition?: string;
  schedule?: string;
  streamName?: string;
  outputs: RouteOutput[];
};

export type RouteEvalResult = {
  name: string;
  matched: boolean;
  outputs: RouteOutput[];
};

export type DeliveryResult = {
  target: OutputTarget;
  delivered: boolean;
  error?: string;
};

export function evaluateRoute(
  route: RouteDefinition,
  streamData: Record<string, unknown>,
): RouteEvalResult {
  if (route.condition) {
    const matched = evaluateCondition(route.condition, streamData);
    return { name: route.name, matched, outputs: matched ? route.outputs : [] };
  }

  // No condition = always match
  return { name: route.name, matched: true, outputs: route.outputs };
}

export async function deliverToOutput(
  output: RouteOutput,
  routeName: string,
  content: string,
  projectId: string,
): Promise<DeliveryResult> {
  switch (output.target) {
    case "log": {
      safeLog("stream-router", `[${routeName}] ${content.slice(0, 200)}`);
      return { target: "log", delivered: true };
    }

    case "webhook": {
      if (!output.url) {
        return { target: "webhook", delivered: false, error: "No URL specified" };
      }
      try {
        const resp = await fetch(output.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: routeName, project: projectId, content }),
          signal: AbortSignal.timeout(10000),
        });
        return {
          target: "webhook",
          delivered: resp.ok,
          error: resp.ok ? undefined : `HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          target: "webhook",
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "telegram": {
      try {
        const { getApprovalNotifier } = await import("../approval/notify.js");
        const notifier = getApprovalNotifier();
        if (!notifier) {
          safeLog("stream-router", `[${routeName}] Telegram not configured, falling back to log`);
          safeLog("stream-router", `[${routeName}] ${content.slice(0, 200)}`);
          return { target: "telegram", delivered: true };
        }
        // Use sendProposalNotification with a synthetic payload
        // (ApprovalNotifier interface only has sendProposalNotification and editProposalMessage)
        await notifier.sendProposalNotification({
          proposalId: `stream-${routeName}-${Date.now()}`,
          projectId,
          title: `Stream: ${routeName}`,
          proposedBy: "system",
          description: content.slice(0, 500),
        });
        return { target: "telegram", delivered: true };
      } catch (err) {
        return {
          target: "telegram",
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "briefing": {
      // Briefing delivery is handled by the assembler at context build time
      // This adapter is a no-op — the route config tells the assembler to include it
      return { target: "briefing", delivered: true };
    }

    default:
      return { target: output.target, delivered: false, error: "Unknown target" };
  }
}

export async function executeRoute(
  route: RouteDefinition,
  streamData: Record<string, unknown>,
  content: string,
  projectId: string,
): Promise<{ route: string; results: DeliveryResult[] }> {
  const evalResult = evaluateRoute(route, streamData);
  if (!evalResult.matched) {
    return { route: route.name, results: [] };
  }

  const results: DeliveryResult[] = [];
  for (const output of evalResult.outputs) {
    const result = await deliverToOutput(output, route.name, content, projectId);
    results.push(result);
  }

  return { route: route.name, results };
}
```

- [ ] **Step 9: Run router tests**

Run: `npx vitest run test/streams/conditions.test.ts test/streams/router.test.ts`
Expected: PASS

- [ ] **Step 10: Add route action to ops-tool**

Add `"route"` to `OPS_ACTIONS` in `src/tools/ops-tool.ts`:

```typescript
  "init_questions", "init_apply", "streams", "route",
```

Add schema params:

```typescript
  // route params
  route_name: Type.Optional(Type.String({ description: "Route name to execute (for route action)." })),
  route_config: Type.Optional(Type.String({ description: "JSON route config: { name, source, condition, outputs } (for route action)." })),
  stream_data: Type.Optional(Type.String({ description: "JSON stream data context for condition evaluation (for route action)." })),
```

Add handler case:

```typescript
    case "route": {
      const routeConfigJson = readStringParam(input, "route_config");
      const streamDataJson = readStringParam(input, "stream_data");
      if (!routeConfigJson) return jsonResult({ error: "route_config is required" });

      let routeConfig, streamData;
      try {
        routeConfig = JSON.parse(routeConfigJson);
        streamData = streamDataJson ? JSON.parse(streamDataJson) : {};
      } catch {
        return jsonResult({ error: "Invalid JSON in route_config or stream_data" });
      }

      const { executeRoute } = await import("../streams/router.js");
      const results = await executeRoute(routeConfig, streamData, JSON.stringify(streamData), projectId);
      return jsonResult(results);
    }
```

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/streams/conditions.ts src/streams/router.ts src/tools/ops-tool.ts test/streams/conditions.test.ts test/streams/router.test.ts
git commit -m "feat(phase9): add multi-output routing with safe condition eval (9.8.4)"
```

---

## Chunk 4: Exports + Integration + Roadmap Update

### Task 10: Update Exports and Index

**Files:**
- Modify: `src/index.ts`
- Modify: `src/streams/builtin-manifest.ts` (final additions)

- [ ] **Step 1: Add all new exports to src/index.ts**

Add after the existing config system exports:

```typescript
// --- Config: Inference ---
export { inferPreset, wasInferred, clearInferenceState } from "./config/inference.js";

// --- Config: Budget Guide ---
export { estimateBudget, formatBudgetSummary, MODEL_COSTS } from "./config/budget-guide.js";
export type { BudgetEstimate, AgentCostEstimate, AgentBudgetInput } from "./config/budget-guide.js";

// --- Config: Init Flow ---
export { getInitQuestions, buildConfigFromAnswers, getBudgetGuidance } from "./config/init-flow.js";
export type { InitQuestion, InitAnswers, AgentAnswer } from "./config/init-flow.js";

// --- Streams ---
export { registerStream, getStream, listStreams, clearCatalog, formatStreamCatalog } from "./streams/catalog.js";
export type { StreamDefinition, ParamSchema, OutputTarget } from "./streams/catalog.js";
export { registerBuiltinStreams } from "./streams/builtin-manifest.js";
export { validateStreamParams } from "./streams/params.js";
export type { ParamValidationResult } from "./streams/params.js";
export { executeCustomStream } from "./streams/custom.js";
export type { CustomStreamDef, StreamResult } from "./streams/custom.js";
export { evaluateCondition } from "./streams/conditions.js";
export { evaluateRoute, executeRoute, deliverToOutput } from "./streams/router.js";
export type { RouteDefinition, RouteOutput, RouteEvalResult, DeliveryResult } from "./streams/router.js";

// --- Onboarding Sources ---
export { resolveWelcomeSource, resolveWeeklyDigestSource, resolveInterventionSource } from "./context/sources/onboarding-sources.js";
```

- [ ] **Step 2: Verify exports compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(phase9): export all new Phase 9 modules from index"
```

---

### Task 11: Update ROADMAP and Final Test Run

**Files:**
- Modify: `ROADMAP-v2.md`

- [ ] **Step 1: Update ROADMAP-v2.md phase summary**

Update the Phase 9 summary section to mark completed items:

```markdown
### Phase 9: UX Overhaul
- [x] 9.1: Minimal viable config (role inference, smart defaults)
- [x] 9.2: Interactive setup (`clawforce init` flow)
- [x] 9.3: Config quality feedback (lint-style best practice warnings)
- [x] 9.4: Budget guidance (cost estimation, recommendations)
- [x] 9.5: Config hot-reload (watch, diff, apply without restart)
- [ ] 9.6: Live actionable dashboard (real-time, approve/reassign/message from UI)
- [x] 9.7: Cron schedule automation (system determines frequency)
- [x] 9.8: Data streams (catalog, parameterized sources, custom queries, multi-output routing)
- [x] 9.9: Human onboarding (welcome flow, first-week digest, guided intervention)
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests green

- [ ] **Step 3: Commit**

```bash
git add ROADMAP-v2.md
git commit -m "docs(phase9): update roadmap — Phase 9 complete (except dashboard)"
```
