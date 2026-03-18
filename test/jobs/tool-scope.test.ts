import { beforeEach, describe, expect, it } from "vitest";

const { resolveEffectiveConfig } = await import("../../src/jobs.js");
import type { AgentConfig } from "../../src/types.js";

const baseConfig: AgentConfig = {
  extends: "manager",
  tools: ["task_assign", "task_create", "budget_check", "message_send", "org_modify"],
  briefing: [{ source: "instructions" }],
  expectations: [],
  performance_policy: { action: "alert" },
  jobs: {
    dispatch: {
      cron: "*/5 * * * *",
      tools: ["task_assign", "task_create"],
    },
    reflect: {
      cron: "0 9 * * MON",
      // no tools field — inherits all agent tools
    },
  },
};

describe("job tool scoping", () => {
  it("narrows agent tools to job-specified subset", () => {
    const effective = resolveEffectiveConfig(baseConfig, "dispatch");
    expect(effective).not.toBeNull();
    expect(effective!.tools).toEqual(["task_assign", "task_create"]);
  });

  it("inherits all agent tools when job has no tools field", () => {
    const effective = resolveEffectiveConfig(baseConfig, "reflect");
    expect(effective).not.toBeNull();
    expect(effective!.tools).toEqual(baseConfig.tools);
  });

  it("returns null for unknown job name", () => {
    const effective = resolveEffectiveConfig(baseConfig, "nonexistent");
    expect(effective).toBeNull();
  });
});
