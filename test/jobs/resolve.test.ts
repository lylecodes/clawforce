import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveJobName, resolveEffectiveConfig, canManageJobs, listJobs, upsertJob, deleteJob } from "../../src/jobs.js";
import type { AgentConfig, ContextSource, Expectation, PerformancePolicy } from "../../src/types.js";
import * as projectModule from "../../src/project.js";

// --- Helpers ---

function makeBaseConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    extends: "manager",
    briefing: [
      { source: "instructions" },
      { source: "task_board" },
      { source: "escalations" },
      { source: "cost_summary" },
    ],
    expectations: [
      { tool: "clawforce_task", action: "list", min_calls: 1 },
    ],
    performance_policy: { action: "alert" },
    ...overrides,
  };
}

// --- resolveJobName ---

describe("resolveJobName", () => {
  it("returns null for undefined prompt", () => {
    expect(resolveJobName(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveJobName("")).toBeNull();
  });

  it("returns null when no tag present", () => {
    expect(resolveJobName("Review your context and take action.")).toBeNull();
  });

  it("extracts simple job name", () => {
    expect(resolveJobName("[clawforce:job=triage]\n\nReview escalations.")).toBe("triage");
  });

  it("extracts hyphenated job name", () => {
    expect(resolveJobName("[clawforce:job=cost-review]")).toBe("cost-review");
  });

  it("extracts underscored job name", () => {
    expect(resolveJobName("[clawforce:job=daily_dispatch]")).toBe("daily_dispatch");
  });

  it("trims whitespace from job name", () => {
    expect(resolveJobName("[clawforce:job= triage ]")).toBe("triage");
  });

  it("extracts only the first tag when multiple present", () => {
    const prompt = "[clawforce:job=first]\n[clawforce:job=second]";
    expect(resolveJobName(prompt)).toBe("first");
  });

  it("works when tag is mid-text", () => {
    const prompt = "Wake up.\n[clawforce:job=dispatch]\nDo the thing.";
    expect(resolveJobName(prompt)).toBe("dispatch");
  });
});

// --- resolveEffectiveConfig ---

describe("resolveEffectiveConfig", () => {
  it("returns null for unknown job name", () => {
    const base = makeBaseConfig({ jobs: { triage: { cron: "5m" } } });
    expect(resolveEffectiveConfig(base, "nonexistent")).toBeNull();
  });

  it("returns null when agent has no jobs", () => {
    const base = makeBaseConfig();
    expect(resolveEffectiveConfig(base, "triage")).toBeNull();
  });

  // --- Briefing resolution ---

  it("replaces briefing when job specifies its own", () => {
    const jobBriefing: ContextSource[] = [
      { source: "task_board" },
      { source: "escalations" },
    ];
    const base = makeBaseConfig({
      jobs: { triage: { briefing: jobBriefing } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective).not.toBeNull();
    // instructions auto-prepended since job briefing didn't include it
    expect(effective.briefing[0]!.source).toBe("instructions");
    expect(effective.briefing[1]!.source).toBe("task_board");
    expect(effective.briefing[2]!.source).toBe("escalations");
    expect(effective.briefing).toHaveLength(3);
  });

  it("does not duplicate instructions if job briefing already has it", () => {
    const jobBriefing: ContextSource[] = [
      { source: "instructions" },
      { source: "task_board" },
    ];
    const base = makeBaseConfig({
      jobs: { triage: { briefing: jobBriefing } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    const instructionCount = effective.briefing.filter((s) => s.source === "instructions").length;
    expect(instructionCount).toBe(1);
    expect(effective.briefing).toHaveLength(2);
  });

  it("filters base briefing via exclude_briefing", () => {
    const base = makeBaseConfig({
      jobs: {
        triage: { exclude_briefing: ["cost_summary", "escalations"] },
      },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    const sources = effective.briefing.map((s) => s.source);
    expect(sources).toContain("instructions");
    expect(sources).toContain("task_board");
    expect(sources).not.toContain("cost_summary");
    expect(sources).not.toContain("escalations");
  });

  it("inherits base briefing when job specifies neither briefing nor exclude", () => {
    const base = makeBaseConfig({
      jobs: { triage: { cron: "5m" } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.briefing).toEqual(base.briefing);
  });

  it("prefers briefing over exclude_briefing when both specified", () => {
    const jobBriefing: ContextSource[] = [{ source: "task_board" }];
    const base = makeBaseConfig({
      jobs: {
        triage: {
          briefing: jobBriefing,
          exclude_briefing: ["task_board"], // should be ignored
        },
      },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    // instructions auto-prepended + task_board from job briefing
    expect(effective.briefing).toHaveLength(2);
    expect(effective.briefing.map((s) => s.source)).toContain("task_board");
  });

  // --- Expectations resolution ---

  it("replaces expectations when job specifies them", () => {
    const jobExpectations: Expectation[] = [
      { tool: "clawforce_log", action: "outcome", min_calls: 1 },
    ];
    const base = makeBaseConfig({
      jobs: { review: { expectations: jobExpectations } },
    });

    const effective = resolveEffectiveConfig(base, "review")!;
    expect(effective.expectations).toEqual(jobExpectations);
    expect(effective.expectations).not.toEqual(base.expectations);
  });

  it("inherits base expectations when job does not specify", () => {
    const base = makeBaseConfig({
      jobs: { triage: { cron: "5m" } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.expectations).toEqual(base.expectations);
  });

  // --- Performance policy resolution ---

  it("replaces performance_policy when job specifies one", () => {
    const jobPolicy: PerformancePolicy = {
      action: "retry",
      max_retries: 3,
      then: "terminate_and_alert",
    };
    const base = makeBaseConfig({
      jobs: { critical: { performance_policy: jobPolicy } },
    });

    const effective = resolveEffectiveConfig(base, "critical")!;
    expect(effective.performance_policy).toEqual(jobPolicy);
  });

  it("inherits base performance_policy when job does not specify", () => {
    const base = makeBaseConfig({
      jobs: { triage: {} },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.performance_policy).toEqual(base.performance_policy);
  });

  // --- Compaction resolution ---

  it("replaces compaction when job specifies it", () => {
    const base = makeBaseConfig({
      compaction: true,
      jobs: { triage: { compaction: false } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.compaction).toBe(false);
  });

  it("inherits base compaction when job does not specify", () => {
    const base = makeBaseConfig({
      compaction: { enabled: true, files: ["CONTEXT.md"] },
      jobs: { triage: {} },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.compaction).toEqual({ enabled: true, files: ["CONTEXT.md"] });
  });

  // --- Identity preservation ---

  it("preserves base identity fields", () => {
    const base = makeBaseConfig({
      extends: "manager",
      title: "VP Engineering",
      model: "claude-opus-4-6",
      persona: "You are a strict manager.",
      reports_to: "parent",
      jobs: { triage: { cron: "5m" } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.extends).toBe("manager");
    expect(effective.title).toBe("VP Engineering");
    expect(effective.model).toBe("claude-opus-4-6");
    expect(effective.persona).toBe("You are a strict manager.");
    expect(effective.reports_to).toBe("parent");
  });

  it("strips jobs from effective config", () => {
    const base = makeBaseConfig({
      jobs: { triage: { cron: "5m" }, dispatch: { cron: "10m" } },
    });

    const effective = resolveEffectiveConfig(base, "triage")!;
    expect(effective.jobs).toBeUndefined();
  });

  it("does not mutate the base config", () => {
    const base = makeBaseConfig({
      jobs: {
        triage: {
          briefing: [{ source: "task_board" }],
          expectations: [{ tool: "clawforce_log", action: "outcome", min_calls: 1 }],
        },
      },
    });

    const originalBriefing = [...base.briefing];
    const originalExpectations = [...base.expectations];

    resolveEffectiveConfig(base, "triage");

    expect(base.briefing).toEqual(originalBriefing);
    expect(base.expectations).toEqual(originalExpectations);
    expect(base.jobs).toBeDefined();
  });
});

// --- CRUD helpers ---

describe("canManageJobs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allows self-management", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config: makeBaseConfig(),
      projectDir: "/tmp",
    });
    expect(canManageJobs("proj", "leon", "leon")).toBe(true);
  });

  it("allows manager to manage direct reports", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockImplementation((id: string) => {
      if (id === "leon") return { projectId: "proj", config: makeBaseConfig({ coordination: { enabled: true } }), projectDir: "/tmp" };
      if (id === "bob") return { projectId: "proj", config: makeBaseConfig({ extends: "employee", reports_to: "leon" }), projectDir: "/tmp" };
      return undefined;
    });
    vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue(["leon", "bob"]);

    expect(canManageJobs("proj", "leon", "bob")).toBe(true);
  });

  it("denies employee managing peers", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockImplementation((id: string) => {
      if (id === "bob") return { projectId: "proj", config: makeBaseConfig({ extends: "employee" }), projectDir: "/tmp" };
      if (id === "alice") return { projectId: "proj", config: makeBaseConfig({ extends: "employee" }), projectDir: "/tmp" };
      return undefined;
    });
    vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue(["bob", "alice"]);

    expect(canManageJobs("proj", "bob", "alice")).toBe(false);
  });

  it("returns false for unknown caller", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(undefined);
    expect(canManageJobs("proj", "unknown", "bob")).toBe(false);
  });
});

describe("listJobs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns jobs from agent config", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config: makeBaseConfig({ jobs: { triage: { cron: "5m" } } }),
      projectDir: "/tmp",
    });
    const jobs = listJobs("leon");
    expect(jobs).toEqual({ triage: { cron: "5m" } });
  });

  it("returns empty record when no jobs", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config: makeBaseConfig(),
      projectDir: "/tmp",
    });
    expect(listJobs("leon")).toEqual({});
  });

  it("returns null for unknown agent", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(undefined);
    expect(listJobs("unknown")).toBeNull();
  });
});

describe("upsertJob", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds a job to an agent with no existing jobs", () => {
    const config = makeBaseConfig();
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config,
      projectDir: "/tmp",
    });

    expect(upsertJob("leon", "triage", { cron: "5m" })).toBe(true);
    expect(config.jobs!["triage"]).toEqual({ cron: "5m" });
  });

  it("updates an existing job", () => {
    const config = makeBaseConfig({ jobs: { triage: { cron: "5m" } } });
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config,
      projectDir: "/tmp",
    });

    expect(upsertJob("leon", "triage", { cron: "10m", nudge: "New nudge" })).toBe(true);
    expect(config.jobs!["triage"]).toEqual({ cron: "10m", nudge: "New nudge" });
  });

  it("returns false for unknown agent", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(undefined);
    expect(upsertJob("unknown", "triage", { cron: "5m" })).toBe(false);
  });
});

describe("deleteJob", () => {
  afterEach(() => vi.restoreAllMocks());

  it("removes a job", () => {
    const config = makeBaseConfig({ jobs: { triage: { cron: "5m" }, dispatch: { cron: "10m" } } });
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config,
      projectDir: "/tmp",
    });

    expect(deleteJob("leon", "triage")).toBe(true);
    expect(config.jobs!["triage"]).toBeUndefined();
    expect(config.jobs!["dispatch"]).toBeDefined();
  });

  it("clears jobs map when last job deleted", () => {
    const config = makeBaseConfig({ jobs: { triage: { cron: "5m" } } });
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config,
      projectDir: "/tmp",
    });

    expect(deleteJob("leon", "triage")).toBe(true);
    expect(config.jobs).toBeUndefined();
  });

  it("returns false for nonexistent job", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj",
      config: makeBaseConfig(),
      projectDir: "/tmp",
    });
    expect(deleteJob("leon", "nonexistent")).toBe(false);
  });
});
