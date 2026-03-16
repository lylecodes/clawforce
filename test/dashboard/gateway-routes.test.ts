import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// Mock dependencies
vi.mock("../../src/dashboard/queries.js", () => ({
  queryAgents: vi.fn(() => [{ id: "a1" }]),
  queryAgentDetail: vi.fn((pid: string, aid: string) => aid === "a1" ? { id: "a1" } : null),
  queryTasks: vi.fn(() => ({ tasks: [], hasMore: false, count: 0 })),
  queryTaskDetail: vi.fn(() => null),
  queryCosts: vi.fn(() => ({ totalCents: 0 })),
  queryGoals: vi.fn(() => ({ goals: [], hasMore: false, count: 0 })),
  queryGoalDetail: vi.fn(() => null),
  queryOrgChart: vi.fn(() => ({ agents: [], departments: [] })),
  queryMessages: vi.fn(() => ({ messages: [] })),
  queryDashboardSummary: vi.fn(() => ({
    budgetUtilization: { spent: 0, limit: 0, pct: 0 },
    activeAgents: 0,
    totalAgents: 0,
    tasksInFlight: 0,
    pendingApprovals: 0,
  })),
  queryApprovals: vi.fn(() => ({ proposals: [], count: 0 })),
  queryBudgetStatus: vi.fn(() => ({ windows: [], alerts: [] })),
  queryBudgetForecast: vi.fn(() => ({ daily: null, weekly: null, monthly: null })),
  queryTrustScores: vi.fn(() => ({ agents: [], overrides: [] })),
  queryConfig: vi.fn(() => ({ agents: {} })),
  queryMeetings: vi.fn(() => ({ meetings: [], count: 0 })),
  queryMeetingDetail: vi.fn(() => null),
  queryHealth: vi.fn(() => ({ tier: "GREEN" })),
  querySlos: vi.fn(() => ({ slos: [] })),
  queryAlerts: vi.fn(() => ({ alerts: [] })),
  queryEvents: vi.fn(() => ({ events: [], total: 0, count: 0, limit: 50, offset: 0 })),
  querySessions: vi.fn(() => ({ sessions: [], hasMore: false })),
  queryMetricsDashboard: vi.fn(() => ({ metrics: [], count: 0 })),
  queryPolicies: vi.fn(() => ({ policies: [] })),
  queryProtocols: vi.fn(() => ({ protocols: [], count: 0 })),
}));

vi.mock("../../src/dashboard/actions.js", () => ({
  handleAction: vi.fn(() => ({ status: 200, body: { ok: true } })),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  getSSEManager: vi.fn(() => ({
    addClient: vi.fn(),
  })),
}));

const { createDashboardHandler } = await import("../../src/dashboard/gateway-routes.js");
const { queryAgents, queryDashboardSummary } = await import("../../src/dashboard/queries.js");
const { handleAction } = await import("../../src/dashboard/actions.js");
const { getSSEManager } = await import("../../src/dashboard/sse.js");

function createMockRequest(method: string, urlStr: string, body?: Record<string, unknown>): {
  req: IncomingMessage;
  res: ServerResponse & { statusCode: number; bodyData: string };
} {
  const handlers: Record<string, Function[]> = {};
  const req = {
    method,
    url: urlStr,
    headers: { host: "localhost" },
    on(event: string, handler: Function) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event]!.push(handler);
      // If data/end, simulate immediately
      if (event === "end") {
        // First emit data if we have a body
        if (body && handlers["data"]) {
          const chunk = Buffer.from(JSON.stringify(body));
          for (const h of handlers["data"]) h(chunk);
        }
        setTimeout(() => {
          for (const h of handlers["end"]!) h();
        }, 0);
      }
      return req;
    },
  } as unknown as IncomingMessage;

  const resData = {
    statusCode: 0,
    bodyData: "",
    headers: {} as Record<string, string>,
    headersSent: false,
  };

  const res = {
    get statusCode() { return resData.statusCode; },
    set statusCode(v: number) { resData.statusCode = v; },
    get bodyData() { return resData.bodyData; },
    get headersSent() { return resData.headersSent; },
    setHeader: vi.fn((key: string, val: string) => { resData.headers[key] = val; }),
    writeHead: vi.fn((status: number, headers?: Record<string, unknown>) => {
      resData.statusCode = status;
      resData.headersSent = true;
    }),
    write: vi.fn((data: string | Buffer) => {
      resData.bodyData += typeof data === "string" ? data : data.toString();
      return true;
    }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) resData.bodyData += typeof data === "string" ? data : data.toString();
    }),
    on: vi.fn(),
  } as unknown as ServerResponse & { statusCode: number; bodyData: string };

  return { req, res };
}

describe("createDashboardHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles OPTIONS preflight", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("OPTIONS", "/clawforce/api/test/agents");
    await handler(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });

  it("routes GET /clawforce/api/:domain/agents to queryAgents", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(queryAgents).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain to dashboard summary", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project");
    await handler(req, res);
    expect(queryDashboardSummary).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/dashboard to dashboard summary", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/dashboard");
    await handler(req, res);
    expect(queryDashboardSummary).toHaveBeenCalledWith("test-project");
  });

  it("routes POST /clawforce/api/:domain/approvals/p1/approve to action handler", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/approvals/p1/approve", {});
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "approvals/p1/approve", {});
  });

  it("routes GET /clawforce/api/sse?domain=test-project to SSE handler", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/sse?domain=test-project");
    await handler(req, res);
    expect(getSSEManager).toHaveBeenCalled();
  });

  it("returns 400 for SSE without domain", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/sse");
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("routes GET /clawforce/api/:domain/budget to budget status", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/budget");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/budget/forecast to budget forecast", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/budget/forecast");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/trust to trust scores", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/trust");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/config to queryConfig", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/config");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/approvals to queryApprovals", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/approvals?status=pending");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/meetings to queryMeetings", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/meetings");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown resource", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/unknown");
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for non-clawforce path when no static dir", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce");
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("sets CORS headers", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
  });
});
