import { describe, expect, it } from "vitest";

const {
  ACTION_CATEGORIES,
  KNOWN_CATEGORIES,
  isKnownCategory,
  getCategoryDomain,
} = await import("../../src/risk/categories.js");

describe("ACTION_CATEGORIES", () => {
  it("has expected domain groups", () => {
    expect(ACTION_CATEGORIES.communication).toBeDefined();
    expect(ACTION_CATEGORIES.calendar).toBeDefined();
    expect(ACTION_CATEGORIES.financial).toBeDefined();
    expect(ACTION_CATEGORIES.code).toBeDefined();
    expect(ACTION_CATEGORIES.data).toBeDefined();
    expect(ACTION_CATEGORIES.booking).toBeDefined();
  });

  it("contains expected categories", () => {
    expect(ACTION_CATEGORIES.communication).toContain("email:send");
    expect(ACTION_CATEGORIES.financial).toContain("financial:purchase");
    expect(ACTION_CATEGORIES.code).toContain("code:merge_pr");
    expect(ACTION_CATEGORIES.data).toContain("data:delete");
  });
});

describe("KNOWN_CATEGORIES", () => {
  it("is a flat set of all categories", () => {
    expect(KNOWN_CATEGORIES.has("email:send")).toBe(true);
    expect(KNOWN_CATEGORIES.has("code:deploy")).toBe(true);
    expect(KNOWN_CATEGORIES.has("nonexistent")).toBe(false);
  });

  it("has correct total count", () => {
    const expected = Object.values(ACTION_CATEGORIES).flat().length;
    expect(KNOWN_CATEGORIES.size).toBe(expected);
  });
});

describe("isKnownCategory", () => {
  it("returns true for known categories", () => {
    expect(isKnownCategory("email:send")).toBe(true);
    expect(isKnownCategory("calendar:create_event")).toBe(true);
    expect(isKnownCategory("financial:transfer")).toBe(true);
  });

  it("returns false for unknown categories", () => {
    expect(isKnownCategory("custom:action")).toBe(false);
    expect(isKnownCategory("")).toBe(false);
  });
});

describe("getCategoryDomain", () => {
  it("returns the domain for a known category", () => {
    expect(getCategoryDomain("email:send")).toBe("communication");
    expect(getCategoryDomain("calendar:create_event")).toBe("calendar");
    expect(getCategoryDomain("code:merge_pr")).toBe("code");
    expect(getCategoryDomain("financial:purchase")).toBe("financial");
    expect(getCategoryDomain("data:delete")).toBe("data");
    expect(getCategoryDomain("booking:create")).toBe("booking");
  });

  it("returns null for unknown categories", () => {
    expect(getCategoryDomain("custom:action")).toBeNull();
    expect(getCategoryDomain("")).toBeNull();
  });
});
