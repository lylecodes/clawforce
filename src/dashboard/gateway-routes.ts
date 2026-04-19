/**
 * Clawforce — Gateway route handler
 *
 * Single HTTP handler registered via api.registerHttpRoute({ path: "/clawforce", match: "prefix" })
 * that dispatches all /clawforce/* requests to:
 *   - SSE endpoint:  GET /clawforce/api/sse?domain=<id>
 *   - REST reads:    GET /clawforce/api/:domain/:resource
 *   - REST actions:  POST /clawforce/api/:domain/:resource/:action
 *   - Static files:  GET /clawforce/* -> clawforce-dashboard/dist/
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  handleAction,
  handleDemoCreate,
  handleStarterDomainCreate,
  handleAgentKillAction,
  handleDomainKillAction,
} from "./actions.js";
import { getSSEManager } from "./sse.js";
import { checkAuth, setCorsHeaders, setSecurityHeaders, checkRateLimit } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import {
  routeGatewayDomainRead,
} from "../app/queries/dashboard-read-router.js";
import {
  queryActiveAttentionRollup,
  queryActiveDecisionInboxRollup,
  queryActiveDomains,
  queryDashboardExtensions,
  queryDashboardRuntimeMetadata,
} from "../app/queries/dashboard-meta.js";
import {
  runDismissNotificationCommand,
  runMarkAllNotificationsReadCommand,
  runMarkNotificationReadCommand,
} from "../app/commands/notification-controls.js";
import { runWriteProjectContextFileCommand } from "../app/commands/project-controls.js";
import type { RouteResult } from "./routes.js";
import type { DashboardRuntimeResponse } from "../api/contract.js";
import { runDeliverOperatorMessageCommand } from "../app/commands/operator-messages.js";

export type DashboardHandlerOptions = {
  /** Absolute path to dashboard dist directory for static files */
  staticDir?: string;
  /** Function to inject a message into an agent session */
  injectAgentMessage?: (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
  /** Authentication options. When used inside a gateway plugin, set skipAuth=true to let the gateway handle auth. */
  auth?: AuthOptions & { skipAuth?: boolean };
  /** Allowed CORS origins. Defaults to localhost-only. */
  allowedOrigins?: string[];
  /**
   * Runtime mode — who owns the process and auth lifecycle.
   *   "embedded"   — running inside an OpenClaw gateway plugin; OpenClaw owns auth.
   *   "standalone" — running as a dedicated HTTP server; ClawForce owns auth.
   * Defaults to "embedded" when skipAuth=true, "standalone" otherwise.
   */
  runtimeMode?: "embedded" | "standalone";
  /** Runtime metadata so the dashboard can explain whether OpenClaw or standalone auth is in effect. */
  runtime?: DashboardRuntimeResponse;
};

function respondTextEventStream(
  res: ServerResponse,
  content: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ content })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Create the dashboard HTTP handler.
 * Returns a handler compatible with registerHttpRoute handler signature.
 */
export function createDashboardHandler(options: DashboardHandlerOptions) {
  const runtimeMode = options.runtimeMode
    ?? (options.auth?.skipAuth ? "embedded" : "standalone");

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // CORS — origin-validated (localhost by default, configurable)
    setCorsHeaders(req, res, options.allowedOrigins);
    setSecurityHeaders(res);

    // Identify runtime mode on every response so the SPA can adapt
    res.setHeader("X-ClawForce-Runtime", runtimeMode);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Determine if we need to apply auth / rate-limiting.
    // Static file serving (non-API) is exempt from auth.
    const isApiRequest = url.pathname.startsWith("/clawforce/api/");

    if (isApiRequest && !options.auth?.skipAuth) {
      // Rate limit check
      if (!checkRateLimit(req, res)) return;

      // Auth check
      if (!checkAuth(req, res, options.auth ?? {})) return;
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
      if (url.pathname === "/clawforce/api/domains" && req.method === "GET") {
        respondJson(res, 200, queryActiveDomains());
        return;
      }
      if (url.pathname === "/clawforce/api/extensions" && req.method === "GET") {
        respondJson(res, 200, queryDashboardExtensions());
        return;
      }
      if (url.pathname === "/clawforce/api/runtime" && req.method === "GET") {
        respondJson(res, 200, queryDashboardRuntimeMetadata(options.runtime));
        return;
      }
      if (url.pathname === "/clawforce/api/demo/create" && req.method === "POST") {
        const result = handleDemoCreate();
        respondJson(res, result.status, result.body);
        return;
      }
      if (url.pathname === "/clawforce/api/domains/create" && req.method === "POST") {
        const body = await parseBody(req);
        const result = handleStarterDomainCreate(body);
        respondJson(res, result.status, result.body);
        return;
      }
      if (url.pathname === "/clawforce/api/attention" && req.method === "GET") {
        respondJson(res, 200, queryActiveAttentionRollup());
        return;
      }
      if (url.pathname === "/clawforce/api/feed" && req.method === "GET") {
        respondJson(res, 200, queryActiveAttentionRollup());
        return;
      }
      if ((url.pathname === "/clawforce/api/decision-inbox" || url.pathname === "/clawforce/api/decisions") && req.method === "GET") {
        respondJson(res, 200, queryActiveDecisionInboxRollup());
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

        // Assistant/widget messages expect an SSE response body.
        if (resource.match(/^agents\/[^/]+\/message$/)) {
          const agentId = resource.split("/")[1]!;
          const result = await runDeliverOperatorMessageCommand(
            domain,
            agentId,
            body,
            options.injectAgentMessage,
          );
          if (!result.ok) {
            respondJson(res, result.status, { error: result.error });
            return;
          }
          respondTextEventStream(
            res,
            result.acknowledgement,
          );
          return;
        }

        if (resource === "messages/operator") {
          const result = await runDeliverOperatorMessageCommand(
            domain,
            "clawforce-assistant",
            body,
            options.injectAgentMessage,
          );
          if (!result.ok) {
            respondJson(res, result.status, { error: result.error });
            return;
          }
          respondJson(res, result.status, {
            delivery: result.delivery,
            acknowledgement: result.acknowledgement,
            message: result.message,
          });
          return;
        }

        if (resource === "context-files") {
          const result = runWriteProjectContextFileCommand(domain, body, {
            includeDomainContext: true,
          });
          respondJson(res, result.status, result.body);
          return;
        }

        if (resource === "kill") {
          const result = await handleDomainKillAction(domain, body);
          respondJson(res, result.status, result.body);
          return;
        }

        if (resource.match(/^agents\/[^/]+\/kill$/)) {
          const agentId = resource.split("/")[1]!;
          const result = await handleAgentKillAction(domain, agentId, body);
          respondJson(res, result.status, result.body);
          return;
        }

        // Notification mutation endpoints
        if (resource === "notifications/read-all") {
          const result = runMarkAllNotificationsReadCommand(domain);
          respondJson(res, result.status, result.body);
          return;
        }

        const notifReadMatch = resource.match(/^notifications\/([^/]+)\/read$/);
        if (notifReadMatch) {
          const result = runMarkNotificationReadCommand(domain, notifReadMatch[1]!);
          respondJson(res, result.status, result.body);
          return;
        }

        const notifDismissMatch = resource.match(/^notifications\/([^/]+)\/dismiss$/);
        if (notifDismissMatch) {
          const result = runDismissNotificationCommand(domain, notifDismissMatch[1]!);
          respondJson(res, result.status, result.body);
          return;
        }

        const result = handleAction(domain, resource, body);
        respondJson(res, result.status, result.body);
        return;
      }

      // GET — route to appropriate query function
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) params[k] = v;

      const result = routeGatewayDomainRead(domain, resource, params);
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

  // Security: prevent path traversal — use path.resolve + separator boundary
  const resolvedFile = path.resolve(filePath);
  const resolvedBase = path.resolve(staticDir);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
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
