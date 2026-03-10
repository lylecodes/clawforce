import { beforeEach, describe, expect, it } from "vitest";

const {
  recordToolGateHit,
  checkBulkThreshold,
  getEffectiveTier,
  resetBulkDetector,
  getActionCount,
} = await import("../../src/risk/bulk-detector.js");

const PROJECT = "test-bulk";
const AGENT = "assistant";

beforeEach(() => {
  resetBulkDetector();
});

describe("recordToolGateHit + getActionCount", () => {
  it("tracks hits in a sliding window", () => {
    recordToolGateHit(PROJECT, AGENT, "email:send");
    recordToolGateHit(PROJECT, AGENT, "email:send");
    recordToolGateHit(PROJECT, AGENT, "email:send");

    expect(getActionCount(PROJECT, AGENT, "email:send", 60_000)).toBe(3);
  });

  it("isolates by project/agent/category", () => {
    recordToolGateHit(PROJECT, AGENT, "email:send");
    recordToolGateHit(PROJECT, "other-agent", "email:send");
    recordToolGateHit("other-project", AGENT, "email:send");
    recordToolGateHit(PROJECT, AGENT, "calendar:create_event");

    expect(getActionCount(PROJECT, AGENT, "email:send", 60_000)).toBe(1);
    expect(getActionCount(PROJECT, "other-agent", "email:send", 60_000)).toBe(1);
    expect(getActionCount("other-project", AGENT, "email:send", 60_000)).toBe(1);
    expect(getActionCount(PROJECT, AGENT, "calendar:create_event", 60_000)).toBe(1);
  });

  it("returns 0 for unknown keys", () => {
    expect(getActionCount(PROJECT, AGENT, "nonexistent", 60_000)).toBe(0);
  });
});

describe("checkBulkThreshold", () => {
  it("returns not exceeded when below threshold", () => {
    for (let i = 0; i < 4; i++) {
      recordToolGateHit(PROJECT, AGENT, "email:send");
    }

    const result = checkBulkThreshold(PROJECT, AGENT, "email:send", {
      "email:send": { windowMs: 3_600_000, maxCount: 5, escalateTo: "high" },
    });

    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(4);
  });

  it("returns exceeded when at or above threshold", () => {
    for (let i = 0; i < 5; i++) {
      recordToolGateHit(PROJECT, AGENT, "email:send");
    }

    const result = checkBulkThreshold(PROJECT, AGENT, "email:send", {
      "email:send": { windowMs: 3_600_000, maxCount: 5, escalateTo: "high" },
    });

    expect(result.exceeded).toBe(true);
    expect(result.count).toBe(5);
    expect(result.escalatedTier).toBe("high");
  });

  it("returns not exceeded for unconfigured categories", () => {
    recordToolGateHit(PROJECT, AGENT, "email:send");

    const result = checkBulkThreshold(PROJECT, AGENT, "email:send", {
      "calendar:create_event": { windowMs: 3_600_000, maxCount: 3, escalateTo: "high" },
    });

    expect(result.exceeded).toBe(false);
    expect(result.count).toBe(0);
  });

  it("returns not exceeded with empty thresholds", () => {
    recordToolGateHit(PROJECT, AGENT, "email:send");

    const result = checkBulkThreshold(PROJECT, AGENT, "email:send", {});

    expect(result.exceeded).toBe(false);
  });
});

describe("getEffectiveTier", () => {
  it("returns original tier when no thresholds configured", () => {
    const result = getEffectiveTier(PROJECT, AGENT, "email:send", "medium", undefined);

    expect(result.tier).toBe("medium");
    expect(result.bulkEscalated).toBe(false);
  });

  it("returns original tier when below threshold", () => {
    recordToolGateHit(PROJECT, AGENT, "email:send");

    const result = getEffectiveTier(PROJECT, AGENT, "email:send", "medium", {
      "email:send": { windowMs: 3_600_000, maxCount: 5, escalateTo: "high" },
    });

    expect(result.tier).toBe("medium");
    expect(result.bulkEscalated).toBe(false);
  });

  it("escalates tier when threshold exceeded", () => {
    for (let i = 0; i < 10; i++) {
      recordToolGateHit(PROJECT, AGENT, "email:send");
    }

    const result = getEffectiveTier(PROJECT, AGENT, "email:send", "medium", {
      "email:send": { windowMs: 3_600_000, maxCount: 5, escalateTo: "high" },
    });

    expect(result.tier).toBe("high");
    expect(result.bulkEscalated).toBe(true);
    expect(result.count).toBe(10);
  });

  it("does not escalate if escalatedTier is lower than original", () => {
    for (let i = 0; i < 10; i++) {
      recordToolGateHit(PROJECT, AGENT, "email:send");
    }

    const result = getEffectiveTier(PROJECT, AGENT, "email:send", "critical", {
      "email:send": { windowMs: 3_600_000, maxCount: 5, escalateTo: "medium" },
    });

    expect(result.tier).toBe("critical");
    expect(result.bulkEscalated).toBe(false);
  });
});
