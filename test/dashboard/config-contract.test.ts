/**
 * Config contract tests — Pack 1
 *
 * Verifies that:
 * 1. queryConfig() preserves rich briefing and expectation structures (no flattening)
 * 2. The validate action returns field-level errors and warnings
 * 3. The preview action returns structured impact info
 * 4. ConfigSaveResponse shape matches the contract (ok, section, error, warnings)
 * 5. Config sections with agent expectations (object form) are preserved
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mocks for queryConfig ---

vi.mock("../../src/lifecycle.js", () => ({
  getActiveProjectIds: vi.fn(() => ["proj1"]),
}));

vi.mock("../../src/project.js", () => {
  const richConfigs = new Map<string, any>([
    ["agent-rich", {
      projectId: "proj1",
      config: {
        extends: "manager",
        title: "Rich Agent",
        department: "eng",
        briefing: [
          { source: "file", path: "context/DIRECTION.md" },
          { source: "direction" },
          { source: "custom_stream", streamName: "ops-feed" },
        ],
        expectations: [
          { tool: "Bash", action: "exec", min_calls: 1 },
          { tool: "Write", action: ["create", "overwrite"], min_calls: 2 },
          "always_document",
        ],
        performance_policy: { action: "retry", max_retries: 3 },
      },
    }],
    ["agent-plain", {
      projectId: "proj1",
      config: {
        extends: "employee",
        title: "Plain Agent",
        department: "eng",
        briefing: [],
        expectations: [],
      },
    }],
  ]);
  return {
    getAgentConfig: vi.fn((id: string) => richConfigs.get(id) ?? null),
    getRegisteredAgentIds: vi.fn(() => [...richConfigs.keys()]),
    getExtendedProjectConfig: vi.fn(() => ({
      toolGates: {
        Bash: { category: "execution", tier: "high" },
        Write: { category: "filesystem", risk_tier: "medium" },
      },
      safety: { maxSpawnDepth: 5, costCircuitBreaker: 2.0 },
    })),
  };
});

vi.mock("../../src/tasks/ops.js", () => ({
  listTasks: vi.fn(() => []),
  getTask: vi.fn(),
  getTaskEvidence: vi.fn(() => []),
  getTaskTransitions: vi.fn(() => []),
}));

vi.mock("../../src/metrics.js", () => ({
  queryMetrics: vi.fn(() => []),
  aggregateMetrics: vi.fn(() => ({})),
}));

vi.mock("../../src/cost.js", () => ({
  getCostSummary: vi.fn(() => ({ totalCents: 0 })),
}));

vi.mock("../../src/monitoring/slo.js", () => ({
  evaluateSlos: vi.fn(() => []),
}));

vi.mock("../../src/monitoring/alerts.js", () => ({
  evaluateAlertRules: vi.fn(() => []),
}));

vi.mock("../../src/monitoring/health-tier.js", () => ({
  computeHealthTier: vi.fn(() => "GREEN"),
}));

vi.mock("../../src/events/store.js", () => ({
  listEvents: vi.fn(() => []),
  countEvents: vi.fn(() => 0),
  ingestEvent: vi.fn(() => ({ deduplicated: false })),
}));

vi.mock("../../src/messaging/store.js", () => ({
  searchMessages: vi.fn(() => ({ messages: [] })),
  createMessage: vi.fn(),
}));

vi.mock("../../src/messaging/protocols.js", () => ({
  getActiveProtocols: vi.fn(() => []),
}));

vi.mock("../../src/goals/ops.js", () => ({
  listGoals: vi.fn(() => []),
  getGoal: vi.fn(),
  getChildGoals: vi.fn(() => []),
  getGoalTasks: vi.fn(() => []),
}));

vi.mock("../../src/goals/cascade.js", () => ({
  computeGoalProgress: vi.fn(() => ({})),
}));

vi.mock("../../src/org.js", () => ({
  getDirectReports: vi.fn(() => []),
  getDepartmentAgents: vi.fn(() => []),
}));

vi.mock("../../src/enforcement/disabled-store.js", () => ({
  listDisabledAgents: vi.fn(() => []),
  isDomainDisabled: vi.fn(() => false),
}));

vi.mock("../../src/enforcement/tracker.js", () => ({
  getActiveSessions: vi.fn(() => []),
}));

vi.mock("../../src/safety.js", () => ({
  isEmergencyStopActive: vi.fn(() => false),
  activateEmergencyStop: vi.fn(),
  deactivateEmergencyStop: vi.fn(),
}));

vi.mock("../../src/approval/resolve.js", () => ({
  listPendingProposals: vi.fn(() => []),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

vi.mock("../../src/budget-windows.js", () => ({
  getBudgetStatus: vi.fn(() => ({
    hourly: undefined,
    daily: undefined,
    monthly: undefined,
    alerts: [],
  })),
}));

vi.mock("../../src/budget/forecast.js", () => ({
  computeDailySnapshot: vi.fn(() => null),
  computeWeeklyTrend: vi.fn(() => null),
  computeMonthlyProjection: vi.fn(() => null),
}));

vi.mock("../../src/trust/tracker.js", () => ({
  getAllCategoryStats: vi.fn(() => []),
  getActiveTrustOverrides: vi.fn(() => []),
}));

vi.mock("../../src/telemetry/trust-history.js", () => ({
  getTrustTimeline: vi.fn(() => []),
}));

vi.mock("../../src/channels/store.js", () => ({
  listChannels: vi.fn(() => []),
  getChannel: vi.fn(() => null),
  getChannelMessages: vi.fn(() => []),
}));

vi.mock("../../src/channels/messages.js", () => ({
  buildChannelTranscript: vi.fn(() => ""),
  sendChannelMessage: vi.fn(),
}));

vi.mock("../../src/channels/meeting.js", () => ({
  getMeetingStatus: vi.fn(() => null),
  startMeeting: vi.fn(),
  concludeMeeting: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(() => ({ changes: 0 })),
    })),
  })),
}));

vi.mock("../../src/audit.js", () => ({
  writeAuditEntry: vi.fn(),
  queryAuditLog: vi.fn(() => []),
}));

vi.mock("../../src/metrics/operational.js", () => ({
  getAllOperationalMetrics: vi.fn(() => ({})),
}));

vi.mock("../../src/telemetry/session-archive.js", () => ({
  listSessionArchives: vi.fn(() => []),
  getSessionArchive: vi.fn(() => null),
  countSessionArchives: vi.fn(() => 0),
}));

vi.mock("../../src/config/api-service.js", () => ({
  readDomainConfig: vi.fn((projectId: string) => {
    if (projectId === "proj1") {
      return {
        domain: "proj1",
        agents: ["agent-rich", "agent-plain"],
        defaults: {
          briefing: [{ source: "standards" }],
          performance_policy: { action: "alert" },
          expectations: [{ tool: "Read", min_calls: 1 }],
        },
        jobs: {
          "agent-rich": {
            heartbeat: { cron: "*/5 * * * *", enabled: true, description: "Heartbeat check" },
          },
        },
      };
    }
    return null;
  }),
  readGlobalConfig: vi.fn(() => ({
    agents: {
      "agent-rich": {
        jobs: {
          heartbeat: { cron: "*/5 * * * *", enabled: true, description: "Heartbeat check" },
        },
      },
      "agent-plain": {},
    },
  })),
  updateDomainConfig: vi.fn(() => ({ ok: true })),
  updateGlobalAgentConfig: vi.fn(() => ({ ok: true })),
  upsertGlobalAgents: vi.fn(() => ({ ok: true })),
  writeDomainConfig: vi.fn(() => ({ ok: true })),
  reloadAllDomains: vi.fn(() => ({ domains: [] })),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  emitSSE: vi.fn(),
}));

vi.mock("../../src/tasks/ops.js", () => ({
  createTask: vi.fn(),
  reassignTask: vi.fn(),
  transitionTask: vi.fn(),
  listTasks: vi.fn(() => []),
  getTask: vi.fn(),
  getTaskEvidence: vi.fn(() => []),
  getTaskTransitions: vi.fn(() => []),
  attachEvidence: vi.fn(),
}));

vi.mock("../../src/audit/auto-kill.js", () => ({
  killStuckAgent: vi.fn(async () => false),
}));

vi.mock("../../src/budget-cascade.js", () => ({
  allocateBudget: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../src/budget/normalize.js", () => ({
  normalizeBudgetConfig: vi.fn((c: unknown) => c ?? {}),
}));

const { queryConfig } = await import("../../src/dashboard/queries.js");
const { handleAction } = await import("../../src/dashboard/actions.js");

// ─── queryConfig contract tests ────────────────────────────────────────────────

describe("queryConfig — rich briefing sources preserved", () => {
  it("preserves full briefing source objects, not flattened strings", () => {
    const result = queryConfig("proj1");
    const rich = result.agents.find((a) => a.id === "agent-rich");
    expect(rich).toBeDefined();

    // Must be objects, not strings like "file: context/DIRECTION.md"
    expect(rich!.briefing).toEqual([
      { source: "file", path: "context/DIRECTION.md" },
      { source: "direction" },
      { source: "custom_stream", streamName: "ops-feed" },
    ]);
  });

  it("preserves empty briefing as empty array", () => {
    const result = queryConfig("proj1");
    const plain = result.agents.find((a) => a.id === "agent-plain");
    expect(plain).toBeDefined();
    expect(plain!.briefing).toEqual([]);
  });
});

describe("queryConfig — rich expectation objects preserved", () => {
  it("preserves structured expectation objects, not display strings", () => {
    const result = queryConfig("proj1");
    const rich = result.agents.find((a) => a.id === "agent-rich");
    expect(rich).toBeDefined();

    // Must be objects, not strings like "Bash: exec (min: 1)"
    expect(rich!.expectations).toEqual([
      { tool: "Bash", action: "exec", min_calls: 1 },
      { tool: "Write", action: ["create", "overwrite"], min_calls: 2 },
      "always_document",  // plain string expectations pass through unchanged
    ]);
  });

  it("preserves action as array when configured that way", () => {
    const result = queryConfig("proj1");
    const rich = result.agents.find((a) => a.id === "agent-rich");
    const writeExp = rich!.expectations.find(
      (e) => typeof e === "object" && (e as any).tool === "Write"
    );
    expect(writeExp).toBeDefined();
    expect((writeExp as any).action).toEqual(["create", "overwrite"]);
  });
});

describe("queryConfig — performance_policy preserved", () => {
  it("preserves performance_policy as structured object", () => {
    const result = queryConfig("proj1");
    const rich = result.agents.find((a) => a.id === "agent-rich");
    expect(rich!.performance_policy).toEqual({ action: "retry", max_retries: 3 });
  });
});

describe("queryConfig — tool_gates structure", () => {
  it("returns tool_gates as array with tool, category, risk_tier", () => {
    const result = queryConfig("proj1");
    expect(result.tool_gates).toEqual(expect.arrayContaining([
      { tool: "Bash", category: "execution", risk_tier: "high" },
    ]));
    // Accepts both tier and risk_tier as source field names
    const writegate = result.tool_gates.find((g) => g.tool === "Write");
    expect(writegate).toBeDefined();
    expect(writegate!.risk_tier).toBe("medium");
  });
});

describe("queryConfig — safety section", () => {
  it("maps canonical safety field names correctly", () => {
    const result = queryConfig("proj1");
    // maxSpawnDepth → spawn_depth_limit; costCircuitBreaker → circuit_breaker_multiplier
    expect(result.safety.spawn_depth_limit).toBe(5);
    expect(result.safety.circuit_breaker_multiplier).toBe(2.0);
  });
});

describe("queryConfig — jobs section", () => {
  it("flattens agent jobs with composite id", () => {
    const result = queryConfig("proj1");
    const job = result.jobs.find((j) => j.id === "agent-rich:heartbeat");
    expect(job).toBeDefined();
    expect(job!.agent).toBe("agent-rich");
    expect(job!.cron).toBe("*/5 * * * *");
    expect(job!.enabled).toBe(true);
    expect(job!.description).toBe("Heartbeat check");
  });
});

describe("queryConfig — defaults section", () => {
  it("preserves full defaults object including nested structures", () => {
    const result = queryConfig("proj1");
    expect(result.defaults).toEqual({
      briefing: [{ source: "standards" }],
      performance_policy: { action: "alert" },
      expectations: [{ tool: "Read", min_calls: 1 }],
    });
  });
});

// ─── config validate action contract tests ────────────────────────────────────

describe("config validate action — contract shape", () => {
  it("returns valid:true with empty errors and warnings for valid budget", () => {
    const result = handleAction("proj1", "config/validate", {
      section: "budget",
      data: { daily: { cents: 1000 }, hourly: { cents: 100 } },
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.section).toBe("budget");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect((body.errors as unknown[]).length).toBe(0);
  });

  it("returns valid:false with field-level errors for invalid budget", () => {
    const result = handleAction("proj1", "config/validate", {
      section: "budget",
      data: { daily: { cents: "not-a-number" } },
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.valid).toBe(false);
    expect((body.errors as string[]).length).toBeGreaterThan(0);
    expect((body.errors as string[]).some((e) => e.includes("budget.daily.cents"))).toBe(true);
  });

  it("returns valid:false with field-level errors for invalid safety", () => {
    const result = handleAction("proj1", "config/validate", {
      section: "safety",
      data: { spawn_depth_limit: 200 },
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.valid).toBe(false);
    expect((body.errors as string[]).some((e) => e.includes("Spawn") || e.includes("spawn") || e.includes("maxSpawnDepth"))).toBe(true);
  });

  it("returns valid:true with warnings for rules referencing unknown agents", () => {
    const result = handleAction("proj1", "config/validate", {
      section: "rules",
      data: [{
        name: "notify-on-fail",
        trigger: { event: "task.failed" },
        action: { agent: "ghost-agent", prompt_template: "Task failed: {{task.title}}" },
      }],
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.section).toBe("rules");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("returns error when section is missing", () => {
    const result = handleAction("proj1", "config/validate", {
      data: { foo: "bar" },
    });
    expect(result.status).toBe(400);
  });

  it("validates agents section structure", () => {
    const result = handleAction("proj1", "config/validate", {
      section: "agents",
      data: [
        { id: "agent-rich", title: 123 },  // title must be string
      ],
    });
    const body = result.body as Record<string, unknown>;
    expect(body.valid).toBe(false);
    expect((body.errors as string[]).some((e) => e.includes("title"))).toBe(true);
  });
});

// ─── config preview action contract tests ─────────────────────────────────────

describe("config preview action — contract shape", () => {
  it("returns costDelta, consequence, risk, riskExplanation for changes", () => {
    const result = handleAction("proj1", "config/preview", {
      current: { daily: { cents: 1000 } },
      proposed: { daily: { cents: 2000 }, hourly: { cents: 100 } },
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(typeof body.costDelta).toBe("string");
    expect(typeof body.consequence).toBe("string");
    expect(typeof body.risk).toBe("string");
    expect(typeof body.riskExplanation).toBe("string");
    expect(body.costDirection).toBe("neutral");
  });

  it("returns no-change response when current and proposed are equal", () => {
    const result = handleAction("proj1", "config/preview", {
      current: { daily: { cents: 1000 } },
      proposed: { daily: { cents: 1000 } },
    });
    const body = result.body as Record<string, unknown>;
    expect(body.risk).toBe("LOW");
    expect((body.costDelta as string).toLowerCase()).toContain("no change");
  });

  it("escalates risk to MEDIUM for more than 3 changed fields", () => {
    const result = handleAction("proj1", "config/preview", {
      current: { a: 1, b: 2, c: 3, d: 4 },
      proposed: { a: 10, b: 20, c: 30, d: 40 },
    });
    const body = result.body as Record<string, unknown>;
    expect(body.risk).toBe("MEDIUM");
  });
});

// ─── config save action — response shape ──────────────────────────────────────

describe("config save action — response shape", () => {
  it("returns ok:true with section name on successful save", () => {
    const result = handleAction("proj1", "config/save", {
      section: "safety",
      data: { spawn_depth_limit: 5 },
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    // ConfigSaveResponse: { ok: boolean, section?: string, error?: string, warnings?: string[] }
    expect(body.ok).toBe(true);
    expect(typeof body.section).toBe("string");
  });

  it("returns error message when section is not provided", () => {
    const result = handleAction("proj1", "config/save", {
      data: { foo: "bar" },
    });
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});
