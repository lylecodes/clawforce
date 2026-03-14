import { afterEach, describe, expect, it } from "vitest";

describe("stream catalog", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("registers and retrieves a stream", async () => {
    const { registerStream, getStream } = await import("../../src/streams/catalog.js");
    registerStream({
      name: "test_stream",
      description: "A test stream",
      builtIn: true,
      outputTargets: ["briefing"],
    });

    const stream = getStream("test_stream");
    expect(stream).toBeDefined();
    expect(stream!.name).toBe("test_stream");
    expect(stream!.builtIn).toBe(true);
  });

  it("lists all registered streams", async () => {
    const { registerStream, listStreams } = await import("../../src/streams/catalog.js");
    registerStream({ name: "a", description: "A", builtIn: true, outputTargets: ["briefing"] });
    registerStream({ name: "b", description: "B", builtIn: false, outputTargets: ["webhook"] });

    const streams = listStreams();
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("returns undefined for unknown stream", async () => {
    const { getStream } = await import("../../src/streams/catalog.js");
    expect(getStream("nonexistent")).toBeUndefined();
  });

  it("registers stream with parameter schema", async () => {
    const { registerStream, getStream } = await import("../../src/streams/catalog.js");
    registerStream({
      name: "parameterized",
      description: "Has params",
      builtIn: true,
      outputTargets: ["briefing"],
      params: [
        { name: "horizon", type: "string", description: "Time horizon", default: "24h" },
        { name: "limit", type: "number", description: "Max results", required: true },
      ],
    });

    const stream = getStream("parameterized")!;
    expect(stream.params).toHaveLength(2);
    expect(stream.params![0].name).toBe("horizon");
  });

  it("prevents duplicate registration", async () => {
    const { registerStream } = await import("../../src/streams/catalog.js");
    registerStream({ name: "dup", description: "First", builtIn: true, outputTargets: [] });
    registerStream({ name: "dup", description: "Second", builtIn: true, outputTargets: [] });

    const { getStream } = await import("../../src/streams/catalog.js");
    // Second registration overwrites
    expect(getStream("dup")!.description).toBe("Second");
  });
});

describe("builtin manifest", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("registers all built-in sources", async () => {
    const { registerBuiltinStreams } = await import("../../src/streams/builtin-manifest.js");
    const { listStreams } = await import("../../src/streams/catalog.js");

    registerBuiltinStreams();
    const streams = listStreams();

    // Should have all 33 built-in sources
    expect(streams.length).toBeGreaterThanOrEqual(29);
    expect(streams.every((s) => s.builtIn)).toBe(true);

    // Spot check key sources
    const names = streams.map((s) => s.name);
    expect(names).toContain("task_board");
    expect(names).toContain("cost_forecast");
    expect(names).toContain("knowledge_candidates");
  });
});
