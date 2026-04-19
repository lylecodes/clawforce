import { describe, expect, it } from "vitest";

import { buildTaskPrompt } from "../../src/dispatch/spawn.js";
import type { Task } from "../../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "demo",
    title: "Open onboarding for Fresno",
    description: "Open governed onboarding work for Fresno.",
    state: "ASSIGNED",
    priority: "P2",
    createdBy: "system:test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  } as Task;
}

describe("buildTaskPrompt", () => {
  it("adds linked entity issue focus for reactive entity issue tasks", () => {
    const prompt = buildTaskPrompt(makeTask({
      metadata: {
        entityIssue: {
          issueId: "issue-123",
          issueKey: "onboarding:requested",
          issueType: "onboarding_request",
          playbook: "jurisdiction-onboarding",
        },
      },
    }), "Execute task: Open onboarding for Fresno");

    expect(prompt).toContain("## Linked Entity Issue");
    expect(prompt).toContain("Issue id: issue-123");
    expect(prompt).toContain("Issue key: onboarding:requested");
    expect(prompt).toContain("Treat the linked entity issue for this task as the primary source of truth.");
    expect(prompt).toContain("If the issue is still open and unowned, create or update the governed follow-on work needed to move it forward before you finish.");
  });

  it("does not add entity issue focus when the task has no linked issue metadata", () => {
    const prompt = buildTaskPrompt(makeTask(), "Do the work");
    expect(prompt).not.toContain("## Linked Entity Issue");
    expect(prompt).not.toContain("## Issue Focus");
  });
});
