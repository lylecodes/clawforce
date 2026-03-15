/**
 * Clawforce — Gateway route handler
 *
 * Single HTTP handler registered via api.registerHttpRoute({ path: "/clawforce", match: "prefix" })
 * that dispatches all /clawforce/* requests to:
 *   - SSE endpoint:  GET /clawforce/api/sse?domain=<id>
 *   - REST reads:    GET /clawforce/api/:domain/:resource
 *   - REST actions:  POST /clawforce/api/:domain/:resource/:action
 *   - Static files:  GET /clawforce/* -> dashboard/dist/
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleAction, handleDemoCreate } from "./actions.js";
import { getSSEManager } from "./sse.js";
import {
  queryAgents,
  queryAgentDetail,
  queryTasks,
  queryTaskDetail,
  queryCosts,
  queryGoals,
  queryGoalDetail,
  queryOrgChart,
  queryMessages,
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryConfig,
  queryMeetings,
  queryMeetingDetail,
  queryHealth,
  querySlos,
  queryAlerts,
  queryEvents,
  querySessions,
  queryMetricsDashboard,
  queryPolicies,
  queryProtocols,
} from "./queries.js";
import type { RouteResult } from "./routes.js";
import type { TaskState, TaskPriority, EventStatus, MessageType, MessageStatus, ProtocolStatus, GoalStatus } from "../types.js";

export type DashboardHandlerOptions = {
  /** Absolute path to dashboard/dist/ for static files */
  staticDir?: string;
  /** Function to inject a message into an agent session */
  injectAgentMessage?: (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
};

/**
 * Create the dashboard HTTP handler.
 * Returns a handler compatible with registerHttpRoute handler signature.
 */
export function createDashboardHandler(options: DashboardHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint: /clawforce/api/sse?domain=<id>
    if (url.pathname === "/clawforce/api/sse" && req.method === "GET") {
      const domain = url.searchParams.get("domain");
      if (!domain) {
        respondJson(res, 400, { error: "domain query parameter required" });
        return;
      }
      getSSEManager().addClient(domain, res);
      return;
    }

    // API routes: /clawforce/api/:domain/...
    if (url.pathname.startsWith("/clawforce/api/")) {
      // Handle non-domain-scoped endpoints first
      if (url.pathname === "/clawforce/api/demo/create" && req.method === "POST") {
        const result = handleDemoCreate();
        respondJson(res, result.status, result.body);
        return;
      }

      const apiPath = url.pathname.slice("/clawforce/api/".length);
      const slashIdx = apiPath.indexOf("/");
      const domain = slashIdx === -1 ? apiPath : apiPath.slice(0, slashIdx);
      const resource = slashIdx === -1 ? "" : apiPath.slice(slashIdx + 1);

      if (!domain) {
        respondJson(res, 400, { error: "domain is required in path" });
        return;
      }

      if (req.method === "POST") {
        const body = await parseBody(req);
        const result = handleAction(domain, resource, body);
        respondJson(res, result.status, result.body);
        return;
      }

      // GET — route to appropriate query function
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) params[k] = v;

      const result = routeRead(domain, resource, params);
      respondJson(res, result.status, result.body);
      return;
    }

    // Static files: /clawforce/* -> serve from dashboard/dist/
    if (options.staticDir) {
      const served = serveStatic(url.pathname, options.staticDir, res);
      if (served) return;
    }

    // SPA fallback for /clawforce paths — serve index.html if it exists
    if (options.staticDir) {
      const indexPath = path.join(options.staticDir, "index.html");
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": content.byteLength });
        res.end(content);
        return;
      }
    }

    respondJson(res, 404, { error: "Not found" });
  };
}

/**
 * Route GET requests to the appropriate query function.
 */
function routeRead(
  domain: string,
  resource: string,
  params: Record<string, string>,
): RouteResult {
  const segments = resource.split("/").filter(Boolean);
  const topResource = segments[0] ?? "";

  switch (topResource) {
    case "": // GET /clawforce/api/:domain — project overview
    case "dashboard":
      return ok(queryDashboardSummary(domain));

    case "agents": {
      if (segments[1]) {
        const detail = queryAgentDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Agent not found");
      }
      return ok(queryAgents(domain));
    }

    case "tasks": {
      if (segments[1]) {
        const detail = queryTaskDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Task not found");
      }
      const stateParam = params.state;
      const states = stateParam ? stateParam.split(",") as TaskState[] : undefined;
      return ok(queryTasks(domain, {
        state: states && states.length === 1 ? states[0] : states as any,
        assignedTo: params.assignee,
        priority: params.priority as TaskPriority | undefined,
        department: params.department,
        team: params.team,
      }, {
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));
    }

    case "approvals":
      return ok(queryApprovals(domain, {
        status: params.status as "pending" | "approved" | "rejected" | undefined,
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));

    case "messages":
      return ok(queryMessages(domain, {
        agentId: params.agent,
        type: params.type as MessageType | undefined,
        status: params.status as MessageStatus | undefined,
        since: params.since ? parseInt(params.since, 10) : undefined,
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));

    case "meetings": {
      if (segments[1]) {
        const detail = queryMeetingDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Meeting not found");
      }
      return ok(queryMeetings(domain, {
        status: params.status,
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));
    }

    case "budget":
      if (segments[1] === "forecast") {
        return ok(queryBudgetForecast(domain));
      }
      return ok(queryBudgetStatus(domain));

    case "trust":
      return ok(queryTrustScores(domain));

    case "costs":
      return ok(queryCosts(domain, {
        agentId: params.agent,
        taskId: params.task,
        since: params.since ? parseInt(params.since, 10) : undefined,
        until: params.until ? parseInt(params.until, 10) : undefined,
      }));

    case "goals": {
      if (segments[1]) {
        const detail = queryGoalDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Goal not found");
      }
      return ok(queryGoals(domain, {
        status: params.status as GoalStatus | undefined,
        ownerAgentId: params.owner,
        parentGoalId: params.parent === "none" ? null : params.parent,
      }, {
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));
    }

    case "config":
      return ok(queryConfig(domain));

    case "org":
      return ok(queryOrgChart(domain));

    case "health":
      return ok(queryHealth(domain));

    case "slos":
      return ok(querySlos(domain));

    case "alerts":
      return ok(queryAlerts(domain));

    case "events":
      return ok(queryEvents(domain, {
        status: params.status as EventStatus | undefined,
        type: params.type,
      }, {
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));

    case "sessions":
      return ok(querySessions(domain, {
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));

    case "metrics":
      return ok(queryMetricsDashboard(domain, {
        type: params.type,
        key: params.key,
        window: params.window ? parseInt(params.window, 10) : undefined,
      }));

    case "policies":
      return ok(queryPolicies(domain));

    case "protocols":
      return ok(queryProtocols(domain, {
        agentId: params.agent,
        type: params.type as MessageType | undefined,
        protocolStatus: params.status as ProtocolStatus | undefined,
        limit: params.limit ? parseInt(params.limit, 10) : undefined,
      }));

    default:
      return notFound(`Unknown resource: ${topResource}`);
  }
}

// --- Static file serving ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveStatic(
  pathname: string,
  staticDir: string,
  res: ServerResponse,
): boolean {
  // Strip /clawforce/ prefix to get relative path
  const relativePath = pathname.replace(/^\/clawforce\/?/, "") || "index.html";
  const filePath = path.join(staticDir, relativePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(staticDir)) {
    return false;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": content.byteLength,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(content);
  return true;
}

// --- Helpers ---

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: { error: message } };
}
