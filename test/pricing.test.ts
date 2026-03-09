import { describe, it, expect, beforeEach } from "vitest";
import {
  getPricing,
  registerModelPricing,
  clearPricingCache,
  registerModelPricingFromConfig,
  registerBulkPricing,
} from "../src/pricing.js";

describe("pricing", () => {
  beforeEach(() => clearPricingCache());

  it("returns default pricing for unknown model", () => {
    const p = getPricing("unknown-model");
    expect(p.inputPerM).toBeGreaterThan(0);
    expect(p.outputPerM).toBeGreaterThan(0);
  });

  it("returns registered pricing for known model", () => {
    registerModelPricing("test-model", {
      inputPerM: 100,
      outputPerM: 500,
      cacheReadPerM: 10,
      cacheWritePerM: 50,
    });
    const p = getPricing("test-model");
    expect(p.inputPerM).toBe(100);
    expect(p.outputPerM).toBe(500);
  });

  it("loads pricing from OpenClaw ModelDefinitionConfig format", () => {
    // OpenClaw uses cost per 1M tokens as raw numbers (dollars)
    registerModelPricingFromConfig("oc-model", {
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    });
    const p = getPricing("oc-model");
    // Converted to cents per M tokens
    expect(p.inputPerM).toBe(1500);
    expect(p.outputPerM).toBe(7500);
  });

  it("registerBulk registers multiple models at once", () => {
    registerBulkPricing([
      { id: "model-a", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      { id: "model-b", cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
    ]);
    expect(getPricing("model-a").inputPerM).toBe(300);
    expect(getPricing("model-b").inputPerM).toBe(80);
  });
});
