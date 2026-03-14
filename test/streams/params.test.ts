import { afterEach, describe, expect, it } from "vitest";

describe("stream params validation", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("validates params against schema", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    const { validateStreamParams } = await import("../../src/streams/params.js");

    registerStream({
      name: "test",
      description: "Test",
      builtIn: true,
      outputTargets: ["briefing"],
      params: [
        { name: "limit", type: "number", description: "Max", required: true },
        { name: "format", type: "string", description: "Output format", default: "table" },
      ],
    });

    // Valid: required param provided
    expect(validateStreamParams("test", { limit: 10 }).valid).toBe(true);

    // Valid: optional param omitted
    expect(validateStreamParams("test", { limit: 5 }).valid).toBe(true);

    // Invalid: required param missing
    const missing = validateStreamParams("test", {});
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]).toContain("limit");

    // Invalid: wrong type
    const wrongType = validateStreamParams("test", { limit: "abc" });
    expect(wrongType.valid).toBe(false);
  });

  it("returns valid for stream with no param schema", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    const { validateStreamParams } = await import("../../src/streams/params.js");

    registerStream({ name: "simple", description: "No params", builtIn: true, outputTargets: [] });
    expect(validateStreamParams("simple", { anything: true }).valid).toBe(true);
  });

  it("returns valid for unknown stream", async () => {
    const { validateStreamParams } = await import("../../src/streams/params.js");
    expect(validateStreamParams("unknown", {}).valid).toBe(true);
  });
});
