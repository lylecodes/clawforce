/**
 * Clawforce -- Conditional config resolution
 *
 * Evaluates `when` blocks in config values, selecting the matching branch
 * based on agent context (department, team, extends, etc.).
 *
 * Usage:
 *   channels:
 *     when:
 *       - match: { department: sales }
 *         value: [sales-channel]
 *       - match: { department: engineering }
 *         value: [eng-channel]
 *       - default: [general]
 */

type WhenClause = {
  match?: Record<string, unknown>;
  value?: unknown;
  default?: unknown;
};

function isWhenBlock(val: unknown): val is { when: WhenClause[] } {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.when);
}

/**
 * Evaluate a single `when` block against a context.
 * Returns the value from the first matching clause, or the default, or undefined.
 */
function evaluateWhen(clauses: WhenClause[], context: Record<string, unknown>): unknown | undefined {
  for (const clause of clauses) {
    // Default clause (no match key, just `default`)
    if ("default" in clause && !("match" in clause)) {
      return clause.default;
    }

    // Match clause — all keys in `match` must equal the corresponding context value
    if (clause.match && typeof clause.match === "object") {
      const allMatch = Object.entries(clause.match).every(([key, expected]) => {
        const actual = context[key];
        if (Array.isArray(expected)) {
          // Match if actual is in the expected array
          return expected.includes(actual);
        }
        return actual === expected;
      });
      if (allMatch) {
        return clause.value;
      }
    }
  }

  return undefined;
}

/**
 * Recursively resolve all `when` blocks in a config object.
 * Context is the agent's own fields (department, team, extends, etc.).
 *
 * A field is a `when` block if its value is `{ when: [...] }`.
 * The block is replaced with the resolved value from the first matching clause.
 */
export function resolveConditionals<T extends Record<string, unknown>>(
  config: T,
  context: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(config)) {
    if (isWhenBlock(val)) {
      const resolved = evaluateWhen(val.when as WhenClause[], context);
      if (resolved !== undefined) {
        result[key] = resolved;
      }
      // If no clause matched and no default, omit the field entirely
    } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      // Recurse into nested objects (but not arrays — arrays are values)
      result[key] = resolveConditionals(val as Record<string, unknown>, context);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}
