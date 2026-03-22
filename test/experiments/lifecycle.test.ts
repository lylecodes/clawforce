/**
 * Tests for experiment lifecycle: create, start, pause, complete, kill.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "k",
    identityToken: "t",
    issuedAt: 0,
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const {
  createExperiment,
  startExperiment,
  pauseExperiment,
  completeExperiment,
  killExperiment,
  getExperiment,
  listExperiments,
  checkExperimentCompletion,
} = await import("../../src/experiments/lifecycle.js");

const PROJECT = "test-project";

function makeVariants() {
  return [
    { name: "control", isControl: true, config: {} },
    { name: "treatment", isControl: false, config: { persona: "Be concise" } },
  ];
}

describe("experiment lifecycle", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // --- create ---

  describe("createExperiment", () => {
    it("creates an experiment in draft state", () => {
      const exp = createExperiment(PROJECT, {
        name: "persona-test",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(exp.id).toBeTruthy();
      expect(exp.name).toBe("persona-test");
      expect(exp.state).toBe("draft");
      expect(exp.variants).toHaveLength(2);
    });

    it("creates variants with correct control flag", () => {
      const exp = createExperiment(PROJECT, {
        name: "v-test",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      const control = exp.variants.find(v => v.name === "control");
      const treatment = exp.variants.find(v => v.name === "treatment");
      expect(control?.isControl).toBe(true);
      expect(treatment?.isControl).toBe(false);
    });

    it("sets default assignment strategy to random", () => {
      const exp = createExperiment(PROJECT, {
        name: "default-strategy",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(exp.assignmentStrategy).toEqual({ type: "random" });
    });

    it("stores custom assignment strategy", () => {
      const exp = createExperiment(PROJECT, {
        name: "custom-strategy",
        createdBy: "admin",
        assignmentStrategy: { type: "round_robin" },
        variants: makeVariants(),
      }, db);

      expect(exp.assignmentStrategy).toEqual({ type: "round_robin" });
    });

    it("stores completion criteria", () => {
      const exp = createExperiment(PROJECT, {
        name: "with-criteria",
        createdBy: "admin",
        completionCriteria: { type: "sessions", perVariant: 10 },
        variants: makeVariants(),
      }, db);

      expect(exp.completionCriteria).toEqual({ type: "sessions", perVariant: 10 });
    });

    it("rejects experiment with fewer than 2 variants", () => {
      expect(() => createExperiment(PROJECT, {
        name: "single-variant",
        createdBy: "admin",
        variants: [{ name: "only-one", config: {} }],
      }, db)).toThrow("at least 2 variants");
    });

    it("rejects duplicate experiment name", () => {
      createExperiment(PROJECT, {
        name: "unique-name",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(() => createExperiment(PROJECT, {
        name: "unique-name",
        createdBy: "admin",
        variants: makeVariants(),
      }, db)).toThrow("already exists");
    });

    it("stores description and hypothesis", () => {
      const exp = createExperiment(PROJECT, {
        name: "detailed",
        description: "Testing persona impact",
        hypothesis: "Concise personas complete tasks faster",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(exp.description).toBe("Testing persona impact");
      expect(exp.hypothesis).toBe("Concise personas complete tasks faster");
    });
  });

  // --- start ---

  describe("startExperiment", () => {
    it("transitions draft experiment to running", () => {
      const exp = createExperiment(PROJECT, {
        name: "to-start",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      const started = startExperiment(PROJECT, exp.id, db);
      expect(started.state).toBe("running");
      expect(started.startedAt).toBeGreaterThan(0);
    });

    it("transitions paused experiment to running", () => {
      const exp = createExperiment(PROJECT, {
        name: "pause-resume",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      pauseExperiment(PROJECT, exp.id, db);
      const restarted = startExperiment(PROJECT, exp.id, db);
      expect(restarted.state).toBe("running");
    });

    it("throws when starting a completed experiment", () => {
      const exp = createExperiment(PROJECT, {
        name: "completed-start",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      completeExperiment(PROJECT, exp.id, undefined, db);

      expect(() => startExperiment(PROJECT, exp.id, db)).toThrow("Cannot start");
    });

    it("enforces max 2 concurrent running experiments", () => {
      const e1 = createExperiment(PROJECT, {
        name: "exp-1",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);
      const e2 = createExperiment(PROJECT, {
        name: "exp-2",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);
      const e3 = createExperiment(PROJECT, {
        name: "exp-3",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, e1.id, db);
      startExperiment(PROJECT, e2.id, db);

      expect(() => startExperiment(PROJECT, e3.id, db)).toThrow("Maximum of 2");
    });

    it("throws for non-existent experiment", () => {
      expect(() => startExperiment(PROJECT, "no-such-id", db)).toThrow("not found");
    });
  });

  // --- pause ---

  describe("pauseExperiment", () => {
    it("transitions running experiment to paused", () => {
      const exp = createExperiment(PROJECT, {
        name: "to-pause",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      const paused = pauseExperiment(PROJECT, exp.id, db);
      expect(paused.state).toBe("paused");
    });

    it("throws when pausing a draft experiment", () => {
      const exp = createExperiment(PROJECT, {
        name: "draft-pause",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(() => pauseExperiment(PROJECT, exp.id, db)).toThrow("Cannot pause");
    });
  });

  // --- complete ---

  describe("completeExperiment", () => {
    it("transitions running experiment to completed", () => {
      const exp = createExperiment(PROJECT, {
        name: "to-complete",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      const completed = completeExperiment(PROJECT, exp.id, undefined, db);
      expect(completed.state).toBe("completed");
      expect(completed.completedAt).toBeGreaterThan(0);
    });

    it("records winner variant id", () => {
      const exp = createExperiment(PROJECT, {
        name: "with-winner",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      const winnerId = exp.variants[0]!.id;
      const completed = completeExperiment(PROJECT, exp.id, winnerId, db);
      expect(completed.winnerVariantId).toBe(winnerId);
    });

    it("throws when winner variant is from a different experiment", () => {
      const exp = createExperiment(PROJECT, {
        name: "wrong-winner",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);

      expect(() => completeExperiment(PROJECT, exp.id, "fake-variant-id", db))
        .toThrow("Winner variant not found");
    });

    it("throws when completing a draft experiment", () => {
      const exp = createExperiment(PROJECT, {
        name: "draft-complete",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(() => completeExperiment(PROJECT, exp.id, undefined, db)).toThrow("Cannot complete");
    });
  });

  // --- kill ---

  describe("killExperiment", () => {
    it("transitions draft to cancelled", () => {
      const exp = createExperiment(PROJECT, {
        name: "to-kill-draft",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      const killed = killExperiment(PROJECT, exp.id, db);
      expect(killed.state).toBe("cancelled");
      expect(killed.completedAt).toBeGreaterThan(0);
    });

    it("transitions running to cancelled", () => {
      const exp = createExperiment(PROJECT, {
        name: "to-kill-running",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      const killed = killExperiment(PROJECT, exp.id, db);
      expect(killed.state).toBe("cancelled");
    });

    it("throws when killing completed experiment", () => {
      const exp = createExperiment(PROJECT, {
        name: "kill-completed",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);
      completeExperiment(PROJECT, exp.id, undefined, db);

      expect(() => killExperiment(PROJECT, exp.id, db)).toThrow("already terminal");
    });
  });

  // --- get ---

  describe("getExperiment", () => {
    it("returns experiment with variants", () => {
      const created = createExperiment(PROJECT, {
        name: "get-test",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      const found = getExperiment(PROJECT, created.id, db);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.variants).toHaveLength(2);
    });

    it("returns null for non-existent experiment", () => {
      const found = getExperiment(PROJECT, "no-such-id", db);
      expect(found).toBeNull();
    });
  });

  // --- list ---

  describe("listExperiments", () => {
    it("lists all experiments for a project", () => {
      createExperiment(PROJECT, { name: "exp-a", createdBy: "admin", variants: makeVariants() }, db);
      createExperiment(PROJECT, { name: "exp-b", createdBy: "admin", variants: makeVariants() }, db);

      const all = listExperiments(PROJECT, undefined, db);
      expect(all).toHaveLength(2);
    });

    it("filters by state", () => {
      const e1 = createExperiment(PROJECT, { name: "draft-exp", createdBy: "admin", variants: makeVariants() }, db);
      const e2 = createExperiment(PROJECT, { name: "running-exp", createdBy: "admin", variants: makeVariants() }, db);
      startExperiment(PROJECT, e2.id, db);

      const drafts = listExperiments(PROJECT, "draft", db);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.name).toBe("draft-exp");

      const running = listExperiments(PROJECT, "running", db);
      expect(running).toHaveLength(1);
      expect(running[0]!.name).toBe("running-exp");
    });
  });

  // --- check completion ---

  describe("checkExperimentCompletion", () => {
    it("auto-completes session-based experiments when all variants meet threshold", () => {
      const exp = createExperiment(PROJECT, {
        name: "auto-complete",
        createdBy: "admin",
        completionCriteria: { type: "sessions", perVariant: 2 },
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);

      // Manually set session counts to meet criteria
      for (const v of exp.variants) {
        db.prepare("UPDATE experiment_variants SET session_count = 2 WHERE id = ?").run(v.id);
      }

      const completed = checkExperimentCompletion(PROJECT, db);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.state).toBe("completed");
    });

    it("does not complete when criteria not yet met", () => {
      const exp = createExperiment(PROJECT, {
        name: "not-yet",
        createdBy: "admin",
        completionCriteria: { type: "sessions", perVariant: 10 },
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);

      const completed = checkExperimentCompletion(PROJECT, db);
      expect(completed).toHaveLength(0);
    });

    it("does not complete manual experiments", () => {
      const exp = createExperiment(PROJECT, {
        name: "manual-exp",
        createdBy: "admin",
        completionCriteria: { type: "manual" },
        variants: makeVariants(),
      }, db);

      startExperiment(PROJECT, exp.id, db);

      // Even with many sessions, manual experiments don't auto-complete
      for (const v of exp.variants) {
        db.prepare("UPDATE experiment_variants SET session_count = 100 WHERE id = ?").run(v.id);
      }

      const completed = checkExperimentCompletion(PROJECT, db);
      expect(completed).toHaveLength(0);
    });
  });
});
