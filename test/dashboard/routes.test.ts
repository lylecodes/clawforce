import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/dashboard/routes.js";
import { readDomainContextFile, ContextFileError } from "../../src/app/queries/context-files.js";
import {
  runIngestProjectEventCommand,
  runUpdateProjectBudgetLimitCommand,
  runWriteProjectContextFileCommand,
} from "../../src/app/commands/project-controls.js";

// Mock all the query dependencies to avoid needing a real database
vi.mock("../../src/dashboard/queries.js", () => ({
  queryProjects: vi.fn(() => [{ id: "proj1", agentCount: 2 }]),
  queryAgents: vi.fn((projectId: string) => [
    { id: "agent1", extends: "manager", status: "idle" },
    { id: "agent2", extends: "employee", status: "active" },
  ]),
  queryAgentDetail: vi.fn((projectId: string, agentId: string) => {
    if (agentId === "agent1") {
      return { id: "agent1", extends: "manager", status: "idle", directReports: ["agent2"] };
    }
    return null;
  }),
  queryTasks: vi.fn(() => ({ tasks: [], hasMore: false, count: 0 })),
  queryTaskDetail: vi.fn((pid: string, tid: string) => {
    if (tid === "task1") return { task: { id: "task1" }, evidence: [], transitions: [] };
    return null;
  }),
  querySessions: vi.fn(() => ({ sessions: [], hasMore: false, count: 0 })),
  queryEvents: vi.fn(() => ({ events: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryMetricsDashboard: vi.fn(() => ({ metrics: [], count: 0 })),
  queryCosts: vi.fn(() => ({ totalCents: 0 })),
  queryPolicies: vi.fn(() => ({ policies: [] })),
  querySlos: vi.fn(() => ({ slos: [] })),
  queryAlerts: vi.fn(() => ({ alerts: [] })),
  queryOrgChart: vi.fn(() => ({ agents: [], departments: [] })),
  queryHealth: vi.fn(() => ({ tier: "GREEN" })),
  queryMessages: vi.fn(() => ({ threads: [], count: 0 })),
  queryProtocols: vi.fn(() => ({ protocols: [], count: 0 })),
  queryGoals: vi.fn(() => ({ goals: [], hasMore: false, count: 0 })),
  queryGoalDetail: vi.fn(() => null),
  queryAuditLog: vi.fn(() => ({ entries: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryAuditRuns: vi.fn(() => ({ runs: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryEnforcementRetries: vi.fn(() => ({ retries: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryOnboardingState: vi.fn(() => ({ entries: [], count: 0 })),
  queryTrackedSessions: vi.fn(() => ({ sessions: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryWorkerAssignments: vi.fn(() => ({ assignments: [], count: 0 })),
  queryExperiments: vi.fn(() => ({ experiments: [], count: 0 })),
  queryKnowledge: vi.fn(() => ({ knowledge: [], count: 0, total: 0 })),
  queryKnowledgeFlags: vi.fn(() => ({ flags: [], count: 0, total: 0 })),
  queryPromotionCandidates: vi.fn(() => ({ candidates: [], count: 0, total: 0 })),
  queryQueueStatus: vi.fn(() => ({ queued: 0 })),
  queryToolCalls: vi.fn(() => ({ toolCalls: [], count: 0, hasMore: false })),
  queryConfigVersions: vi.fn(() => ({ versions: [], count: 0 })),
  queryManagerReviews: vi.fn(() => ({ reviews: [], count: 0 })),
  queryTrustDecisions: vi.fn(() => ({ decisions: [], count: 0 })),
  queryPolicyViolations: vi.fn(() => ({ violations: [], count: 0 })),
  queryWorkStreams: vi.fn(() => ({ workStreams: [], count: 0 })),
  queryUserInbox: vi.fn(() => ({ messages: [], count: 0 })),
}));

vi.mock("../../src/app/queries/context-files.js", () => ({
  readDomainContextFile: vi.fn(() => ({ content: "hello", path: "DIRECTION.md", lastModified: 123 })),
  ContextFileError: class ContextFileError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../../src/app/commands/project-controls.js", () => ({
  runIngestProjectEventCommand: vi.fn(() => ({ status: 201, body: { id: "evt-1", deduplicated: false } })),
  runUpdateProjectBudgetLimitCommand: vi.fn(() => ({
    status: 200,
    body: { ok: true, previousLimit: 25000, newLimit: 50000 },
  })),
  runWriteProjectContextFileCommand: vi.fn(() => ({ status: 200, body: { ok: true } })),
}));

vi.mock("../../src/project.js", () => ({
  getExtendedProjectConfig: vi.fn(() => null),
}));

describe("dashboard routes", () => {
  it("GET /api/projects returns projects list", () => {
    const result = handleRequest("/api/projects", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual([{ id: "proj1", agentCount: 2 }]);
  });

  it("GET /api/projects/:id/agents returns agents", () => {
    const result = handleRequest("/api/projects/proj1/agents", {});
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(2);
  });

  it("GET /api/projects/:id/agents/:aid returns agent detail", () => {
    const result = handleRequest("/api/projects/proj1/agents/agent1", {});
    expect(result.status).toBe(200);
    expect((result.body as any).id).toBe("agent1");
  });

  it("GET /api/projects/:id/agents/:aid returns 404 for unknown agent", () => {
    const result = handleRequest("/api/projects/proj1/agents/unknown", {});
    expect(result.status).toBe(404);
  });

  it("GET /api/projects/:id/tasks returns tasks", () => {
    const result = handleRequest("/api/projects/proj1/tasks", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/tasks?origin=user_request filters by origin", () => {
    const result = handleRequest("/api/projects/proj1/tasks", { origin: "user_request" });
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("tasks");
    expect(result.body).toHaveProperty("hasMore");
  });

  it("GET /api/projects/:id/tasks?origin=lead_proposal filters by lead proposal origin", () => {
    const result = handleRequest("/api/projects/proj1/tasks", { origin: "lead_proposal" });
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("tasks");
  });

  it("GET /api/projects/:id/tasks?origin=reactive filters by reactive origin", () => {
    const result = handleRequest("/api/projects/proj1/tasks", { origin: "reactive" });
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("tasks");
  });

  it("GET /api/projects/:id/tasks?origin=invalid ignores invalid origin", () => {
    const result = handleRequest("/api/projects/proj1/tasks", { origin: "invalid_origin" });
    expect(result.status).toBe(200);
    // Invalid origin should be ignored, not cause an error
    expect(result.body).toHaveProperty("tasks");
  });

  it("GET /api/projects/:id/tasks/:tid returns task detail", () => {
    const result = handleRequest("/api/projects/proj1/tasks/task1", {});
    expect(result.status).toBe(200);
    expect((result.body as any).task.id).toBe("task1");
  });

  it("GET /api/projects/:id/tasks/:tid returns 404 for unknown task", () => {
    const result = handleRequest("/api/projects/proj1/tasks/unknown", {});
    expect(result.status).toBe(404);
  });

  it("GET /api/projects/:id/sessions returns sessions", () => {
    const result = handleRequest("/api/projects/proj1/sessions", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/events returns events", () => {
    const result = handleRequest("/api/projects/proj1/events", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/metrics returns metrics", () => {
    const result = handleRequest("/api/projects/proj1/metrics", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/costs returns costs", () => {
    const result = handleRequest("/api/projects/proj1/costs", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/policies returns policies", () => {
    const result = handleRequest("/api/projects/proj1/policies", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/slos returns SLOs", () => {
    const result = handleRequest("/api/projects/proj1/slos", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/alerts returns alerts", () => {
    const result = handleRequest("/api/projects/proj1/alerts", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/org returns org chart", () => {
    const result = handleRequest("/api/projects/proj1/org", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/health returns health", () => {
    const result = handleRequest("/api/projects/proj1/health", {});
    expect(result.status).toBe(200);
  });

  it("unknown resource returns 404", () => {
    const result = handleRequest("/api/projects/proj1/unknown", {});
    expect(result.status).toBe(404);
  });

  it("root path returns 404", () => {
    const result = handleRequest("/", {});
    expect(result.status).toBe(404);
  });

  it("strips trailing slash", () => {
    const result = handleRequest("/api/projects/", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/audit-log returns audit log", () => {
    const result = handleRequest("/api/projects/proj1/audit-log", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/audit-runs returns audit runs", () => {
    const result = handleRequest("/api/projects/proj1/audit-runs", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/enforcement-retries returns retries", () => {
    const result = handleRequest("/api/projects/proj1/enforcement-retries", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/onboarding returns onboarding state", () => {
    const result = handleRequest("/api/projects/proj1/onboarding", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/tracked-sessions returns tracked sessions", () => {
    const result = handleRequest("/api/projects/proj1/tracked-sessions", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/worker-assignments returns assignments", () => {
    const result = handleRequest("/api/projects/proj1/worker-assignments", {});
    expect(result.status).toBe(200);
  });

  it("GET /api/projects/:id/context-files returns file content", () => {
    const result = handleRequest("/api/projects/proj1/context-files", { path: "DIRECTION.md" });
    expect(result.status).toBe(200);
    expect(readDomainContextFile).toHaveBeenCalledWith("proj1", "DIRECTION.md");
    expect(result.body).toEqual({ content: "hello", path: "DIRECTION.md", lastModified: 123 });
  });

  it("POST /api/projects/:id/context-files writes file", () => {
    const result = handleRequest(
      "/api/projects/proj1/context-files",
      {},
      "POST",
      { path: "SOUL.md", content: "updated" },
    );

    expect(result.status).toBe(200);
    expect(runWriteProjectContextFileCommand).toHaveBeenCalledWith("proj1", { path: "SOUL.md", content: "updated" });
    expect(result.body).toEqual({ ok: true });
  });

  it("GET /api/projects/:id/context-files returns 403 on traversal", () => {
    vi.mocked(readDomainContextFile).mockImplementationOnce(() => {
      throw new ContextFileError("Path traversal is not allowed", 403);
    });

    const result = handleRequest("/api/projects/proj1/context-files", { path: "../etc/passwd" });
    expect(result.status).toBe(403);
  });

  it("GET /api/projects/:id/context-files returns 404 for missing file", () => {
    vi.mocked(readDomainContextFile).mockImplementationOnce(() => {
      throw new ContextFileError("File not found", 404);
    });

    const result = handleRequest("/api/projects/proj1/context-files", { path: "MISSING.md" });
    expect(result.status).toBe(404);
  });

  it("POST /api/projects/:id/budget updates daily budget limit", () => {
    const result = handleRequest(
      "/api/projects/proj1/budget",
      {},
      "POST",
      { dailyLimitCents: 50000 },
    );

    expect(result.status).toBe(200);
    expect(runUpdateProjectBudgetLimitCommand).toHaveBeenCalledWith("proj1", { dailyLimitCents: 50000 });
    expect(result.body).toEqual({ ok: true, previousLimit: 25000, newLimit: 50000 });
  });

  it("POST /api/projects/:id/budget rejects invalid limits", () => {
    vi.mocked(runUpdateProjectBudgetLimitCommand).mockReturnValueOnce({
      status: 400,
      body: { error: "dailyLimitCents must be > 0 and <= 100000" },
    });
    const zero = handleRequest("/api/projects/proj1/budget", {}, "POST", { dailyLimitCents: 0 });
    expect(zero.status).toBe(400);

    vi.mocked(runUpdateProjectBudgetLimitCommand).mockReturnValueOnce({
      status: 400,
      body: { error: "dailyLimitCents must be > 0 and <= 100000" },
    });
    const negative = handleRequest("/api/projects/proj1/budget", {}, "POST", { dailyLimitCents: -1 });
    expect(negative.status).toBe(400);

    vi.mocked(runUpdateProjectBudgetLimitCommand).mockReturnValueOnce({
      status: 400,
      body: { error: "dailyLimitCents must be > 0 and <= 100000" },
    });
    const tooLarge = handleRequest("/api/projects/proj1/budget", {}, "POST", { dailyLimitCents: 100001 });
    expect(tooLarge.status).toBe(400);
  });

  it("POST /api/projects/:id/events/ingest delegates to project controls command", () => {
    const result = handleRequest(
      "/api/projects/proj1/events/ingest",
      {},
      "POST",
      { type: "deployment_complete", payload: { env: "prod" } },
    );

    expect(result.status).toBe(201);
    expect(runIngestProjectEventCommand).toHaveBeenCalledWith("proj1", {
      type: "deployment_complete",
      payload: { env: "prod" },
    });
    expect(result.body).toEqual({ id: "evt-1", deduplicated: false });
  });
});
