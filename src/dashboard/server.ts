/**
 * Clawforce — Dashboard HTTP server
 *
 * Lightweight Node.js http server with no external dependencies.
 * Configurable port, optional bearer token auth, CORS headers.
 */

import http from "node:http";
import { handleRequest } from "./routes.js";

export type DashboardOptions = {
  /** Port to listen on (default 3117). */
  port?: number;
  /** Optional bearer token for authentication. */
  token?: string;
  /** Allowed CORS origins (default "*"). */
  corsOrigin?: string;
  /** Hostname to bind (default "127.0.0.1"). */
  host?: string;
};

export function createDashboardServer(options?: DashboardOptions) {
  const port = options?.port ?? 3117;
  const host = options?.host ?? "127.0.0.1";
  const corsOrigin = options?.corsOrigin ?? "*";
  const token = options?.token;

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

    // Only GET and POST
    if (req.method !== "GET" && req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
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

    // Parse URL
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }

    const route = (body?: Record<string, unknown>) => {
      try {
        const result = handleRequest(pathname, params, req.method, body);
        respondJson(res, result.status, result.body);
      } catch (err) {
        respondJson(res, 500, {
          error: "Internal server error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const body = raw.length > 0 ? JSON.parse(raw) : {};
          route(body);
        } catch {
          respondJson(res, 400, { error: "Invalid JSON body" });
        }
      });
    } else {
      route();
    }
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
