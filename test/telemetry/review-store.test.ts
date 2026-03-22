import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  recordReview,
  getReviewsForTask,
  getReviewStats,
} = await import("../../src/telemetry/review-store.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-telemetry";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("recordReview", () => {
  it("creates a review record", () => {
    const review = recordReview({
      projectId: PROJECT,
      taskId: "task-1",
      reviewerAgentId: "manager-1",
      verdict: "approved",
      reasoning: "Code looks good",
    }, db);

    expect(review.id).toBeDefined();
    expect(review.verdict).toBe("approved");
    expect(review.reasoning).toBe("Code looks good");
    expect(review.createdAt).toBeGreaterThan(0);
  });

  it("stores criteria checked as JSON", () => {
    const review = recordReview({
      projectId: PROJECT,
      taskId: "task-2",
      reviewerAgentId: "manager-1",
      verdict: "approved",
      criteriaChecked: ["tests_pass", "code_reviewed", "docs_updated"],
    }, db);

    const reviews = getReviewsForTask(PROJECT, "task-2", db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.criteriaChecked).toEqual(["tests_pass", "code_reviewed", "docs_updated"]);
  });

  it("records revision_needed verdict with notes", () => {
    const review = recordReview({
      projectId: PROJECT,
      taskId: "task-3",
      reviewerAgentId: "manager-1",
      verdict: "revision_needed",
      revisionNotes: "Add error handling for edge case",
      followUpTaskId: "task-3b",
    }, db);

    expect(review.verdict).toBe("revision_needed");
    expect(review.revisionNotes).toBe("Add error handling for edge case");
    expect(review.followUpTaskId).toBe("task-3b");
  });

  it("tracks review duration", () => {
    const review = recordReview({
      projectId: PROJECT,
      taskId: "task-4",
      reviewerAgentId: "manager-1",
      verdict: "approved",
      reviewDurationMs: 5000,
    }, db);

    const reviews = getReviewsForTask(PROJECT, "task-4", db);
    expect(reviews[0]!.reviewDurationMs).toBe(5000);
  });
});

describe("getReviewsForTask", () => {
  it("returns all reviews for a task", () => {
    recordReview({
      projectId: PROJECT,
      taskId: "task-multi",
      reviewerAgentId: "manager-1",
      verdict: "revision_needed",
    }, db);
    recordReview({
      projectId: PROJECT,
      taskId: "task-multi",
      reviewerAgentId: "manager-1",
      verdict: "approved",
    }, db);

    const reviews = getReviewsForTask(PROJECT, "task-multi", db);
    expect(reviews).toHaveLength(2);
  });

  it("returns empty array for unknown task", () => {
    const reviews = getReviewsForTask(PROJECT, "nonexistent", db);
    expect(reviews).toHaveLength(0);
  });
});

describe("getReviewStats", () => {
  it("computes aggregate statistics", () => {
    // 3 approved, 1 rejected, 1 revision_needed
    for (let i = 0; i < 3; i++) {
      recordReview({
        projectId: PROJECT,
        taskId: `task-${i}`,
        reviewerAgentId: "manager-1",
        verdict: "approved",
      }, db);
    }
    recordReview({
      projectId: PROJECT,
      taskId: "task-rej",
      reviewerAgentId: "manager-1",
      verdict: "rejected",
    }, db);
    recordReview({
      projectId: PROJECT,
      taskId: "task-rev",
      reviewerAgentId: "manager-1",
      verdict: "revision_needed",
    }, db);

    const stats = getReviewStats(PROJECT, db);
    expect(stats.total).toBe(5);
    expect(stats.approved).toBe(3);
    expect(stats.rejected).toBe(1);
    expect(stats.revisionNeeded).toBe(1);
    expect(stats.deferred).toBe(0);
    expect(stats.approvalRate).toBeCloseTo(0.6, 2);
  });

  it("returns zero stats for empty project", () => {
    const stats = getReviewStats(PROJECT, db);
    expect(stats.total).toBe(0);
    expect(stats.approvalRate).toBe(0);
  });
});
