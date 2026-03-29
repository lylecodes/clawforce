import { describe, expect, it } from "vitest";
import {
  computeBudgetPacing,
  type BudgetPacingInput,
  type DispatchBudget,
} from "../../src/budget/pacer.js";

describe("computeBudgetPacing", () => {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function defaultInput(overrides: Partial<BudgetPacingInput> = {}): BudgetPacingInput {
    return {
      dailyBudgetCents: 10000, // $100
      spentCents: 2000,        // $20 spent
      hoursRemaining: 16,
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Normal pacing computation
  // ---------------------------------------------------------------------------

  describe("normal pacing", () => {
    it("computes hourly rate from allocatable budget", () => {
      const result = computeBudgetPacing(defaultInput());

      // remaining = 10000 - 2000 = 8000
      // reserve = 8000 * 0.20 = 1600
      // allocatable = 8000 - 1600 = 6400
      // hourlyRate = 6400 / 16 = 400
      expect(result.hourlyRate).toBe(400);
      expect(result.reactiveReserve).toBe(1600);
    });

    it("allows both lead and worker dispatch under normal conditions", () => {
      const result = computeBudgetPacing(defaultInput());
      expect(result.canDispatchLead).toBe(true);
      expect(result.canDispatchWorker).toBe(true);
    });

    it("returns zero pace delay when under hourly rate", () => {
      const result = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 100, // well under hourlyRate of 400
      }));
      expect(result.paceDelay).toBe(0);
    });

    it("generates a recommendation string", () => {
      const result = computeBudgetPacing(defaultInput());
      expect(result.recommendation).toBeTruthy();
      expect(typeof result.recommendation).toBe("string");
      expect(result.recommendation.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Critical budget threshold
  // ---------------------------------------------------------------------------

  describe("critical threshold", () => {
    it("blocks everything when remaining is at or below critical threshold", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 9600, // 4% remaining (below default 5%)
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.recommendation).toContain("critical");
    });

    it("blocks everything at exactly the critical threshold", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 9500, // exactly 5% remaining
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
    });

    it("respects custom critical threshold", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 8500, // 15% remaining
        criticalThreshold: 20,  // custom: 20% triggers critical
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Low budget threshold
  // ---------------------------------------------------------------------------

  describe("low budget threshold", () => {
    it("blocks workers but allows leads in low budget mode", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 9100, // 9% remaining (below default 10%, above default 5% critical)
      }));

      expect(result.canDispatchLead).toBe(true);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.recommendation).toContain("low");
    });

    it("triggers at exactly the low budget threshold", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 9000, // exactly 10% remaining
      }));

      expect(result.canDispatchLead).toBe(true);
      expect(result.canDispatchWorker).toBe(false);
    });

    it("respects custom low budget threshold", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 7500, // 25% remaining
        lowBudgetThreshold: 30,  // custom: 30% triggers low
        criticalThreshold: 5,
      }));

      expect(result.canDispatchLead).toBe(true);
      expect(result.canDispatchWorker).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Pace delay when burning too fast
  // ---------------------------------------------------------------------------

  describe("pace delay", () => {
    it("computes positive delay when current hour spend exceeds hourly rate", () => {
      const result = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 600, // over hourlyRate of 400
      }));

      expect(result.paceDelay).toBeGreaterThan(0);
    });

    it("delay scales with overspend amount", () => {
      const small = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 500, // slightly over 400
      }));
      const large = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 800, // way over 400
      }));

      expect(large.paceDelay).toBeGreaterThan(small.paceDelay);
    });

    it("returns zero delay when currentHourSpent is under hourly rate", () => {
      const result = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 200,
      }));
      expect(result.paceDelay).toBe(0);
    });

    it("returns zero delay when currentHourSpent is not provided", () => {
      const result = computeBudgetPacing(defaultInput());
      expect(result.paceDelay).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Custom reserve percentage
  // ---------------------------------------------------------------------------

  describe("reactive reserve", () => {
    it("applies custom reactive reserve percentage", () => {
      const result = computeBudgetPacing(defaultInput({
        reactiveReservePct: 30,
      }));

      // remaining = 8000, reserve = 8000 * 0.30 = 2400
      // allocatable = 8000 - 2400 = 5600
      // hourlyRate = 5600 / 16 = 350
      expect(result.reactiveReserve).toBe(2400);
      expect(result.hourlyRate).toBe(350);
    });

    it("uses 20% reserve by default", () => {
      const result = computeBudgetPacing(defaultInput());
      // remaining = 8000, reserve = 8000 * 0.20 = 1600
      expect(result.reactiveReserve).toBe(1600);
    });
  });

  // ---------------------------------------------------------------------------
  // Lead/worker session cost checks
  // ---------------------------------------------------------------------------

  describe("session cost gating", () => {
    it("blocks lead dispatch when remaining is less than lead session cost", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 8400, // remaining = 1600, above low threshold (16%)
        leadSessionCostCents: 2000, // but can't afford a lead session
      }));

      expect(result.canDispatchLead).toBe(false);
    });

    it("blocks worker dispatch when remaining is less than worker session cost", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 100,
        spentCents: 50, // remaining = 50, 50% budget remaining
        workerSessionCostCents: 60, // can't afford a worker session
      }));

      expect(result.canDispatchWorker).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles zero hoursRemaining by blocking everything", () => {
      const result = computeBudgetPacing(defaultInput({
        hoursRemaining: 0,
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.hourlyRate).toBe(0);
    });

    it("handles fully spent budget", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 10000,
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.hourlyRate).toBe(0);
    });

    it("handles overspent budget (spent > daily)", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 10000,
        spentCents: 12000,
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.hourlyRate).toBe(0);
      expect(result.reactiveReserve).toBe(0);
    });

    it("handles zero daily budget", () => {
      const result = computeBudgetPacing(defaultInput({
        dailyBudgetCents: 0,
        spentCents: 0,
      }));

      expect(result.canDispatchLead).toBe(false);
      expect(result.canDispatchWorker).toBe(false);
      expect(result.hourlyRate).toBe(0);
    });

    it("handles fractional hours remaining", () => {
      const result = computeBudgetPacing(defaultInput({
        hoursRemaining: 0.5,
      }));

      // remaining = 8000, reserve = 1600, allocatable = 6400
      // hourlyRate = 6400 / 0.5 = 12800
      expect(result.hourlyRate).toBe(12800);
      expect(result.canDispatchLead).toBe(true);
      expect(result.canDispatchWorker).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Recommendation string
  // ---------------------------------------------------------------------------

  describe("recommendation strings", () => {
    it("reports normal pacing", () => {
      const result = computeBudgetPacing(defaultInput());
      expect(result.recommendation).toMatch(/normal|ok|healthy/i);
    });

    it("reports critical state", () => {
      const result = computeBudgetPacing(defaultInput({
        spentCents: 9600,
      }));
      expect(result.recommendation).toMatch(/critical/i);
    });

    it("reports low budget state", () => {
      const result = computeBudgetPacing(defaultInput({
        spentCents: 9100,
      }));
      expect(result.recommendation).toMatch(/low/i);
    });

    it("reports exhausted state", () => {
      const result = computeBudgetPacing(defaultInput({
        spentCents: 10000,
      }));
      expect(result.recommendation).toMatch(/exhaust/i);
    });

    it("reports throttled state when pace delay is active", () => {
      const result = computeBudgetPacing(defaultInput({
        currentHourSpentCents: 600,
      }));
      expect(result.recommendation).toMatch(/throttl|delay|pac/i);
    });
  });
});
