/**
 * Tests for experiment config validation.
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
const { createExperiment } = await import("../../src/experiments/lifecycle.js");
const { validateExperimentConfig, validateVariantConfig } = await import("../../src/experiments/validation.js");

const PROJECT = "test-project";

function makeVariants() {
  return [
    { name: "control", isControl: true, config: {} },
    { name: "treatment", isControl: false, config: { persona: "concise" } },
  ];
}

describe("experiment validation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // --- validateExperimentConfig ---

  describe("validateExperimentConfig", () => {
    it("passes for valid experiment config", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "valid-experiment",
        variants: makeVariants(),
      }, db)).not.toThrow();
    });

    it("rejects duplicate experiment name", () => {
      createExperiment(PROJECT, {
        name: "existing",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(() => validateExperimentConfig(PROJECT, {
        name: "existing",
        variants: makeVariants(),
      }, db)).toThrow("already exists");
    });

    it("rejects fewer than 2 variants", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "one-variant",
        variants: [{ name: "only", config: {} }],
      }, db)).toThrow("at least 2");
    });

    it("rejects multiple control variants", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "multi-control",
        variants: [
          { name: "c1", isControl: true, config: {} },
          { name: "c2", isControl: true, config: {} },
        ],
      }, db)).toThrow("At most one");
    });

    it("rejects duplicate variant names", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "dup-variants",
        variants: [
          { name: "same", config: {} },
          { name: "same", config: { persona: "x" } },
        ],
      }, db)).toThrow("Duplicate variant name");
    });

    it("validates weighted strategy references valid variant names", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "bad-weights",
        variants: makeVariants(),
        assignmentStrategy: {
          type: "weighted",
          weights: { control: 1, nonexistent: 2 },
        },
      }, db)).toThrow("nonexistent");
    });

    it("validates per_agent strategy references valid variant names", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "bad-agent-map",
        variants: makeVariants(),
        assignmentStrategy: {
          type: "per_agent",
          agentVariantMap: { "agent-a": "nonexistent-variant" },
        },
      }, db)).toThrow("nonexistent-variant");
    });

    it("accepts valid weighted strategy", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "good-weights",
        variants: makeVariants(),
        assignmentStrategy: {
          type: "weighted",
          weights: { control: 1, treatment: 3 },
        },
      }, db)).not.toThrow();
    });

    it("accepts valid per_agent strategy", () => {
      expect(() => validateExperimentConfig(PROJECT, {
        name: "good-agent-map",
        variants: makeVariants(),
        assignmentStrategy: {
          type: "per_agent",
          agentVariantMap: {
            "agent-a": "control",
            "agent-b": "treatment",
          },
        },
      }, db)).not.toThrow();
    });
  });

  // --- validateVariantConfig ---

  describe("validateVariantConfig", () => {
    it("returns empty array for valid config", () => {
      const errors = validateVariantConfig({
        persona: "Be thorough",
        expectations: [{ tool: "clawforce_task", action: "done", min_calls: 1 }],
        performance_policy: { action: "retry", max_retries: 2 },
      });
      expect(errors).toHaveLength(0);
    });

    it("returns empty array for empty config", () => {
      const errors = validateVariantConfig({});
      expect(errors).toHaveLength(0);
    });

    it("returns empty array for config with model override", () => {
      const errors = validateVariantConfig({ model: "gpt-4o" });
      expect(errors).toHaveLength(0);
    });
  });
});
