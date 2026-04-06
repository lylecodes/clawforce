import { describe, expect, it, vi, afterAll, beforeEach } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { resetRateLimits } from "../../src/dashboard/auth.js";

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));

// Mock gateway-routes handler so we don't need a real database
vi.mock("../../src/dashboard/gateway-routes.js", () => ({
  createDashboardHandler: vi.fn(() => {
    return (req: { url?: string; method?: string }, res: { writeHead: (s: number, h?: Record<string, unknown>) => void; end: (d?: string) => void; setHeader: (k: string, v: string) => void }) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Rewrite: the server rewrites /api/* → /clawforce/api/*
      const pathname = url.pathname.replace("/clawforce", "");

      if (pathname === "/api/health") {
        const json = JSON.stringify({ tier: "GREEN" });
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(json)) });
        res.end(json);
        return;
      }
      if (pathname === "/api/error") {
        throw new Error("mock error");
      }
      const json = JSON.stringify({ error: "Not found" });
      res.writeHead(404, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(json)) });
      res.end(json);
    };
  }),
}));

function fetch(url: string, opts?: RequestInit) {
  return globalThis.fetch(url, opts);
}

describe("createDashboardServer", () => {
  const instances: Array<{ stop(): Promise<void> }> = [];

  beforeEach(() => {
    resetRateLimits();
  });

  afterAll(async () => {
    resetRateLimits();
    for (const inst of instances) {
      await inst.stop();
    }
  });

  async function startServer(opts?: Parameters<typeof createDashboardServer>[0]) {
    const inst = createDashboardServer(opts);
    instances.push(inst);
    await inst.start();
    const addr = inst.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { inst, port };
  }

  it("starts and responds to GET requests", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe("GREEN");
  });

  it("sets CORS headers for localhost origin", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(`http://127.0.0.1:${port}`);
  });

  it("sets baseline security headers on API responses", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("sets CORS headers for configured origin", async () => {
    const { port } = await startServer({ port: 0, corsOrigin: "https://example.com" });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("rejects non-configured CORS origins", async () => {
    const { port } = await startServer({ port: 0, corsOrigin: "https://example.com" });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("handles OPTIONS preflight", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("rejects unsupported methods on static paths", async () => {
    const { port } = await startServer({ port: 0 });
    // PUT on a non-API path → 405 (static file handler only allows GET)
    const res = await fetch(`http://127.0.0.1:${port}/some-page`, { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("enforces bearer token auth", async () => {
    const { port } = await startServer({ port: 0, token: "secret123" });

    // No token → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(noAuth.status).toBe(401);

    // Wrong token → 401
    const wrongAuth = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(wrongAuth.status).toBe(401);

    // Correct token → 200
    const goodAuth = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(goodAuth.status).toBe(200);
  });

  it("returns 500 on route handler error without leaking details", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/error`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    // Should NOT include the detailed error message
    expect(body.message).toBeUndefined();
  });

  it("refuses to start on non-localhost without token", () => {
    expect(() => createDashboardServer({ port: 0, host: "0.0.0.0" })).toThrow(
      /Refusing to start.*without authentication/
    );
  });

  it("starts on non-localhost with token", async () => {
    const { port, inst } = await startServer({ port: 0, host: "0.0.0.0", token: "test-token" });
    expect(port).toBeGreaterThan(0);
    await inst.stop();
  });

  it("stops cleanly", async () => {
    const inst = createDashboardServer({ port: 0 });
    await inst.start();
    await inst.stop();
    // Server should no longer accept connections
    const addr = inst.server.address();
    expect(addr).toBeNull();
  });

  it("sets X-Content-Type-Options: nosniff on all responses", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY on all responses", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets X-ClawForce-Runtime: standalone on all responses", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.headers.get("x-clawforce-runtime")).toBe("standalone");
  });

  it("sets X-ClawForce-Runtime: standalone on OPTIONS preflight", async () => {
    const { port } = await startServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "OPTIONS" });
    expect(res.headers.get("x-clawforce-runtime")).toBe("standalone");
  });
});
