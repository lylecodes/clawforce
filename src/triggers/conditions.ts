/**
 * Clawforce — Trigger condition evaluation
 *
 * Evaluates an array of TriggerConditions against a payload.
 * All conditions must pass (AND logic) for the trigger to fire.
 * Supports dotted path resolution for nested payload fields.
 */

import type { TriggerCondition, TriggerConditionOperator } from "../types.js";

/** Result of evaluating a single condition. */
export type ConditionResult = {
  field: string;
  operator: TriggerConditionOperator;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

/** Result of evaluating all conditions for a trigger. */
export type ConditionsResult = {
  pass: boolean;
  results: ConditionResult[];
};

/**
 * Resolve a dotted path (e.g. "data.status.code") against an object.
 * Returns undefined when any segment is missing.
 */
export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a single condition against a payload value.
 */
function evaluateSingle(actual: unknown, operator: TriggerConditionOperator, expected: unknown): boolean {
  switch (operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "==":
      // eslint-disable-next-line eqeqeq
      return actual == expected;
    case "!=":
      // eslint-disable-next-line eqeqeq
      return actual != expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    case "matches":
      if (typeof actual === "string" && typeof expected === "string") {
        try {
          return new RegExp(expected).test(actual);
        } catch {
          return false;
        }
      }
      return false;
    default:
      return false;
  }
}

/**
 * Evaluate all conditions against a payload.
 * Returns { pass: true } only if ALL conditions pass.
 * If conditions is empty or undefined, pass is true (no filter).
 */
export function evaluateConditions(
  conditions: TriggerCondition[] | undefined,
  payload: Record<string, unknown>,
): ConditionsResult {
  if (!conditions || conditions.length === 0) {
    return { pass: true, results: [] };
  }

  const results: ConditionResult[] = [];
  let allPass = true;

  for (const cond of conditions) {
    const actual = resolvePath(payload, cond.field);
    const pass = evaluateSingle(actual, cond.operator, cond.value);
    results.push({
      field: cond.field,
      operator: cond.operator,
      expected: cond.value,
      actual,
      pass,
    });
    if (!pass) allPass = false;
  }

  return { pass: allPass, results };
}
