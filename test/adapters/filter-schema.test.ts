import { describe, expect, it } from "vitest";

/**
 * Test the description stripping logic used by filterToolSchema.
 * We test the stripRemovedActionReferences function indirectly by testing
 * the pattern matching logic.
 */
describe("filterToolSchema description stripping", () => {
  // Replicate the stripping logic for testing
  function stripRemovedActionReferences(text: string, removedActions: string[]): string {
    let result = text;
    for (const action of removedActions) {
      result = result.replace(new RegExp(`\\b${action}:\\s*[^.,;]*[.,;]?\\s*`, "g"), "");
      result = result.replace(new RegExp(`,?\\s*\\b${action}\\b\\s*,?`, "g"), (match) => {
        return match.startsWith(",") && match.endsWith(",") ? "," : "";
      });
    }
    result = result.replace(/\s{2,}/g, " ").trim();
    return result;
  }

  it("strips action: description patterns", () => {
    const text = "CRUD: create, get, list. Lifecycle: transition, fail.";
    const result = stripRemovedActionReferences(text, ["create", "fail"]);
    expect(result).not.toContain("create");
    expect(result).not.toContain("fail");
    expect(result).toContain("get");
    expect(result).toContain("list");
    expect(result).toContain("transition");
  });

  it("strips comma-separated action references", () => {
    const text = "Actions: create, get, list, transition";
    const result = stripRemovedActionReferences(text, ["create", "transition"]);
    expect(result).not.toContain("create");
    expect(result).not.toContain("transition");
    expect(result).toContain("get");
    expect(result).toContain("list");
  });

  it("handles empty removedActions", () => {
    const text = "Some description";
    expect(stripRemovedActionReferences(text, [])).toBe(text);
  });

  it("handles no matches", () => {
    const text = "Some description with no matching actions";
    expect(stripRemovedActionReferences(text, ["nonexistent"])).toBe(text);
  });
});
