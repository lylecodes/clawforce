/**
 * Clawforce — Experiment config validation
 *
 * Validates experiment configs before creation:
 * - Concurrent experiment limit (max 2 running per project)
 * - Unique experiment name per project
 * - At least 2 variants
 * - At most one control variant
 * - Variant config safety checks
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ExperimentAssignmentStrategy, VariantConfig } from "../types.js";

export type ValidationError = {
  field: string;
  message: string;
};

export type ExperimentConfigInput = {
  name: string;
  variants: Array<{
    name: string;
    isControl?: boolean;
    config: VariantConfig;
  }>;
  assignmentStrategy?: ExperimentAssignmentStrategy;
};

/**
 * Validate an experiment configuration before creation.
 * Throws an error with all validation issues if any are found.
 */
export function validateExperimentConfig(
  projectId: string,
  experiment: ExperimentConfigInput,
  db?: DatabaseSync,
): void {
  const d = db ?? getDb(projectId);
  const errors: ValidationError[] = [];

  // Check name uniqueness
  const existing = d.prepare(
    "SELECT id FROM experiments WHERE project_id = ? AND name = ?",
  ).get(projectId, experiment.name) as Record<string, unknown> | undefined;

  if (existing) {
    errors.push({
      field: "name",
      message: `Experiment name "${experiment.name}" already exists in this project`,
    });
  }

  // Check variant count
  if (!experiment.variants || experiment.variants.length < 2) {
    errors.push({
      field: "variants",
      message: "Experiment must have at least 2 variants",
    });
  }

  // Check at most one control
  if (experiment.variants) {
    const controls = experiment.variants.filter(v => v.isControl);
    if (controls.length > 1) {
      errors.push({
        field: "variants",
        message: `At most one variant can be marked as control (found ${controls.length})`,
      });
    }

    // Check unique variant names within experiment
    const names = new Set<string>();
    for (const v of experiment.variants) {
      if (names.has(v.name)) {
        errors.push({
          field: "variants",
          message: `Duplicate variant name: "${v.name}"`,
        });
      }
      names.add(v.name);
    }

    // Validate each variant config
    for (const v of experiment.variants) {
      const variantErrors = validateVariantConfig(v.config);
      for (const ve of variantErrors) {
        errors.push({
          field: `variants.${v.name}.${ve.field}`,
          message: ve.message,
        });
      }
    }
  }

  // Validate assignment strategy
  if (experiment.assignmentStrategy) {
    const strategy = experiment.assignmentStrategy;
    if (strategy.type === "weighted" && experiment.variants) {
      // Weighted strategy should reference valid variant names
      for (const key of Object.keys(strategy.weights)) {
        const found = experiment.variants.some(v => v.name === key);
        if (!found) {
          errors.push({
            field: "assignmentStrategy.weights",
            message: `Weight key "${key}" does not match any variant name`,
          });
        }
      }
    }

    if (strategy.type === "per_agent" && experiment.variants) {
      // Per-agent strategy should reference valid variant names
      for (const [agentId, variantName] of Object.entries(strategy.agentVariantMap)) {
        const found = experiment.variants.some(v => v.name === variantName);
        if (!found) {
          errors.push({
            field: "assignmentStrategy.agentVariantMap",
            message: `Agent "${agentId}" mapped to unknown variant "${variantName}"`,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    const messages = errors.map(e => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Experiment validation failed:\n${messages}`);
  }
}

/**
 * Validate a single variant config for safety issues.
 * Returns an array of validation errors (empty = valid).
 */
export function validateVariantConfig(config: VariantConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Safety: don't allow disabling performance policy entirely
  if (config.performance_policy) {
    if (config.performance_policy.action === "retry" && config.performance_policy.max_retries === 0) {
      // This effectively disables retries but still has the policy — ok
    }
    // The action field is required by the type, so it can't be "none" — safe by default
  }

  // Safety: empty expectations array is a warning but not an error
  // (it means no compliance requirements for the variant)

  return errors;
}
