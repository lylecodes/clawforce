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
  queryConfigVersions: vi.fn(() => ({ versions: [], count: 0 })),
  queryApprovals: vi.fn(() => ({ proposals: [], count: 0 })),
  queryBudgetStatus: vi.fn(() => ({ windows: [], alerts: [] })),
  queryBudgetForecast: vi.fn(() => ({ daily: null, weekly: null, monthly: null })),
  queryTrustScores: vi.fn(() => ({ agents: [], overrides: [] })),
  queryTrustHistory: vi.fn(() => ({ history: [] })),
  queryConfig: vi.fn(() => ({ agents: {} })),
  queryMeetings: vi.fn(() => ({ meetings: [], count: 0 })),
  queryMeetingDetail: vi.fn(() => null),
  queryThreadMessages: vi.fn(() => ({ messages: [] })),
  queryHealth: vi.fn(() => ({ tier: "GREEN" })),
  querySlos: vi.fn(() => ({ slos: [] })),
  queryAlerts: vi.fn(() => ({ alerts: [] })),
  queryEvents: vi.fn(() => ({ events: [], total: 0, count: 0, limit: 50, offset: 0 })),
  querySessions: vi.fn(() => ({ sessions: [], hasMore: false, count: 0 })),
  querySessionDetail: vi.fn((pid: string, sid: string) => sid === "s1" ? { id: "s1" } : null),
  queryMetricsDashboard: vi.fn(() => ({ metrics: [], count: 0 })),
  queryPolicies: vi.fn(() => ({ policies: [] })),
  queryProtocols: vi.fn(() => ({ protocols: [], count: 0 })),
  queryAuditLog: vi.fn(() => ({ entries: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryAuditRuns: vi.fn(() => ({ runs: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryEnforcementRetries: vi.fn(() => ({ retries: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryOnboardingState: vi.fn(() => ({ entries: [], count: 0 })),
  queryTrackedSessions: vi.fn(() => ({ sessions: [], total: 0, count: 0, limit: 50, offset: 0 })),
  queryWorkerAssignments: vi.fn(() => ({ assignments: [], count: 0 })),
  queryQueueStatus: vi.fn(() => ({ queue: [], pending: 0, processing: 0 })),
  queryKnowledge: vi.fn(() => ({ entries: [], count: 0 })),
  queryKnowledgeFlags: vi.fn(() => ({ flags: [], count: 0 })),
  queryPromotionCandidates: vi.fn(() => ({ candidates: [], count: 0 })),
  queryInterventions: vi.fn(() => ({ interventions: [], count: 0 })),
  queryWorkStreams: vi.fn(() => ({ workstreams: [], count: 0 })),
  queryUserInbox: vi.fn(() => ({ messages: [], count: 0 })),
  queryOperationalMetrics: vi.fn(() => ({ metrics: {} })),
  readContextFile: vi.fn((_root: string, relativePath: string) => ({
    content: `content for ${relativePath}`,
    path: relativePath,
    lastModified: 123,
  })),
  writeContextFile: vi.fn(() => ({ ok: true })),
  ContextFileError: class ContextFileError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../../src/dashboard/actions.js", () => ({
  handleAction: vi.fn(() => ({ status: 200, body: { ok: true } })),
  handleAgentKillAction: vi.fn(async () => ({ status: 200, body: { ok: true, killedSessions: 1 } })),
  handleDomainKillAction: vi.fn(async () => ({ status: 200, body: { ok: true, emergencyStop: true } })),
  handleDemoCreate: vi.fn(() => ({ status: 201, body: { ok: true } })),
  handleStarterDomainCreate: vi.fn(() => ({ status: 201, body: { ok: true, domainId: "starter-co" } })),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  getSSEManager: vi.fn(() => ({
    addClient: vi.fn(),
  })),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));

vi.mock("../../src/project.js", () => {
  const configs = new Map<string, any>([
    ["lead-root", { projectId: "test-project", projectDir: "/tmp/test-project", config: { title: "Root Lead", coordination: { enabled: true } } }],
    ["lead-child", { projectId: "test-project", projectDir: "/tmp/test-project", config: { title: "Child Lead", coordination: { enabled: true }, reports_to: "lead-root" } }],
    ["worker-1", { projectId: "test-project", projectDir: "/tmp/test-project", config: { title: "Worker", reports_to: "lead-root" } }],
  ]);
  return {
    getExtendedProjectConfig: vi.fn(() => null),
    getRegisteredAgentIds: vi.fn(() => [...configs.keys()]),
    getAgentConfig: vi.fn((id: string) => configs.get(id) ?? null),
  };
});

vi.mock("../../src/config/api-service.js", () => ({
  getDomainContextDir: vi.fn((projectId: string) => `/tmp/domain-context/${projectId}`),
  readDomainConfig: vi.fn(() => null),
}));

const { createDashboardHandler } = await import("../../src/dashboard/gateway-routes.js");
const {
  registerDashboardExtension,
  clearDashboardExtensions,
} = await import("../../src/dashboard/extensions.js");
const {
  queryAgents, queryDashboardSummary, querySessions, querySessionDetail,
  queryAuditLog, queryAuditRuns, queryEnforcementRetries,
  queryOnboardingState, queryTrackedSessions, queryWorkerAssignments,
  queryQueueStatus, queryKnowledge, queryKnowledgeFlags,
  queryPromotionCandidates, queryInterventions, queryWorkStreams,
  queryUserInbox, queryOperationalMetrics, queryTrustHistory, queryThreadMessages,
  queryConfigVersions,
  readContextFile, writeContextFile,
} = await import("../../src/dashboard/queries.js");
const {
  handleAction,
  handleStarterDomainCreate,
  handleAgentKillAction,
  handleDomainKillAction,
} = await import("../../src/dashboard/actions.js");
const { getSSEManager } = await import("../../src/dashboard/sse.js");
const { readDomainConfig } = await import("../../src/config/api-service.js");

function createMockRequest(method: string, urlStr: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>): {
  req: IncomingMessage;
  res: ServerResponse & { statusCode: number; bodyData: string };
} {
  const handlers: Record<string, Function[]> = {};
  const req = {
    method,
    url: urlStr,
    headers: { host: "localhost", ...extraHeaders },
    socket: { remoteAddress: "127.0.0.1" },
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
    clearDashboardExtensions();
    (readDomainConfig as any).mockReturnValue(null);
  });

  it("handles OPTIONS preflight", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("OPTIONS", "/clawforce/api/test/agents");
    await handler(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });

  it("routes GET /clawforce/api/:domain/agents to queryAgents", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(queryAgents).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain to dashboard summary", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project");
    await handler(req, res);
    expect(queryDashboardSummary).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/extensions to the extension registry", async () => {
    registerDashboardExtension({
      id: "clawforce-experiments",
      title: "Experiments",
      source: { kind: "openclaw-plugin", pluginId: "@clawforce/plugin-experiments" },
      pages: [{ id: "experiments", title: "Experiments", route: "/experiments" }],
    });

    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/extensions");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.bodyData)).toEqual({
      count: 1,
      extensions: [
        expect.objectContaining({
          id: "clawforce-experiments",
          title: "Experiments",
        }),
      ],
    });
  });

  it("routes GET /clawforce/api/runtime to runtime metadata", async () => {
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      runtime: {
        mode: "embedded",
        authMode: "openclaw-delegated",
      },
    });
    const { req, res } = createMockRequest("GET", "/clawforce/api/runtime");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.bodyData);
    expect(body.mode).toBe("embedded");
    expect(body.authMode).toBe("openclaw-delegated");
  });

  it("routes GET /clawforce/api/:domain/dashboard to dashboard summary", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/dashboard");
    await handler(req, res);
    expect(queryDashboardSummary).toHaveBeenCalledWith("test-project");
  });

  it("routes POST /clawforce/api/:domain/approvals/p1/approve to action handler", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/approvals/p1/approve", {});
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "approvals/p1/approve", {});
  });

  it("routes POST /clawforce/api/domains/create to the starter domain handler", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const body = { domainId: "starter-co", mode: "new" };
    const { req, res } = createMockRequest("POST", "/clawforce/api/domains/create", body);
    await handler(req, res);
    expect(handleStarterDomainCreate).toHaveBeenCalledWith(body);
    expect(res.statusCode).toBe(201);
  });

  it("routes POST /clawforce/api/:domain/kill to the async domain kill handler", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/kill", { reason: "panic" });
    await handler(req, res);
    expect(handleDomainKillAction).toHaveBeenCalledWith("test-project", { reason: "panic" });
    expect(res.statusCode).toBe(200);
  });

  it("routes POST /clawforce/api/:domain/agents/:id/kill to the async agent kill handler", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/a1/kill", { reason: "panic" });
    await handler(req, res);
    expect(handleAgentKillAction).toHaveBeenCalledWith("test-project", "a1", { reason: "panic" });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/sse?domain=test-project to SSE handler", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/sse?domain=test-project");
    await handler(req, res);
    expect(getSSEManager).toHaveBeenCalled();
  });

  it("returns 400 for SSE without domain", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/sse");
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("routes GET /clawforce/api/:domain/sessions with pagination", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/sessions?limit=25&offset=10");
    await handler(req, res);
    expect(querySessions).toHaveBeenCalledWith("test-project", { agentId: undefined }, { limit: 25, offset: 10 });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/budget to budget status", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/budget");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/budget/forecast to budget forecast", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/budget/forecast");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/trust to trust scores", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/trust");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/config to queryConfig", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/config");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/config/versions to config version history", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/config/versions?limit=25");
    await handler(req, res);
    expect(queryConfigVersions).toHaveBeenCalledWith("test-project", 25);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/config-versions to the legacy config version history alias", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/config-versions?limit=10");
    await handler(req, res);
    expect(queryConfigVersions).toHaveBeenCalledWith("test-project", 10);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/context-files to the context file reader", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/context-files?path=DIRECTION.md");
    await handler(req, res);
    expect(readContextFile).toHaveBeenCalledWith("/tmp/test-project", "DIRECTION.md");
    expect(res.statusCode).toBe(200);
  });

  it("routes POST /clawforce/api/:domain/context-files to the context file writer", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/context-files", {
      path: "DIRECTION.md",
      content: "# direction",
    });
    await handler(req, res);
    expect(writeContextFile).toHaveBeenCalledWith("/tmp/test-project", "DIRECTION.md", "# direction");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/approvals to queryApprovals", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/approvals?status=pending");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/meetings to queryMeetings", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/meetings");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/audit-log to queryAuditLog", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/audit-log?limit=25&offset=0");
    await handler(req, res);
    expect(queryAuditLog).toHaveBeenCalledWith("test-project", { actor: undefined, action: undefined, targetType: undefined }, { limit: 25, offset: 0 });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/audit-runs to queryAuditRuns", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/audit-runs?agent=bot1");
    await handler(req, res);
    expect(queryAuditRuns).toHaveBeenCalledWith("test-project", { agentId: "bot1", status: undefined }, { limit: undefined, offset: undefined });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/enforcement-retries to queryEnforcementRetries", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/enforcement-retries");
    await handler(req, res);
    expect(queryEnforcementRetries).toHaveBeenCalledWith("test-project", { agentId: undefined }, { limit: undefined, offset: undefined });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/onboarding to queryOnboardingState", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/onboarding");
    await handler(req, res);
    expect(queryOnboardingState).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/tracked-sessions to queryTrackedSessions", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/tracked-sessions");
    await handler(req, res);
    expect(queryTrackedSessions).toHaveBeenCalledWith("test-project", { limit: undefined, offset: undefined });
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/worker-assignments to queryWorkerAssignments", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/worker-assignments");
    await handler(req, res);
    expect(queryWorkerAssignments).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown resource", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/unknown");
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for non-clawforce path when no static dir", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce");
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("streams an agent message acknowledgement when live injection is configured", async () => {
    const injectAgentMessage = vi.fn(async () => ({}));
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      injectAgentMessage,
    });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/a1/message", {
      content: "hello",
    });
    await handler(req, res);
    expect(injectAgentMessage).toHaveBeenCalledWith({
      sessionKey: "agent:a1:main",
      message: "hello",
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
  });

  it("routes assistant messages to the default lead when no live session is wired", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/clawforce-assistant/message", {
      content: "please review the org",
    });
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "messages/send", expect.objectContaining({
      to: "lead-root",
      content: "please review the org",
    }));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
  });

  it("routes assistant messages to the configured dashboard assistant target", async () => {
    (readDomainConfig as any).mockReturnValueOnce({
      domain: "test-project",
      dashboard_assistant: { agentId: "lead-child" },
    });
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/clawforce-assistant/message", {
      content: "review the roadmap",
    });
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "messages/send", expect.objectContaining({
      to: "lead-child",
      content: "review the roadmap",
    }));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
    expect(res.bodyData).toContain("configured assistant target");
  });

  it("injects assistant messages into the configured assistant target session", async () => {
    (readDomainConfig as any).mockReturnValueOnce({
      domain: "test-project",
      dashboard_assistant: { agentId: "lead-child" },
    });
    const injectAgentMessage = vi.fn(async () => ({}));
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      injectAgentMessage,
    });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/clawforce-assistant/message", {
      content: "check staffing",
    });
    await handler(req, res);
    expect(injectAgentMessage).toHaveBeenCalledWith({
      sessionKey: "agent:lead-child:main",
      message: "check staffing",
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
  });

  it("supports @mentions inside the assistant route itself", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/clawforce-assistant/message", {
      content: "@lead-child focus on auth",
    });
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "messages/send", expect.objectContaining({
      to: "lead-child",
      content: "focus on auth",
    }));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
  });

  it("reports when the dashboard assistant is disabled for a domain", async () => {
    (readDomainConfig as any).mockReturnValueOnce({
      domain: "test-project",
      dashboard_assistant: { enabled: false },
    });
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/clawforce-assistant/message", {
      content: "help me",
    });
    await handler(req, res);
    expect(handleAction).not.toHaveBeenCalledWith("test-project", "messages/send", expect.anything());
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
    expect(res.bodyData).toContain("dashboard assistant is disabled");
  });

  it("falls back to stored delivery when live agent injection fails", async () => {
    const injectAgentMessage = vi.fn(async () => {
      throw new Error("session offline");
    });
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      injectAgentMessage,
    });
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/agents/worker-1/message", {
      content: "check task t1",
    });
    await handler(req, res);
    expect(handleAction).toHaveBeenCalledWith("test-project", "messages/send", expect.objectContaining({
      to: "worker-1",
      content: "check task t1",
    }));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
    }));
  });

  it("sets CORS method and header headers", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Headers", "Authorization, Content-Type");
  });

  it("reflects localhost origin in CORS", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents", undefined, { origin: "http://localhost:5173" });
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "http://localhost:5173");
  });

  it("does not set CORS Allow-Origin for external origins", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents", undefined, { origin: "https://evil.com" });
    await handler(req, res);
    // Should not have set Allow-Origin for evil.com
    const setHeaderCalls = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls;
    const originCalls = setHeaderCalls.filter((c: unknown[]) => c[0] === "Access-Control-Allow-Origin");
    expect(originCalls).toHaveLength(0);
  });

  it("sets baseline security headers", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(res.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(res.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
    expect(res.setHeader).toHaveBeenCalledWith("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  it("allows configured CORS origins", async () => {
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      allowedOrigins: ["https://my-app.example.com"],
    });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents", undefined, { origin: "https://my-app.example.com" });
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "https://my-app.example.com");
  });

  it("enforces auth when not skipped — rejects non-localhost without token", async () => {
    const handler = createDashboardHandler({});
    const handlers: Record<string, Function[]> = {};
    const req = {
      method: "GET",
      url: "/clawforce/api/test-project/agents",
      headers: { host: "localhost" },
      socket: { remoteAddress: "192.168.1.50" },
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event]!.push(handler);
        return req;
      },
    } as unknown as IncomingMessage;
    const { res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("enforces auth when not skipped — allows with valid token", async () => {
    const handler = createDashboardHandler({ auth: { token: "mytoken" } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents", undefined, { authorization: "Bearer mytoken" });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  // --- Runtime mode ---

  it("GET /clawforce/api/runtime returns provided runtime metadata", async () => {
    const handler = createDashboardHandler({
      auth: { skipAuth: true },
      runtime: { mode: "embedded", authMode: "openclaw-delegated" },
    });
    const { req, res } = createMockRequest("GET", "/clawforce/api/runtime");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.bodyData);
    expect(body.mode).toBe("embedded");
    expect(body.authMode).toBe("openclaw-delegated");
  });

  it("GET /clawforce/api/runtime returns standalone fallback when no runtime provided", async () => {
    const handler = createDashboardHandler({ auth: { token: "tok" } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/runtime", undefined, { authorization: "Bearer tok" });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.bodyData);
    expect(body.mode).toBe("standalone");
    expect(body.authMode).toBe("localhost-only");
  });

  it("sets X-ClawForce-Runtime header on all responses (embedded)", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("X-ClawForce-Runtime", "embedded");
  });

  it("sets X-ClawForce-Runtime header on all responses (standalone)", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: false, token: "tok" } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents", undefined, { authorization: "Bearer tok" });
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("X-ClawForce-Runtime", "standalone");
  });

  it("sets X-ClawForce-Runtime header on OPTIONS preflight", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("OPTIONS", "/clawforce/api/test-project/agents");
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("X-ClawForce-Runtime", "embedded");
  });

  // --- Previously untested routes ---

  it("routes GET /clawforce/api/:domain/trust/history to queryTrustHistory", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/trust/history");
    await handler(req, res);
    expect(queryTrustHistory).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/messages/:threadId to queryThreadMessages", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/messages/thread-1");
    await handler(req, res);
    expect(queryThreadMessages).toHaveBeenCalledWith("test-project", "thread-1", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/sessions/:sessionId to querySessionDetail", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/sessions/s1");
    await handler(req, res);
    expect(querySessionDetail).toHaveBeenCalledWith("test-project", "s1");
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown session", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/sessions/no-such-session");
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("routes GET /clawforce/api/:domain/queue to queryQueueStatus", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/queue");
    await handler(req, res);
    expect(queryQueueStatus).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/knowledge to queryKnowledge", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/knowledge");
    await handler(req, res);
    expect(queryKnowledge).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/knowledge-flags to queryKnowledgeFlags", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/knowledge-flags");
    await handler(req, res);
    expect(queryKnowledgeFlags).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/promotion-candidates to queryPromotionCandidates", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/promotion-candidates");
    await handler(req, res);
    expect(queryPromotionCandidates).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/interventions to queryInterventions", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/interventions");
    await handler(req, res);
    expect(queryInterventions).toHaveBeenCalledWith("test-project");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/workstreams to queryWorkStreams", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/workstreams");
    await handler(req, res);
    expect(queryWorkStreams).toHaveBeenCalledWith("test-project", undefined);
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/workstreams/:leadId to queryWorkStreams with leadId", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/workstreams/lead-1");
    await handler(req, res);
    expect(queryWorkStreams).toHaveBeenCalledWith("test-project", "lead-1");
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/inbox to queryUserInbox", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/inbox");
    await handler(req, res);
    expect(queryUserInbox).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });

  it("routes GET /clawforce/api/:domain/operational-metrics to queryOperationalMetrics", async () => {
    const handler = createDashboardHandler({ auth: { skipAuth: true } });
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/operational-metrics");
    await handler(req, res);
    expect(queryOperationalMetrics).toHaveBeenCalledWith("test-project", expect.any(Object));
    expect(res.statusCode).toBe(200);
  });
});
