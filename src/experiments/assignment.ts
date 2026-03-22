/**
 * Clawforce — Experiment variant assignment
 *
 * Assigns sessions to experiment variants based on the experiment's
 * assignment strategy (random, round_robin, per_agent, weighted, manual).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ExperimentVariant, VariantConfig } from "../types.js";
import { rowToExperiment, rowToVariant } from "./lifecycle.js";

// --- Assignment context ---

export type AssignmentContext = {
  agentId: string;
  jobName?: string;
  taskId?: string;
};

// --- Get active experiment ---

export function getActiveExperimentForProject(
  projectId: string,
  db?: DatabaseSync,
): { experimentId: string; assignmentStrategy: any } | null {
  const d = db ?? getDb(projectId);
  const row = d.prepare(
    "SELECT * FROM experiments WHERE project_id = ? AND state = 'running' ORDER BY started_at ASC LIMIT 1",
  ).get(projectId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const exp = rowToExperiment(row);
  return { experimentId: exp.id, assignmentStrategy: exp.assignmentStrategy };
}

// --- Assign variant ---

export function assignVariant(
  experimentId: string,
  sessionKey: string,
  context: AssignmentContext,
  db?: DatabaseSync,
): { variantId: string; variant: ExperimentVariant } {
  // We need projectId from the experiment
  const d = db ?? (() => { throw new Error("db required for assignVariant without project context"); })();

  // Check if session already assigned
  const existing = d.prepare(
    "SELECT variant_id FROM experiment_sessions WHERE experiment_id = ? AND session_key = ?",
  ).get(experimentId, sessionKey) as { variant_id: string } | undefined;

  if (existing) {
    const variant = d.prepare(
      "SELECT * FROM experiment_variants WHERE id = ?",
    ).get(existing.variant_id) as Record<string, unknown>;
    return { variantId: existing.variant_id, variant: rowToVariant(variant) };
  }

  // Get experiment
  const expRow = d.prepare("SELECT * FROM experiments WHERE id = ?")
    .get(experimentId) as Record<string, unknown> | undefined;
  if (!expRow) throw new Error(`Experiment not found: ${experimentId}`);

  const exp = rowToExperiment(expRow);
  if (exp.state !== "running") {
    throw new Error(`Experiment "${exp.name}" is not running (state: ${exp.state})`);
  }

  // Get variants
  const variantRows = d.prepare(
    "SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY created_at",
  ).all(experimentId) as Record<string, unknown>[];
  const variants = variantRows.map(rowToVariant);

  if (variants.length === 0) {
    throw new Error(`Experiment "${exp.name}" has no variants`);
  }

  // Select variant based on strategy
  let selectedVariant: ExperimentVariant;

  switch (exp.assignmentStrategy.type) {
    case "random": {
      const idx = Math.floor(Math.random() * variants.length);
      selectedVariant = variants[idx]!;
      break;
    }

    case "round_robin": {
      // Pick the variant with fewest sessions
      selectedVariant = variants.reduce((min, v) =>
        v.sessionCount < min.sessionCount ? v : min,
        variants[0]!,
      );
      break;
    }

    case "per_agent": {
      const map = exp.assignmentStrategy.agentVariantMap;
      const variantName = map[context.agentId];
      if (!variantName) {
        // Fallback to first variant if agent not mapped
        selectedVariant = variants[0]!;
      } else {
        const found = variants.find(v => v.name === variantName || v.id === variantName);
        selectedVariant = found ?? variants[0]!;
      }
      break;
    }

    case "weighted": {
      const weights = exp.assignmentStrategy.weights;
      const entries = variants.map(v => ({
        variant: v,
        weight: weights[v.name] ?? weights[v.id] ?? 1,
      }));
      const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
      let r = Math.random() * totalWeight;
      selectedVariant = entries[0]!.variant;
      for (const entry of entries) {
        r -= entry.weight;
        if (r <= 0) {
          selectedVariant = entry.variant;
          break;
        }
      }
      break;
    }

    case "manual": {
      // Manual assignment: use first variant as default
      selectedVariant = variants[0]!;
      break;
    }

    default:
      selectedVariant = variants[0]!;
  }

  // Record the session assignment
  const sessionId = randomUUID();
  const now = Date.now();

  d.prepare(`
    INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, job_name, task_id, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    experimentId,
    selectedVariant.id,
    sessionKey,
    context.agentId,
    exp.projectId,
    context.jobName ?? null,
    context.taskId ?? null,
    now,
  );

  // Increment session count on the variant
  d.prepare(
    "UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?",
  ).run(selectedVariant.id);

  // Return updated variant
  const updatedVariant = d.prepare(
    "SELECT * FROM experiment_variants WHERE id = ?",
  ).get(selectedVariant.id) as Record<string, unknown>;

  return { variantId: selectedVariant.id, variant: rowToVariant(updatedVariant) };
}

// --- Get variant config ---

export function getVariantConfig(
  experimentId: string,
  variantId: string,
  db?: DatabaseSync,
): VariantConfig | null {
  const d = db ?? (() => { throw new Error("db required for getVariantConfig"); })();

  const row = d.prepare(
    "SELECT config FROM experiment_variants WHERE id = ? AND experiment_id = ?",
  ).get(variantId, experimentId) as { config: string } | undefined;

  if (!row) return null;

  return JSON.parse(row.config);
}
