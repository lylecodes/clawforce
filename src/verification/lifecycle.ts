/**
 * Clawforce — Verification lifecycle integration
 *
 * Reads verification config from the project's extended config,
 * and runs gates when configured. Used by the adapter's agent_end handler.
 */

import type { VerificationConfig } from "../types.js";
import { runVerificationGates, formatGateResults, type VerificationRunResult } from "./runner.js";
import { getExtendedProjectConfig } from "../project.js";

/**
 * Get the effective verification config for a project, with defaults applied.
 */
export function getEffectiveVerificationConfig(projectId: string): VerificationConfig & { enabled: boolean } {
  const ext = getExtendedProjectConfig(projectId);
  const vc = ext?.verification as VerificationConfig | undefined;
  return {
    enabled: vc?.enabled ?? false,
    gates: vc?.gates ?? [],
    total_timeout_seconds: vc?.total_timeout_seconds ?? 300,
    parallel: vc?.parallel ?? false,
    git: vc?.git,
  };
}

/**
 * Run verification gates if the project has them configured and enabled.
 * Returns null if verification is not configured or no gates are defined.
 */
export function runVerificationIfConfigured(
  projectId: string,
  projectDir: string | undefined,
): { result: VerificationRunResult; formatted: string } | null {
  const config = getEffectiveVerificationConfig(projectId);
  if (!config.enabled || !config.gates || config.gates.length === 0) return null;
  if (!projectDir) return null;

  const result = runVerificationGates(config.gates, projectDir, {
    totalTimeoutMs: (config.total_timeout_seconds ?? 300) * 1000,
  });
  const formatted = formatGateResults(result);
  return { result, formatted };
}
