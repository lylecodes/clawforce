/**
 * Clawforce — Safe Condition Evaluation
 *
 * Uses filtrex for safe expression evaluation with a strict whitelist.
 * No access to globals, prototypes, or arbitrary code execution.
 */

import { compileExpression } from "filtrex";

export function evaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  if (!expression || expression.trim().length === 0) return false;

  try {
    const fn = compileExpression(expression);
    const result = fn(context as Record<string, number | string | boolean>);
    // filtrex v3 returns Error objects for unknown properties instead of throwing
    if (result instanceof Error) return false;
    return Boolean(result);
  } catch {
    return false;
  }
}
