/**
 * Clawforce — Evidence schema validation (advisory)
 *
 * Validates evidence content and metadata before insertion.
 * Returns warnings but never blocks — all validation is advisory.
 */

import type { EvidenceType } from "../types.js";

const MAX_CONTENT_SIZE = 1_000_000; // 1MB warning threshold

/** Per-type expected metadata keys (advisory). */
const EXPECTED_METADATA: Record<string, string[]> = {
  test_result: ["passed", "failed", "total"],
  diff: ["files", "linesAdded", "linesRemoved"],
  output: ["exitCode", "durationMs"],
};

export type EvidenceValidationResult = {
  valid: boolean;
  warnings: string[];
};

/**
 * Validate evidence content and metadata.
 * Returns advisory warnings — callers should log but not block.
 */
export function validateEvidence(
  type: EvidenceType,
  content: string,
  metadata?: Record<string, unknown>,
): EvidenceValidationResult {
  const warnings: string[] = [];

  // Check for empty content
  if (!content || content.trim().length === 0) {
    warnings.push("Evidence content is empty");
  }

  // Check content size
  if (content && content.length > MAX_CONTENT_SIZE) {
    warnings.push(`Evidence content exceeds 1MB (${(content.length / 1_000_000).toFixed(2)}MB)`);
  }

  // Check expected metadata keys for known types
  const expectedKeys = EXPECTED_METADATA[type];
  if (expectedKeys && metadata) {
    const missingKeys = expectedKeys.filter((key) => !(key in metadata));
    if (missingKeys.length > 0) {
      warnings.push(`Evidence type "${type}" is missing recommended metadata: ${missingKeys.join(", ")}`);
    }
  } else if (expectedKeys && !metadata) {
    warnings.push(`Evidence type "${type}" has no metadata; recommended keys: ${expectedKeys.join(", ")}`);
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
