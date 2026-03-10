import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock all downstream dependencies
vi.mock("../../src/lifecycle.js", () => ({
  getActiveProjectIds: vi.fn(() => ["proj1", "proj2"]),
}));

vi.mock("../../src/project.js", () => {
  const configs = new Map<string, any>([
    ["agent-mgr", { projectId: "proj1", config: { role: "manager", title: "Manager", department: "eng", team: "core", persona: "helpful", reports_to: null, expectations: [], performance_policy: {} } }],
    ["agent-dev", { projectId: "proj1", config: { role: "employee", title: "Developer", department: "eng", team: "core", persona: "focused", reports_to: "agent-mgr", expectations: [], performance_policy: {} } }],
    ["agent-other", { projectId: "proj2", config: { role: "employee", title: "Other", department: "ops" } }],
  ]);
  return {
    getAgentConfig: vi.fn((id: string) => configs.get(id) ?? null),
    getRegisteredAgentIds: vi.fn(() => [...configs.keys()]),
    getExtendedProjectConfig: vi.fn((pid: string) => {
      if (pid === "proj1") return { policies: [{ id: "p1" }], monitoring: { slos: {}, alertRules: {} } };
      return null;
    }),
  };
});

vi.mock("../../src/tasks/ops.js", () => ({
  listTasks: vi.fn(() => [{ id: "t1" }, { id: "t2" }]),
  getTask: vi.fn((pid: string, tid: string) => (tid === "t1" ? { id: "t1", state: "OPEN" } : null)),
  getTaskEvidence: vi.fn(() => []),
  getTaskTransitions: vi.fn(() => []),
}));

vi.mock("../../src/audit.js", () => ({
  queryAuditLog: vi.fn(() => [{ sessionKey: "s1" }]),
}));

vi.mock("../../src/metrics.js", () => ({
  queryMetrics: vi.fn(() => [{ type: "task", key: "velocity", value: 5 }]),
  aggregateMetrics: vi.fn(() => ({ sum: 10, count: 2 })),
}));

vi.mock("../../src/cost.js", () => ({
  getCostSummary: vi.fn(() => ({ totalCents: 42 })),
}));

vi.mock("../../src/monitoring/slo.js", () => ({
  evaluateSlos: vi.fn(() => [{ id: "slo1", status: "ok" }]),
}));

vi.mock("../../src/monitoring/alerts.js", () => ({
  evaluateAlertRules: vi.fn(() => [{ id: "alert1", fired: false }]),
}));

vi.mock("../../src/monitoring/health-tier.js", () => ({
  computeHealthTier: vi.fn(() => "GREEN"),
}));

vi.mock("../../src/events/store.js", () => ({
  listEvents: vi.fn(() => [{ id: "e1", type: "task.created" }]),
}));

vi.mock("../../src/org.js", () => ({
  getDirectReports: vi.fn(() => ["agent-dev"]),
  getDepartmentAgents: vi.fn(() => ["agent-mgr", "agent-dev"]),
}));

vi.mock("../../src/enforcement/disabled-store.js", () => ({
  listDisabledAgents: vi.fn(() => []),
}));

vi.mock("../../src/enforcement/tracker.js", () => ({
  getActiveSessions: vi.fn(() => [
    { agentId: "agent-dev", projectId: "proj1", sessionKey: "sk1", metrics: { startedAt: 0, toolCalls: [] } },
  ]),
}));

const {
  queryProjects, queryAgents, queryAgentDetail,
  queryTasks, queryTaskDetail, querySessions,
  queryEvents, queryMetricsDashboard, queryCosts,
  queryPolicies, querySlos, queryAlerts, queryOrgChart, queryHealth,
} = await import("../../src/dashboard/queries.js");

describe("queryProjects", () => {
  it("returns all active projects with agent counts", () => {
    const result = queryProjects();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "proj1", agentCount: 2 });
    expect(result[1]).toEqual({ id: "proj2", agentCount: 1 });
  });
});

describe("queryAgents", () => {
  it("returns agents for a specific project", () => {
    const result = queryAgents("proj1");
    expect(result).toHaveLength(2);
    const mgr = result.find((a: any) => a.id === "agent-mgr");
    expect(mgr?.status).toBe("idle");
    const dev = result.find((a: any) => a.id === "agent-dev");
    expect(dev?.status).toBe("active");
  });

  it("excludes agents from other projects", () => {
    const result = queryAgents("proj1");
    expect(result.find((a: any) => a.id === "agent-other")).toBeFalsy();
  });
});

describe("queryAgentDetail", () => {
  it("returns detail for a matching agent", () => {
    const result = queryAgentDetail("proj1", "agent-mgr");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("manager");
    expect(result!.directReports).toContain("agent-dev");
  });

  it("returns null for non-existent agent", () => {
    expect(queryAgentDetail("proj1", "unknown")).toBeNull();
  });
});

describe("queryTasks", () => {
  it("returns tasks with hasMore flag", () => {
    const result = queryTasks("proj1");
    expect(result.tasks).toBeDefined();
    expect(result).toHaveProperty("hasMore");
    expect(result).toHaveProperty("count");
  });
});

describe("queryTaskDetail", () => {
  it("returns task with evidence and transitions", () => {
    const result = queryTaskDetail("proj1", "t1");
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe("t1");
    expect(result!.evidence).toEqual([]);
  });

  it("returns null for missing task", () => {
    expect(queryTaskDetail("proj1", "missing")).toBeNull();
  });
});

describe("querySessions", () => {
  it("returns audit sessions", () => {
    const result = querySessions("proj1");
    expect(result.sessions).toHaveLength(1);
  });
});

describe("queryEvents", () => {
  it("returns events", () => {
    const result = queryEvents("proj1");
    expect(result.events).toHaveLength(1);
    expect(result.count).toBe(1);
  });
});

describe("queryMetricsDashboard", () => {
  it("returns raw metrics without key param", () => {
    const result = queryMetricsDashboard("proj1");
    expect(result.metrics).toBeDefined();
  });

  it("returns aggregates with key param", () => {
    const result = queryMetricsDashboard("proj1", { key: "velocity" });
    expect(result.aggregates).toBeDefined();
  });
});

describe("queryCosts", () => {
  it("returns cost summary", () => {
    const result = queryCosts("proj1");
    expect(result.totalCents).toBe(42);
  });
});

describe("queryPolicies", () => {
  it("returns policies for project", () => {
    const result = queryPolicies("proj1");
    expect(result.policies).toHaveLength(1);
  });

  it("returns empty policies for unknown project", () => {
    const result = queryPolicies("unknown");
    expect(result.policies).toEqual([]);
  });
});

describe("querySlos", () => {
  it("evaluates SLOs", () => {
    const result = querySlos("proj1");
    expect(result.slos).toHaveLength(1);
  });

  it("returns empty for project without SLO config", () => {
    const result = querySlos("unknown");
    expect(result.slos).toEqual([]);
  });
});

describe("queryAlerts", () => {
  it("evaluates alert rules", () => {
    const result = queryAlerts("proj1");
    expect(result.alerts).toHaveLength(1);
  });
});

describe("queryOrgChart", () => {
  it("returns agents and departments", () => {
    const result = queryOrgChart("proj1");
    expect(result.agents).toHaveLength(2);
    expect(result.departments).toContain("eng");
  });
});

describe("queryHealth", () => {
  it("returns health tier", () => {
    const result = queryHealth("proj1");
    expect(result.tier).toBe("GREEN");
  });
});
