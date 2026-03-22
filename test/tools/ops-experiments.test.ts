import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createClawforceOpsTool } = await import("../../src/tools/ops-tool.js");
const trackerModule = await import("../../src/enforcement/tracker.js");
const workerRegistryModule = await import("../../src/worker-registry.js");

const PROJECT = "test-project";

const VARIANTS = JSON.stringify([
  { name: "control", isControl: true, config: {} },
  { name: "treatment", isControl: false, config: { model: "claude-3-haiku-20240307" } },
]);

describe("clawforce_ops — experiment management actions", () => {
  let db: DatabaseSync;
  let tool: ReturnType<typeof createClawforceOpsTool>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    vi.spyOn(trackerModule, "getActiveSessions").mockReturnValue([]);

    tool = createClawforceOpsTool({
      agentSessionKey: "manager-session",
      projectId: PROJECT,
    });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
    workerRegistryModule.resetWorkerRegistryForTest();
    trackerModule.resetTrackerForTest();
  });

  async function execute(params: Record<string, unknown>) {
    const result = await tool.execute("call-1", { project_id: PROJECT, ...params });
    return JSON.parse(result.content[0]!.text);
  }

  // --- create_experiment ---

  describe("create_experiment", () => {
    it("creates an experiment and returns it with variants", async () => {
      const result = await execute({
        action: "create_experiment",
        experiment_name: "My Experiment",
        experiment_variants: VARIANTS,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.name).toBe("My Experiment");
      expect(result.experiment.state).toBe("draft");
      expect(result.experiment.variants).toHaveLength(2);
      expect(result.experiment.variants[0].name).toBe("control");
      expect(result.experiment.variants[1].name).toBe("treatment");
    });

    it("returns error when experiment_name is missing", async () => {
      const result = await execute({
        action: "create_experiment",
        experiment_variants: VARIANTS,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/experiment_name/i);
    });

    it("returns error when experiment_variants is missing", async () => {
      const result = await execute({
        action: "create_experiment",
        experiment_name: "Test",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/experiment_variants/i);
    });

    it("returns error when experiment_variants is invalid JSON", async () => {
      const result = await execute({
        action: "create_experiment",
        experiment_name: "Test",
        experiment_variants: "not-json",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/JSON/i);
    });

    it("stores optional description, hypothesis, and auto_apply", async () => {
      const result = await execute({
        action: "create_experiment",
        experiment_name: "Full Experiment",
        experiment_description: "Testing new models",
        experiment_hypothesis: "Haiku is cheaper",
        experiment_auto_apply: true,
        experiment_variants: VARIANTS,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.description).toBe("Testing new models");
      expect(result.experiment.hypothesis).toBe("Haiku is cheaper");
      expect(result.experiment.autoApplyWinner).toBe(true);
    });

    it("parses experiment_strategy JSON", async () => {
      const strategy = JSON.stringify({ type: "random" });
      const result = await execute({
        action: "create_experiment",
        experiment_name: "Strategy Test",
        experiment_variants: VARIANTS,
        experiment_strategy: strategy,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.assignmentStrategy.type).toBe("random");
    });
  });

  // --- start_experiment ---

  describe("start_experiment", () => {
    it("transitions draft → running", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Start Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      const result = await execute({
        action: "start_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("running");
    });

    it("returns error when experiment_id is missing", async () => {
      const result = await execute({ action: "start_experiment" });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/experiment_id/i);
    });

    it("returns error when experiment not found", async () => {
      const result = await execute({
        action: "start_experiment",
        experiment_id: "nonexistent-id",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not found/i);
    });
  });

  // --- pause_experiment ---

  describe("pause_experiment", () => {
    it("transitions running → paused", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Pause Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      await execute({ action: "start_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "pause_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("paused");
    });

    it("returns error for non-running experiment", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Pause Draft Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      // Draft state — cannot pause
      const result = await execute({
        action: "pause_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/running/i);
    });
  });

  // --- complete_experiment ---

  describe("complete_experiment", () => {
    it("transitions running → completed", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Complete Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      await execute({ action: "start_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "complete_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("completed");
      expect(result.experiment.completedAt).toBeDefined();
    });

    it("transitions paused → completed", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Complete From Paused",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      await execute({ action: "start_experiment", experiment_id: experimentId });
      await execute({ action: "pause_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "complete_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("completed");
    });
  });

  // --- kill_experiment ---

  describe("kill_experiment", () => {
    it("transitions draft → cancelled", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Kill Draft",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      const result = await execute({
        action: "kill_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("cancelled");
    });

    it("transitions running → cancelled", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Kill Running",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      await execute({ action: "start_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "kill_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment.state).toBe("cancelled");
    });

    it("returns error when trying to kill already-completed experiment", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Kill Completed",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      await execute({ action: "start_experiment", experiment_id: experimentId });
      await execute({ action: "complete_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "kill_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/terminal/i);
    });
  });

  // --- list_experiments ---

  describe("list_experiments", () => {
    it("returns all experiments for the project", async () => {
      await execute({ action: "create_experiment", experiment_name: "Exp A", experiment_variants: VARIANTS });
      await execute({ action: "create_experiment", experiment_name: "Exp B", experiment_variants: VARIANTS });

      const result = await execute({ action: "list_experiments" });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.experiments.map((e: { name: string }) => e.name)).toContain("Exp A");
      expect(result.experiments.map((e: { name: string }) => e.name)).toContain("Exp B");
    });

    it("filters by state via experiment_state_filter", async () => {
      const expA = await execute({ action: "create_experiment", experiment_name: "Draft Exp", experiment_variants: VARIANTS });
      const expB = await execute({ action: "create_experiment", experiment_name: "Running Exp", experiment_variants: VARIANTS });

      await execute({ action: "start_experiment", experiment_id: expB.experiment.id });

      const draftResult = await execute({ action: "list_experiments", experiment_state_filter: "draft" });
      expect(draftResult.ok).toBe(true);
      expect(draftResult.count).toBe(1);
      expect(draftResult.experiments[0].name).toBe("Draft Exp");

      const runningResult = await execute({ action: "list_experiments", experiment_state_filter: "running" });
      expect(runningResult.ok).toBe(true);
      expect(runningResult.count).toBe(1);
      expect(runningResult.experiments[0].name).toBe("Running Exp");
    });

    it("returns empty list when no experiments exist", async () => {
      const result = await execute({ action: "list_experiments" });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(0);
      expect(result.experiments).toEqual([]);
    });
  });

  // --- experiment_status ---

  describe("experiment_status", () => {
    it("returns experiment metadata and variant results", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Status Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;

      const result = await execute({
        action: "experiment_status",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experiment).toBeDefined();
      expect(result.experiment.name).toBe("Status Test");
      expect(result.experiment.variants).toHaveLength(2);
      expect(result.results).toBeDefined();
      expect(result.results.variants).toHaveLength(2);
      expect(result.results.experimentId).toBe(experimentId);
    });

    it("returns error when experiment_id is missing", async () => {
      const result = await execute({ action: "experiment_status" });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/experiment_id/i);
    });

    it("returns error when experiment not found", async () => {
      const result = await execute({
        action: "experiment_status",
        experiment_id: "nonexistent",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not found/i);
    });
  });

  // --- apply_experiment ---

  describe("apply_experiment", () => {
    it("returns winner info for a completed experiment", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Apply Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;
      const winnerVariantId = created.experiment.variants[0].id;

      await execute({ action: "start_experiment", experiment_id: experimentId });

      // Complete with explicit winner variant
      const { completeExperiment: ce } = await import("../../src/experiments/lifecycle.js");
      ce(PROJECT, experimentId, winnerVariantId, db);

      const result = await execute({
        action: "apply_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(true);
      expect(result.experimentId).toBe(experimentId);
      expect(result.winnerVariantId).toBe(winnerVariantId);
    });

    it("returns error for non-completed experiment", async () => {
      const created = await execute({
        action: "create_experiment",
        experiment_name: "Apply Running Test",
        experiment_variants: VARIANTS,
      });
      const experimentId = created.experiment.id;
      await execute({ action: "start_experiment", experiment_id: experimentId });

      const result = await execute({
        action: "apply_experiment",
        experiment_id: experimentId,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/completed/i);
    });

    it("returns error when experiment_id is missing", async () => {
      const result = await execute({ action: "apply_experiment" });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/experiment_id/i);
    });
  });
});
