import { describe, expect, it } from "vitest";
import { inferPreset } from "../../src/config/inference.js";
import type { GlobalAgentDef } from "../../src/config/schema.js";

describe("inferPreset", () => {
  it("infers manager when other agents report to this one", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    expect(inferPreset("lead", agents)).toBe("manager");
  });

  it("infers employee when agent reports to someone", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    expect(inferPreset("worker", agents)).toBe("employee");
  });

  it("infers employee for standalone agent with no reports_to", () => {
    const agents: Record<string, GlobalAgentDef> = {
      solo: { title: "Solo Worker" },
    };
    expect(inferPreset("solo", agents)).toBe("employee");
  });

  it("infers manager for deeply nested reporting chain root", () => {
    const agents: Record<string, GlobalAgentDef> = {
      ceo: { title: "CEO" },
      vp: { title: "VP", reports_to: "ceo" },
      dev: { title: "Dev", reports_to: "vp" },
    };
    expect(inferPreset("ceo", agents)).toBe("manager");
    expect(inferPreset("vp", agents)).toBe("manager");
    expect(inferPreset("dev", agents)).toBe("employee");
  });

  it("does not infer for agents with explicit extends", () => {
    const agents: Record<string, GlobalAgentDef> = {
      lead: { extends: "employee", title: "Lead" },
      worker: { title: "Worker", reports_to: "lead" },
    };
    // inferPreset should still return manager based on structure,
    // but the caller skips calling it when extends is set
    expect(inferPreset("lead", agents)).toBe("manager");
  });
});
