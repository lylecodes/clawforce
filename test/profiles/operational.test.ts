import { describe, expect, it } from "vitest";
import type {
  OperationalProfile,
  OperationalProfileConfig,
  CostBucket,
  CostLineItem,
  ProfileCostEstimate,
  ProfileRecommendation,
} from "../../src/types.js";
import { OPERATIONAL_PROFILES } from "../../src/types.js";

describe("operational profile types", () => {
  it("exports OPERATIONAL_PROFILES constant", () => {
    expect(OPERATIONAL_PROFILES).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("OperationalProfileConfig type can be constructed", () => {
    const config: OperationalProfileConfig = {
      profile: "medium",
      coordination: {
        sessionTarget: "main",
        sessionPersistHours: 8,
        cronSchedule: "*/30 * * * *",
        adaptiveWake: true,
        wakeBounds: ["30m", "120m"],
      },
      memory: {
        reviewSchedule: "0 18 * * *",
        reviewAggressiveness: "medium",
        ghostRecallIntensity: "medium",
        expectations: true,
      },
      meetings: {
        standupSchedule: "0 9 * * MON-FRI",
        reflectionSchedule: "0 9 * * FRI",
      },
      models: {
        managerRecommended: "gpt-5.4",
        employeeRecommended: "gpt-5.4-mini",
      },
    };
    expect(config.profile).toBe("medium");
    expect(config.coordination.sessionTarget).toBe("main");
  });
});

describe("expandProfile", () => {
  it("expands low profile with correct defaults", async () => {
    const { expandProfile } = await import("../../src/profiles/operational.js");
    const config = expandProfile("low");

    expect(config.profile).toBe("low");
    expect(config.coordination.sessionTarget).toBe("isolated");
    expect(config.coordination.cronSchedule).toBe("0 */2 * * *");
    expect(config.coordination.adaptiveWake).toBe(false);
    expect(config.memory.reviewAggressiveness).toBe("low");
    expect(config.memory.ghostRecallIntensity).toBe("low");
    expect(config.memory.expectations).toBe(false);
    expect(config.meetings.standupSchedule).toBeUndefined();
    expect(config.meetings.reflectionSchedule).toBe("0 9 * * FRI");
    expect(config.models.managerRecommended).toBe("gpt-5.4-mini");
    expect(config.models.employeeRecommended).toBe("gpt-5.4-mini");
    expect(config.sessionReset).toBeUndefined();
  });

  it("expands medium profile", async () => {
    const { expandProfile } = await import("../../src/profiles/operational.js");
    const config = expandProfile("medium");

    expect(config.profile).toBe("medium");
    expect(config.coordination.sessionTarget).toBe("main");
    expect(config.coordination.sessionPersistHours).toBe(8);
    expect(config.coordination.cronSchedule).toBe("*/30 * * * *");
    expect(config.coordination.adaptiveWake).toBe(true);
    expect(config.coordination.wakeBounds).toEqual(["30m", "120m"]);
    expect(config.memory.reviewSchedule).toBe("0 18 * * *");
    expect(config.memory.reviewAggressiveness).toBe("medium");
    expect(config.memory.ghostRecallIntensity).toBe("medium");
    expect(config.memory.expectations).toBe(true);
    expect(config.meetings.standupSchedule).toBe("0 9 * * MON-FRI");
    expect(config.meetings.reflectionSchedule).toBe("0 9 * * FRI");
    expect(config.models.managerRecommended).toBe("gpt-5.4");
    expect(config.models.employeeRecommended).toBe("gpt-5.4-mini");
    expect(config.sessionReset?.enabled).toBe(true);
    expect(config.sessionReset?.schedule).toBe("0 0 * * *");
  });

  it("expands high profile", async () => {
    const { expandProfile } = await import("../../src/profiles/operational.js");
    const config = expandProfile("high");

    expect(config.profile).toBe("high");
    expect(config.coordination.sessionTarget).toBe("main");
    expect(config.coordination.sessionPersistHours).toBe(24);
    expect(config.coordination.cronSchedule).toBe("*/15 * * * *");
    expect(config.coordination.adaptiveWake).toBe(true);
    expect(config.coordination.wakeBounds).toEqual(["15m", "120m"]);
    expect(config.memory.reviewSchedule).toBe("0 12,18 * * *");
    expect(config.memory.reviewAggressiveness).toBe("high");
    expect(config.memory.expectations).toBe(true);
    expect(config.meetings.standupSchedule).toBe("0 9,14 * * MON-FRI");
    expect(config.meetings.reflectionSchedule).toBe("0 9 * * WED,FRI");
    expect(config.models.managerRecommended).toBe("gpt-5.4");
    expect(config.models.employeeRecommended).toBe("gpt-5.4");
    expect(config.sessionReset?.enabled).toBe(true);
    expect(config.sessionReset?.schedule).toBe("59 23 * * *");
  });

  it("expands ultra profile", async () => {
    const { expandProfile } = await import("../../src/profiles/operational.js");
    const config = expandProfile("ultra");

    expect(config.profile).toBe("ultra");
    expect(config.coordination.sessionTarget).toBe("main");
    expect(config.coordination.sessionPersistHours).toBe(24);
    expect(config.coordination.cronSchedule).toBe("*/10 * * * *");
    expect(config.coordination.adaptiveWake).toBe(true);
    expect(config.coordination.wakeBounds).toEqual(["10m", "60m"]);
    expect(config.memory.reviewAggressiveness).toBe("high");
    expect(config.memory.ghostRecallIntensity).toBe("high");
    expect(config.memory.expectations).toBe(true);
    expect(config.meetings.standupSchedule).toBe("0 9,12,16 * * MON-FRI");
    expect(config.meetings.reflectionSchedule).toBe("0 18 * * *");
    expect(config.models.managerRecommended).toBe("gpt-5.4");
    expect(config.models.employeeRecommended).toBe("gpt-5.4");
    expect(config.sessionReset?.enabled).toBe(true);
  });
});

describe("normalizeDomainProfile", () => {
  it("returns domain unchanged when no operational_profile is set", async () => {
    const { normalizeDomainProfile } = await import("../../src/profiles/operational.js");

    const domain = {
      domain: "test",
      agents: ["bot"],
    };
    const global = {
      agents: {
        bot: { extends: "employee" },
      },
    };

    const result = normalizeDomainProfile(domain, global);
    expect(result).toEqual(domain);
  });

  it("expands profile and adds jobs to manager agents", async () => {
    const { normalizeDomainProfile } = await import("../../src/profiles/operational.js");

    const domain = {
      domain: "test",
      agents: ["lead", "dev"],
      operational_profile: "medium" as const,
    };
    const global = {
      agents: {
        lead: { extends: "manager" },
        dev: { extends: "employee", reports_to: "lead" },
      },
    };

    const result = normalizeDomainProfile(domain, global);

    // Should have manager_overrides with jobs
    expect(result.manager_overrides).toBeDefined();
    const leadOverrides = result.manager_overrides?.lead;
    expect(leadOverrides).toBeDefined();
    expect(leadOverrides?.jobs?.coordination).toBeDefined();
    expect(leadOverrides?.jobs?.coordination?.cron).toBe("*/30 * * * *");
    expect(leadOverrides?.jobs?.coordination?.sessionTarget).toBe("main");
    expect(leadOverrides?.jobs?.memory_review).toBeDefined();
    expect(leadOverrides?.jobs?.standup).toBeDefined();
    expect(leadOverrides?.jobs?.reflection).toBeDefined();

    // Should have scheduling config
    expect(leadOverrides?.scheduling?.adaptiveWake).toBe(true);
    expect(leadOverrides?.scheduling?.wakeBounds).toEqual(["30m", "120m"]);

    // Employee should get memory config
    const devOverrides = result.manager_overrides?.dev;
    expect(devOverrides).toBeDefined();
    expect(devOverrides?.memory?.review?.aggressiveness).toBe("medium");
  });

  it("does not overwrite existing per-agent job overrides", async () => {
    const { normalizeDomainProfile } = await import("../../src/profiles/operational.js");

    const domain = {
      domain: "test",
      agents: ["lead"],
      operational_profile: "medium" as const,
      manager_overrides: {
        lead: {
          jobs: {
            coordination: {
              cron: "*/5 * * * *",  // custom override
            },
          },
        },
      },
    };
    const global = {
      agents: {
        lead: { extends: "manager" },
      },
    };

    const result = normalizeDomainProfile(domain, global);
    // Custom cron should be preserved
    expect(result.manager_overrides?.lead?.jobs?.coordination?.cron).toBe("*/5 * * * *");
    // But other profile jobs should still be added
    expect(result.manager_overrides?.lead?.jobs?.memory_review).toBeDefined();
  });

  it("adds session_reset for high/ultra profiles", async () => {
    const { normalizeDomainProfile } = await import("../../src/profiles/operational.js");

    const domain = {
      domain: "test",
      agents: ["lead"],
      operational_profile: "high" as const,
    };
    const global = {
      agents: {
        lead: { extends: "manager" },
      },
    };

    const result = normalizeDomainProfile(domain, global);
    expect(result.manager_overrides?.lead?.jobs?.session_reset).toBeDefined();
    expect(result.manager_overrides?.lead?.jobs?.session_reset?.cron).toBe("59 23 * * *");
    expect(result.manager_overrides?.lead?.jobs?.session_reset?.sessionTarget).toBe("main");
  });

  it("does not add session_reset for low profile", async () => {
    const { normalizeDomainProfile } = await import("../../src/profiles/operational.js");

    const domain = {
      domain: "test",
      agents: ["lead"],
      operational_profile: "low" as const,
    };
    const global = {
      agents: {
        lead: { extends: "manager" },
      },
    };

    const result = normalizeDomainProfile(domain, global);
    expect(result.manager_overrides?.lead?.jobs?.session_reset).toBeUndefined();
  });
});
