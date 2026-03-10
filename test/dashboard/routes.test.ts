import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/dashboard/routes.js";

// Mock all the query dependencies to avoid needing a real database
vi.mock("../../src/dashboard/queries.js", () => ({
  queryProjects: vi.fn(() => [{ id: "proj1", agentCount: 2 }]),
  queryAgents: vi.fn((projectId: string) => [
    { id: "agent1", role: "manager", status: "idle" },
    { id: "agent2", role: "employee", status: "active" },
  ]),
  queryAgentDetail: vi.fn((projectId: string, agentId: string) => {
    if (agentId === "agent1") {
      return { id: "agent1", role: "manager", status: "idle", directReports: ["agent2"] };
    }
    return null;
  }),
  queryTasks: vi.fn(() => ({ tasks: [], hasMore: false, count: 0 })),
  queryTaskDetail: vi.fn((pid: string, tid: string) => {
    if (tid === "task1") return { task: { id: "task1" }, evidence: [], transitions: [] };
    return null;
  }),
  querySessions: vi.fn(() => ({ sessions: [], hasMore: false })),
  queryEvents: vi.fn(() => ({ events: [], count: 0 })),
  queryMetricsDashboard: vi.fn(() => ({ metrics: [], count: 0 })),
  queryCosts: vi.fn(() => ({ totalCents: 0 })),
  queryPolicies: vi.fn(() => ({ policies: [] })),
  querySlos: vi.fn(() => ({ slos: [] })),
  queryAlerts: vi.fn(() => ({ alerts: [] })),
  queryOrgChart: vi.fn(() => ({ agents: [], departments: [] })),
  queryHealth: vi.fn(() => ({ tier: "GREEN" })),
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
});
