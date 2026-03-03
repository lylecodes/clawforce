import { describe, expect, it } from "vitest";
import {
  getValidNextStates,
  isValidTransition,
  validateTransition,
} from "../../src/tasks/state-machine.js";
import type { Task, TaskState } from "../../src/types.js";

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    projectId: "proj1",
    title: "Test task",
    state: "OPEN" as TaskState,
    priority: "P2",
    createdBy: "agent:pm",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe("getValidNextStates", () => {
  it("OPEN can go to ASSIGNED, BLOCKED, and CANCELLED", () => {
    const states = getValidNextStates("OPEN");
    expect(states).toContain("ASSIGNED");
    expect(states).toContain("BLOCKED");
    expect(states).toContain("CANCELLED");
  });

  it("ASSIGNED can go to IN_PROGRESS, BLOCKED, FAILED, OPEN, CANCELLED", () => {
    const states = getValidNextStates("ASSIGNED");
    expect(states).toContain("IN_PROGRESS");
    expect(states).toContain("BLOCKED");
    expect(states).toContain("FAILED");
    expect(states).toContain("OPEN");
    expect(states).toContain("CANCELLED");
  });

  it("IN_PROGRESS can go to REVIEW, BLOCKED, FAILED, CANCELLED", () => {
    const states = getValidNextStates("IN_PROGRESS");
    expect(states).toContain("REVIEW");
    expect(states).toContain("BLOCKED");
    expect(states).toContain("FAILED");
    expect(states).toContain("CANCELLED");
  });

  it("REVIEW can go to DONE, IN_PROGRESS, FAILED, CANCELLED", () => {
    const states = getValidNextStates("REVIEW");
    expect(states).toContain("DONE");
    expect(states).toContain("IN_PROGRESS");
    expect(states).toContain("FAILED");
    expect(states).toContain("CANCELLED");
  });

  it("DONE has no valid next states", () => {
    const states = getValidNextStates("DONE");
    expect(states).toEqual([]);
  });

  it("FAILED can go to OPEN or CANCELLED", () => {
    const states = getValidNextStates("FAILED");
    expect(states).toContain("OPEN");
    expect(states).toContain("CANCELLED");
    expect(states).toHaveLength(2);
  });

  it("BLOCKED can go to OPEN, FAILED, or CANCELLED", () => {
    const states = getValidNextStates("BLOCKED");
    expect(states).toContain("OPEN");
    expect(states).toContain("FAILED");
    expect(states).toContain("CANCELLED");
    expect(states).toHaveLength(3);
  });

  it("CANCELLED has no valid next states", () => {
    const states = getValidNextStates("CANCELLED");
    expect(states).toEqual([]);
  });
});

describe("isValidTransition", () => {
  it("returns true for valid transitions", () => {
    expect(isValidTransition("OPEN", "ASSIGNED")).toBe(true);
    expect(isValidTransition("ASSIGNED", "IN_PROGRESS")).toBe(true);
    expect(isValidTransition("IN_PROGRESS", "REVIEW")).toBe(true);
    expect(isValidTransition("REVIEW", "DONE")).toBe(true);
  });

  it("returns false for invalid transitions", () => {
    expect(isValidTransition("OPEN", "DONE")).toBe(false);
    expect(isValidTransition("DONE", "OPEN")).toBe(false);
    expect(isValidTransition("REVIEW", "ASSIGNED")).toBe(false);
  });
});

describe("validateTransition", () => {
  it("returns null for valid transition", () => {
    const error = validateTransition({
      task: makeTask({ state: "OPEN" }),
      toState: "ASSIGNED",
      actor: "agent:worker",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).toBeNull();
  });

  it("returns error with valid next states for invalid transition", () => {
    const error = validateTransition({
      task: makeTask({ state: "OPEN" }),
      toState: "DONE",
      actor: "agent:pm",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("INVALID_TRANSITION");
    expect(error!.message).toContain("ASSIGNED");
    expect(error!.message).toContain("BLOCKED");
  });

  it("enforces verifier gate on REVIEW → DONE", () => {
    const error = validateTransition({
      task: makeTask({ state: "REVIEW", assignedTo: "agent:worker" }),
      toState: "DONE",
      actor: "agent:worker",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("VERIFIER_GATE");
  });

  it("skips verifier gate when verificationRequired is false", () => {
    const error = validateTransition({
      task: makeTask({ state: "REVIEW", assignedTo: "agent:worker" }),
      toState: "DONE",
      actor: "agent:worker",
      hasEvidence: false,
      verificationRequired: false,
    });
    expect(error).toBeNull();
  });

  it("requires evidence for IN_PROGRESS → REVIEW", () => {
    const error = validateTransition({
      task: makeTask({ state: "IN_PROGRESS" }),
      toState: "REVIEW",
      actor: "agent:worker",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("EVIDENCE_REQUIRED");
  });

  it("allows IN_PROGRESS → REVIEW with evidence", () => {
    const error = validateTransition({
      task: makeTask({ state: "IN_PROGRESS" }),
      toState: "REVIEW",
      actor: "agent:worker",
      hasEvidence: true,
      verificationRequired: true,
    });
    expect(error).toBeNull();
  });

  it("blocks FAILED → OPEN when retries exhausted", () => {
    const error = validateTransition({
      task: makeTask({ state: "FAILED", retryCount: 3, maxRetries: 3 }),
      toState: "OPEN",
      actor: "agent:pm",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RETRY_EXHAUSTED");
  });

  it("allows FAILED → OPEN when retries remain", () => {
    const error = validateTransition({
      task: makeTask({ state: "FAILED", retryCount: 1, maxRetries: 3 }),
      toState: "OPEN",
      actor: "agent:pm",
      hasEvidence: false,
      verificationRequired: true,
    });
    expect(error).toBeNull();
  });
});
