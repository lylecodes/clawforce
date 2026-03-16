/**
 * Tests for src/sdk/capabilities.ts
 *
 * These tests are purely functional — no internal registry state, no database,
 * no module mocks. The capability functions take plain config objects and
 * return arrays, so tests simply call them directly.
 */

import { describe, expect, it } from "vitest";
import {
  getAgentCapabilities,
  hasCapability,
} from "../../src/sdk/capabilities.js";

// ---------------------------------------------------------------------------
// getAgentCapabilities — built-in preset mapping
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — built-in presets", () => {
  it("manager preset includes coordinate, create_tasks, run_meetings, review_work, escalate", () => {
    const caps = getAgentCapabilities({ extends: "manager" });
    expect(caps).toContain("coordinate");
    expect(caps).toContain("create_tasks");
    expect(caps).toContain("run_meetings");
    expect(caps).toContain("review_work");
    expect(caps).toContain("escalate");
  });

  it("employee preset includes execute_tasks, report_status", () => {
    const caps = getAgentCapabilities({ extends: "employee" });
    expect(caps).toContain("execute_tasks");
    expect(caps).toContain("report_status");
  });

  it("employee preset does NOT include coordinate or create_tasks", () => {
    const caps = getAgentCapabilities({ extends: "employee" });
    expect(caps).not.toContain("coordinate");
    expect(caps).not.toContain("create_tasks");
  });

  it("assistant preset includes monitor, report_status", () => {
    const caps = getAgentCapabilities({ extends: "assistant" });
    expect(caps).toContain("monitor");
    expect(caps).toContain("report_status");
  });

  it("assistant preset does NOT include coordinate or execute_tasks", () => {
    const caps = getAgentCapabilities({ extends: "assistant" });
    expect(caps).not.toContain("coordinate");
    expect(caps).not.toContain("execute_tasks");
  });
});

// ---------------------------------------------------------------------------
// getAgentCapabilities — default fallback when extends is omitted
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — default fallback", () => {
  it("defaults to employee caps when extends is undefined", () => {
    const caps = getAgentCapabilities({});
    expect(caps).toContain("execute_tasks");
    expect(caps).toContain("report_status");
  });

  it("defaults to employee caps when extends is undefined (no coordination)", () => {
    const caps = getAgentCapabilities({ coordination: { enabled: false } });
    expect(caps).not.toContain("coordinate");
    expect(caps).toContain("execute_tasks");
  });
});

// ---------------------------------------------------------------------------
// getAgentCapabilities — unknown preset fallback
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — unknown preset", () => {
  it("returns employee defaults for an unrecognized preset name", () => {
    const caps = getAgentCapabilities({ extends: "spaceship-pilot" });
    expect(caps).toContain("execute_tasks");
    expect(caps).toContain("report_status");
    expect(caps).not.toContain("coordinate");
  });
});

// ---------------------------------------------------------------------------
// getAgentCapabilities — coordination.enabled implies coordinate
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — coordination.enabled", () => {
  it("adds coordinate when coordination.enabled is true (even on employee preset)", () => {
    const caps = getAgentCapabilities({
      extends: "employee",
      coordination: { enabled: true },
    });
    expect(caps).toContain("coordinate");
    expect(caps).toContain("execute_tasks");
  });

  it("does not duplicate coordinate for manager preset with coordination.enabled", () => {
    const caps = getAgentCapabilities({
      extends: "manager",
      coordination: { enabled: true },
    });
    const coordinateCount = caps.filter((c) => c === "coordinate").length;
    expect(coordinateCount).toBe(1);
  });

  it("does NOT add coordinate when coordination.enabled is false", () => {
    const caps = getAgentCapabilities({
      extends: "employee",
      coordination: { enabled: false },
    });
    expect(caps).not.toContain("coordinate");
  });

  it("does NOT add coordinate when coordination is undefined", () => {
    const caps = getAgentCapabilities({ extends: "employee" });
    expect(caps).not.toContain("coordinate");
  });
});

// ---------------------------------------------------------------------------
// getAgentCapabilities — custom capabilities merged with preset
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — custom capabilities", () => {
  it("merges custom capabilities with preset capabilities", () => {
    const caps = getAgentCapabilities({
      extends: "employee",
      capabilities: ["review_work", "custom_capability"],
    });
    expect(caps).toContain("execute_tasks");
    expect(caps).toContain("report_status");
    expect(caps).toContain("review_work");
    expect(caps).toContain("custom_capability");
  });

  it("deduplicates capabilities appearing in both preset and custom list", () => {
    const caps = getAgentCapabilities({
      extends: "employee",
      capabilities: ["execute_tasks", "report_status"],
    });
    const count = caps.filter((c) => c === "execute_tasks").length;
    expect(count).toBe(1);
  });

  it("supports custom capabilities on manager preset", () => {
    const caps = getAgentCapabilities({
      extends: "manager",
      capabilities: ["custom_tool_access"],
    });
    expect(caps).toContain("coordinate");
    expect(caps).toContain("custom_tool_access");
  });
});

// ---------------------------------------------------------------------------
// getAgentCapabilities — userPresets override
// ---------------------------------------------------------------------------

describe("getAgentCapabilities — userPresets override", () => {
  const userPresets = {
    "lead-researcher": {
      capabilities: ["execute_tasks", "review_work", "publish"] as string[],
    },
  };

  it("uses userPreset capabilities when a matching preset name is supplied", () => {
    const caps = getAgentCapabilities(
      { extends: "lead-researcher" },
      userPresets as any,
    );
    expect(caps).toContain("execute_tasks");
    expect(caps).toContain("review_work");
    expect(caps).toContain("publish");
    // should NOT fall through to built-in employee defaults
    expect(caps).not.toContain("report_status");
  });

  it("falls back to built-in presets for unmatched preset names in userPresets", () => {
    const caps = getAgentCapabilities(
      { extends: "manager" },
      userPresets as any,
    );
    expect(caps).toContain("coordinate");
    expect(caps).toContain("create_tasks");
  });

  it("userPreset with undefined capabilities falls back to built-in", () => {
    const presetsWithNoCapabilities = { manager: {} };
    const caps = getAgentCapabilities(
      { extends: "manager" },
      presetsWithNoCapabilities as any,
    );
    // userPresets[manager].capabilities is undefined, falls back to PRESET_CAPABILITIES
    expect(caps).toContain("coordinate");
    expect(caps).toContain("create_tasks");
  });
});

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe("hasCapability", () => {
  it("returns true for a capability in the manager preset", () => {
    expect(hasCapability({ extends: "manager" }, "coordinate")).toBe(true);
    expect(hasCapability({ extends: "manager" }, "create_tasks")).toBe(true);
    expect(hasCapability({ extends: "manager" }, "run_meetings")).toBe(true);
    expect(hasCapability({ extends: "manager" }, "review_work")).toBe(true);
    expect(hasCapability({ extends: "manager" }, "escalate")).toBe(true);
  });

  it("returns false for a capability not in the manager preset", () => {
    expect(hasCapability({ extends: "manager" }, "execute_tasks")).toBe(false);
  });

  it("returns true for a capability in the employee preset", () => {
    expect(hasCapability({ extends: "employee" }, "execute_tasks")).toBe(true);
    expect(hasCapability({ extends: "employee" }, "report_status")).toBe(true);
  });

  it("returns false for coordinate on employee without coordination.enabled", () => {
    expect(hasCapability({ extends: "employee" }, "coordinate")).toBe(false);
  });

  it("returns true for coordinate on employee when coordination.enabled is true", () => {
    expect(
      hasCapability({ extends: "employee", coordination: { enabled: true } }, "coordinate"),
    ).toBe(true);
  });

  it("returns true for a custom capability added to an employee config", () => {
    expect(
      hasCapability(
        { extends: "employee", capabilities: ["special_access"] },
        "special_access",
      ),
    ).toBe(true);
  });

  it("returns false for unknown capability on any preset", () => {
    expect(hasCapability({ extends: "manager" }, "fly_spaceship")).toBe(false);
    expect(hasCapability({ extends: "employee" }, "fly_spaceship")).toBe(false);
    expect(hasCapability({}, "fly_spaceship")).toBe(false);
  });

  it("works with default config (no extends) for employee capabilities", () => {
    expect(hasCapability({}, "execute_tasks")).toBe(true);
    expect(hasCapability({}, "coordinate")).toBe(false);
  });

  it("supports userPresets in hasCapability", () => {
    const userPresets = {
      specialist: { capabilities: ["deep_analysis"] as string[] },
    };
    expect(
      hasCapability({ extends: "specialist" }, "deep_analysis", userPresets as any),
    ).toBe(true);
    expect(
      hasCapability({ extends: "specialist" }, "execute_tasks", userPresets as any),
    ).toBe(false);
  });
});
