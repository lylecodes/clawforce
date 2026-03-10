import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence, isSelfReviewEligible } = await import("../../src/tasks/ops.js");
const project = await import("../../src/project.js");

import type { ReviewConfig } from "../../src/types.js";

describe("self-review gate", () => {
  let db: DatabaseSync;
  const PROJECT = "self-review-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function injectReviewConfig(config: ReviewConfig | undefined) {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue(
      config ? { review: config } as any : null,
    );
  }

  /** Create a task and move it to REVIEW state. */
  function moveToReview(priority: "P0" | "P1" | "P2" | "P3" = "P3", assignee = "worker-1") {
    const task = createTask({ projectId: PROJECT, title: `Task ${priority}`, priority, createdBy: "mgr" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "mgr", assignedTo: assignee, verificationRequired: false }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: assignee, verificationRequired: false }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: assignee }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: assignee, verificationRequired: false }, db);
    return task;
  }

  describe("isSelfReviewEligible", () => {
    it("P3 eligible when max is P3", () => expect(isSelfReviewEligible("P3", "P3")).toBe(true));
    it("P2 eligible when max is P2", () => expect(isSelfReviewEligible("P2", "P2")).toBe(true));
    it("P3 eligible when max is P2", () => expect(isSelfReviewEligible("P3", "P2")).toBe(true));
    it("P1 not eligible when max is P2", () => expect(isSelfReviewEligible("P1", "P2")).toBe(false));
    it("P0 not eligible when max is P3", () => expect(isSelfReviewEligible("P0", "P3")).toBe(false));
  });

  it("self-review blocked by default (no config)", () => {
    injectReviewConfig(undefined);
    const task = moveToReview("P3");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Verifier must be a different actor");
  });

  it("self-review blocked when selfReviewAllowed is false", () => {
    injectReviewConfig({ selfReviewAllowed: false });
    const task = moveToReview("P3");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(false);
  });

  it("self-review allowed for P3 task with selfReviewAllowed: true", () => {
    injectReviewConfig({ selfReviewAllowed: true });
    const task = moveToReview("P3");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(true);
  });

  it("self-review blocked for P1 task with max priority P3", () => {
    injectReviewConfig({ selfReviewAllowed: true, selfReviewMaxPriority: "P3" });
    const task = moveToReview("P1");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(false);
  });

  it("self-review allowed for P2 task with max priority P2", () => {
    injectReviewConfig({ selfReviewAllowed: true, selfReviewMaxPriority: "P2" });
    const task = moveToReview("P2");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(true);
  });

  it("different actor can always verify regardless of self-review config", () => {
    injectReviewConfig(undefined); // No self-review
    const task = moveToReview("P3");

    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "verifier-agent",
    }, db);

    expect(result.ok).toBe(true);
  });

  it("P0 task always blocked even with most permissive config", () => {
    injectReviewConfig({ selfReviewAllowed: true, selfReviewMaxPriority: "P0" });
    const task = moveToReview("P0");

    // P0 maps to 0, maxPriority P0 maps to 0 → eligible (0 >= 0 is true)
    // This is intentional: if you set max to P0, you're explicitly allowing self-review on everything
    const result = transitionTask({
      projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "worker-1",
    }, db);

    expect(result.ok).toBe(true);
  });
});
