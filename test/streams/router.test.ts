import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("stream router", () => {
  afterEach(async () => {
    const { clearCatalog } = await import("../../src/streams/catalog.js");
    clearCatalog();
  });

  it("evaluates a route with passing condition", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "test-route",
        source: "cost_forecast",
        condition: "hours_remaining < 4",
        outputs: [{ target: "log" as const }],
      },
      { hours_remaining: 2, total_spend: 1500 },
    );

    expect(result.matched).toBe(true);
    expect(result.outputs).toHaveLength(1);
  });

  it("skips route when condition fails", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "test-route",
        source: "cost_forecast",
        condition: "hours_remaining < 4",
        outputs: [{ target: "log" as const }],
      },
      { hours_remaining: 10 },
    );

    expect(result.matched).toBe(false);
  });

  it("matches when no condition specified", async () => {
    const { evaluateRoute } = await import("../../src/streams/router.js");

    const result = evaluateRoute(
      {
        name: "always-route",
        source: "task_board",
        outputs: [{ target: "log" as const }],
      },
      { tasks: 5 },
    );

    expect(result.matched).toBe(true);
  });

  it("delivers to log output adapter", async () => {
    const { deliverToOutput } = await import("../../src/streams/router.js");

    // Log adapter should not throw
    const result = await deliverToOutput(
      { target: "log" as const },
      "test-route",
      "Some content to log",
      "test-project",
    );

    expect(result.delivered).toBe(true);
  });

  it("delivers to webhook output adapter", async () => {
    const { deliverToOutput } = await import("../../src/streams/router.js");

    // Webhook to invalid URL should fail gracefully
    const result = await deliverToOutput(
      { target: "webhook" as const, url: "http://localhost:99999/invalid" },
      "test-route",
      "payload",
      "test-project",
    );

    expect(result.delivered).toBe(false);
  });
});
