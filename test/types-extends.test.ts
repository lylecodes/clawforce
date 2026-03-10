import { describe, it, expect } from "vitest";
import type { AgentConfig, CoordinationConfig } from "../src/types.js";

describe("AgentConfig type migration", () => {
  it("accepts extends field instead of role", () => {
    const config: AgentConfig = {
      extends: "manager",
      title: "Test Manager",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: false,
    };
    expect(config.extends).toBe("manager");
  });

  it("extends is optional for fully inline config", () => {
    const config: AgentConfig = {
      title: "Inline Agent",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: false,
    };
    expect(config.extends).toBeUndefined();
  });

  it("supports coordination field", () => {
    const config: AgentConfig = {
      extends: "manager",
      title: "Coordinator",
      briefing: [{ source: "soul" }],
      expectations: [],
      performance_policy: { action: "alert" },
      compaction: true,
      coordination: { enabled: true, schedule: "*/30 * * * *" },
    };
    expect(config.coordination?.enabled).toBe(true);
  });

  it("CoordinationConfig has correct shape", () => {
    const coord: CoordinationConfig = { enabled: true, schedule: "*/30 * * * *" };
    expect(coord.enabled).toBe(true);
    expect(coord.schedule).toBe("*/30 * * * *");
  });
});
