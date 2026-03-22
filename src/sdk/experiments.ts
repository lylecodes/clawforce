/**
 * Clawforce SDK — Experiments Namespace
 *
 * Wraps internal experiment framework operations with the public SDK API.
 * All operations are scoped to the domain (projectId) passed at construction.
 */

import {
  createExperiment as internalCreate,
  startExperiment as internalStart,
  pauseExperiment as internalPause,
  completeExperiment as internalComplete,
  killExperiment as internalKill,
  getExperiment as internalGet,
  listExperiments as internalList,
} from "../experiments/lifecycle.js";
import { getExperimentResults as internalResults } from "../experiments/results.js";

import type { CreateExperimentParams } from "../experiments/lifecycle.js";
import type { ExperimentResults } from "../experiments/results.js";
import type {
  Experiment,
  ExperimentState,
  ExperimentVariant,
} from "../types.js";

export class ExperimentsNamespace {
  constructor(readonly domain: string) {}

  /**
   * Create a new experiment with variants.
   * Requires at least 2 variants. One can be marked as control.
   */
  create(params: CreateExperimentParams): Experiment & { variants: ExperimentVariant[] } {
    return internalCreate(this.domain, params);
  }

  /**
   * Start a draft or paused experiment. Transitions to "running".
   * Enforces max 2 concurrent running experiments per project.
   */
  start(experimentId: string): Experiment {
    return internalStart(this.domain, experimentId);
  }

  /**
   * Pause a running experiment. Can be resumed with start().
   */
  pause(experimentId: string): Experiment {
    return internalPause(this.domain, experimentId);
  }

  /**
   * Complete an experiment, optionally designating a winner variant.
   */
  complete(experimentId: string, winnerVariantId?: string): Experiment {
    return internalComplete(this.domain, experimentId, winnerVariantId);
  }

  /**
   * Kill (cancel) an experiment. Terminal state — cannot be restarted.
   */
  kill(experimentId: string): Experiment {
    return internalKill(this.domain, experimentId);
  }

  /**
   * Get an experiment by ID, including its variants and stats.
   * Returns null if not found.
   */
  get(experimentId: string): (Experiment & { variants: ExperimentVariant[] }) | null {
    return internalGet(this.domain, experimentId);
  }

  /**
   * List experiments, optionally filtered by state.
   */
  list(state?: ExperimentState): Experiment[] {
    return internalList(this.domain, state);
  }

  /**
   * Get detailed results for an experiment including per-variant stats
   * and winner computation.
   */
  results(experimentId: string): ExperimentResults {
    return internalResults(this.domain, experimentId);
  }
}
