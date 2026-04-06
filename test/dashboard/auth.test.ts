import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  checkAuth,
  setCorsHeaders,
  checkRateLimit,
  resetRateLimits,
  isLocalhost,
  getRemoteIp,
  getRateLimitMap,
} from "../../src/dashboard/auth.js";

// Mock diagnostics to avoid side effects
vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReq(overrides?: {
  remoteAddress?: string;
  authorization?: string;
  origin?: string;
}): IncomingMessage {
  return {
    headers: {
      ...(overrides?.authorization ? { authorization: overrides.authorization } : {}),
      ...(overrides?.origin ? { origin: overrides.origin } : {}),
    },
    socket: {
      remoteAddress: overrides?.remoteAddress ?? "127.0.0.1",
    } as Socket,
  } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & {
  statusCode: number;
  bodyData: string;
  _headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const resData = { statusCode: 0, bodyData: "", headersSent: false };

  return {
    get statusCode() { return resData.statusCode; },
    set statusCode(v: number) { resData.statusCode = v; },
    get bodyData() { return resData.bodyData; },
    get headersSent() { return resData.headersSent; },
    get _headers() { return headers; },
    setHeader: vi.fn((key: string, val: string) => { headers[key.toLowerCase()] = val; }),
    writeHead: vi.fn((status: number) => {
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
  } as unknown as ServerResponse & { statusCode: number; bodyData: string; _headers: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isLocalhost", () => {
  it("recognizes 127.0.0.1", () => {
    expect(isLocalhost("127.0.0.1")).toBe(true);
  });

  it("recognizes ::1", () => {
    expect(isLocalhost("::1")).toBe(true);
  });

  it("recognizes ::ffff:127.0.0.1", () => {
    expect(isLocalhost("::ffff:127.0.0.1")).toBe(true);
  });

  it("recognizes localhost", () => {
    expect(isLocalhost("localhost")).toBe(true);
  });

  it("rejects external IPs", () => {
    expect(isLocalhost("192.168.1.1")).toBe(false);
    expect(isLocalhost("10.0.0.1")).toBe(false);
    expect(isLocalhost("0.0.0.0")).toBe(false);
  });
});

describe("getRemoteIp", () => {
  it("extracts remote address from socket", () => {
    const req = createMockReq({ remoteAddress: "192.168.1.100" });
    expect(getRemoteIp(req)).toBe("192.168.1.100");
  });

  it("returns 'unknown' when socket has no address", () => {
    const req = { socket: {} } as unknown as IncomingMessage;
    expect(getRemoteIp(req)).toBe("unknown");
  });
});

describe("checkAuth", () => {
  it("allows requests with valid bearer token", () => {
    const req = createMockReq({ authorization: "Bearer secret123" });
    const res = createMockRes();
    expect(checkAuth(req, res, { token: "secret123" })).toBe(true);
  });

  it("rejects requests with wrong bearer token", () => {
    const req = createMockReq({ authorization: "Bearer wrong" });
    const res = createMockRes();
    expect(checkAuth(req, res, { token: "secret123" })).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.bodyData).toContain("Unauthorized");
  });

  it("rejects requests without Authorization header when token is set", () => {
    const req = createMockReq({});
    const res = createMockRes();
    expect(checkAuth(req, res, { token: "secret123" })).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("allows localhost requests when no token is configured", () => {
    const req = createMockReq({ remoteAddress: "127.0.0.1" });
    const res = createMockRes();
    expect(checkAuth(req, res, {})).toBe(true);
  });

  it("allows ::1 requests when no token is configured", () => {
    const req = createMockReq({ remoteAddress: "::1" });
    const res = createMockRes();
    expect(checkAuth(req, res, {})).toBe(true);
  });

  it("rejects non-localhost requests when no token is configured", () => {
    const req = createMockReq({ remoteAddress: "192.168.1.50" });
    const res = createMockRes();
    expect(checkAuth(req, res, {})).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("reads token from CLAWFORCE_DASHBOARD_TOKEN env var", () => {
    const origEnv = process.env.CLAWFORCE_DASHBOARD_TOKEN;
    try {
      process.env.CLAWFORCE_DASHBOARD_TOKEN = "env-token";
      const req = createMockReq({ authorization: "Bearer env-token" });
      const res = createMockRes();
      expect(checkAuth(req, res, {})).toBe(true);
    } finally {
      if (origEnv === undefined) {
        delete process.env.CLAWFORCE_DASHBOARD_TOKEN;
      } else {
        process.env.CLAWFORCE_DASHBOARD_TOKEN = origEnv;
      }
    }
  });

  it("option token takes precedence over env var", () => {
    const origEnv = process.env.CLAWFORCE_DASHBOARD_TOKEN;
    try {
      process.env.CLAWFORCE_DASHBOARD_TOKEN = "env-token";
      const req = createMockReq({ authorization: "Bearer opt-token" });
      const res = createMockRes();
      // opts.token should win
      expect(checkAuth(req, res, { token: "opt-token" })).toBe(true);
    } finally {
      if (origEnv === undefined) {
        delete process.env.CLAWFORCE_DASHBOARD_TOKEN;
      } else {
        process.env.CLAWFORCE_DASHBOARD_TOKEN = origEnv;
      }
    }
  });

  it("sets X-Content-Type-Options: nosniff on 401 response", () => {
    const req = createMockReq({ remoteAddress: "192.168.1.50" });
    // Capture writeHead headers
    let capturedHeaders: Record<string, unknown> = {};
    const res = {
      writeHead: vi.fn((status: number, headers?: Record<string, unknown>) => {
        capturedHeaders = headers ?? {};
      }),
      end: vi.fn(),
    } as unknown as ServerResponse;
    checkAuth(req, res, {});
    expect(capturedHeaders["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("setCorsHeaders", () => {
  it("sets Allow-Methods and Allow-Headers always", () => {
    const req = createMockReq({});
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(res._headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
  });

  it("sets Access-Control-Max-Age for preflight caching", () => {
    const req = createMockReq({});
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-max-age"]).toBe("600");
  });

  it("does not set Allow-Origin when no Origin header", () => {
    const req = createMockReq({});
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows localhost origins by default", () => {
    const req = createMockReq({ origin: "http://localhost:5173" });
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res._headers["vary"]).toBe("Origin");
  });

  it("allows 127.0.0.1 origins by default", () => {
    const req = createMockReq({ origin: "http://127.0.0.1:3117" });
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3117");
  });

  it("rejects non-localhost origins by default", () => {
    const req = createMockReq({ origin: "https://evil.com" });
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows configured origins", () => {
    const req = createMockReq({ origin: "https://my-dashboard.example.com" });
    const res = createMockRes();
    setCorsHeaders(req, res, ["https://my-dashboard.example.com", "https://other.com"]);
    expect(res._headers["access-control-allow-origin"]).toBe("https://my-dashboard.example.com");
  });

  it("rejects non-configured origins even if localhost", () => {
    const req = createMockReq({ origin: "http://localhost:5173" });
    const res = createMockRes();
    // When explicit origins are configured, only those are allowed
    setCorsHeaders(req, res, ["https://specific.com"]);
    expect(res._headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reads from CLAWFORCE_CORS_ORIGINS env var", () => {
    const origEnv = process.env.CLAWFORCE_CORS_ORIGINS;
    try {
      process.env.CLAWFORCE_CORS_ORIGINS = "https://app.example.com, https://other.example.com";
      const req = createMockReq({ origin: "https://app.example.com" });
      const res = createMockRes();
      setCorsHeaders(req, res);
      expect(res._headers["access-control-allow-origin"]).toBe("https://app.example.com");
    } finally {
      if (origEnv === undefined) {
        delete process.env.CLAWFORCE_CORS_ORIGINS;
      } else {
        process.env.CLAWFORCE_CORS_ORIGINS = origEnv;
      }
    }
  });

  it("handles invalid origin URLs gracefully", () => {
    const req = createMockReq({ origin: "not-a-url" });
    const res = createMockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  afterEach(() => {
    resetRateLimits();
  });

  it("allows requests under the limit", () => {
    const req = createMockReq({ remoteAddress: "10.0.0.1" });
    const res = createMockRes();
    expect(checkRateLimit(req, res)).toBe(true);
  });

  it("allows exactly 100 requests in a window", () => {
    for (let i = 0; i < 100; i++) {
      const req = createMockReq({ remoteAddress: "10.0.0.2" });
      const res = createMockRes();
      expect(checkRateLimit(req, res)).toBe(true);
    }
  });

  it("rejects the 101st request with 429", () => {
    for (let i = 0; i < 100; i++) {
      const req = createMockReq({ remoteAddress: "10.0.0.3" });
      const res = createMockRes();
      checkRateLimit(req, res);
    }
    const req = createMockReq({ remoteAddress: "10.0.0.3" });
    const res = createMockRes();
    expect(checkRateLimit(req, res)).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.bodyData).toContain("Rate limit exceeded");
  });

  it("tracks different IPs independently", () => {
    // Use up IP A's quota
    for (let i = 0; i < 100; i++) {
      const req = createMockReq({ remoteAddress: "10.0.0.4" });
      const res = createMockRes();
      checkRateLimit(req, res);
    }
    // IP B should still be allowed
    const req = createMockReq({ remoteAddress: "10.0.0.5" });
    const res = createMockRes();
    expect(checkRateLimit(req, res)).toBe(true);
  });

  it("resets after window expires", () => {
    const req1 = createMockReq({ remoteAddress: "10.0.0.6" });
    const res1 = createMockRes();
    checkRateLimit(req1, res1);

    // Manually expire the window
    const map = getRateLimitMap();
    const entry = map.get("10.0.0.6");
    if (entry) {
      entry.resetAt = Date.now() - 1;
    }

    // Should be able to start fresh
    for (let i = 0; i < 100; i++) {
      const req = createMockReq({ remoteAddress: "10.0.0.6" });
      const res = createMockRes();
      expect(checkRateLimit(req, res)).toBe(true);
    }
  });

  it("resetRateLimits clears all state", () => {
    const req = createMockReq({ remoteAddress: "10.0.0.7" });
    const res = createMockRes();
    checkRateLimit(req, res);
    expect(getRateLimitMap().size).toBeGreaterThan(0);
    resetRateLimits();
    expect(getRateLimitMap().size).toBe(0);
  });

  it("sets X-Content-Type-Options: nosniff on 429 response", () => {
    // Exhaust the rate limit
    for (let i = 0; i < 100; i++) {
      const req = createMockReq({ remoteAddress: "10.0.0.8" });
      const res = createMockRes();
      checkRateLimit(req, res);
    }
    let capturedHeaders: Record<string, unknown> = {};
    const req = createMockReq({ remoteAddress: "10.0.0.8" });
    const res = {
      writeHead: vi.fn((status: number, headers?: Record<string, unknown>) => {
        capturedHeaders = headers ?? {};
      }),
      end: vi.fn(),
    } as unknown as ServerResponse;
    checkRateLimit(req, res);
    expect(capturedHeaders["X-Content-Type-Options"]).toBe("nosniff");
  });
});
