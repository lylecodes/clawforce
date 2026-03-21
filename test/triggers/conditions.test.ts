/**
 * Tests for trigger condition evaluation.
 *
 * Covers all operators, dotted path resolution, edge cases.
 */

import { describe, expect, it } from "vitest";

import { evaluateConditions, resolvePath } from "../../src/triggers/conditions.js";
import type { TriggerCondition } from "../../src/types.js";

// ---------- resolvePath ----------

describe("resolvePath", () => {
  it("resolves a top-level key", () => {
    expect(resolvePath({ status: "ok" }, "status")).toBe("ok");
  });

  it("resolves a nested dotted path", () => {
    expect(resolvePath({ data: { status: { code: 200 } } }, "data.status.code")).toBe(200);
  });

  it("returns undefined for missing top-level key", () => {
    expect(resolvePath({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined for missing nested key", () => {
    expect(resolvePath({ data: { x: 1 } }, "data.y.z")).toBeUndefined();
  });

  it("returns undefined when traversing a non-object", () => {
    expect(resolvePath({ data: 42 }, "data.nested")).toBeUndefined();
  });

  it("returns undefined for null payload", () => {
    expect(resolvePath(null, "field")).toBeUndefined();
  });

  it("resolves nested objects as values", () => {
    const obj = { inner: { key: "val" } };
    expect(resolvePath({ data: obj }, "data")).toEqual(obj);
  });

  it("handles empty string path", () => {
    // An empty string splits into [""] which is not a valid key
    expect(resolvePath({ "": "val" }, "")).toBe("val");
  });
});

// ---------- evaluateConditions ----------

describe("evaluateConditions", () => {
  // --- empty / undefined ---

  it("returns pass=true when conditions is undefined", () => {
    const result = evaluateConditions(undefined, { foo: 1 });
    expect(result.pass).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("returns pass=true when conditions array is empty", () => {
    const result = evaluateConditions([], { foo: 1 });
    expect(result.pass).toBe(true);
    expect(result.results).toEqual([]);
  });

  // --- == operator ---

  describe("== operator", () => {
    it("passes when values are equal (string)", () => {
      const conds: TriggerCondition[] = [{ field: "status", operator: "==", value: "success" }];
      const result = evaluateConditions(conds, { status: "success" });
      expect(result.pass).toBe(true);
      expect(result.results[0]!.pass).toBe(true);
    });

    it("passes when values are equal (number)", () => {
      const conds: TriggerCondition[] = [{ field: "code", operator: "==", value: 200 }];
      const result = evaluateConditions(conds, { code: 200 });
      expect(result.pass).toBe(true);
    });

    it("passes with loose equality (string '1' == number 1)", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "==", value: 1 }];
      const result = evaluateConditions(conds, { val: "1" });
      expect(result.pass).toBe(true);
    });

    it("fails when values differ", () => {
      const conds: TriggerCondition[] = [{ field: "status", operator: "==", value: "success" }];
      const result = evaluateConditions(conds, { status: "failed" });
      expect(result.pass).toBe(false);
      expect(result.results[0]!.pass).toBe(false);
    });
  });

  // --- != operator ---

  describe("!= operator", () => {
    it("passes when values differ", () => {
      const conds: TriggerCondition[] = [{ field: "status", operator: "!=", value: "failed" }];
      const result = evaluateConditions(conds, { status: "success" });
      expect(result.pass).toBe(true);
    });

    it("fails when values are equal", () => {
      const conds: TriggerCondition[] = [{ field: "status", operator: "!=", value: "ok" }];
      const result = evaluateConditions(conds, { status: "ok" });
      expect(result.pass).toBe(false);
    });
  });

  // --- > operator ---

  describe("> operator", () => {
    it("passes when actual > expected", () => {
      const conds: TriggerCondition[] = [{ field: "count", operator: ">", value: 5 }];
      const result = evaluateConditions(conds, { count: 10 });
      expect(result.pass).toBe(true);
    });

    it("fails when actual <= expected", () => {
      const conds: TriggerCondition[] = [{ field: "count", operator: ">", value: 5 }];
      expect(evaluateConditions(conds, { count: 5 }).pass).toBe(false);
      expect(evaluateConditions(conds, { count: 3 }).pass).toBe(false);
    });

    it("fails when types are not numbers", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: ">", value: 5 }];
      expect(evaluateConditions(conds, { val: "10" }).pass).toBe(false);
    });
  });

  // --- < operator ---

  describe("< operator", () => {
    it("passes when actual < expected", () => {
      const conds: TriggerCondition[] = [{ field: "count", operator: "<", value: 10 }];
      const result = evaluateConditions(conds, { count: 5 });
      expect(result.pass).toBe(true);
    });

    it("fails when actual >= expected", () => {
      const conds: TriggerCondition[] = [{ field: "count", operator: "<", value: 10 }];
      expect(evaluateConditions(conds, { count: 10 }).pass).toBe(false);
    });
  });

  // --- >= operator ---

  describe(">= operator", () => {
    it("passes when actual >= expected", () => {
      const conds: TriggerCondition[] = [{ field: "score", operator: ">=", value: 80 }];
      expect(evaluateConditions(conds, { score: 80 }).pass).toBe(true);
      expect(evaluateConditions(conds, { score: 90 }).pass).toBe(true);
    });

    it("fails when actual < expected", () => {
      const conds: TriggerCondition[] = [{ field: "score", operator: ">=", value: 80 }];
      expect(evaluateConditions(conds, { score: 79 }).pass).toBe(false);
    });
  });

  // --- <= operator ---

  describe("<= operator", () => {
    it("passes when actual <= expected", () => {
      const conds: TriggerCondition[] = [{ field: "temp", operator: "<=", value: 100 }];
      expect(evaluateConditions(conds, { temp: 100 }).pass).toBe(true);
      expect(evaluateConditions(conds, { temp: 50 }).pass).toBe(true);
    });

    it("fails when actual > expected", () => {
      const conds: TriggerCondition[] = [{ field: "temp", operator: "<=", value: 100 }];
      expect(evaluateConditions(conds, { temp: 101 }).pass).toBe(false);
    });
  });

  // --- contains operator ---

  describe("contains operator", () => {
    it("passes when string contains substring", () => {
      const conds: TriggerCondition[] = [{ field: "msg", operator: "contains", value: "error" }];
      expect(evaluateConditions(conds, { msg: "fatal error occurred" }).pass).toBe(true);
    });

    it("fails when string does not contain substring", () => {
      const conds: TriggerCondition[] = [{ field: "msg", operator: "contains", value: "error" }];
      expect(evaluateConditions(conds, { msg: "all good" }).pass).toBe(false);
    });

    it("passes when array contains value", () => {
      const conds: TriggerCondition[] = [{ field: "tags", operator: "contains", value: "critical" }];
      expect(evaluateConditions(conds, { tags: ["info", "critical", "deploy"] }).pass).toBe(true);
    });

    it("fails when array does not contain value", () => {
      const conds: TriggerCondition[] = [{ field: "tags", operator: "contains", value: "critical" }];
      expect(evaluateConditions(conds, { tags: ["info", "deploy"] }).pass).toBe(false);
    });

    it("fails when field is not a string or array", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "contains", value: "x" }];
      expect(evaluateConditions(conds, { val: 42 }).pass).toBe(false);
    });
  });

  // --- matches operator ---

  describe("matches operator", () => {
    it("passes when regex matches", () => {
      const conds: TriggerCondition[] = [{ field: "branch", operator: "matches", value: "^main$" }];
      expect(evaluateConditions(conds, { branch: "main" }).pass).toBe(true);
    });

    it("passes with partial regex match", () => {
      const conds: TriggerCondition[] = [{ field: "ref", operator: "matches", value: "release/.*" }];
      expect(evaluateConditions(conds, { ref: "release/v2.0" }).pass).toBe(true);
    });

    it("fails when regex does not match", () => {
      const conds: TriggerCondition[] = [{ field: "branch", operator: "matches", value: "^main$" }];
      expect(evaluateConditions(conds, { branch: "develop" }).pass).toBe(false);
    });

    it("fails gracefully on invalid regex", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "matches", value: "[invalid" }];
      expect(evaluateConditions(conds, { val: "test" }).pass).toBe(false);
    });

    it("fails when field is not a string", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "matches", value: "\\d+" }];
      expect(evaluateConditions(conds, { val: 42 }).pass).toBe(false);
    });
  });

  // --- exists operator ---

  describe("exists operator", () => {
    it("passes when field exists (string value)", () => {
      const conds: TriggerCondition[] = [{ field: "name", operator: "exists" }];
      expect(evaluateConditions(conds, { name: "test" }).pass).toBe(true);
    });

    it("passes when field exists (zero value)", () => {
      const conds: TriggerCondition[] = [{ field: "count", operator: "exists" }];
      expect(evaluateConditions(conds, { count: 0 }).pass).toBe(true);
    });

    it("passes when field exists (false value)", () => {
      const conds: TriggerCondition[] = [{ field: "active", operator: "exists" }];
      expect(evaluateConditions(conds, { active: false }).pass).toBe(true);
    });

    it("passes when field exists (empty string)", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "exists" }];
      expect(evaluateConditions(conds, { val: "" }).pass).toBe(true);
    });

    it("fails when field is undefined", () => {
      const conds: TriggerCondition[] = [{ field: "missing", operator: "exists" }];
      expect(evaluateConditions(conds, { other: 1 }).pass).toBe(false);
    });

    it("fails when field is null", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "exists" }];
      expect(evaluateConditions(conds, { val: null }).pass).toBe(false);
    });
  });

  // --- not_exists operator ---

  describe("not_exists operator", () => {
    it("passes when field is undefined", () => {
      const conds: TriggerCondition[] = [{ field: "missing", operator: "not_exists" }];
      expect(evaluateConditions(conds, { other: 1 }).pass).toBe(true);
    });

    it("passes when field is null", () => {
      const conds: TriggerCondition[] = [{ field: "val", operator: "not_exists" }];
      expect(evaluateConditions(conds, { val: null }).pass).toBe(true);
    });

    it("fails when field exists", () => {
      const conds: TriggerCondition[] = [{ field: "name", operator: "not_exists" }];
      expect(evaluateConditions(conds, { name: "test" }).pass).toBe(false);
    });
  });

  // --- dotted paths ---

  describe("dotted path resolution", () => {
    it("evaluates conditions on deeply nested fields", () => {
      const conds: TriggerCondition[] = [
        { field: "data.result.status", operator: "==", value: "complete" },
      ];
      const payload = { data: { result: { status: "complete" } } };
      expect(evaluateConditions(conds, payload).pass).toBe(true);
    });

    it("fails when nested path does not exist", () => {
      const conds: TriggerCondition[] = [
        { field: "data.result.status", operator: "==", value: "complete" },
      ];
      const payload = { data: { other: "value" } };
      expect(evaluateConditions(conds, payload).pass).toBe(false);
    });
  });

  // --- multiple conditions (AND logic) ---

  describe("multiple conditions (AND logic)", () => {
    it("passes when all conditions pass", () => {
      const conds: TriggerCondition[] = [
        { field: "status", operator: "==", value: "failed" },
        { field: "retries", operator: ">=", value: 3 },
        { field: "branch", operator: "contains", value: "main" },
      ];
      const payload = { status: "failed", retries: 5, branch: "main-release" };
      const result = evaluateConditions(conds, payload);
      expect(result.pass).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.results.every(r => r.pass)).toBe(true);
    });

    it("fails when any condition fails", () => {
      const conds: TriggerCondition[] = [
        { field: "status", operator: "==", value: "failed" },
        { field: "retries", operator: ">=", value: 3 },
      ];
      const payload = { status: "failed", retries: 1 };
      const result = evaluateConditions(conds, payload);
      expect(result.pass).toBe(false);
      expect(result.results[0]!.pass).toBe(true);
      expect(result.results[1]!.pass).toBe(false);
    });
  });

  // --- result shape ---

  describe("result shape", () => {
    it("includes field, operator, expected, actual, and pass in each result", () => {
      const conds: TriggerCondition[] = [
        { field: "val", operator: "==", value: "x" },
      ];
      const result = evaluateConditions(conds, { val: "y" });
      const r = result.results[0]!;
      expect(r.field).toBe("val");
      expect(r.operator).toBe("==");
      expect(r.expected).toBe("x");
      expect(r.actual).toBe("y");
      expect(r.pass).toBe(false);
    });
  });
});
