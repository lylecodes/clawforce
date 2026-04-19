# Dashboard V2 — Phase A Implementation Plan

> Written: 2026-04-19
> Scope: **core repo only** — `/Users/lylejens/workplace/clawforce`
> Drives: `docs/plans/2026-04-19-dashboard-v2-implementation-brief.md` §Phase A
> Product stance: `docs/DASHBOARD_PRODUCT_STANCE.md`

## Goal

Add the minimum **read-side** framework contracts the v2 workspace shell will
render against, without touching any dashboard UI code and without inventing a
parallel state system.

Phase A covers four contracts only:

1. project workspace query
2. workflow topology query
3. stage inspector query
4. scoped feed query

Phase B (draft sessions / overlays), Phase C (review loop), Phase D (helper) are
out of scope. Types are shaped so later phases extend them without breaking
changes.

## Grounding — what already exists

| Concept | Current location | Notes |
|---|---|---|
| Project/domain identity | `src/project.ts` | `domain` in gateway URL maps 1:1 to `projectId` in every query function. No separate "workspace" entity. |
| Workflow | `src/workflow.ts`, `Workflow` type at `src/types.ts:89` | Has `phases[]`, `currentPhase`, `state: active \| completed \| failed`. Persisted in `workflows` table. |
| Stage | — | No first-class type. `WorkflowPhase` (`src/types.ts:101`) is the closest analogue: `{ name, description?, taskIds[], gateCondition? }`. No stable id beyond array index. |
| Task ↔ workflow linkage | `tasks.workflow_id`, `tasks.workflow_phase` columns, set by `addTaskToPhase` | Makes it trivial to resolve stage → tasks. |
| Attention/feed | `src/attention/builder.ts`, `src/attention/types.ts` | Canonical `AttentionItem` already carries `projectId`, optional `entityId`, `taskId`. Scoped only by project today. |
| Dashboard query surface | `src/dashboard/queries.ts` (3290 lines) | Every reader returns a typed shape consumed by the gateway router. |
| Dashboard contract types | `src/api/contract.ts` | Re-exports `AttentionSummary`. |
| Gateway read router | `src/app/queries/dashboard-read-router.ts:421` (`routeGatewayDomainRead`) | Resource dispatch on `/clawforce/api/:domain/:resource/*`. |
| Test pattern A (queries) | `test/dashboard/queries.test.ts` | Heavy `vi.mock()` on downstream deps. |
| Test pattern B (integration) | `test/workflow.test.ts`, `test/attention/builder.test.ts` | Real in-memory DB via `getMemoryDb()` + real workflow/task creation. |

## Design decisions

### Scope is a first-class response field

Every new response includes:

```ts
scope: { kind: "project" | "workflow" | "stage", domainId, workflowId?, stageKey? }
```

The UI should never infer scope. Also surfaces scope in tests, which makes
shape contract assertions trivial.

### Stable stage key

`WorkflowPhase` has no stored id. For Phase A we use a deterministic,
derivable key:

```
stageKey = `${workflowId}:phase:${phaseIndex}`
```

- Stable per workflow version because phases live in a single JSON blob.
- If a future draft session restructures phases, the key changes — that is
  intentional, and Phase B's draft overlay will carry both `liveStageKey` and
  `draftStageKey` to keep truth explicit.
- The new types reserve `stageId?: string` as optional for Phase B promotion.

### Live vs draft vs review

- Phase A returns only `live` state.
- Types include `draftOverlays: never[]` / `draftSessions: never[]` as
  **present but empty** arrays where the brief says they'll eventually live,
  so Phase B's widening isn't a breaking change.
- Each workflow response has an explicit `liveState: "active" | "completed" | "failed"` and a `hasDraftOverlays: false` flag, so dashboard code writes for the real multi-state world from day one.

### Feed is not a new event system

`queryScopedWorkspaceFeed` reuses `buildAttentionSummary(projectId)` and
filters. It **never** invents a second event stream.

Filtering rules (Phase A):

- `scope.kind = "project"` → pass-through.
- `scope.kind = "workflow"` → keep items whose `taskId` belongs to a task in
  that workflow, or whose `metadata.workflowId === workflowId`.
- `scope.kind = "stage"` → keep items whose `taskId` belongs to a task with
  matching `workflow_id` AND `workflow_phase`.
- Items that are project-wide (budget, emergency stop, health) are always
  included at project scope, and surfaced at workflow/stage scope only if
  `urgency = "action-needed"` (so the operator still sees critical,
  cross-cutting signals while focused) — marked with `crossScope: true`.

Note: we do **not** add new `AttentionKind` values. Workflow/stage events
flow through existing `category: "task"` / `"compliance"` / `"approval"`
items that are already emitted by the attention builder.

## Files to add / change

### New

- `src/workspace/types.ts` — public contract types (scope union, `ProjectWorkspace`, `WorkflowTopology`, `WorkflowMiniTopology`, `WorkflowStageSummary`, `WorkflowStageEdge`, `WorkflowStageInspector`, `ScopedWorkspaceFeed`).
- `src/workspace/queries.ts` — `queryProjectWorkspace`, `queryWorkflowTopology`, `queryWorkflowStageInspector`, `queryScopedWorkspaceFeed`.
- `test/workspace/queries.test.ts` — shape + scope + feed-filter coverage against real in-memory DB.
- `test/app/queries/dashboard-read-router-workspace.test.ts` — router dispatch + 404 coverage for the four new resources.

### Changed

- `src/api/contract.ts` — re-export from `src/workspace/types.js` so the dashboard imports through the contract as it does for every other surface.
- `src/dashboard/queries.ts` — re-export the four new query functions (keeps the canonical import path stable for the gateway).
- `src/dashboard/index.ts` — barrel export of workspace queries and types.
- `src/app/queries/dashboard-read-router.ts` — new cases in `routeGatewayDomainRead`:
  - `workspace` → `queryProjectWorkspace`
  - `workspace/feed` (supports `?workflowId=`, `?stageKey=`, optional `?scope=project|workflow|stage` — inferred when omitted) → `queryScopedWorkspaceFeed`
  - `workflows/:workflowId/topology` → `queryWorkflowTopology`
  - `workflows/:workflowId/stages/:stageKey` → `queryWorkflowStageInspector`

## Implementation order

1. Types (`src/workspace/types.ts`) — start from the contract so queries and tests are both typed against the same shape.
2. Query implementations (`src/workspace/queries.ts`).
3. Dashboard barrel re-exports (`src/dashboard/queries.ts`, `src/dashboard/index.ts`, `src/api/contract.ts`).
4. Gateway router wiring.
5. Tests (query-level, then router-level).
6. Verification: `pnpm typecheck`, targeted vitest, `pnpm build`.

## Test plan

**Query shape coverage (integration-style, real DB):**

- `queryProjectWorkspace` returns `scope.kind === "project"`, at least one real workflow summary with a mini topology containing `Start`/`End` markers, and an empty `draftSessions: []`.
- `queryWorkflowTopology` returns N stages matching `workflow.phases.length`, edges connecting adjacent phases, `liveState` equal to workflow state, and `hasDraftOverlays === false`.
- `queryWorkflowStageInspector`:
  - returns the stage for a valid `stageKey`
  - returns `null` for an unknown stage or workflow
  - includes tasks currently assigned to that phase with stable ids
  - reports the gate condition and `currentPhase` comparison honestly
- `queryScopedWorkspaceFeed`:
  - project scope yields the same items as `buildAttentionSummary`
  - workflow scope narrows to items whose tasks belong to the workflow (and cross-scope critical items)
  - stage scope narrows further to a single phase
  - switching scope does not introduce a second event source (spy on the attention builder: called exactly once per call)

**Router coverage:**

- Each of the four new resource paths dispatches to the right query and returns 200.
- Unknown workflow/stage → 404.
- `workspace/feed` without explicit scope defaults to project.

## Verification commands

```
pnpm typecheck
npx vitest --run test/workspace test/dashboard test/app/queries test/attention
pnpm build
```

The vitest scope is deliberate — covers the new tests and regressed surfaces
without running the entire 4269-test suite on every iteration.

## Explicitly deferred to later phases

- All write/mutation surfaces (draft create/toggle/confirm, review approve/reject, helper session).
- Draft overlay rendering on canvas (Phase B).
- Review detail query + `WorkflowReview` type (Phase C).
- Helper session types + helper-authored workflow drafts (Phase D).
- Dashboard-side: canvas layout math, scope routing, rail UIs, any SPA work.

## Explicitly not touched

- OpenClaw packages.
- Any mutation code paths.
- `WorkflowPhase` schema (no `id` field added yet).
- `AttentionItem` schema (no new kinds for v1).
- Migrations.
