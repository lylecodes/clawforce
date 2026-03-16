import { describe, it, expect } from "vitest";
import type {
  Task,
  TaskParams,
  ClawforceOptions,
  AgentCapability,
} from "../../src/sdk/types.js";

describe("SDK types", () => {
  it("TaskParams accepts abstract vocabulary", () => {
    const params: TaskParams = {
      title: "Cook dinner",
      assignedTo: "npc-alice",
      group: "household",
      subgroup: "kitchen-duty",
    };
    expect(params.group).toBe("household");
  });

  it("AgentCapability accepts custom strings", () => {
    const caps: AgentCapability[] = ["coordinate", "custom_ability"];
    expect(caps).toContain("custom_ability");
  });

  it("ClawforceOptions requires domain", () => {
    const opts: ClawforceOptions = { domain: "test" };
    expect(opts.domain).toBe("test");
  });
});
