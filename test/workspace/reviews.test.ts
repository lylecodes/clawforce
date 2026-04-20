/**
 * Phase C — workflow review lifecycle tests.
 *
 * Integration-style against a real in-memory DB so we're testing the actual
 * SQL + audit + draft-session transitions, not a mock surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createWorkflow } = await import("../../src/workflow.js");
const {
  createWorkflowDraftSession,
  getWorkflowDraftSessionRecord,
} = await import("../../src/workspace/drafts.js");
const {
  approveWorkflowReview,
  createWorkflowReviewFromDraft,
  getWorkflowReviewRecord,
  listWorkflowReviewRecords,
  rejectWorkflowReview,
} = await import("../../src/workspace/reviews.js");

const DOMAIN = "ws-review-test";

function seedDraft(db: DatabaseSync, overrides: { draftPhases?: { name: string }[] } = {}) {
  const workflow = createWorkflow({
    projectId: DOMAIN,
    name: "Pipeline",
    phases: [{ name: "Build" }, { name: "Ship" }],
    createdBy: "agent:pm",
  }, db);
  const draft = createWorkflowDraftSession({
    projectId: DOMAIN,
    workflowId: workflow.id,
    title: "Insert verify stage",
    createdBy: "agent:pm",
    draftWorkflow: {
      name: workflow.name,
      phases: overrides.draftPhases
        ? overrides.draftPhases.map((p) => ({ name: p.name, taskIds: [], gateCondition: "all_done" as const }))
        : [
            { name: "Build", taskIds: [], gateCondition: "all_done" as const },
            { name: "Verify", taskIds: [], gateCondition: "all_done" as const },
            { name: "Ship", taskIds: [], gateCondition: "all_done" as const },
          ],
    },
  }, db);
  return { workflow, draft };
}

describe("createWorkflowReviewFromDraft", () => {
  let db: DatabaseSync;

  beforeEach(() => { db = getMemoryDb(); });
  afterEach(() => { try { db.close(); } catch { /* already */ } });

  it("creates a pending review, snapshots overlays, and transitions draft to review_pending", () => {
    const { draft } = seedDraft(db);

    const result = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db);
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.record.status).toBe("pending");
    expect(result!.record.draftSessionId).toBe(draft.id);
    expect(result!.record.workflowId).toBe(draft.workflowId);
    expect(result!.record.confirmedBy).toBe("user");
    expect(result!.record.overlays.length).toBeGreaterThan(0);
    expect(result!.record.changeSummary.totalChanges).toBe(result!.record.overlays.length);
    expect(result!.record.affectedStageCount).toBe(result!.record.overlays.length);

    const draftAfter = getWorkflowDraftSessionRecord(DOMAIN, draft.id, db);
    expect(draftAfter?.status).toBe("review_pending");
  });

  it("is idempotent — a second call returns the existing pending review without creating a new row", () => {
    const { draft } = seedDraft(db);
    const first = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    const second = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user2",
    }, db)!;

    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.confirmedBy).toBe("user");

    const all = listWorkflowReviewRecords(DOMAIN, { draftSessionId: draft.id, includeStatuses: ["pending", "approved", "rejected"] }, db);
    expect(all).toHaveLength(1);
  });

  it("returns draft_not_found for a missing draft session", () => {
    const result = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: "no-such-draft",
      confirmedBy: "user",
    }, db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("draft_not_found");
  });

  it("allows confirming a new review after a previous one was resolved", () => {
    const { draft } = seedDraft(db);
    const first = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    // Resolve it
    rejectWorkflowReview({ projectId: DOMAIN, reviewId: first.record.id, actor: "user" }, db);

    const again = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    expect(again.created).toBe(true);
    expect(again.record.id).not.toBe(first.record.id);
  });

  // -------------------------------------------------------------------------
  // Terminal-applied governance guard
  // -------------------------------------------------------------------------
  //
  // Once a draft has been ratified (approve → draft.status === "applied"),
  // the Phase C review lifecycle is terminal. Reconfirming must fail with
  // `draft_terminal` rather than creating a second pending review or
  // regressing the draft back to `review_pending`.

  it("rejects reconfirm of an already-applied draft without creating a new review or regressing state", () => {
    const { draft } = seedDraft(db);
    const first = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    approveWorkflowReview({ projectId: DOMAIN, reviewId: first.record.id, actor: "reviewer" }, db);

    // Draft is now applied (ratified).
    const draftBefore = getWorkflowDraftSessionRecord(DOMAIN, draft.id, db);
    expect(draftBefore?.status).toBe("applied");

    const retry = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("unreachable");
    expect(retry.reason).toBe("draft_terminal");
    expect(retry.currentStatus).toBe("applied");

    // No second review row was created.
    const allReviews = listWorkflowReviewRecords(
      DOMAIN,
      { draftSessionId: draft.id, includeStatuses: ["pending", "approved", "rejected"] },
      db,
    );
    expect(allReviews).toHaveLength(1);
    expect(allReviews[0]!.id).toBe(first.record.id);
    expect(allReviews[0]!.status).toBe("approved");

    // Draft did not regress from applied back to review_pending.
    const draftAfter = getWorkflowDraftSessionRecord(DOMAIN, draft.id, db);
    expect(draftAfter?.status).toBe("applied");

    // No extra `workflow_review.confirm` audit entries were written.
    const confirmAuditRows = db.prepare(
      "SELECT COUNT(*) AS cnt FROM audit_log WHERE project_id = ? AND action = ?",
    ).get(DOMAIN, "workflow_review.confirm") as { cnt: number };
    expect(confirmAuditRows.cnt).toBe(1);
  });
});

describe("approveWorkflowReview", () => {
  let db: DatabaseSync;

  beforeEach(() => { db = getMemoryDb(); });
  afterEach(() => { try { db.close(); } catch { /* already */ } });

  it("transitions review -> approved, draft -> applied, writes audit", () => {
    const { draft } = seedDraft(db);
    const review = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;

    const result = approveWorkflowReview({
      projectId: DOMAIN,
      reviewId: review.record.id,
      actor: "reviewer",
      decisionNotes: "LGTM",
    }, db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.record.status).toBe("approved");
    expect(result.record.resolvedBy).toBe("reviewer");
    expect(result.record.decisionNotes).toBe("LGTM");
    expect(typeof result.record.resolvedAt).toBe("number");

    const draftAfter = getWorkflowDraftSessionRecord(DOMAIN, draft.id, db);
    expect(draftAfter?.status).toBe("applied");

    const auditRows = db.prepare(
      "SELECT action FROM audit_log WHERE project_id = ? AND target_id = ? ORDER BY created_at",
    ).all(DOMAIN, review.record.id) as Array<{ action: string }>;
    expect(auditRows.map((r) => r.action)).toContain("workflow_review.confirm");
    expect(auditRows.map((r) => r.action)).toContain("workflow_review.approve");
  });

  it("returns not_pending when the review is already resolved", () => {
    const { draft } = seedDraft(db);
    const review = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    approveWorkflowReview({ projectId: DOMAIN, reviewId: review.record.id, actor: "reviewer" }, db);
    const second = approveWorkflowReview({ projectId: DOMAIN, reviewId: review.record.id, actor: "reviewer" }, db);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("not_pending");
    expect(second.currentStatus).toBe("approved");
  });

  it("returns not_found for an unknown review", () => {
    const result = approveWorkflowReview({ projectId: DOMAIN, reviewId: "no-such", actor: "reviewer" }, db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_found");
  });
});

describe("rejectWorkflowReview", () => {
  let db: DatabaseSync;

  beforeEach(() => { db = getMemoryDb(); });
  afterEach(() => { try { db.close(); } catch { /* already */ } });

  it("transitions review -> rejected, draft -> discarded, writes audit", () => {
    const { draft } = seedDraft(db);
    const review = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;

    const result = rejectWorkflowReview({
      projectId: DOMAIN,
      reviewId: review.record.id,
      actor: "reviewer",
      decisionNotes: "too risky",
    }, db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.record.status).toBe("rejected");
    expect(result.record.decisionNotes).toBe("too risky");

    const draftAfter = getWorkflowDraftSessionRecord(DOMAIN, draft.id, db);
    expect(draftAfter?.status).toBe("discarded");
  });

  it("returns not_pending when already rejected", () => {
    const { draft } = seedDraft(db);
    const review = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: draft.id,
      confirmedBy: "user",
    }, db)!;
    rejectWorkflowReview({ projectId: DOMAIN, reviewId: review.record.id, actor: "reviewer" }, db);
    const second = rejectWorkflowReview({ projectId: DOMAIN, reviewId: review.record.id, actor: "reviewer" }, db);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("not_pending");
  });
});

describe("listWorkflowReviewRecords + getWorkflowReviewRecord", () => {
  let db: DatabaseSync;

  beforeEach(() => { db = getMemoryDb(); });
  afterEach(() => { try { db.close(); } catch { /* already */ } });

  it("filters by workflowId and status", () => {
    const seededA = seedDraft(db);
    const seededB = seedDraft(db);
    const reviewA = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: seededA.draft.id,
      confirmedBy: "user",
    }, db)!;
    const reviewB = createWorkflowReviewFromDraft({
      projectId: DOMAIN,
      draftSessionId: seededB.draft.id,
      confirmedBy: "user",
    }, db)!;

    // Resolve B
    approveWorkflowReview({ projectId: DOMAIN, reviewId: reviewB.record.id, actor: "user" }, db);

    const pending = listWorkflowReviewRecords(DOMAIN, { includeStatuses: ["pending"] }, db);
    expect(pending.map((r) => r.id)).toEqual([reviewA.record.id]);

    const all = listWorkflowReviewRecords(DOMAIN, { includeStatuses: ["pending", "approved", "rejected"] }, db);
    expect(all.map((r) => r.id).sort()).toEqual([reviewA.record.id, reviewB.record.id].sort());

    const forWorkflowA = listWorkflowReviewRecords(
      DOMAIN,
      { workflowId: seededA.workflow.id, includeStatuses: ["pending", "approved", "rejected"] },
      db,
    );
    expect(forWorkflowA.map((r) => r.id)).toEqual([reviewA.record.id]);
  });

  it("getWorkflowReviewRecord returns null for unknown id", () => {
    expect(getWorkflowReviewRecord(DOMAIN, "no-such", db)).toBeNull();
  });
});
