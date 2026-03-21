import { describe, expect, it } from "vitest";
import { BUILTIN_JOB_PRESETS } from "../../src/presets.js";

describe("daily_review job preset", () => {
  it("exists in BUILTIN_JOB_PRESETS", () => {
    expect(BUILTIN_JOB_PRESETS).toHaveProperty("daily_review");
  });

  it("has a cron schedule set to 6pm daily", () => {
    const preset = BUILTIN_JOB_PRESETS.daily_review!;
    expect(preset.cron).toBe("0 18 * * *");
  });

  it("has briefing sources for progress review", () => {
    const preset = BUILTIN_JOB_PRESETS.daily_review!;
    const briefing = preset.briefing as Array<{ source: string }>;
    expect(briefing).toBeDefined();
    expect(Array.isArray(briefing)).toBe(true);

    const sourceNames = briefing.map(s => s.source);
    expect(sourceNames).toContain("instructions");
    expect(sourceNames).toContain("task_board");
    expect(sourceNames).toContain("team_performance");
    expect(sourceNames).toContain("velocity");
    expect(sourceNames).toContain("trust_scores");
    expect(sourceNames).toContain("cost_summary");
  });

  it("has a nudge with review instructions", () => {
    const preset = BUILTIN_JOB_PRESETS.daily_review!;
    expect(typeof preset.nudge).toBe("string");
    expect(preset.nudge as string).toContain("Review today");
  });

  it("has 6 briefing sources", () => {
    const preset = BUILTIN_JOB_PRESETS.daily_review!;
    const briefing = preset.briefing as unknown[];
    expect(briefing).toHaveLength(6);
  });
});
