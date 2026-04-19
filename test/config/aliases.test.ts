import { describe, expect, it } from "vitest";
import { normalizeAgentConfig } from "../../src/config/aliases.js";

describe("normalizeAgentConfig (aliases)", () => {
  it("maps group to department", () => {
    const result = normalizeAgentConfig({ group: "engineering", title: "Dev" });
    expect(result.department).toBe("engineering");
  });

  it("maps subgroup to team", () => {
    const result = normalizeAgentConfig({ subgroup: "frontend", title: "Dev" });
    expect(result.team).toBe("frontend");
  });

  it("canonical department takes precedence over group alias", () => {
    const result = normalizeAgentConfig({ group: "sales", department: "engineering" });
    expect(result.department).toBe("engineering");
  });

  it("canonical team takes precedence over subgroup alias", () => {
    const result = normalizeAgentConfig({ subgroup: "backend", team: "frontend" });
    expect(result.team).toBe("frontend");
  });

  it("handles missing alias fields gracefully", () => {
    const result = normalizeAgentConfig({ title: "Solo" });
    expect(result.department).toBeUndefined();
    expect(result.team).toBeUndefined();
    expect(result.extends).toBeUndefined();
  });

  it("preserves alias fields alongside canonical names for SDK consumers", () => {
    const result = normalizeAgentConfig({ group: "engineering" });
    expect(result.group).toBe("engineering");
    expect(result.department).toBe("engineering");
  });

  it("preserves all other unrelated fields unchanged", () => {
    const result = normalizeAgentConfig({ group: "ops", title: "Operator", persona: "Efficient" });
    expect(result.title).toBe("Operator");
    expect(result.persona).toBe("Efficient");
  });

  it("handles both supported aliases together", () => {
    const result = normalizeAgentConfig({ group: "sales", subgroup: "lead-gen", extends: "employee" });
    expect(result.department).toBe("sales");
    expect(result.team).toBe("lead-gen");
    expect(result.extends).toBe("employee");
  });

  it("does not overwrite canonical when both alias and canonical are present", () => {
    const result = normalizeAgentConfig({
      group: "sales",
      department: "engineering",
      subgroup: "backend",
      team: "frontend",
      extends: "manager",
    });
    expect(result.department).toBe("engineering");
    expect(result.team).toBe("frontend");
    expect(result.extends).toBe("manager");
  });
});
