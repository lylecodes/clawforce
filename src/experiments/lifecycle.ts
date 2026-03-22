/**
 * Clawforce — Experiment lifecycle management
 *
 * Create, start, pause, complete, and kill experiments.
 * Manages state transitions and validates safety constraints.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type {
  CompletionCriteria,
  Experiment,
  ExperimentAssignmentStrategy,
  ExperimentState,
  ExperimentVariant,
  VariantConfig,
} from "../types.js";
import { validateExperimentConfig } from "./validation.js";

// --- Row mappers ---

export function rowToExperiment(row: Record<string, unknown>): Experiment {
  const exp: Experiment = {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    state: row.state as ExperimentState,
    assignmentStrategy: JSON.parse(row.assignment_strategy as string),
    autoApplyWinner: (row.auto_apply_winner as number) === 1,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
  if (row.description != null) exp.description = row.description as string;
  if (row.hypothesis != null) exp.hypothesis = row.hypothesis as string;
  if (row.completion_criteria != null) {
    try { exp.completionCriteria = JSON.parse(row.completion_criteria as string); } catch { /* ignore */ }
  }
  if (row.winner_variant_id != null) exp.winnerVariantId = row.winner_variant_id as string;
  if (row.metadata != null) {
    try { exp.metadata = JSON.parse(row.metadata as string); } catch { /* ignore */ }
  }
  if (row.started_at != null) exp.startedAt = row.started_at as number;
  if (row.completed_at != null) exp.completedAt = row.completed_at as number;
  return exp;
}

export function rowToVariant(row: Record<string, unknown>): ExperimentVariant {
  return {
    id: row.id as string,
    experimentId: row.experiment_id as string,
    name: row.name as string,
    isControl: (row.is_control as number) === 1,
    config: JSON.parse(row.config as string),
    sessionCount: row.session_count as number,
    compliantCount: row.compliant_count as number,
    totalCostCents: row.total_cost_cents as number,
    totalDurationMs: row.total_duration_ms as number,
    createdAt: row.created_at as number,
  };
}

// --- Create ---

export type CreateExperimentParams = {
  name: string;
  description?: string;
  hypothesis?: string;
  assignmentStrategy?: ExperimentAssignmentStrategy;
  completionCriteria?: CompletionCriteria;
  autoApplyWinner?: boolean;
  createdBy: string;
  metadata?: Record<string, unknown>;
  variants: Array<{
    name: string;
    isControl?: boolean;
    config: VariantConfig;
  }>;
};

export function createExperiment(
  projectId: string,
  params: CreateExperimentParams,
  db?: DatabaseSync,
): Experiment & { variants: ExperimentVariant[] } {
  const d = db ?? getDb(projectId);
  const id = randomUUID();
  const now = Date.now();

  if (!params.variants || params.variants.length < 2) {
    throw new Error("Experiment must have at least 2 variants");
  }

  // Validate before inserting
  validateExperimentConfig(projectId, {
    name: params.name,
    variants: params.variants,
    assignmentStrategy: params.assignmentStrategy,
  }, d);

  d.prepare(`
    INSERT INTO experiments (id, project_id, name, description, hypothesis, state, assignment_strategy, completion_criteria, auto_apply_winner, created_by, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    params.name,
    params.description ?? null,
    params.hypothesis ?? null,
    JSON.stringify(params.assignmentStrategy ?? { type: "random" }),
    params.completionCriteria ? JSON.stringify(params.completionCriteria) : null,
    params.autoApplyWinner ? 1 : 0,
    params.createdBy,
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
  );

  const variants: ExperimentVariant[] = [];
  for (const v of params.variants) {
    const vid = randomUUID();
    d.prepare(`
      INSERT INTO experiment_variants (id, experiment_id, name, is_control, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(vid, id, v.name, v.isControl ? 1 : 0, JSON.stringify(v.config), now);

    variants.push({
      id: vid,
      experimentId: id,
      name: v.name,
      isControl: v.isControl ?? false,
      config: v.config,
      sessionCount: 0,
      compliantCount: 0,
      totalCostCents: 0,
      totalDurationMs: 0,
      createdAt: now,
    });
  }

  const exp = rowToExperiment(
    d.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Record<string, unknown>,
  );

  return { ...exp, variants };
}

// --- Start ---

export function startExperiment(
  projectId: string,
  experimentId: string,
  db?: DatabaseSync,
): Experiment {
  const d = db ?? getDb(projectId);
  const row = d.prepare("SELECT * FROM experiments WHERE id = ? AND project_id = ?")
    .get(experimentId, projectId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Experiment not found: ${experimentId}`);

  const exp = rowToExperiment(row);
  if (exp.state !== "draft" && exp.state !== "paused") {
    throw new Error(`Cannot start experiment in state "${exp.state}" — must be "draft" or "paused"`);
  }

  // Check concurrent experiment limit
  const running = d.prepare(
    "SELECT COUNT(*) as cnt FROM experiments WHERE project_id = ? AND state = 'running'",
  ).get(projectId) as { cnt: number };

  if (running.cnt >= 2) {
    throw new Error("Maximum of 2 concurrent running experiments per project");
  }

  const now = Date.now();
  d.prepare(
    "UPDATE experiments SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
  ).run(now, experimentId);

  return rowToExperiment(
    d.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as Record<string, unknown>,
  );
}

// --- Pause ---

export function pauseExperiment(
  projectId: string,
  experimentId: string,
  db?: DatabaseSync,
): Experiment {
  const d = db ?? getDb(projectId);
  const row = d.prepare("SELECT * FROM experiments WHERE id = ? AND project_id = ?")
    .get(experimentId, projectId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Experiment not found: ${experimentId}`);

  const exp = rowToExperiment(row);
  if (exp.state !== "running") {
    throw new Error(`Cannot pause experiment in state "${exp.state}" — must be "running"`);
  }

  d.prepare("UPDATE experiments SET state = 'paused' WHERE id = ?").run(experimentId);

  return rowToExperiment(
    d.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as Record<string, unknown>,
  );
}

// --- Complete ---

export function completeExperiment(
  projectId: string,
  experimentId: string,
  winnerVariantId?: string,
  db?: DatabaseSync,
): Experiment {
  const d = db ?? getDb(projectId);
  const row = d.prepare("SELECT * FROM experiments WHERE id = ? AND project_id = ?")
    .get(experimentId, projectId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Experiment not found: ${experimentId}`);

  const exp = rowToExperiment(row);
  if (exp.state !== "running" && exp.state !== "paused") {
    throw new Error(`Cannot complete experiment in state "${exp.state}" — must be "running" or "paused"`);
  }

  // Validate winner variant belongs to this experiment
  if (winnerVariantId) {
    const variant = d.prepare(
      "SELECT id FROM experiment_variants WHERE id = ? AND experiment_id = ?",
    ).get(winnerVariantId, experimentId) as Record<string, unknown> | undefined;
    if (!variant) {
      throw new Error(`Winner variant not found in this experiment: ${winnerVariantId}`);
    }
  }

  const now = Date.now();
  d.prepare(
    "UPDATE experiments SET state = 'completed', completed_at = ?, winner_variant_id = ? WHERE id = ?",
  ).run(now, winnerVariantId ?? null, experimentId);

  return rowToExperiment(
    d.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as Record<string, unknown>,
  );
}

// --- Kill (cancel) ---

export function killExperiment(
  projectId: string,
  experimentId: string,
  db?: DatabaseSync,
): Experiment {
  const d = db ?? getDb(projectId);
  const row = d.prepare("SELECT * FROM experiments WHERE id = ? AND project_id = ?")
    .get(experimentId, projectId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Experiment not found: ${experimentId}`);

  const exp = rowToExperiment(row);
  if (exp.state === "completed" || exp.state === "cancelled") {
    throw new Error(`Cannot kill experiment in state "${exp.state}" — already terminal`);
  }

  const now = Date.now();
  d.prepare(
    "UPDATE experiments SET state = 'cancelled', completed_at = ? WHERE id = ?",
  ).run(now, experimentId);

  return rowToExperiment(
    d.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as Record<string, unknown>,
  );
}

// --- Get ---

export function getExperiment(
  projectId: string,
  experimentId: string,
  db?: DatabaseSync,
): (Experiment & { variants: ExperimentVariant[] }) | null {
  const d = db ?? getDb(projectId);
  const row = d.prepare("SELECT * FROM experiments WHERE id = ? AND project_id = ?")
    .get(experimentId, projectId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const exp = rowToExperiment(row);
  const variantRows = d.prepare(
    "SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY created_at",
  ).all(experimentId) as Record<string, unknown>[];

  return { ...exp, variants: variantRows.map(rowToVariant) };
}

// --- List ---

export function listExperiments(
  projectId: string,
  state?: ExperimentState,
  db?: DatabaseSync,
): Experiment[] {
  const d = db ?? getDb(projectId);

  if (state) {
    const rows = d.prepare(
      "SELECT * FROM experiments WHERE project_id = ? AND state = ? ORDER BY created_at DESC",
    ).all(projectId, state) as Record<string, unknown>[];
    return rows.map(rowToExperiment);
  }

  const rows = d.prepare(
    "SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at DESC",
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToExperiment);
}

// --- Check completion criteria ---

export function checkExperimentCompletion(
  projectId: string,
  db?: DatabaseSync,
): Experiment[] {
  const d = db ?? getDb(projectId);
  const running = d.prepare(
    "SELECT * FROM experiments WHERE project_id = ? AND state = 'running'",
  ).all(projectId) as Record<string, unknown>[];

  const completed: Experiment[] = [];

  for (const row of running) {
    const exp = rowToExperiment(row);
    if (!exp.completionCriteria) continue;

    let shouldComplete = false;

    if (exp.completionCriteria.type === "sessions") {
      const variants = d.prepare(
        "SELECT session_count FROM experiment_variants WHERE experiment_id = ?",
      ).all(exp.id) as { session_count: number }[];

      shouldComplete = variants.length > 0 && variants.every(
        v => v.session_count >= exp.completionCriteria!.perVariant,
      );
    } else if (exp.completionCriteria.type === "time") {
      if (exp.startedAt) {
        shouldComplete = Date.now() - exp.startedAt >= exp.completionCriteria.durationMs;
      }
    }
    // "manual" type: never auto-completes

    if (shouldComplete) {
      const result = completeExperiment(projectId, exp.id, undefined, d);
      completed.push(result);
    }
  }

  return completed;
}
