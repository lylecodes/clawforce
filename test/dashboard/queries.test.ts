import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock all downstream dependencies
vi.mock("../../src/lifecycle.js", () => ({
  getActiveProjectIds: vi.fn(() => ["proj1", "proj2"]),
}));

vi.mock("../../src/project.js", () => {
  const configs = new Map<string, any>([
    ["agent-mgr", { projectId: "proj1", config: { extends: "manager", title: "Manager", department: "eng", team: "core", persona: "helpful", reports_to: null, expectations: [], performance_policy: {} } }],
    ["agent-dev", { projectId: "proj1", config: { extends: "employee", title: "Developer", department: "eng", team: "core", persona: "focused", reports_to: "agent-mgr", expectations: [], performance_policy: {} } }],
    ["agent-other", { projectId: "proj2", config: { extends: "employee", title: "Other", department: "ops" } }],
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

vi.mock("../../src/telemetry/session-archive.js", () => ({
  listSessionArchives: vi.fn(() => [{ sessionKey: "s1", agentId: "agent-dev", durationMs: 1200, toolCallCount: 3, totalCostCents: 15 }]),
  countSessionArchives: vi.fn(() => 1),
}));

vi.mock("../../src/metrics.js", () => ({
  queryMetrics: vi.fn(() => [{ type: "task", key: "velocity", value: 5 }]),
  aggregateMetrics: vi.fn(() => ({ sum: 10, count: 2 })),
}));

vi.mock("../../src/cost.js", () => ({
  getCostSummary: vi.fn(() => ({ totalCostCents: 42, totalInputTokens: 100, totalOutputTokens: 200, recordCount: 3 })),
}));

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => {
      if (sql.includes("audit_log") && sql.includes("COUNT")) {
        return { get: vi.fn(() => ({ cnt: 2 })) };
      }
      if (sql.includes("audit_log")) {
        return { all: vi.fn(() => [
          { id: "al1", actor: "agent-dev", action: "task.complete", target_type: "task", target_id: "t1", detail: null, created_at: 1000 },
          { id: "al2", actor: "agent-mgr", action: "agent.disable", target_type: "agent", target_id: "agent-dev", detail: "test", created_at: 900 },
        ]) };
      }
      if (sql.includes("audit_runs") && sql.includes("COUNT")) {
        return { get: vi.fn(() => ({ cnt: 1 })) };
      }
      if (sql.includes("audit_runs")) {
        return { all: vi.fn(() => [
          { id: "ar1", agent_id: "agent-dev", session_key: "sk1", status: "pass", summary: "All good", details: null, started_at: 800, ended_at: 900, duration_ms: 100 },
        ]) };
      }
      if (sql.includes("enforcement_retries") && sql.includes("COUNT")) {
        return { get: vi.fn(() => ({ cnt: 1 })) };
      }
      if (sql.includes("enforcement_retries")) {
        return { all: vi.fn(() => [
          { id: "er1", agent_id: "agent-dev", session_key: "sk1", attempted_at: 500, outcome: "success" },
        ]) };
      }
      if (sql.includes("onboarding_state")) {
        return { all: vi.fn(() => [
          { key: "welcome_delivered", value: "true", updated_at: 700 },
        ]) };
      }
      if (sql.includes("tracked_sessions") && sql.includes("COUNT")) {
        return { get: vi.fn(() => ({ cnt: 1 })) };
      }
      if (sql.includes("tracked_sessions")) {
        return { all: vi.fn(() => [
          { session_key: "sk1", agent_id: "agent-dev", started_at: 600, requirements: "[]", satisfied: "[]", tool_call_count: 3, last_persisted_at: 650 },
        ]) };
      }
      if (sql.includes("worker_assignments")) {
        return { all: vi.fn(() => [
          { agent_id: "agent-dev", task_id: "t1", assigned_at: 400 },
        ]) };
      }
      return {
        all: vi.fn(() => []),
        get: vi.fn(() => ({})),
      };
    }),
  })),
}));

vi.mock("../../src/monitoring/slo.js", () => ({
  evaluateSlos: vi.fn(() => [{ sloName: "slo1", metricKey: "latency", threshold: 100, actual: 50, passed: true, noData: false }]),
}));

vi.mock("../../src/monitoring/alerts.js", () => ({
  evaluateAlertRules: vi.fn(() => [{ id: "alert1", fired: false }]),
}));

vi.mock("../../src/monitoring/health-tier.js", () => ({
  computeHealthTier: vi.fn(() => "GREEN"),
}));

vi.mock("../../src/events/store.js", () => ({
  listEvents: vi.fn(() => [{ id: "e1", type: "task.created" }]),
  countEvents: vi.fn(() => 1),
}));

vi.mock("../../src/org.js", () => ({
  getDirectReports: vi.fn(() => ["agent-dev"]),
  getDepartmentAgents: vi.fn(() => ["agent-mgr", "agent-dev"]),
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

const {
  queryProjects, queryAgents, queryAgentDetail,
  queryTasks, queryTaskDetail, querySessions,
  queryEvents, queryMetricsDashboard, queryCosts,
  queryPolicies, querySlos, queryAlerts, queryOrgChart, queryHealth,
  queryAuditLog, queryAuditRuns, queryEnforcementRetries,
  queryOnboardingState, queryTrackedSessions, queryWorkerAssignments,
  readContextFile, writeContextFile,
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
    expect(result!.extends).toBe("manager");
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
  it("returns archived sessions with pagination metadata", () => {
    const result = querySessions("proj1");
    expect(result.sessions).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    expect(result.sessions[0]).toMatchObject({
      sessionKey: "s1",
      agentId: "agent-dev",
      durationMs: 1200,
      toolCallCount: 3,
      totalCostCents: 15,
    });
  });
});

describe("queryEvents", () => {
  it("returns events with total count and pagination info", () => {
    const result = queryEvents("proj1");
    expect(result.events).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
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

  it("resolves valid reportsTo chains", () => {
    const result = queryOrgChart("proj1");
    const dev = result.agents.find((a: any) => a.id === "agent-dev");
    const mgr = result.agents.find((a: any) => a.id === "agent-mgr");
    // agent-dev reports to agent-mgr which exists — should be preserved
    expect(dev?.reportsTo).toBe("agent-mgr");
    // agent-mgr has reports_to: null — should remain undefined
    expect(mgr?.reportsTo).toBeUndefined();
  });

  it("nullifies unresolved reportsTo references", async () => {
    // Temporarily add an agent that reports to a non-existent manager
    const { getAgentConfig, getRegisteredAgentIds } = await import("../../src/project.js");
    const origGetConfig = vi.mocked(getAgentConfig).getMockImplementation()!;
    const origGetIds = vi.mocked(getRegisteredAgentIds).getMockImplementation()!;

    vi.mocked(getRegisteredAgentIds).mockImplementation(() => [
      ...origGetIds(),
      "agent-orphan",
    ]);
    vi.mocked(getAgentConfig).mockImplementation((id: string) => {
      if (id === "agent-orphan") {
        return {
          projectId: "proj1",
          config: {
            extends: "employee",
            title: "Orphan Worker",
            department: "eng",
            reports_to: "deleted-manager",
            expectations: [],
            performance_policy: {},
          },
        } as any;
      }
      return origGetConfig(id);
    });

    const result = queryOrgChart("proj1");
    const orphan = result.agents.find((a: any) => a.id === "agent-orphan");
    expect(orphan).toBeDefined();
    // "deleted-manager" doesn't exist in the project — should be nullified
    expect(orphan?.reportsTo).toBeUndefined();

    // Restore original mocks
    vi.mocked(getAgentConfig).mockImplementation(origGetConfig);
    vi.mocked(getRegisteredAgentIds).mockImplementation(origGetIds);
  });

  it('treats reports_to: "parent" as a root node', async () => {
    const { getAgentConfig, getRegisteredAgentIds } = await import("../../src/project.js");
    const origGetConfig = vi.mocked(getAgentConfig).getMockImplementation()!;
    const origGetIds = vi.mocked(getRegisteredAgentIds).getMockImplementation()!;

    vi.mocked(getRegisteredAgentIds).mockImplementation(() => [
      ...origGetIds(),
      "agent-sub",
    ]);
    vi.mocked(getAgentConfig).mockImplementation((id: string) => {
      if (id === "agent-sub") {
        return {
          projectId: "proj1",
          config: {
            extends: "employee",
            title: "Sub Agent",
            department: "eng",
            reports_to: "parent",
            expectations: [],
            performance_policy: {},
          },
        } as any;
      }
      return origGetConfig(id);
    });

    const result = queryOrgChart("proj1");
    const sub = result.agents.find((a: any) => a.id === "agent-sub");
    expect(sub).toBeDefined();
    // "parent" is a special value (subagent auto-announce) — should become undefined (root)
    expect(sub?.reportsTo).toBeUndefined();

    // Restore original mocks
    vi.mocked(getAgentConfig).mockImplementation(origGetConfig);
    vi.mocked(getRegisteredAgentIds).mockImplementation(origGetIds);
  });
});

describe("queryHealth", () => {
  it("returns health tier", () => {
    const result = queryHealth("proj1");
    expect(result.tier).toBe("GREEN");
    expect(result.emergencyStop).toBe(false);
    expect(result.domainEnabled).toBe(true);
  });
});

describe("queryAuditLog", () => {
  it("returns audit log entries with pagination", () => {
    const result = queryAuditLog("proj1");
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.entries[0]).toMatchObject({ id: "al1", actor: "agent-dev", action: "task.complete" });
  });
});

describe("queryAuditRuns", () => {
  it("returns audit runs with pagination", () => {
    const result = queryAuditRuns("proj1");
    expect(result.runs).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.runs[0]).toMatchObject({ id: "ar1", agentId: "agent-dev", status: "pass" });
  });
});

describe("queryEnforcementRetries", () => {
  it("returns enforcement retries", () => {
    const result = queryEnforcementRetries("proj1");
    expect(result.retries).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.retries[0]).toMatchObject({ id: "er1", agentId: "agent-dev", outcome: "success" });
  });
});

describe("queryOnboardingState", () => {
  it("returns onboarding state entries", () => {
    const result = queryOnboardingState("proj1");
    expect(result.entries).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.entries[0]).toMatchObject({ key: "welcome_delivered", value: "true" });
  });
});

describe("queryTrackedSessions", () => {
  it("returns tracked sessions with pagination", () => {
    const result = queryTrackedSessions("proj1");
    expect(result.sessions).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.sessions[0]).toMatchObject({ sessionKey: "sk1", agentId: "agent-dev", toolCallCount: 3 });
  });
});

describe("queryWorkerAssignments", () => {
  it("returns worker assignments", () => {
    const result = queryWorkerAssignments("proj1");
    expect(result.assignments).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.assignments[0]).toMatchObject({ agentId: "agent-dev", taskId: "t1" });
  });
});

describe("context file queries", () => {
  it("writes then reads a context file (round-trip)", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-context-"));
    const relativePath = "DIRECTION.md";

    writeContextFile(projectDir, relativePath, "# direction\nship it");
    const result = readContextFile(projectDir, relativePath);

    expect(result.path).toBe(relativePath);
    expect(result.content).toBe("# direction\nship it");
    expect(result.lastModified).toBeGreaterThan(0);
  });

  it("rejects path traversal attempts", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-context-"));

    expect(() => readContextFile(projectDir, "../etc/passwd")).toThrow(/Path traversal/i);
    expect(() => writeContextFile(projectDir, "../etc/passwd", "nope")).toThrow(/Path traversal/i);
  });

  it("throws when reading a non-existent file", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-context-"));
    expect(() => readContextFile(projectDir, "MISSING.md")).toThrow(/File not found/i);
  });
});
