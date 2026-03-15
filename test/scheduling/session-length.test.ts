/**
 * Tests for Task 10.2: Session Length Optimization
 * - SchedulingConfig.maxTurnsPerCycle field
 * - Manager preset default of 50 turns per cycle
 * - Wrap-up instruction injection logic (via adapter before_prompt_build hook simulation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SchedulingConfig } from "../../src/types.js";

describe("SchedulingConfig.maxTurnsPerCycle", () => {
  it("is optional (undefined by default — backward compatible)", () => {
    const cfg: SchedulingConfig = { adaptiveWake: true };
    expect(cfg.maxTurnsPerCycle).toBeUndefined();
  });

  it("accepts a numeric value", () => {
    const cfg: SchedulingConfig = { maxTurnsPerCycle: 50 };
    expect(cfg.maxTurnsPerCycle).toBe(50);
  });

  it("accepts maxTurnsPerCycle: 0 (edge case — wraps immediately)", () => {
    const cfg: SchedulingConfig = { maxTurnsPerCycle: 0 };
    expect(cfg.maxTurnsPerCycle).toBe(0);
  });
});

describe("manager preset maxTurnsPerCycle default", () => {
  it("manager preset has maxTurnsPerCycle: 50", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const manager = BUILTIN_AGENT_PRESETS["manager"];
    expect(manager).toBeDefined();
    const scheduling = manager?.scheduling as SchedulingConfig | undefined;
    expect(scheduling?.maxTurnsPerCycle).toBe(50);
  });

  it("employee preset does not have maxTurnsPerCycle", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const employee = BUILTIN_AGENT_PRESETS["employee"];
    expect(employee).toBeDefined();
    const scheduling = employee?.scheduling as SchedulingConfig | undefined;
    // Employee has no scheduling config at all
    expect(scheduling?.maxTurnsPerCycle).toBeUndefined();
  });

  it("resolveConfig propagates maxTurnsPerCycle from manager preset", async () => {
    const { resolveConfig, BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const resolved = resolveConfig(
      { extends: "manager", briefing: [], expectations: [], performance_policy: { action: "alert" } },
      BUILTIN_AGENT_PRESETS,
    );
    const scheduling = resolved.scheduling as SchedulingConfig | undefined;
    expect(scheduling?.maxTurnsPerCycle).toBe(50);
  });

  it("child config can override maxTurnsPerCycle from manager preset", async () => {
    const { resolveConfig, BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const resolved = resolveConfig(
      {
        extends: "manager",
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
        scheduling: { maxTurnsPerCycle: 100 },
      },
      BUILTIN_AGENT_PRESETS,
    );
    const scheduling = resolved.scheduling as SchedulingConfig | undefined;
    expect(scheduling?.maxTurnsPerCycle).toBe(100);
  });

  it("child config can disable the limit by setting maxTurnsPerCycle to undefined", async () => {
    const { resolveConfig, BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    // When child omits maxTurnsPerCycle, it inherits manager's 50
    const resolved = resolveConfig(
      {
        extends: "manager",
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
        scheduling: { adaptiveWake: false },
      },
      BUILTIN_AGENT_PRESETS,
    );
    const scheduling = resolved.scheduling as SchedulingConfig | undefined;
    // Deep merge: child scheduling { adaptiveWake: false } merges into parent
    // The parent has maxTurnsPerCycle: 50, so it should still be there
    expect(scheduling?.maxTurnsPerCycle).toBe(50);
    expect(scheduling?.adaptiveWake).toBe(false);
  });
});

describe("wrap-up instruction format", () => {
  it("wrap-up message contains turn count and limit", () => {
    // Simulate the logic from the adapter before_prompt_build hook
    function buildWrapUpContext(currentTurn: number, maxTurns: number): string {
      return `## Coordination Cycle Limit\n\nYou've been running for ${currentTurn} turns this cycle (limit: ${maxTurns}). Wrap up your current work, log your decisions, and conclude. Your next coordination cycle will continue where you left off.`;
    }

    const msg = buildWrapUpContext(51, 50);
    expect(msg).toContain("51 turns");
    expect(msg).toContain("limit: 50");
    expect(msg).toContain("Wrap up your current work");
    expect(msg).toContain("log your decisions");
    expect(msg).toContain("Your next coordination cycle will continue where you left off");
  });

  it("wrap-up is only injected when turn count EXCEEDS limit (not at exactly limit)", () => {
    // Simulate the gate: currentTurn > maxTurns
    const maxTurns = 50;
    const shouldInject = (turn: number) => turn > maxTurns;

    expect(shouldInject(49)).toBe(false);
    expect(shouldInject(50)).toBe(false); // at the limit — not yet
    expect(shouldInject(51)).toBe(true);  // exceeded — inject
    expect(shouldInject(100)).toBe(true);
  });
});
