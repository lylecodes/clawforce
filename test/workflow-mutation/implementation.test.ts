import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseSync } from "../../src/sqlite-driver.js";

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, attachEvidence, getTask } = await import("../../src/tasks/ops.js");
const {
  buildWorkflowMutationImplementationDescription,
  maybeNormalizeWorkflowMutationImplementationTask,
} = await import("../../src/workflow-mutation/implementation.js");

describe("workflow-mutation implementation description", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it("extracts a compact result summary from review evidence", () => {
    const description = buildWorkflowMutationImplementationDescription({
      subject: "San Francisco",
      sourceTaskId: "source-task",
      sourceTaskTitle: "Remediate San Francisco",
      reviewTaskId: "review-task",
      reviewTaskTitle: "Restructure workflow for San Francisco",
      reviewDescription: undefined,
      reviewEvidence: [
        "**Result**",
        "",
        "Route the blocked verifier through the fallback backend task so the rerun can proceed without operator steering.",
        "",
        "**Verification**",
        "",
        "- targeted test passed",
      ].join("\n"),
      reasonCode: "verification_environment_blocked",
      mutationCategory: "verification_path",
    });

    expect(description).toContain("Accepted recommendation summary:");
    expect(description).toContain("Route the blocked verifier through the fallback backend task");
    expect(description).not.toContain("**Verification**");
  });

  it("repairs stale implementation tasks that still contain transcript dumps", () => {
    const reviewTask = createTask({
      projectId: PROJECT,
      title: "Restructure workflow for repeated semantic_mismatch across 3 jurisdictions",
      description: [
        "Recommended changes:",
        "- Route the repeated CPI-formula semantic mismatch through one workflow mutation instead of duplicate owner loops.",
        "- Rerun the affected issue checks after the shared mutation lands.",
        "",
        "Acceptance criteria:",
        "- Stop duplicate remediation churn.",
      ].join("\n"),
      createdBy: "system",
    }, db);

    attachEvidence({
      projectId: PROJECT,
      taskId: reviewTask.id,
      type: "output",
      content: "**Result**\n\nThis evidence should not be needed because the description already has a clean recommendation.",
      attachedBy: "system",
    }, db);

    const implementationTask = createTask({
      projectId: PROJECT,
      title: "Implement workflow mutation for 3 jurisdictions: workflow gap",
      description: [
        "Accepted recommendation:",
        "Reading additional input from stdin...",
        "OpenAI Codex v0.118.0 (research preview)",
        "<system_context>",
        "## Work Board",
      ].join("\n"),
      createdBy: "system:workflow-mutation",
      assignedTo: "workflow-steward",
      metadata: {
        workflowMutationStage: "implementation",
        sourceTaskId: "source-task",
        sourceTaskTitle: "Remediate Los Angeles County",
        reviewTaskId: reviewTask.id,
        reasonCode: "workflow_gap",
        mutationCategory: "workflow_routing",
      },
    }, db);

    const normalized = maybeNormalizeWorkflowMutationImplementationTask(PROJECT, implementationTask, db);
    const stored = getTask(PROJECT, implementationTask.id, db);

    expect(normalized.description).toContain("Accepted recommendation summary:");
    expect(normalized.description).toContain("Route the repeated CPI-formula semantic mismatch through one workflow mutation");
    expect(normalized.description).not.toContain("Reading additional input from stdin");
    expect(stored?.description).toBe(normalized.description);
  });
});
