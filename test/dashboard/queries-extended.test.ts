import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock all downstream dependencies (same as queries.test.ts plus new ones)
vi.mock("../../src/lifecycle.js", () => ({
  getActiveProjectIds: vi.fn(() => ["proj1"]),
}));

vi.mock("../../src/project.js", () => {
  const configs = new Map<string, any>([
    ["agent-mgr", {
      projectId: "proj1",
      config: {
        extends: "manager",
        title: "Manager",
        department: "eng",
        briefing: [{ source: "file", path: "context/manager.md" }, { source: "direction" }],
      },
    }],
    ["agent-dev", { projectId: "proj1", config: { extends: "employee", title: "Developer", department: "eng", briefing: [] } }],
  ]);
  return {
    getAgentConfig: vi.fn((id: string) => configs.get(id) ?? null),
    getRegisteredAgentIds: vi.fn(() => [...configs.keys()]),
    getExtendedProjectConfig: vi.fn((pid: string) => {
      if (pid === "proj1") return {
        agents: { "agent-mgr": {}, "agent-dev": {} },
        budget: { monthly: 1000 },
        tool_gates: {},
        initiatives: [],
        jobs: {},
        safety: {},
        monitoring: {},
        policies: [],
      };
      return null;
    }),
  };
});

vi.mock("../../src/tasks/ops.js", () => ({
  listTasks: vi.fn(() => [{ id: "t1", state: "IN_PROGRESS" }, { id: "t2", state: "ASSIGNED" }]),
  getTask: vi.fn(),
  getTaskEvidence: vi.fn(() => []),
  getTaskTransitions: vi.fn(() => []),
}));

vi.mock("../../src/audit.js", () => ({
  queryAuditLog: vi.fn(() => []),
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
}));

vi.mock("../../src/messaging/store.js", () => ({
  searchMessages: vi.fn(() => ({ messages: [] })),
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
  getActiveSessions: vi.fn(() => [
    { agentId: "agent-dev", projectId: "proj1", sessionKey: "sk1", metrics: { startedAt: 0, toolCalls: [] } },
  ]),
}));

vi.mock("../../src/safety.js", () => ({
  isEmergencyStopActive: vi.fn(() => false),
}));

vi.mock("../../src/approval/resolve.js", () => ({
  listPendingProposals: vi.fn(() => [
    { id: "p1", status: "pending", title: "Deploy v2" },
    { id: "p2", status: "pending", title: "Add agent" },
  ]),
}));

vi.mock("../../src/budget-windows.js", () => ({
  getBudgetStatus: vi.fn(() => ({
    hourly: { window: "hourly", limitCents: 1000, spentCents: 500, remainingCents: 500, usedPercent: 50 },
    daily: { window: "daily", limitCents: 10000, spentCents: 2000, remainingCents: 8000, usedPercent: 20 },
    monthly: undefined,
    alerts: [],
  })),
}));

vi.mock("../../src/budget/forecast.js", () => ({
  computeDailySnapshot: vi.fn(() => ({ spent: 20, remaining: 80, rate: 2.5 })),
  computeWeeklyTrend: vi.fn(() => ({ days: [], avgDaily: 20 })),
  computeMonthlyProjection: vi.fn(() => ({ projected: 600, limit: 1000 })),
}));

vi.mock("../../src/trust/tracker.js", () => ({
  getAllCategoryStats: vi.fn(() => [
    { category: "code_exec", approved: 10, rejected: 1 },
    { category: "file_write", approved: 5, rejected: 0 },
  ]),
  getActiveTrustOverrides: vi.fn(() => []),
}));

vi.mock("../../src/channels/store.js", () => ({
  listChannels: vi.fn(() => [
    { id: "ch1", name: "meeting-1", type: "meeting", status: "active" },
  ]),
  getChannel: vi.fn((pid: string, chId: string) => {
    if (chId === "ch1") return { id: "ch1", name: "meeting-1", type: "meeting", status: "active" };
    return null;
  }),
}));

vi.mock("../../src/channels/messages.js", () => ({
  buildChannelTranscript: vi.fn(() => "agent-a: hello\nagent-b: hi"),
}));

vi.mock("../../src/channels/meeting.js", () => ({
  getMeetingStatus: vi.fn(() => ({
    channel: { id: "ch1" },
    currentTurn: 3,
    participants: ["agent-a", "agent-b"],
    transcript: "agent-a: hello\nagent-b: hi",
  })),
}));

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => []),
      get: vi.fn(() => {
        if (sql.includes("FROM budgets")) {
          return {
            hourly_limit_cents: 1000,
            hourly_limit_tokens: 10000,
            hourly_limit_requests: 10,
            daily_limit_cents: 10000,
            daily_limit_tokens: 100000,
            daily_limit_requests: 100,
            monthly_limit_cents: null,
            monthly_limit_tokens: null,
            monthly_limit_requests: null,
          };
        }
        return undefined;
      }),
    })),
  })),
}));

vi.mock("../../src/config/api-service.js", () => ({
  readDomainConfig: vi.fn((projectId: string) => {
    if (projectId === "proj1") {
      return {
        domain: "proj1",
        agents: ["agent-mgr", "agent-dev"],
        operational_profile: "medium",
        defaults: {
          briefing: [{ source: "direction" }],
          performance_policy: { action: "alert" },
        },
        workflows: ["daily_review", "incident_response"],
        knowledge: {
          provider: "filesystem",
          categories: ["ops", "product"],
        },
        event_handlers: {
          task_created: {
            type: "notify",
            target: "agent-mgr",
          },
        },
        role_defaults: {
          manager: {
            briefing: [{ source: "policies" }],
          },
        },
        team_templates: {
          eng: {
            briefing: [{ source: "file", path: "context/eng.md" }],
          },
        },
        dashboard_assistant: {
          agentId: "agent-mgr",
          model: "gpt-5.4-mini",
        },
        rules: [{ type: "budget_guard" }],
        goals: {
          launch: { allocation: 40, description: "Launch work" },
          reserve: { description: "Unallocated reserve" },
        },
      };
    }
    return null;
  }),
  readGlobalConfig: vi.fn(() => ({
    agents: {
      "agent-mgr": {
        jobs: {
          standup: {
            cron: "0 9 * * *",
            description: "Daily standup",
            enabled: true,
          },
        },
      },
      "agent-dev": {
        jobs: {
          cleanup: {
            cron: "0 18 * * *",
            enabled: false,
          },
        },
      },
    },
  })),
}));

const {
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryConfig,
  queryMeetings,
  queryMeetingDetail,
} = await import("../../src/dashboard/queries.js");

describe("queryDashboardSummary", () => {
  it("returns metric card data", () => {
    const result = queryDashboardSummary("proj1");
    expect(result).toHaveProperty("budgetUtilization");
    expect(result).toHaveProperty("activeAgents");
    expect(result).toHaveProperty("tasksInFlight");
    expect(result).toHaveProperty("pendingApprovals");
    expect(result.activeAgents).toBe(1); // agent-dev has active session
    expect(result.totalAgents).toBe(2);
    expect(result.pendingApprovals).toBe(2);
    // Should report the worst-case window (hourly: 50%), not sum across windows
    expect(result.budgetUtilization.spent).toBe(500); // hourly window (50% > daily 20%)
    expect(result.budgetUtilization.limit).toBe(1000); // hourly limit
    expect(result.budgetUtilization.pct).toBe(50);
    expect(result.budgetUtilization.dimension).toBe("cents");
  });
});

describe("queryApprovals", () => {
  it("returns pending proposals by default", () => {
    const result = queryApprovals("proj1", {});
    expect(result).toHaveProperty("proposals");
    expect(result.proposals).toHaveLength(2);
  });

  it("returns pending proposals with explicit status filter", () => {
    const result = queryApprovals("proj1", { status: "pending" });
    expect(result.proposals).toHaveLength(2);
  });

  it("queries resolved proposals from DB", () => {
    const result = queryApprovals("proj1", { status: "approved" });
    expect(result).toHaveProperty("proposals");
  });
});

describe("queryBudgetStatus", () => {
  it("returns window breakdowns", () => {
    const result = queryBudgetStatus("proj1");
    expect(result).toHaveProperty("hourly");
    expect(result).toHaveProperty("daily");
    expect(result).toHaveProperty("alerts");
  });
});

describe("queryBudgetForecast", () => {
  it("returns daily, weekly, and monthly forecasts", () => {
    const result = queryBudgetForecast("proj1");
    expect(result).toHaveProperty("daily");
    expect(result).toHaveProperty("weekly");
    expect(result).toHaveProperty("monthly");
    expect(result.daily).not.toBeNull();
  });
});

describe("queryTrustScores", () => {
  it("returns per-category trust stats", () => {
    const result = queryTrustScores("proj1");
    expect(result).toHaveProperty("agents");
    expect(result.agents).toHaveLength(2);
    expect(result).toHaveProperty("overrides");
  });
});

describe("queryConfig", () => {
  it("returns structured config sections", () => {
    const result = queryConfig("proj1");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("tool_gates");
    expect(result).toHaveProperty("safety");
    expect(result).toHaveProperty("agents");
    // briefing preserves full source objects so the SPA can round-trip edits
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "agent-mgr",
        briefing: [{ source: "file", path: "context/manager.md" }, { source: "direction" }],
      }),
    ]));
    expect(result).toHaveProperty("budget");
    expect(result.budget).toEqual({
      daily: { cents: 10000, tokens: 100000, requests: 100 },
      hourly: { cents: 1000, tokens: 10000, requests: 10 },
      monthly: undefined,
      operational_profile: "medium",
      initiatives: { launch: 40 },
    });
    expect(result.profile).toEqual({ operational_profile: "medium" });
    expect(result.initiatives).toEqual({
      launch: { allocation_pct: 40, goal: "launch" },
    });
    expect(result.dashboard_assistant).toEqual({
      enabled: true,
      agentId: "agent-mgr",
      model: "gpt-5.4-mini",
    });
    expect(result.defaults).toEqual({
      briefing: [{ source: "direction" }],
      performance_policy: { action: "alert" },
    });
    expect(result.workflows).toEqual(["daily_review", "incident_response"]);
    expect(result.knowledge).toEqual({
      provider: "filesystem",
      categories: ["ops", "product"],
    });
    expect(result.event_handlers).toEqual({
      task_created: {
        type: "notify",
        target: "agent-mgr",
      },
    });
    expect(result.role_defaults).toEqual({
      manager: {
        briefing: [{ source: "policies" }],
      },
    });
    expect(result.team_templates).toEqual({
      eng: {
        briefing: [{ source: "file", path: "context/eng.md" }],
      },
    });
    expect(result.jobs).toEqual([
      {
        id: "agent-mgr:standup",
        agent: "agent-mgr",
        cron: "0 9 * * *",
        enabled: true,
        description: "Daily standup",
      },
      {
        id: "agent-dev:cleanup",
        agent: "agent-dev",
        cron: "0 18 * * *",
        enabled: false,
        description: undefined,
      },
    ]);
    expect(result.rules).toEqual([{ type: "budget_guard" }]);
  });

  it("returns empty data for unknown project", () => {
    const result = queryConfig("unknown-project");
    expect(result).not.toBeNull();
    expect(result.agents).toHaveLength(0);
    expect(result.dashboard_assistant).toEqual({ enabled: true });
    expect(result.defaults).toEqual({});
    expect(result.workflows).toEqual([]);
    expect(result.knowledge).toEqual({});
    expect(result.event_handlers).toEqual({});
    expect(result.role_defaults).toEqual({});
    expect(result.team_templates).toEqual({});
    expect(result.profile).toEqual({});
    expect(result.initiatives).toEqual({});
  });
});

describe("queryMeetings", () => {
  it("returns meeting channels", () => {
    const result = queryMeetings("proj1");
    expect(result).toHaveProperty("meetings");
    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0]!.type).toBe("meeting");
  });
});

describe("queryMeetingDetail", () => {
  it("returns meeting detail with transcript", () => {
    const result = queryMeetingDetail("proj1", "ch1");
    expect(result).not.toBeNull();
    expect(result!.channel.id).toBe("ch1");
    expect(result).toHaveProperty("transcript");
    expect(result).toHaveProperty("participants");
  });

  it("returns null for nonexistent meeting", () => {
    const result = queryMeetingDetail("proj1", "nonexistent");
    expect(result).toBeNull();
  });
});
