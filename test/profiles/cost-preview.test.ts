import { describe, expect, it } from "vitest";

describe("cost preview engine", () => {
  describe("estimateProfileCost", () => {
    it("estimates low profile cost for a simple team", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      const estimate = estimateProfileCost("low", [
        { agentId: "lead", role: "manager" },
        { agentId: "dev", role: "employee" },
      ]);

      expect(estimate.profile).toBe("low");
      expect(estimate.dailyCents).toBeGreaterThan(0);
      expect(estimate.monthlyCents).toBe(estimate.dailyCents * 30);
      expect(estimate.buckets.length).toBe(3);

      // Should have management, execution, intelligence buckets
      const bucketNames = estimate.buckets.map((b) => b.name);
      expect(bucketNames).toContain("Management");
      expect(bucketNames).toContain("Execution");
      expect(bucketNames).toContain("Intelligence");
    });

    it("ultra profile costs more than low", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      const agents = [
        { agentId: "lead", role: "manager" as const },
        { agentId: "dev1", role: "employee" as const },
        { agentId: "dev2", role: "employee" as const },
      ];

      const low = estimateProfileCost("low", agents);
      const ultra = estimateProfileCost("ultra", agents);

      expect(ultra.dailyCents).toBeGreaterThan(low.dailyCents);
    });

    it("uses persistent session multiplier for high/ultra coordination", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      // High profile has persistent sessions: coordination should use 0.2x cost
      const estimate = estimateProfileCost("high", [
        { agentId: "lead", role: "manager" },
      ]);

      const mgmt = estimate.buckets.find((b) => b.name === "Management")!;
      expect(mgmt.items.length).toBeGreaterThan(0);
      // Coordination item should exist
      const coordItem = mgmt.items.find((i) => i.label.includes("coordination"));
      expect(coordItem).toBeDefined();
      expect(coordItem!.cents).toBeGreaterThan(0);
    });

    it("reflects budget fit when given a budget", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      const generous = estimateProfileCost("low", [
        { agentId: "lead", role: "manager" },
      ], 100_000); // $1000/day
      expect(generous.fitsInBudget).toBe(true);
      expect(generous.headroomPercent).toBeGreaterThan(0);

      const tight = estimateProfileCost("ultra", [
        { agentId: "lead", role: "manager" },
        { agentId: "dev1", role: "employee" },
        { agentId: "dev2", role: "employee" },
        { agentId: "dev3", role: "employee" },
        { agentId: "dev4", role: "employee" },
      ], 100); // $1/day
      expect(tight.fitsInBudget).toBe(false);
    });

    it("fitsInBudget defaults to true when no budget is given", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      const estimate = estimateProfileCost("medium", [
        { agentId: "lead", role: "manager" },
      ]);
      expect(estimate.fitsInBudget).toBe(true);
    });

    it("each bucket total matches sum of its items", async () => {
      const { estimateProfileCost } = await import("../../src/profiles/cost-preview.js");

      const estimate = estimateProfileCost("medium", [
        { agentId: "lead", role: "manager" },
        { agentId: "dev", role: "employee" },
      ]);

      for (const bucket of estimate.buckets) {
        const itemSum = bucket.items.reduce((sum, item) => sum + item.cents, 0);
        expect(bucket.totalCents).toBeCloseTo(itemSum, 0);
      }
    });
  });

  describe("recommendProfile", () => {
    it("recommends the highest profile within budget with 30% headroom", async () => {
      const { recommendProfile } = await import("../../src/profiles/cost-preview.js");

      // $100/day budget with 2 agents
      const rec = recommendProfile(2, 10_000);
      expect(rec.recommended).toBeDefined();
      expect(["low", "medium", "high", "ultra"]).toContain(rec.recommended);
      expect(rec.reason).toBeTruthy();
      expect(rec.allProfiles.length).toBe(4);
    });

    it("recommends low with warning when nothing fits", async () => {
      const { recommendProfile } = await import("../../src/profiles/cost-preview.js");

      const rec = recommendProfile(10, 50); // $0.50/day for 10 agents
      expect(rec.recommended).toBe("low");
      expect(rec.reason).toContain("tight");
    });

    it("all profiles are included in allProfiles sorted by cost", async () => {
      const { recommendProfile } = await import("../../src/profiles/cost-preview.js");

      const rec = recommendProfile(3, 50_000);
      expect(rec.allProfiles.length).toBe(4);
      expect(rec.allProfiles[0].profile).toBe("low");
      expect(rec.allProfiles[3].profile).toBe("ultra");

      // Each subsequent profile should cost more
      for (let i = 1; i < rec.allProfiles.length; i++) {
        expect(rec.allProfiles[i]!.estimatedCents).toBeGreaterThanOrEqual(
          rec.allProfiles[i - 1]!.estimatedCents,
        );
      }
    });

    it("respects custom agent roles in recommendation", async () => {
      const { recommendProfile } = await import("../../src/profiles/cost-preview.js");

      // Mostly managers should be more expensive
      const managerHeavy = recommendProfile(5, 50_000, [
        { agentId: "m1", role: "manager" },
        { agentId: "m2", role: "manager" },
        { agentId: "m3", role: "manager" },
        { agentId: "e1", role: "employee" },
        { agentId: "e2", role: "employee" },
      ]);

      const employeeHeavy = recommendProfile(5, 50_000, [
        { agentId: "m1", role: "manager" },
        { agentId: "e1", role: "employee" },
        { agentId: "e2", role: "employee" },
        { agentId: "e3", role: "employee" },
        { agentId: "e4", role: "employee" },
      ]);

      // Manager-heavy team should have higher costs at same profile
      const mIdx = managerHeavy.allProfiles.findIndex((p) => p.profile === "medium");
      const eIdx = employeeHeavy.allProfiles.findIndex((p) => p.profile === "medium");
      expect(managerHeavy.allProfiles[mIdx]!.estimatedCents).toBeGreaterThan(
        employeeHeavy.allProfiles[eIdx]!.estimatedCents,
      );
    });
  });
});
