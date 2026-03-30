/**
 * Clawforce — Dashboard HTTP server (standalone)
 *
 * Serves BOTH the React SPA static files AND the API routes from a single
 * Node.js HTTP server on a dedicated port (default 3117).
 *
 * Request routing:
 *   /api/*  → gateway-routes handler (SSE, REST reads, REST actions)
 *   /*      → static files from dashboard/dist/ with SPA fallback
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleRequest } from "./routes.js";
import { createDashboardHandler } from "./gateway-routes.js";
import type { DashboardHandlerOptions } from "./gateway-routes.js";
import { checkAuth, setCorsHeaders, checkRateLimit, isLocalhost } from "./auth.js";
import { safeLog } from "../diagnostics.js";

export type DashboardOptions = {
  /** Port to listen on (default 3117). */
  port?: number;
  /** Optional bearer token for authentication. */
  token?: string;
  /** Comma-separated allowed CORS origins (default: localhost only). Also configurable via CLAWFORCE_CORS_ORIGINS env var. */
  corsOrigin?: string;
  /** Hostname to bind (default "127.0.0.1"). */
  host?: string;
  /**
   * Absolute path to the dashboard dist directory containing the built SPA.
   * Defaults to `../clawforce-dashboard/dist` (sibling project).
   * Override to point at a custom dashboard build output.
   */
  dashboardDir?: string;
  /** Function to inject a message into an agent session */
  injectAgentMessage?: DashboardHandlerOptions["injectAgentMessage"];
};

// --- MIME types ---

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

export function createDashboardServer(options?: DashboardOptions) {
  const port = options?.port
    ?? (process.env.CLAWFORCE_DASHBOARD_PORT ? Number(process.env.CLAWFORCE_DASHBOARD_PORT) : 3117);
  const host = options?.host
    ?? process.env.CLAWFORCE_DASHBOARD_HOST
    ?? "127.0.0.1";
  const token = options?.token ?? process.env.CLAWFORCE_DASHBOARD_TOKEN;
  const allowedOrigins = options?.corsOrigin
    ? options.corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
    : undefined;

  // Security check: refuse to start on non-localhost without a token
  if (!token && !isLocalhost(host)) {
    throw new Error(
      `Refusing to start dashboard server on non-localhost host "${host}" without authentication. ` +
      `Set CLAWFORCE_DASHBOARD_TOKEN or pass options.token to enable auth.`
    );
  }
  if (!token && isLocalhost(host)) {
    console.warn("[clawforce-dashboard] WARNING: Starting without authentication on localhost. Set CLAWFORCE_DASHBOARD_TOKEN for production use.");
  }

  // Resolve static dir — use the provided dashboardDir or look for
  // clawforce-dashboard/dist as a sibling project (the extracted dashboard repo)
  const candidates = [
    path.resolve(import.meta.dirname, "../../../clawforce-dashboard/dist"),
    // Sibling project when running from source (adapters/ or src/)
    path.resolve(import.meta.dirname, "../../clawforce-dashboard/dist"),
  ];
  const defaultDir = candidates.find(d => fs.existsSync(d)) ?? candidates[0]!;
  const staticDir = options?.dashboardDir ?? defaultDir;

  // Create the gateway-routes handler for /api/* requests.
  // The gateway-routes handler expects paths prefixed with /clawforce/api/,
  // so we'll rewrite /api/* → /clawforce/api/* before delegating.
  // Auth is handled at this server layer, so skip it in the gateway handler.
  const gatewayHandler = createDashboardHandler({
    staticDir,
    injectAgentMessage: options?.injectAgentMessage,
    auth: { token, skipAuth: true },
    allowedOrigins,
  });

  const server = http.createServer(async (req, res) => {
    // CORS — origin-validated
    setCorsHeaders(req, res, allowedOrigins);

    // Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const isApi = pathname.startsWith("/clawforce/api/") || pathname === "/clawforce/api"
      || pathname.startsWith("/api/") || pathname === "/api";

    // Auth & rate limiting for API requests only (static files are exempt)
    if (isApi) {
      if (!checkRateLimit(req, res)) return;
      if (!checkAuth(req, res, { token })) return;
    }

    // --- API routes: /clawforce/api/* or /api/* → delegate to gateway handler ---
    if (pathname.startsWith("/clawforce/api/") || pathname === "/clawforce/api") {
      // Already has /clawforce prefix — pass through directly
      try {
        await gatewayHandler(req, res);
      } catch (err) {
        safeLog("dashboard-server", err);
        if (!res.headersSent) {
          respondJson(res, 500, { error: "Internal server error" });
        }
      }
      return;
    }

    if (pathname.startsWith("/api/") || pathname === "/api") {
      // Legacy: rewrite /api/* → /clawforce/api/* for backward compat
      req.url = `/clawforce${req.url}`;
      try {
        await gatewayHandler(req, res);
      } catch (err) {
        safeLog("dashboard-server", err);
        if (!res.headersSent) {
          respondJson(res, 500, { error: "Internal server error" });
        }
      }
      return;
    }

    // --- Static files ---
    if (req.method !== "GET") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Try to serve a static file from dashboard/dist/
    // Strip /clawforce/ prefix since the SPA is built with base="/clawforce/"
    const stripped = pathname.replace(/^\/clawforce\/?/, "/");
    const relativePath = stripped === "/" ? "index.html" : stripped.slice(1);
    const filePath = path.join(staticDir, relativePath);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(staticDir)) {
      respondJson(res, 403, { error: "Forbidden" });
      return;
    }

    if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
      const ext = path.extname(resolved);
      const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = fs.readFileSync(resolved);

      // Assets get long cache, everything else no-cache
      const isAsset = stripped.startsWith("/assets/");
      const cacheControl = isAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache";

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": content.byteLength,
        "Cache-Control": cacheControl,
      });
      res.end(content);
      return;
    }

    // SPA fallback: serve index.html for non-asset paths
    const indexPath = path.join(staticDir, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": content.byteLength,
        "Cache-Control": "no-cache",
      });
      res.end(content);
      return;
    }

    respondJson(res, 404, { error: "Not found" });
  });

  return {
    server,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once("error", reject);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}
