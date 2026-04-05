# Extract Experiments as OpenClaw Plugin — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all experiment-related code out of ClawForce core into a standalone OpenClaw plugin package.

**Architecture:** Experiments become `@clawforce/openclaw-plugin-experiments`, an OpenClaw plugin that uses `clawforce` as a peer dependency. The plugin registers its own tool and dashboard route via the OpenClaw plugin API. It creates its own DB tables on initialization via `CREATE TABLE IF NOT EXISTS`. ClawForce core is cleaned of all experiment references.

**Tech Stack:** TypeScript, OpenClaw plugin API, Vitest, ClawForce SDK (`getDb`, `writeAuditEntry`, `recordMetric`)

**Spec:** `docs/superpowers/specs/2026-04-04-extract-experiments-plugin-design.md`

---

## Chunk 1: Create Plugin Package + Move Core Logic

### Task 1: Scaffold the plugin package

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/package.json`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/openclaw.plugin.json`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@clawforce/openclaw-plugin-experiments",
  "version": "0.1.0",
  "description": "A/B experiment framework for ClawForce — variant assignment, canary health, results analysis",
  "type": "module",
  "license": "MIT",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "openclaw.plugin.json"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "tsc --noEmit && vitest run"
  },
  "peerDependencies": {
    "openclaw": ">=2025.1.0",
    "clawforce": "*"
  },
  "devDependencies": {
    "@sinclair/typebox": "^0.34.48",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "clawforce": "file:../../clawforce",
    "openclaw": "file:../../openclaw-dev"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

- [ ] **Step 2: Create openclaw.plugin.json**

```json
{
  "id": "clawforce-experiments",
  "version": "0.1.0",
  "description": "A/B experiment framework for ClawForce agent teams",
  "main": "index.js",
  "tools": ["clawforce_experiment"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "maxConcurrentExperiments": {
        "type": "number",
        "default": 2,
        "description": "Maximum concurrent running experiments per domain"
      }
    }
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/workplace/openclaw-plugins/clawforce-experiments
git init
git add package.json openclaw.plugin.json tsconfig.json
git commit -m "chore: scaffold clawforce-experiments plugin package"
```

---

### Task 2: Create plugin types

Move experiment types from `clawforce/src/types.ts` into the plugin.

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/types.ts`

- [ ] **Step 1: Create types.ts**

Copy the experiment types from `clawforce/src/types.ts:1608-1685`. These types reference `ContextSource`, `Expectation`, and `PerformancePolicy` from clawforce — import those as types.

```typescript
import type { ContextSource, Expectation, PerformancePolicy } from "clawforce";

export type ExperimentState = "draft" | "running" | "paused" | "completed" | "cancelled";

export type ExperimentAssignmentStrategy =
  | { type: "random"; seed?: number }
  | { type: "round_robin" }
  | { type: "per_agent"; agentVariantMap: Record<string, string> }
  | { type: "weighted"; weights: Record<string, number> }
  | { type: "manual" };

export type CompletionCriteria =
  | { type: "sessions"; perVariant: number }
  | { type: "time"; durationMs: number }
  | { type: "manual" };

export type VariantConfig = {
  persona?: string;
  briefing?: ContextSource[];
  exclude_briefing?: string[];
  expectations?: Expectation[];
  performance_policy?: PerformancePolicy;
  model?: string;
  context_overrides?: Record<string, string>;
};

export type ExperimentOutcome = {
  compliant: boolean | null;
  toolCalls: number;
  errorCount: number;
  durationMs: number;
  costCents: number;
};

export type Experiment = {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  hypothesis?: string;
  state: ExperimentState;
  assignmentStrategy: ExperimentAssignmentStrategy;
  completionCriteria?: CompletionCriteria;
  autoApplyWinner: boolean;
  createdBy: string;
  winnerVariantId?: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
};

export type ExperimentVariant = {
  id: string;
  experimentId: string;
  name: string;
  isControl: boolean;
  config: VariantConfig;
  sessionCount: number;
  compliantCount: number;
  totalCostCents: number;
  totalDurationMs: number;
  createdAt: number;
};

export type ExperimentSession = {
  id: string;
  experimentId: string;
  variantId: string;
  sessionKey: string;
  agentId: string;
  projectId: string;
  jobName?: string;
  taskId?: string;
  assignedAt: number;
  completedAt?: number;
  outcome?: ExperimentOutcome;
};
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add experiment types"
```

---

### Task 3: Create schema (table initialization)

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/schema.ts`

- [ ] **Step 1: Create schema.ts**

Extract table DDL from `clawforce/src/migrations.ts:1155-1213`. Use `CREATE TABLE IF NOT EXISTS` since these tables may already exist from the V36 migration in clawforce core.

```typescript
import type { DatabaseSync } from "node:sqlite";

/**
 * Ensure experiment tables exist in the given database.
 * Uses IF NOT EXISTS so it's safe to call on databases that
 * already have the tables from ClawForce's V36 migration.
 */
export function ensureExperimentTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      hypothesis TEXT,
      state TEXT NOT NULL DEFAULT 'draft',
      assignment_strategy TEXT NOT NULL DEFAULT '{"type":"random"}',
      completion_criteria TEXT,
      auto_apply_winner INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      winner_variant_id TEXT,
      metadata TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id, state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_name ON experiments(project_id, name);

    CREATE TABLE IF NOT EXISTS experiment_variants (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_control INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      session_count INTEGER NOT NULL DEFAULT 0,
      compliant_count INTEGER NOT NULL DEFAULT 0,
      total_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_variants_experiment ON experiment_variants(experiment_id);

    CREATE TABLE IF NOT EXISTS experiment_sessions (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_name TEXT,
      task_id TEXT,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER,
      outcome TEXT,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id),
      FOREIGN KEY (variant_id) REFERENCES experiment_variants(id)
    );

    CREATE INDEX IF NOT EXISTS idx_experiment_sessions_experiment ON experiment_sessions(experiment_id, variant_id);
    CREATE INDEX IF NOT EXISTS idx_experiment_sessions_session ON experiment_sessions(session_key);
  `);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/schema.ts
git commit -m "feat: add experiment table schema (CREATE IF NOT EXISTS)"
```

---

### Task 4: Move core experiment modules

Copy the 6 experiment files from clawforce, updating imports to use `clawforce` package and local `./types.js`.

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/lifecycle.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/assignment.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/results.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/config.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/canary.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/validation.ts`

- [ ] **Step 1: Copy lifecycle.ts**

Copy from `clawforce/src/experiments/lifecycle.ts`. Change imports:
- `"../db.js"` → `"clawforce"`
- `"../types.js"` → `"./types.js"`
- `"./validation.js"` stays as-is

- [ ] **Step 2: Copy assignment.ts**

Copy from `clawforce/src/experiments/assignment.ts`. Change imports:
- `"../db.js"` → `"clawforce"`
- `"../types.js"` → `"./types.js"`
- `"./lifecycle.js"` stays as-is

- [ ] **Step 3: Copy results.ts**

Copy from `clawforce/src/experiments/results.ts`. Change imports:
- `"../db.js"` → `"clawforce"`
- `"../types.js"` → `"./types.js"`
- `"./lifecycle.js"` stays as-is

- [ ] **Step 4: Copy config.ts**

Copy from `clawforce/src/experiments/config.ts`. Change imports:
- `"../types.js"` → `"./types.js"` (for `VariantConfig`)
- Also need `AgentConfig` from `"clawforce"` — import it: `import type { AgentConfig } from "clawforce";`

- [ ] **Step 5: Copy canary.ts**

Copy from `clawforce/src/experiments/canary.ts`. Change imports:
- `"../db.js"` → `"clawforce"`
- `"./lifecycle.js"` stays as-is

- [ ] **Step 6: Copy validation.ts**

Copy from `clawforce/src/experiments/validation.ts`. Change imports:
- `"../db.js"` → `"clawforce"`
- `"../types.js"` → `"./types.js"`

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle.ts src/assignment.ts src/results.ts src/config.ts src/canary.ts src/validation.ts
git commit -m "feat: move experiment core modules from clawforce"
```

---

### Task 5: Create the tool registration

Build the experiment tool that registers via OpenClaw's plugin API.

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/tool.ts`

- [ ] **Step 1: Create tool.ts**

Extract the 8 experiment action cases from `clawforce/src/tools/ops-tool.ts:1300-1481` into a standalone tool factory. The tool will be registered via `api.registerTool()`.

Import from `clawforce` for `getDb`, `writeAuditEntry`. Import from local modules for experiment functions.

```typescript
import { Type } from "@sinclair/typebox";
import { getDb } from "clawforce";
import {
  createExperiment,
  startExperiment,
  pauseExperiment,
  completeExperiment,
  killExperiment,
  getExperiment,
  listExperiments,
} from "./lifecycle.js";
import { getExperimentResults } from "./results.js";
import type { ExperimentState } from "./types.js";

// ... tool factory function that returns the tool definition
// with execute handler containing the 8 experiment actions
```

The tool should follow the same pattern as the claude-code plugin's tool factories — a function that accepts context and returns an agent tool object compatible with `api.registerTool()`.

- [ ] **Step 2: Commit**

```bash
git add src/tool.ts
git commit -m "feat: add experiment tool for OpenClaw plugin registration"
```

---

### Task 6: Create the plugin entry point

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/src/index.ts`

- [ ] **Step 1: Create index.ts**

The entry point exports a `register(api)` function that:
1. Gets the ClawForce DB for the current domain
2. Calls `ensureExperimentTables(db)` 
3. Registers the experiment tool via `api.registerTool()`
4. Registers the dashboard HTTP route for `/experiments` via `api.registerHttpRoute()`

```typescript
import { getDb } from "clawforce";
import { ensureExperimentTables } from "./schema.js";
import { createExperimentTool } from "./tool.js";

export default {
  id: "clawforce-experiments",
  name: "ClawForce Experiments",
  description: "A/B experiment framework for ClawForce agent teams",
  version: "0.1.0",

  register(api: any) {
    // Initialize tables
    // Note: we need the domain/projectId from the runtime context
    // The plugin will init tables lazily on first tool call

    // Register tool
    api.registerTool(createExperimentTool(api));

    api.logger.info("ClawForce Experiments plugin loaded");
  },
};

// Re-export public API for direct consumers
export * from "./types.js";
export * from "./lifecycle.js";
export { assignVariant, getActiveExperimentForProject } from "./assignment.js";
export { recordExperimentOutcome, getExperimentResults } from "./results.js";
export type { ExperimentResults } from "./results.js";
export { checkCanaryHealth } from "./canary.js";
export { validateExperimentConfig } from "./validation.js";
export { mergeVariantConfig } from "./config.js";
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add plugin entry point with register(api)"
```

---

### Task 7: Move tests to plugin package

**Files:**
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/test/e2e-experiment.test.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/test/tool.test.ts`
- Create: `~/workplace/openclaw-plugins/clawforce-experiments/vitest.config.ts`

- [ ] **Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Copy e2e test**

Copy from `clawforce/test/experiments/e2e-experiment.test.ts`. Update imports to use local plugin modules instead of `../../src/experiments/...`. Keep `getMemoryDb` import from `clawforce`.

- [ ] **Step 3: Copy tool test**

Copy from `clawforce/test/tools/ops-experiments.test.ts`. This test currently tests the ops-tool experiment actions — adapt it to test the standalone experiment tool instead.

- [ ] **Step 4: Run tests to verify**

```bash
cd ~/workplace/openclaw-plugins/clawforce-experiments
npm install
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts test/
git commit -m "test: add experiment e2e and tool tests"
```

---

## Chunk 2: Remove Experiments from ClawForce Core

### Task 8: Export missing primitives from ClawForce

Before removing experiments, ensure the primitives the plugin needs are exported.

**Files:**
- Modify: `~/workplace/clawforce/src/index.ts`

- [ ] **Step 1: Add missing exports**

Add to `src/index.ts`:

```typescript
// --- Metrics ---
export { recordMetric } from "./metrics.js";

// --- Audit ---
export { writeAuditEntry } from "./audit.js";
```

Also check that `PerformancePolicy` type is exported (needed by plugin's `VariantConfig`). If not, add it to the type export block.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ~/workplace/clawforce
git add src/index.ts
git commit -m "feat: export recordMetric, writeAuditEntry for plugin consumption"
```

---

### Task 9: Remove experiment files from ClawForce

**Files:**
- Delete: `src/experiments/lifecycle.ts`
- Delete: `src/experiments/assignment.ts`
- Delete: `src/experiments/results.ts`
- Delete: `src/experiments/config.ts`
- Delete: `src/experiments/canary.ts`
- Delete: `src/experiments/validation.ts`
- Delete: `src/sdk/experiments.ts`
- Delete: `test/experiments/e2e-experiment.test.ts`
- Delete: `test/tools/ops-experiments.test.ts`

- [ ] **Step 1: Delete experiment source files**

```bash
cd ~/workplace/clawforce
rm -rf src/experiments/
rm src/sdk/experiments.ts
```

- [ ] **Step 2: Delete experiment test files**

```bash
rm test/experiments/e2e-experiment.test.ts
rm test/tools/ops-experiments.test.ts
rmdir test/experiments/ 2>/dev/null || true
```

- [ ] **Step 3: Commit**

```bash
git add -A src/experiments/ src/sdk/experiments.ts test/experiments/ test/tools/ops-experiments.test.ts
git commit -m "refactor: remove experiment files (moved to plugin)"
```

---

### Task 10: Remove experiment references from SDK

**Files:**
- Modify: `src/sdk/index.ts`

- [ ] **Step 1: Remove ExperimentsNamespace from SDK**

In `src/sdk/index.ts`:
- Remove line 18: `import { ExperimentsNamespace } from "./experiments.js";`
- Remove line 40: `private _experiments?: ExperimentsNamespace;`
- Remove lines 99-101: the `get experiments()` getter

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: errors in other files that still reference experiments — those are handled in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/sdk/index.ts
git commit -m "refactor: remove ExperimentsNamespace from SDK"
```

---

### Task 11: Remove experiment exports from index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Remove experiment section**

Remove lines 262-269 (the `// --- Experiments ---` block with all 7 export lines).

- [ ] **Step 2: Remove experiment types from type export block**

In the `export type { ... } from "./types.js"` block (around line 348-354), remove:
- `ExperimentState,`
- `ExperimentAssignmentStrategy,`
- `CompletionCriteria,`
- `VariantConfig,`
- `ExperimentOutcome,`
- `Experiment,`
- `ExperimentVariant,`

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: remove experiment exports from index.ts"
```

---

### Task 12: Remove experiment types from types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Remove experiment type block**

Remove lines 1608-1685 (the `// --- Experiment framework types ---` section through `ExperimentSession`).

Note: `VariantConfig` references `ContextSource`, `Expectation`, `PerformancePolicy` which are defined earlier in types.ts. Those stay — only the experiment-specific types are removed.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: errors in files that still import experiment types — handled in next tasks.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: remove experiment types from core types"
```

---

### Task 13: Remove experiment actions from ops-tool

**Files:**
- Modify: `src/tools/ops-tool.ts`

- [ ] **Step 1: Remove experiment imports**

Remove lines 56-65:
```typescript
import {
  createExperiment,
  startExperiment,
  pauseExperiment,
  completeExperiment,
  killExperiment,
  getExperiment,
  listExperiments,
} from "../experiments/lifecycle.js";
import { getExperimentResults } from "../experiments/results.js";
import type { ExperimentState } from "../types.js";
```

- [ ] **Step 2: Remove experiment actions from OPS_ACTIONS array**

In the `OPS_ACTIONS` array (around line 79-80), remove:
```
"create_experiment", "start_experiment", "pause_experiment", "complete_experiment",
"kill_experiment", "apply_experiment", "experiment_status", "list_experiments",
```

- [ ] **Step 3: Remove experiment params from schema**

Remove lines 152-161 (the `// experiment management params` block with all `experiment_*` param definitions).

- [ ] **Step 4: Remove experiment action cases**

Remove the entire `// --- Experiment Management ---` block: lines 1300-1481 (from `case "create_experiment"` through the end of `case "list_experiments"`).

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean (or errors in dashboard files, handled next).

- [ ] **Step 6: Commit**

```bash
git add src/tools/ops-tool.ts
git commit -m "refactor: remove experiment actions from ops-tool"
```

---

### Task 14: Remove experiment references from dashboard

**Files:**
- Modify: `src/dashboard/queries.ts`
- Modify: `src/dashboard/routes.ts`
- Modify: `src/dashboard/gateway-routes.ts`

- [ ] **Step 1: Remove queryExperiments from queries.ts**

Remove the `queryExperiments` function (lines 1472-1545 of `src/dashboard/queries.ts`).

- [ ] **Step 2: Remove experiment import and case from routes.ts**

In `src/dashboard/routes.ts`:
- Remove `queryExperiments,` from the imports (line 63)
- Remove the `case "experiments":` block (lines 380-382)

- [ ] **Step 3: Remove experiment references from gateway-routes.ts**

In `src/dashboard/gateway-routes.ts`:
- Remove `queryExperiments,` from the imports (line 57)
- Remove the `case "experiments":` block (lines 472-473)
- Remove `let hasExperiments = false;` (line 533)
- Remove `hasExperiments = true;` (line 544)
- Remove `experiments: hasExperiments,` from features object (line 559)
- Remove `"experiments"` from the endpoints array (line 568)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/queries.ts src/dashboard/routes.ts src/dashboard/gateway-routes.ts
git commit -m "refactor: remove experiment queries and routes from dashboard"
```

---

### Task 15: Remove experiment from api contract and config validator

**Files:**
- Modify: `src/api/contract.ts`
- Modify: `src/config-validator.ts`

- [ ] **Step 1: Remove experiments from CapabilityResponse**

In `src/api/contract.ts:134`, remove `experiments: boolean;` from the `features` type.

- [ ] **Step 2: Remove clawforce_experiment from KNOWN_TOOLS**

In `src/config-validator.ts:43`, remove `"clawforce_experiment",` from the `KNOWN_TOOLS` set.

- [ ] **Step 3: Commit**

```bash
git add src/api/contract.ts src/config-validator.ts
git commit -m "refactor: remove experiment from capabilities and known tools"
```

---

### Task 16: Final verification

- [ ] **Step 1: Run typecheck**

```bash
cd ~/workplace/clawforce
npx tsc --noEmit
```

Expected: clean, no errors.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest --run
```

Expected: all tests pass (count will drop by the experiment tests that were removed).

- [ ] **Step 3: Grep for any remaining experiment references**

```bash
grep -ri "experiment" src/ --include="*.ts" -l
```

Expected: only `src/migrations.ts` (V36 migration DDL, kept for backward compat) and `src/telemetry/session-archive.ts` (`experiment_variant_id` column, nullable backward compat).

- [ ] **Step 4: Commit any fixups if needed**

---

### Task 17: Verify plugin tests pass

- [ ] **Step 1: Run plugin test suite**

```bash
cd ~/workplace/openclaw-plugins/clawforce-experiments
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Verify plugin builds**

```bash
npm run build
```

Expected: clean build with no errors.
