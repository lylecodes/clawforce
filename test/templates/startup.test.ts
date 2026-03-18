import { describe, expect, it } from "vitest";

const { getTemplate, STARTUP_TEMPLATE } = await import("../../src/templates/startup.js");

describe("startup template", () => {
  it("defines a lead manager agent", () => {
    expect(STARTUP_TEMPLATE.agents.lead).toBeDefined();
    expect(STARTUP_TEMPLATE.agents.lead.extends).toBe("manager");
  });

  it("defines a dev-1 employee agent", () => {
    expect(STARTUP_TEMPLATE.agents["dev-1"]).toBeDefined();
    expect(STARTUP_TEMPLATE.agents["dev-1"].extends).toBe("employee");
    expect(STARTUP_TEMPLATE.agents["dev-1"].reports_to).toBe("lead");
  });

  it("defines an agent-builder employee", () => {
    expect(STARTUP_TEMPLATE.agents["agent-builder"]).toBeDefined();
    expect(STARTUP_TEMPLATE.agents["agent-builder"].extends).toBe("employee");
    expect(STARTUP_TEMPLATE.agents["agent-builder"].reports_to).toBe("lead");
  });

  it("defines manager jobs with tool scoping", () => {
    const jobs = STARTUP_TEMPLATE.agents.lead.jobs;
    expect(jobs).toBeDefined();
    expect(jobs!.dispatch.cron).toBe("*/5 * * * *");
    expect(jobs!.dispatch.tools).toBeDefined();
    expect(jobs!.reflect.cron).toBe("0 9 * * MON");
    expect(jobs!.reflect.tools).toContain("agent_hire");
  });

  it("getTemplate returns startup template", () => {
    const t = getTemplate("startup");
    expect(t).toBe(STARTUP_TEMPLATE);
  });

  it("getTemplate returns null for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });
});
