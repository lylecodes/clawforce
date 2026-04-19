/**
 * Clawforce — State machine + policy engine
 *
 * Defines valid transitions and enforces policy rules:
 * - Verifier gate: REVIEW → DONE/FAILED requires different actor than assignee
 * - Evidence required for IN_PROGRESS → REVIEW
 * - Retry limits enforced on FAILED → OPEN
 */

import type { Task, TaskState } from "../types.js";

export type TransitionRule = {
  from: TaskState;
  to: TaskState;
};

/** All valid transitions in the state machine. */
const VALID_TRANSITIONS: TransitionRule[] = [
  // Happy path
  { from: "OPEN", to: "ASSIGNED" },
  { from: "ASSIGNED", to: "IN_PROGRESS" },
  { from: "IN_PROGRESS", to: "REVIEW" },
  { from: "REVIEW", to: "DONE" },

  // Rework on review failure
  { from: "REVIEW", to: "IN_PROGRESS" },

  // Review → failed (max retries)
  { from: "REVIEW", to: "FAILED" },

  // Retry from failed
  { from: "FAILED", to: "OPEN" },

  // Blocking (any active state can be blocked)
  { from: "OPEN", to: "BLOCKED" },
  { from: "ASSIGNED", to: "BLOCKED" },
  { from: "IN_PROGRESS", to: "BLOCKED" },
  { from: "REVIEW", to: "BLOCKED" },
  { from: "BLOCKED", to: "OPEN" },
  { from: "BLOCKED", to: "ASSIGNED" },

  // Direct failure from any active state
  { from: "ASSIGNED", to: "FAILED" },
  { from: "IN_PROGRESS", to: "FAILED" },

  // Cancel / reassign
  { from: "ASSIGNED", to: "OPEN" },
  { from: "IN_PROGRESS", to: "ASSIGNED" },

  // Direct failure from blocked (enables deadline enforcement on blocked tasks)
  { from: "BLOCKED", to: "FAILED" },

  // Cancellation (terminal — no retry, no evidence required)
  { from: "OPEN", to: "CANCELLED" },
  { from: "ASSIGNED", to: "CANCELLED" },
  { from: "IN_PROGRESS", to: "CANCELLED" },
  { from: "REVIEW", to: "CANCELLED" },
  { from: "BLOCKED", to: "CANCELLED" },
  { from: "FAILED", to: "CANCELLED" },
];

const transitionSet = new Set(VALID_TRANSITIONS.map((t) => `${t.from}->${t.to}`));

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return transitionSet.has(`${from}->${to}`);
}

/** Get all valid next states from a given state. */
export function getValidNextStates(from: TaskState): TaskState[] {
  return VALID_TRANSITIONS
    .filter((t) => t.from === from)
    .map((t) => t.to);
}

export type ValidationContext = {
  task: Task;
  toState: TaskState;
  actor: string;
  hasEvidence: boolean;
  verificationRequired: boolean;
};

export type ValidationError = {
  code: "INVALID_TRANSITION" | "VERIFIER_GATE" | "EVIDENCE_REQUIRED" | "RETRY_EXHAUSTED" | "PARENT_NOT_DONE";
  message: string;
};

/**
 * Validate a proposed transition, returning null if valid or an error if not.
 */
export function validateTransition(ctx: ValidationContext): ValidationError | null {
  const { task, toState, actor, hasEvidence, verificationRequired } = ctx;

  // 1. Check the transition is structurally valid
  if (!isValidTransition(task.state, toState)) {
    const validNext = getValidNextStates(task.state);
    const validStr = validNext.length > 0 ? validNext.join(", ") : "none";
    return {
      code: "INVALID_TRANSITION",
      message: `Cannot transition from ${task.state} to ${toState}. Valid next states: ${validStr}`,
    };
  }

  // 2. Verifier gate: REVIEW → DONE or REVIEW → FAILED or REVIEW → IN_PROGRESS
  //    Actor must differ from the assignee
  if (
    task.state === "REVIEW" &&
    (toState === "DONE" || toState === "FAILED" || toState === "IN_PROGRESS") &&
    verificationRequired
  ) {
    if (actor === task.assignedTo) {
      return {
        code: "VERIFIER_GATE",
        message: "Verifier must be a different actor than the assignee (no self-grading)",
      };
    }
  }

  // 3. Evidence required for IN_PROGRESS → REVIEW
  if (task.state === "IN_PROGRESS" && toState === "REVIEW" && !hasEvidence) {
    return {
      code: "EVIDENCE_REQUIRED",
      message: "Evidence must be attached before transitioning to REVIEW",
    };
  }

  // 4. Retry limit for FAILED → OPEN
  if (task.state === "FAILED" && toState === "OPEN") {
    if (task.retryCount >= task.maxRetries) {
      return {
        code: "RETRY_EXHAUSTED",
        message: `Max retries (${task.maxRetries}) exhausted — cannot retry`,
      };
    }
  }

  return null;
}
