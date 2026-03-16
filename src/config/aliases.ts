/**
 * Clawforce — Config alias normalization
 *
 * Maps user-facing vocabulary aliases to canonical internal field names.
 * This lets users write `group: engineering` in YAML and have it treated
 * the same as `department: engineering`.
 */

/** Alias mappings: new name → canonical name */
const FIELD_ALIASES: Record<string, string> = {
  group: "department",
  subgroup: "team",
  role: "extends",
};

/**
 * Normalize agent config by resolving aliases to canonical field names.
 * Canonical names take precedence if both are set (no silent overwrite).
 * Alias fields are preserved so SDK consumers that read them continue to work.
 */
export function normalizeAgentConfig<T extends Record<string, unknown>>(config: T): T {
  const result = { ...config };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (alias in result && !(canonical in result)) {
      (result as Record<string, unknown>)[canonical] = result[alias];
    }
    // Canonical already set: keep it, ignore alias (canonical wins).
    // Alias field is intentionally left in place for SDK consumers.
  }
  return result;
}
