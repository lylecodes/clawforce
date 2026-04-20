# Phase C — Workflow Review Loop (Core)

> Written: 2026-04-19
> Scope: `/Users/lylejens/workplace/clawforce` only.
> Drives: `docs/plans/2026-04-19-dashboard-v2-implementation-brief.md` §Phase C.
> Builds on: `1530d08` (Phase B draft session core), `f39c177` (draft visibility action).

## Goal

Turn a confirmed workflow draft session into a **first-class, auditable,
framework-backed review** that flows through the canonical operator feed.
Approve and reject are real mutations with explicit state transitions.

Phase C does **not** mutate the live workflow on approval — it ratifies the
draft. Actually applying the draft onto the workflow is a later concern and
is called out explicitly in-code so it is obvious it is not silently skipped.

## Grounding — what already exists

| Concern | Location |
|---|---|
| Draft session store | `src/workspace/drafts.ts` — `createWorkflowDraftSession`, `setWorkflowDraftSessionVisibility`, `listWorkflowDraftSessionRecords`, `getWorkflowDraftSessionRecord`, `toWorkflowDraftSessionSummary`, `toWorkflowDraftSessionDetail`, `diffDraftWorkflow`, `summarizeOverlays` |
| Draft session types | `src/workspace/types.ts` — `WorkflowDraftSessionStatus: "draft" \| "review_pending" \| "applied" \| "discarded"` already in place |
| Draft migration | `src/migrations.ts:V55` (table `workflow_draft_sessions`) |
| Workspace queries | `src/workspace/queries.ts` — already returns `draftSessions[]` + `draftOverlays[]` on `WorkflowTopology`/`ProjectWorkspace` |
| Canonical attention builder | `src/attention/builder.ts` — `detectApprovals`, `detectApprovedPendingExecution`, etc. Category `"approval"` exists; `kind: "approval"` exists. `item(...)` helper builds entries |
| Proposal pattern we mirror | `src/approval/resolve.ts` — `listPendingProposals`, `approveProposal`, `rejectProposal`. Table `proposals` with `status pending\|approved\|rejected`, `resolved_at`, `user_feedback`, audit entries |
| Dashboard POST dispatcher | `src/dashboard/actions.ts` — `handleAction` -> `handleWorkspaceAction` already handles `workspace/drafts/:id/visibility`; `handleApprovalAction` pattern for `approvals/:id/approve`\|`reject` |
| Read router | `src/app/queries/dashboard-read-router.ts` — `routeGatewayDomainRead` case switch |
| SSE | `emitSSE(domain, event, payload)` — already used by `workspace:draft`; we add `workspace:review` |
| Audit | `src/audit.ts` — `writeAuditEntry({projectId, actor, action, targetType, targetId, detail})` |

## Design decisions

1. **Separate `workflow_reviews` table, not reuse `proposals`.** Reviews are
   bound 1:1 to a draft session and expose a distinct lifecycle that the
   proposal table does not carry (execution_status, risk_tier, etc. would be
   mis-typed here). Reuse lands us in a type-collision mess; separation keeps
   both tables honest. The attention model still uses the canonical
   `category: "approval"` — reviews and proposals share the operator inbox,
   not the storage schema.
2. **Confirmation is a state transition, not an orphan event.** Confirming a
   draft creates one review row and transitions the draft from
   `draft`/`review_pending` to `review_pending` (idempotent). The FK is
   `draft_session_id`.
3. **Approve = ratify, not apply.** Approve transitions the review from
   `pending` → `approved` and marks the draft session `applied`. The
   "materialize onto the live workflow" step is deferred (explicitly
   documented — a `// TODO: Phase D/E — materialize draft onto live workflow`
   comment lives at the transition site). Reject transitions review →
   `rejected` and draft → `discarded`.
4. **Scope widening, not a new scope surface in URL.** `WorkspaceScope` is
   extended with `{ kind: "review", domainId, workflowId, reviewId }` so the
   topology response can carry review-scoped items, but the dashboard Phase C
   pass will use it via existing workflow scope; we don't add a new URL path
   segment here.
5. **Feed integration via canonical semantics only.** `detectWorkflowReviews`
   pushes items with `category: "approval"`, `kind: "approval"`, metadata
   carrying `{ reviewId, draftSessionId, workflowId, requiresDecision: true }`.
   No new event system, no new category.

## Schema

Migration **V56** in `src/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS workflow_reviews (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  draft_session_id    TEXT NOT NULL,
  workflow_id         TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  confirmed_by        TEXT NOT NULL,
  resolved_by         TEXT,
  decision_notes      TEXT,
  change_summary      TEXT NOT NULL, -- JSON(WorkflowDraftChangeSummary) snapshot
  affected_stage_count INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_reviews_project
  ON workflow_reviews(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_reviews_workflow
  ON workflow_reviews(project_id, workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_reviews_status
  ON workflow_reviews(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_reviews_draft
  ON workflow_reviews(project_id, draft_session_id);
```

Bump `SCHEMA_VERSION = 56`.

## Types (extensions to `src/workspace/types.ts`)

```ts
export type WorkflowReviewStatus = "pending" | "approved" | "rejected";

export type WorkflowReviewSummary = {
  scope: Extract<WorkspaceScope, { kind: "review" }>;
  id: string;
  workflowId: string;
  workflowName: string;
  draftSessionId: string;
  title: string;
  summary?: string;
  status: WorkflowReviewStatus;
  changeSummary: WorkflowDraftChangeSummary;
  affectedStageCount: number;
  confirmedBy: string;
  resolvedBy?: string;
  decisionNotes?: string;
  createdAt: number;
  resolvedAt?: number;
};

export type WorkflowReview = WorkflowReviewSummary & {
  overlays: WorkflowDraftStageOverlay[]; // captured at confirm time
  draftSession: WorkflowDraftSessionSummary; // snapshot of the linked draft
};

// WorkspaceScope union gains:
//   | { kind: "review"; domainId: string; workflowId: string; reviewId: string };
```

`WorkflowTopology` gains `reviews: WorkflowReviewSummary[]` (pending only).
`ProjectWorkspace` gains `reviews: WorkflowReviewSummary[]` (all pending across the domain).

## New module: `src/workspace/reviews.ts`

Functions:

- `createWorkflowReviewFromDraft({projectId, draftSessionId, confirmedBy, title?, summary?}, db?)` — reads `getWorkflowDraftSessionRecord`, idempotency guard (if a `pending` review already exists for this draft, return it), snapshots overlays + change summary into the row, transitions draft `.status` → `review_pending` (idempotent if already), writes audit `workflow_review.confirm`. Returns record.
- `approveWorkflowReview({projectId, reviewId, actor, decisionNotes?}, db?)` — transitions `pending` → `approved`, sets `resolved_at/by/notes`, transitions linked draft session `.status` → `applied`, writes audit `workflow_review.approve`. Returns record. Returns `null` when not found; throws only for invalid-state transitions with a clear reason.
- `rejectWorkflowReview({projectId, reviewId, actor, decisionNotes?}, db?)` — transitions `pending` → `rejected`, sets `resolved_at/by/notes`, transitions linked draft session `.status` → `discarded`, writes audit `workflow_review.reject`.
- `getWorkflowReviewRecord(projectId, reviewId, db?)`
- `listWorkflowReviewRecords(projectId, {workflowId?, includeStatuses?, draftSessionId?}, db?)`
- `toWorkflowReviewSummary(record, draftName)` pure
- `toWorkflowReviewDetail(record, overlaysJson, draftSummary)` pure

Idempotency policy is explicit in doc comments.

## Workspace queries (`src/workspace/queries.ts`)

- `queryWorkflowReview(domainId, reviewId, db?)` → `WorkflowReview | null`
- `queryWorkflowReviews(domainId, {workflowId?, includeStatuses?}, db?)` → `WorkflowReviewSummary[]`
- Widen `queryWorkflowTopology` to include `reviews: [...]` (status = `pending`, filtered to that workflow)
- Widen `queryProjectWorkspace` to include `reviews: [...]` (all pending for the domain)

## Gateway router (`src/app/queries/dashboard-read-router.ts`)

Under `routeGatewayDomainRead`:

- `workflow-reviews` → list (query params: `status`, `workflowId`)
- `workflow-reviews/:id` → detail

## Write-side (`src/dashboard/actions.ts`)

- Extend `handleWorkspaceAction` so `workspace/drafts/:id/confirm` creates a review:
  - body: `{ actor?, title?, summary? }`
  - calls `createWorkflowReviewFromDraft`
  - emits SSE `workspace:review` with `{ reviewId, workflowId, draftSessionId, status: "pending" }`
- New top-level `workflow-reviews` action resource:
  - `workflow-reviews/:id/approve` → `approveWorkflowReview`
  - `workflow-reviews/:id/reject` → `rejectWorkflowReview`
  - emit SSE `workspace:review` with `{ reviewId, workflowId, status }`

## Feed integration (`src/attention/builder.ts`)

- Add `detectWorkflowReviews(projectId, db, items)` reading
  `listWorkflowReviewRecords(projectId, { includeStatuses: ["pending"] })`.
- Each pending review pushes an `item(...)` with:
  - `urgency: "action-needed"`, `kind: "approval"`, `category: "approval"`
  - title: `"Workflow review: ${title}"`; summary derived from change summary
  - `destination: "/workspaces/${domainId}/workflows/${workflowId}"` (or similar — the dashboard surfaces it from there in Phase C)
  - `metadata: { reviewId, draftSessionId, workflowId, affectedStageCount, requiresDecision: true }`
  - `sourceType: "workflow_review"`, `sourceId: reviewId`
- Called from `buildAttentionSummary` alongside `detectApprovals`.
- No new category, no new event system.

## Tests

1. `test/workspace/reviews.test.ts` (new) — unit-ish, real in-memory DB:
   - confirm creates review, transitions draft `review_pending`, writes audit
   - confirm is idempotent (second call returns same review)
   - approve transitions review `approved` + draft `applied` + audit
   - reject transitions review `rejected` + draft `discarded` + audit
   - approve/reject on non-pending review returns null or throws with clear reason
2. `test/workspace/queries.test.ts` (extend) — topology now includes pending review, project includes pending reviews.
3. `test/attention/builder.test.ts` (extend) — pending review surfaces as `action-needed` / `category: "approval"` with review metadata.
4. `test/dashboard/workspace-reviews-actions.test.ts` (new) OR extend `test/dashboard/actions.test.ts` — POST dispatch for `workspace/drafts/:id/confirm`, `workflow-reviews/:id/approve`, `workflow-reviews/:id/reject`.
5. `test/app/queries/dashboard-read-router-workspace.test.ts` (extend) — new read routes.

## Verification

```
pnpm typecheck
./scripts/with-runtime-node.sh ./node_modules/vitest/vitest.mjs run test/workspace test/dashboard test/app/queries test/attention
pnpm build
git status --short   # must be empty after commit
```

## Explicit non-goals

- Actually materializing the draft onto the live workflow on approve.
- New review-scope URL path in the dashboard. The `review` scope value in
  `WorkspaceScope` exists so later phases can wire it; Phase C does not add a
  route.
- Changing the `proposals` table or any existing approval semantics.
- Emitting a new event category. Reviews flow through `category: "approval"`.
- Exposing review-list surface in the top-level dashboard top bar.
