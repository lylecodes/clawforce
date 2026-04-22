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
        runtime: {
          allowedTools: ["Read", "Write"],
          workspacePaths: ["/repo/core", "/repo/shared"],
        },
        briefing: [{ source: "file", path: "context/manager.md" }, { source: "direction" }],
      },
    }],
    ["agent-dev", {
      projectId: "proj1",
      config: {
        extends: "employee",
        title: "Developer",
        department: "eng",
        briefing: [],
      },
    }],
  ]);
  return {
    parseWorkforceConfigContent: vi.fn((content: string) => {
      const raw = JSON.parse(content) as Record<string, any>;
      const agents = Object.fromEntries(
        Object.entries(raw.agents ?? {}).map(([agentId, agentDef]) => {
          const config = agentDef as Record<string, any>;
          const runtime = config.runtime && typeof config.runtime === "object"
            ? config.runtime as Record<string, any>
            : {};
          const extendsFrom = typeof config.extends === "string" ? config.extends : "employee";
          const defaultAllowedTools = extendsFrom === "employee"
            ? ["Bash", "Read", "Edit", "Write", "WebSearch"]
            : extendsFrom === "verifier"
              ? ["Bash", "Read", "WebSearch"]
              : undefined;
          return [agentId, {
            extends: extendsFrom,
            title: typeof config.title === "string" ? config.title : undefined,
            department: typeof config.department === "string" ? config.department : undefined,
            briefing: [],
            expectations: [],
            performance_policy: undefined,
            runtime: Object.keys(runtime).length > 0 ? runtime : undefined,
            allowedTools: Array.isArray(runtime.allowedTools)
              ? runtime.allowedTools
              : Array.isArray(runtime.allowed_tools)
                ? runtime.allowed_tools
                : Array.isArray(config.allowedTools)
              ? config.allowedTools
              : Array.isArray(config.allowed_tools)
                ? config.allowed_tools
                : defaultAllowedTools,
            workspacePaths: Array.isArray(runtime.workspacePaths)
              ? runtime.workspacePaths
              : Array.isArray(runtime.workspace_paths)
                ? runtime.workspace_paths
                : Array.isArray(config.workspacePaths)
              ? config.workspacePaths
              : Array.isArray(config.workspace_paths)
                ? config.workspace_paths
                : undefined,
          }];
        }),
      );
      return {
        name: typeof raw.name === "string" ? raw.name : "mock-project",
        agents,
      };
    }),
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
        entities: {
          jurisdiction: {
            runtimeCreate: true,
            states: {
              proposed: { initial: true },
              shadow: {},
              active: {},
            },
            transitions: [
              {
                from: "shadow",
                to: "active",
                approvalRequired: true,
                blockedByOpenIssues: true,
              },
            ],
            issues: {
              types: {
                onboarding_request: {
                  defaultSeverity: "medium",
                  task: { enabled: true },
                },
              },
              stateSignals: [
                {
                  id: "proposed-onboarding-request",
                  whenStates: ["proposed"],
                  ownerPresence: "missing",
                  issueType: "onboarding_request",
                  recommendedAction: "Create or update governed onboarding work for this proposed jurisdiction.",
                },
              ],
            },
          },
        },
        review: {
          workflowSteward: {
            agentId: "workflow-steward",
          },
        },
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
  getSessionHeartbeatStatus: vi.fn(() => ({ state: "live", ageMs: 10 })),
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
        extends: "manager",
        jobs: {
          standup: {
            cron: "0 9 * * *",
            description: "Daily standup",
            enabled: true,
          },
        },
      },
      "agent-dev": {
        extends: "employee",
        workspace_paths: ["/repo/dashboard"],
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

vi.mock("../../src/setup/report.js", () => ({
  buildSetupReport: vi.fn((_root: string, targetDomainId?: string | null) => ({
    root: "/tmp/.clawforce",
    targetDomainId: targetDomainId ?? null,
    valid: true,
    hasGlobalConfig: true,
    domainFileIds: ["proj1"],
    domains: [{
      id: "proj1",
      file: "domains/proj1.yaml",
      exists: true,
      loaded: true,
      enabled: true,
      workflows: ["data-source-onboarding"],
      agentCount: 2,
      jobCount: 2,
      jobs: [
        {
          agentId: "agent-mgr",
          jobId: "standup",
          cron: "0 9 * * *",
          frequency: null,
          lastScheduledAt: null,
          lastFinishedAt: null,
          lastStatus: null,
          activeTaskId: null,
          activeTaskState: null,
          activeTaskTitle: null,
          activeTaskBlockedReason: null,
          activeQueueStatus: null,
          activeSessionState: "none",
          nextRunAt: null,
        },
        {
          agentId: "agent-dev",
          jobId: "cleanup",
          cron: "0 18 * * *",
          frequency: null,
          lastScheduledAt: null,
          lastFinishedAt: null,
          lastStatus: null,
          activeTaskId: "task-cleanup-1",
          activeTaskState: "IN_PROGRESS",
          activeTaskTitle: "Run recurring workflow agent-dev.cleanup",
          activeTaskBlockedReason: null,
          activeQueueStatus: null,
          activeSessionState: "none",
          nextRunAt: null,
        },
      ],
      controller: {
        state: "live",
        ownerLabel: "controller:proj1",
        heartbeatAgeMs: 1000,
        activeSessionCount: 1,
        activeDispatchCount: 1,
      },
      managerAgentId: "agent-mgr",
      pathCount: 1,
      issueCounts: { errors: 0, warnings: 0, suggestions: 0 },
    }],
    issueCounts: { errors: 0, warnings: 0, suggestions: 0 },
    checks: [{
      id: "domain:proj1:controller-config",
      status: "warn",
      summary: 'Live controller for "proj1" is running an older config revision than the config currently on disk.',
      detail: "Caller-side reload feedback is not enough to prove the live controller picked up the newer config.",
      fix: "Reload this domain through the live controller.",
      domainId: "proj1",
    }],
    issues: [],
    nextSteps: [],
  })),
  buildSetupExplanation: vi.fn(() => ({
    summary: "Setup is clean and ready.",
    targetDomainId: "proj1",
    immediateActions: [{
      id: "domain:proj1:controller-config",
      status: "warn",
      summary: 'Live controller for "proj1" is running an older config revision than the config currently on disk.',
      why: "Caller-side reload feedback is not enough to prove the live controller picked up the newer config.",
      fix: "Reload this domain through the live controller.",
      domainId: "proj1",
    }],
    domains: [{
      id: "proj1",
      diagnosis: "healthy",
      controllerState: "live",
      managerAgentId: "agent-mgr",
      counts: {
        running: 1,
        dispatching: 0,
        queued: 0,
        blocked: 0,
        stalled: 0,
        orphaned: 0,
        completed: 1,
        failed: 0,
        never: 0,
      },
      highlights: ["declared workflows: data-source-onboarding"],
    }],
  })),
}));

vi.mock("../../src/paths.js", () => ({
  getClawforceHome: vi.fn(() => "/tmp/.clawforce"),
}));

const {
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryConfig,
  querySetupExperience,
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
        allowedTools: ["Read", "Write"],
        workspacePaths: ["/repo/core", "/repo/shared"],
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

describe("querySetupExperience", () => {
  it("returns a setup-focused control-plane payload", () => {
    const result = querySetupExperience("proj1");
    expect(result.domainId).toBe("proj1");
    expect(result.report.targetDomainId).toBe("proj1");
    expect(result.explanation.summary).toContain("Setup");
    expect(result.topology.manager?.id).toBe("agent-mgr");
    expect(result.topology.manager?.executor).toBe("openclaw");
    expect(result.topology.manager?.enforcementGrade).toBe("hard-scoped");
    expect(result.topology.manager?.runtime).toEqual({
      allowedTools: ["Read", "Write"],
      workspacePaths: ["/repo/core", "/repo/shared"],
    });
    expect(result.topology.manager?.allowedTools).toEqual(["Read", "Write"]);
    expect(result.topology.manager?.workspacePaths).toEqual(["/repo/core", "/repo/shared"]);
    expect(result.topology.owners).toEqual([]);
    expect(result.topology.sharedSpecialists).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "agent-dev",
        role: "specialist",
        jobCount: 1,
        activeSessionCount: 1,
        executor: "openclaw",
        enforcementGrade: "hard-scoped",
        runtime: {
          allowedTools: ["Bash", "Read", "Edit", "Write", "WebSearch"],
          workspacePaths: ["/repo/dashboard"],
        },
        allowedTools: ["Bash", "Read", "Edit", "Write", "WebSearch"],
        workspacePaths: ["/repo/dashboard"],
      }),
    ]));
    expect(result.topology.workflows).toEqual(["data-source-onboarding"]);
    expect(result.preflight.summary).toContain("modeled behavior");
    expect(result.preflight.scenarios.some((scenario) => scenario.category === "execution")).toBe(true);
    const executionScenario = result.preflight.scenarios.find((scenario) => scenario.id === "execution:default-mutation-policy");
    expect(executionScenario?.explainability).toEqual(expect.objectContaining({
      whyThisExists: expect.stringContaining("execution policy"),
      configDrivers: expect.arrayContaining(["execution"]),
    }));
    expect(result.feed).toHaveProperty("counts");
    expect(result.decisionInbox).toHaveProperty("counts");
    expect(result.runtime).toHaveProperty("queue");
    expect(result.runtime).toHaveProperty("trackedSessions");
    expect(result.runtime.execution).toMatchObject({
      mode: "live",
      simulatedActions: {
        total: 0,
        pending: 0,
        simulated: 0,
        blocked: 0,
        approvedForLive: 0,
        discarded: 0,
        latestCreatedAt: null,
      },
      lastReload: null,
    });
    expect(result.context.agents["agent-mgr"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configPath: "agents[agent-mgr]",
          domainId: "proj1",
          route: expect.objectContaining({
            path: "/config",
            params: expect.objectContaining({ section: "agents", agentId: "agent-mgr" }),
          }),
        }),
      ]),
    );
    expect(result.context.preflight["execution:default-mutation-policy"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configPath: "execution",
        }),
      ]),
    );
    expect(result.context.preflight["state-signal:jurisdiction:proposed-onboarding-request"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configPath: "entities.jurisdiction.issues.stateSignals",
        }),
        expect.objectContaining({
          configPath: "entities.jurisdiction.issues.types.onboarding_request",
        }),
      ]),
    );
    const mutationScenario = result.preflight.scenarios.find((scenario) => scenario.id === "mutation:workflow-steward");
    expect(mutationScenario?.explainability).toEqual(expect.objectContaining({
      configDrivers: expect.arrayContaining(["review.workflowSteward"]),
    }));
    expect(result.actions.immediateActions["domain:proj1:controller-config"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: { type: "request_controller_handoff" },
        }),
      ]),
    );
    expect(result.actions.jobs["agent-dev:cleanup"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: { type: "recover_recurring_run", taskId: "task-cleanup-1" },
        }),
      ]),
    );
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
