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

export type DashboardOptions = {
  /** Port to listen on (default 3117). */
  port?: number;
  /** Optional bearer token for authentication. */
  token?: string;
  /** Allowed CORS origins (default "*"). */
  corsOrigin?: string;
  /** Hostname to bind (default "127.0.0.1"). */
  host?: string;
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
  const port = options?.port ?? 3117;
  const host = options?.host ?? "127.0.0.1";
  const corsOrigin = options?.corsOrigin ?? "*";
  const token = options?.token;

  // Resolve static dir — dashboard/dist/ relative to this file's location
  // This file lives at src/dashboard/server.ts, so ../../dashboard/dist
  const staticDir = path.resolve(import.meta.dirname, "../../dashboard/dist");

  // Create the gateway-routes handler for /api/* requests.
  // The gateway-routes handler expects paths prefixed with /clawforce/api/,
  // so we'll rewrite /api/* → /clawforce/api/* before delegating.
  const gatewayHandler = createDashboardHandler({
    staticDir,
    injectAgentMessage: options?.injectAgentMessage,
  });

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    // Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (token) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${token}`) {
        respondJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // --- API routes: /api/* → delegate to gateway handler ---
    if (pathname.startsWith("/api/") || pathname === "/api") {
      // Rewrite the URL to add /clawforce prefix so gateway-routes can parse it
      req.url = `/clawforce${req.url}`;
      gatewayHandler(req, res);
      return;
    }

    // --- Static files ---
    if (req.method !== "GET") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Try to serve a static file from dashboard/dist/
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
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
      const isAsset = pathname.startsWith("/assets/");
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
