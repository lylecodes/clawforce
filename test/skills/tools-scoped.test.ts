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

  it("employee scope excludes manager-only tools", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.employee);

    expect(content).toContain("clawforce_task");
    expect(content).toContain("clawforce_log");
    expect(content).toContain("clawforce_verify");
    expect(content).toContain("clawforce_compact");
    expect(content).toContain("clawforce_setup");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_get");

    // Manager-only tools should NOT appear
    expect(content).not.toContain("clawforce_workflow");
    expect(content).not.toContain("clawforce_ops");
  });

  it("employee scope restricts clawforce_task actions", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.employee);

    // Allowed actions
    expect(content).toContain("`get`");
    expect(content).toContain("`list`");
    expect(content).toContain("`transition`");
    expect(content).toContain("`fail`");
    expect(content).toContain("`attach_evidence`");
    expect(content).toContain("`history`");

    // Disallowed actions for employee
    expect(content).not.toContain("`create`");
    expect(content).not.toContain("`bulk_create`");
    expect(content).not.toContain("`bulk_transition`");
    expect(content).not.toContain("`metrics`");
  });

  it("employee scope restricts clawforce_log actions", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.employee);

    expect(content).toContain("`write`");
    expect(content).toContain("`outcome`");
    expect(content).toContain("`search`");
    // verify_audit is manager-only
    expect(content).not.toContain("`verify_audit`");
  });

  it("scheduled scope shows minimal tools", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.scheduled);

    // Scheduled agents only get these tools
    expect(content).toContain("clawforce_log");
    expect(content).toContain("clawforce_setup");
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_get");

    // Should NOT see these
    expect(content).not.toContain("clawforce_task");
    expect(content).not.toContain("clawforce_verify");
    expect(content).not.toContain("clawforce_compact");
    expect(content).not.toContain("clawforce_workflow");
    expect(content).not.toContain("clawforce_ops");
  });

  it("scheduled scope restricts clawforce_log to outcome, search, list", () => {
    const content = generateScoped(DEFAULT_ACTION_SCOPES.scheduled);

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
