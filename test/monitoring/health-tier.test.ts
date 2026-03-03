import { describe, expect, it } from "vitest";
import { computeHealthTier } from "../../src/monitoring/health-tier.js";

describe("computeHealthTier", () => {
  it("returns GREEN when all clear", () => {
    const tier = computeHealthTier({
      sloChecked: 5,
      sloBreach: 0,
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("GREEN");
  });

  it("returns GREEN when nothing is checked", () => {
    const tier = computeHealthTier({
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("GREEN");
  });

  it("returns YELLOW when a single SLO breach exists", () => {
    const tier = computeHealthTier({
      sloChecked: 5,
      sloBreach: 1,
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("YELLOW");
  });

  it("returns YELLOW when a single alert fires", () => {
    const tier = computeHealthTier({
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 1,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("YELLOW");
  });

  it("returns YELLOW when an anomaly is detected", () => {
    const tier = computeHealthTier({
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 0,
      anomaliesDetected: 1,
    });
    expect(tier).toBe("YELLOW");
  });

  it("returns RED when 50%+ SLO breaches", () => {
    const tier = computeHealthTier({
      sloChecked: 4,
      sloBreach: 2,
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("RED");
  });

  it("returns RED when 100% SLO breaches", () => {
    const tier = computeHealthTier({
      sloChecked: 3,
      sloBreach: 3,
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("RED");
  });

  it("returns RED when 3+ alerts fired", () => {
    const tier = computeHealthTier({
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 3,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("RED");
  });

  it("returns RED when alerts threshold met even with no SLO breach", () => {
    const tier = computeHealthTier({
      sloChecked: 5,
      sloBreach: 0,
      alertsFired: 4,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("RED");
  });

  it("YELLOW boundary: exactly below 50% breach", () => {
    const tier = computeHealthTier({
      sloChecked: 10,
      sloBreach: 4, // 40% < 50%
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("YELLOW");
  });

  it("RED boundary: exactly at 50% breach", () => {
    const tier = computeHealthTier({
      sloChecked: 10,
      sloBreach: 5, // 50% >= 50%
      alertsFired: 0,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("RED");
  });

  it("YELLOW boundary: 2 alerts (below 3)", () => {
    const tier = computeHealthTier({
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 2,
      anomaliesDetected: 0,
    });
    expect(tier).toBe("YELLOW");
  });
});
