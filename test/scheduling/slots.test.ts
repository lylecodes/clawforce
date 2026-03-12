import { describe, expect, it } from "vitest";

describe("computeAvailableSlots", () => {
  it("computes available slots based on rate limits and active sessions", async () => {
    const { computeAvailableSlots } = await import("../../src/scheduling/slots.js");

    const slots = computeAvailableSlots({
      models: {
        "claude-opus-4-6": { rpm: 60, tpm: 200000, costPer1kInput: 15, costPer1kOutput: 75 },
        "claude-sonnet-4-6": { rpm: 120, tpm: 400000, costPer1kInput: 3, costPer1kOutput: 15 },
      },
      activeSessions: {
        "claude-opus-4-6": 4,
        "claude-sonnet-4-6": 2,
      },
      avgTokensPerSession: {
        "claude-opus-4-6": 15000,
        "claude-sonnet-4-6": 8000,
      },
    });

    expect(slots).toHaveLength(2);
    const opus = slots.find((s) => s.model === "claude-opus-4-6")!;
    const sonnet = slots.find((s) => s.model === "claude-sonnet-4-6")!;

    expect(opus.currentActive).toBe(4);
    expect(opus.availableSlots).toBeGreaterThanOrEqual(0);

    expect(sonnet.currentActive).toBe(2);
    expect(sonnet.availableSlots).toBeGreaterThan(opus.availableSlots);
  });

  it("returns 0 slots when rate limit is fully utilized", async () => {
    const { computeAvailableSlots } = await import("../../src/scheduling/slots.js");

    const slots = computeAvailableSlots({
      models: {
        "claude-opus-4-6": { rpm: 10, tpm: 50000, costPer1kInput: 15, costPer1kOutput: 75 },
      },
      activeSessions: {
        "claude-opus-4-6": 10,
      },
      avgTokensPerSession: {
        "claude-opus-4-6": 15000,
      },
    });

    const opus = slots.find((s) => s.model === "claude-opus-4-6")!;
    expect(opus.availableSlots).toBe(0);
  });

  it("uses default tokens when no average provided", async () => {
    const { computeAvailableSlots } = await import("../../src/scheduling/slots.js");

    const slots = computeAvailableSlots({
      models: {
        "claude-sonnet-4-6": { rpm: 120, tpm: 400000, costPer1kInput: 3, costPer1kOutput: 15 },
      },
      activeSessions: {},
      avgTokensPerSession: {},
    });

    const sonnet = slots.find((s) => s.model === "claude-sonnet-4-6")!;
    expect(sonnet.avgTokensPerSession).toBe(10000); // DEFAULT_AVG_TOKENS
    expect(sonnet.availableSlots).toBeGreaterThan(0);
  });
});
