import { describe, expect, it } from "vitest";
import {
  adaptTool,
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  safeExecute,
} from "../../src/tools/common.js";

describe("jsonResult", () => {
  it("wraps a plain object as pretty-printed JSON text", () => {
    const result = jsonResult({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe(JSON.stringify({ foo: "bar" }, null, 2));
  });

  it("sets details to null", () => {
    const result = jsonResult({ x: 1 });
    expect(result.details).toBeNull();
  });

  it("handles a primitive string value", () => {
    const result = jsonResult("hello");
    expect(result.content[0]!.text).toBe(JSON.stringify("hello", null, 2));
  });

  it("handles a number value", () => {
    const result = jsonResult(42);
    expect(result.content[0]!.text).toBe("42");
  });

  it("handles null", () => {
    const result = jsonResult(null);
    expect(result.content[0]!.text).toBe("null");
  });

  it("handles an array", () => {
    const result = jsonResult([1, 2, 3]);
    expect(result.content[0]!.text).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it("handles nested objects", () => {
    const input = { a: { b: { c: true } } };
    const result = jsonResult(input);
    expect(JSON.parse(result.content[0]!.text)).toEqual(input);
  });
});

describe("errorResult", () => {
  it("produces a ToolResult with ok:false and the given reason", () => {
    const result = errorResult("something went wrong");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("something went wrong");
  });

  it("sets details to null", () => {
    const result = errorResult("oops");
    expect(result.details).toBeNull();
  });

  it("preserves special characters in the reason string", () => {
    const result = errorResult('Error: "quotes" & <angle>');
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.reason).toBe('Error: "quotes" & <angle>');
  });
});

describe("readStringParam", () => {
  it("returns the string value when present", () => {
    expect(readStringParam({ name: "alice" }, "name")).toBe("alice");
  });

  it("coerces a number to string", () => {
    expect(readStringParam({ count: 99 }, "count")).toBe("99");
  });

  it("coerces a boolean to string", () => {
    expect(readStringParam({ flag: true }, "flag")).toBe("true");
  });

  it("returns null when the key is absent and not required", () => {
    expect(readStringParam({}, "missing")).toBeNull();
  });

  it("returns null when the value is null and not required", () => {
    expect(readStringParam({ key: null }, "key")).toBeNull();
  });

  it("returns null when the value is undefined and not required", () => {
    expect(readStringParam({ key: undefined }, "key")).toBeNull();
  });

  it("returns null when the value is an empty string and not required", () => {
    expect(readStringParam({ key: "" }, "key")).toBeNull();
  });

  it("throws when the key is absent and required:true", () => {
    expect(() => readStringParam({}, "name", { required: true })).toThrow(
      "Missing required parameter: name",
    );
  });

  it("throws when the value is null and required:true", () => {
    expect(() => readStringParam({ name: null }, "name", { required: true })).toThrow(
      "Missing required parameter: name",
    );
  });

  it("throws when the value is an empty string and required:true", () => {
    expect(() => readStringParam({ name: "" }, "name", { required: true })).toThrow(
      "Missing required parameter: name",
    );
  });

  it("does not throw when required:false is explicitly passed and value is absent", () => {
    expect(readStringParam({}, "name", { required: false })).toBeNull();
  });
});

describe("readNumberParam", () => {
  it("returns the numeric value for a plain number", () => {
    expect(readNumberParam({ n: 3.14 }, "n")).toBe(3.14);
  });

  it("parses a numeric string", () => {
    expect(readNumberParam({ n: "7" }, "n")).toBe(7);
  });

  it("returns null when the key is absent", () => {
    expect(readNumberParam({}, "n")).toBeNull();
  });

  it("returns null when the value is null", () => {
    expect(readNumberParam({ n: null }, "n")).toBeNull();
  });

  it("returns null when the value is undefined", () => {
    expect(readNumberParam({ n: undefined }, "n")).toBeNull();
  });

  it("returns null for a non-numeric string (NaN)", () => {
    expect(readNumberParam({ n: "abc" }, "n")).toBeNull();
  });

  it("rounds to the nearest integer when integer:true", () => {
    expect(readNumberParam({ n: 2.7 }, "n", { integer: true })).toBe(3);
    expect(readNumberParam({ n: 2.2 }, "n", { integer: true })).toBe(2);
  });

  it("does not round when integer option is omitted", () => {
    expect(readNumberParam({ n: 2.7 }, "n")).toBe(2.7);
  });

  it("handles a zero value", () => {
    expect(readNumberParam({ n: 0 }, "n")).toBe(0);
  });

  it("handles a negative value", () => {
    expect(readNumberParam({ n: -5.5 }, "n")).toBe(-5.5);
  });
});

describe("readBooleanParam", () => {
  it("returns true for a native true boolean", () => {
    expect(readBooleanParam({ flag: true }, "flag")).toBe(true);
  });

  it("returns false for a native false boolean", () => {
    expect(readBooleanParam({ flag: false }, "flag")).toBe(false);
  });

  it('returns true for the string "true"', () => {
    expect(readBooleanParam({ flag: "true" }, "flag")).toBe(true);
  });

  it('returns false for the string "false"', () => {
    expect(readBooleanParam({ flag: "false" }, "flag")).toBe(false);
  });

  it('returns true for the string "1"', () => {
    expect(readBooleanParam({ flag: "1" }, "flag")).toBe(true);
  });

  it('returns false for the string "0"', () => {
    expect(readBooleanParam({ flag: "0" }, "flag")).toBe(false);
  });

  it('is case-insensitive — accepts "TRUE" and "FALSE"', () => {
    expect(readBooleanParam({ flag: "TRUE" }, "flag")).toBe(true);
    expect(readBooleanParam({ flag: "FALSE" }, "flag")).toBe(false);
  });

  it("returns null when the key is absent", () => {
    expect(readBooleanParam({}, "flag")).toBeNull();
  });

  it("returns null when the value is null", () => {
    expect(readBooleanParam({ flag: null }, "flag")).toBeNull();
  });

  it("returns null when the value is undefined", () => {
    expect(readBooleanParam({ flag: undefined }, "flag")).toBeNull();
  });

  it('returns null for an unrecognized string like "yes"', () => {
    expect(readBooleanParam({ flag: "yes" }, "flag")).toBeNull();
  });

  it('returns null for an unrecognized string like "2"', () => {
    expect(readBooleanParam({ flag: "2" }, "flag")).toBeNull();
  });
});

describe("readStringArrayParam", () => {
  it("returns an array of strings for a string array", () => {
    expect(readStringArrayParam({ tags: ["a", "b", "c"] }, "tags")).toEqual(["a", "b", "c"]);
  });

  it("coerces non-string elements (numbers) to strings", () => {
    expect(readStringArrayParam({ ids: [1, 2, 3] }, "ids")).toEqual(["1", "2", "3"]);
  });

  it("coerces boolean elements to strings", () => {
    expect(readStringArrayParam({ vals: [true, false] }, "vals")).toEqual(["true", "false"]);
  });

  it("returns null when the value is not an array", () => {
    expect(readStringArrayParam({ tags: "single" }, "tags")).toBeNull();
  });

  it("returns null when the value is a plain object", () => {
    expect(readStringArrayParam({ tags: { a: 1 } }, "tags")).toBeNull();
  });

  it("returns null when the key is absent", () => {
    expect(readStringArrayParam({}, "tags")).toBeNull();
  });

  it("returns null when the value is null", () => {
    expect(readStringArrayParam({ tags: null }, "tags")).toBeNull();
  });

  it("returns an empty array for an empty array value", () => {
    expect(readStringArrayParam({ tags: [] }, "tags")).toEqual([]);
  });
});

describe("safeExecute", () => {
  it("returns the result of a successful function", async () => {
    const expected = jsonResult({ ok: true });
    const result = await safeExecute(async () => expected);
    expect(result).toBe(expected);
  });

  it("catches a thrown Error and returns an error result", async () => {
    const result = await safeExecute(async () => {
      throw new Error("boom");
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("boom");
  });

  it("catches a thrown non-Error value and converts it to string", async () => {
    const result = await safeExecute(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "plain string error";
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("plain string error");
  });

  it("catches a thrown number and stringifies it", async () => {
    const result = await safeExecute(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 404;
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("404");
  });

  it("sets details to null on a caught error result", async () => {
    const result = await safeExecute(async () => {
      throw new Error("details check");
    });
    expect(result.details).toBeNull();
  });
});

describe("adaptTool", () => {
  it("returns the tool object unchanged (identity)", () => {
    const tool = {
      label: "My Tool",
      name: "my_tool",
      description: "Does something useful",
      parameters: { type: "object", properties: {} },
      execute: async () => jsonResult({}),
    };
    expect(adaptTool(tool)).toBe(tool);
  });

  it("preserves all properties on the returned object", () => {
    const execute = async () => jsonResult({ ok: true });
    const tool = {
      label: "L",
      name: "N",
      description: "D",
      parameters: null,
      execute,
    };
    const adapted = adaptTool(tool);
    expect(adapted.label).toBe("L");
    expect(adapted.name).toBe("N");
    expect(adapted.description).toBe("D");
    expect(adapted.parameters).toBeNull();
    expect(adapted.execute).toBe(execute);
  });
});
