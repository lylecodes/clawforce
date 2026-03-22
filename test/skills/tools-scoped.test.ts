import { describe, expect, it } from "vitest";
import { generateScoped } from "../../src/skills/topics/tools.js";
import { DEFAULT_ACTION_SCOPES } from "../../src/profiles.js";

describe("generateScoped", () => {
  it("manager scope includes all tools", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.manager);

    expect(content).toContain("clawforce_task");
    expect(content).toContain("clawforce_log");
    expect(content).toContain("clawforce_verify");
    expect(content).toContain("clawforce_workflow");
    expect(content).toContain("clawforce_setup");
    expect(content).toContain("clawforce_compact");
    expect(content).toContain("clawforce_ops");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_get");
  });

  it("employee scope has no clawforce tools (auto-lifecycle)", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.employee);

    // Employee has only memory tools (no clawforce tools)
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_get");

    // No clawforce tools at all
    expect(content).not.toContain("clawforce_task");
    expect(content).not.toContain("clawforce_log");
    expect(content).not.toContain("clawforce_verify");
    expect(content).not.toContain("clawforce_compact");
    expect(content).not.toContain("clawforce_setup");
    expect(content).not.toContain("clawforce_workflow");
    expect(content).not.toContain("clawforce_ops");
  });

  it("minimal custom scope shows only specified tools", () => {
    const minimalScope = {
      clawforce_log: ["outcome", "search", "list"] as string[],
      clawforce_setup: ["explain", "status"] as string[],
      memory_search: "*" as const,
      memory_get: "*" as const,
    };
    const content = generateScoped(minimalScope);

    // Specified tools
    expect(content).toContain("clawforce_log");
    expect(content).toContain("clawforce_setup");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_get");

    // Should NOT see tools not in scope
    expect(content).not.toContain("clawforce_task");
    expect(content).not.toContain("clawforce_verify");
    expect(content).not.toContain("clawforce_compact");
    expect(content).not.toContain("clawforce_workflow");
    expect(content).not.toContain("clawforce_ops");
  });

  it("minimal custom scope restricts clawforce_log to outcome, search, list", () => {
    const minimalScope = {
      clawforce_log: ["outcome", "search", "list"] as string[],
      clawforce_setup: ["explain", "status"] as string[],
      memory_search: "*" as const,
      memory_get: "*" as const,
    };
    const content = generateScoped(minimalScope);

    expect(content).toContain("`outcome`");
    expect(content).toContain("`search`");
    expect(content).toContain("`list`");
    expect(content).not.toContain("`write`");
    expect(content).not.toContain("`verify_audit`");
  });

  it("empty scope returns no-tools message", () => {
    const content = generateScoped({});

    expect(content).toContain("No Clawforce tools are available");
  });

  it("includes tool and action counts in header", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.employee);

    // Should mention how many tools and actions
    expect(content).toMatch(/\d+ tools? for your role/);
    expect(content).toMatch(/\d+ actions? total/);
  });

  it("custom scope with single tool and specific actions", () => {
    const content = generateScoped({
      clawforce_log: ["write"],
    });

    expect(content).toContain("1 tool for your role");
    expect(content).toContain("1 action total");
    expect(content).toContain("`write`");
    expect(content).not.toContain("clawforce_task");
  });
});
