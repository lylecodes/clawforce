/**
 * Clawforce — Dashboard authentication & rate limiting middleware
 *
 * Provides:
 *   - Bearer token authentication
 *   - Localhost-only fallback when no token is configured
 *   - CORS origin validation
 *   - Simple in-memory per-IP rate limiting
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { safeLog } from "../diagnostics.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthOptions = {
  /** Bearer token for API auth. If unset, falls back to localhost-only. */
  token?: string;
  /** Comma-separated allowed CORS origins (env: CLAWFORCE_CORS_ORIGINS). */
  allowedOrigins?: string[];
};

export type SecurityHeaderOptions = {
  csp?: string;
};

export type RateLimitEntry = {
  count: number;
  resetAt: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCALHOST_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** Extract the remote IP from a request. */
export function getRemoteIp(req: IncomingMessage): string {
  const raw = req.socket?.remoteAddress ?? "unknown";
  return raw;
}

/** Check whether a remote address is localhost. */
export function isLocalhost(addr: string): boolean {
  return LOCALHOST_ADDRS.has(addr);
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

/**
 * Returns true if the request is authorized, false otherwise.
 * On failure, writes a 401 response.
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AuthOptions,
): boolean {
  const token = opts.token ?? process.env.CLAWFORCE_DASHBOARD_TOKEN;

  if (token) {
    // Token configured — require Bearer header
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      respondJson(res, 401, { error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // No token — allow only localhost
  const remoteIp = getRemoteIp(req);
  if (!isLocalhost(remoteIp)) {
    respondJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Set CORS headers based on the request Origin.
 * - If the origin matches a configured allowed origin or is localhost, reflect it.
 * - Otherwise, don't set Access-Control-Allow-Origin (browser will block).
 */
export function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins?: string[],
): void {
  const origin = req.headers.origin;
  const envOrigins = process.env.CLAWFORCE_CORS_ORIGINS;
  const configured = allowedOrigins
    ?? (envOrigins ? envOrigins.split(",").map((o) => o.trim()).filter(Boolean) : undefined);

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");

  if (!origin) {
    // No Origin header (same-origin or non-browser) — skip ACAO
    return;
  }

  // Check configured allowed origins
  if (configured && configured.length > 0) {
    if (configured.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    return;
  }

  // No configured origins — allow localhost origins only
  try {
    const url = new URL(origin);
    if (isLocalhost(url.hostname)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  } catch {
    // Invalid origin URL — don't set header
  }
}

/**
 * Apply baseline security headers shared by standalone and embedded dashboard
 * responses. Keep this lightweight so it does not fight OpenClaw's own auth
 * model when the dashboard is embedded as a plugin route.
 */
export function setSecurityHeaders(
  res: ServerResponse,
  opts?: SecurityHeaderOptions,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (opts?.csp) {
    res.setHeader("Content-Security-Policy", opts.csp);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 100; // requests per window per IP

type DashboardAuthRuntimeState = {
  rateLimitMap: Map<string, RateLimitEntry>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
};

const runtime = getDefaultRuntimeState();

function getDashboardAuthState(): DashboardAuthRuntimeState {
  return runtime.dashboardAuth as DashboardAuthRuntimeState;
}

function ensureCleanupTimer(): void {
  const state = getDashboardAuthState();
  if (state.cleanupTimer) return;
  state.cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of state.rateLimitMap) {
      if (now >= entry.resetAt) {
        state.rateLimitMap.delete(key);
      }
    }
  }, 2 * RATE_LIMIT_WINDOW_MS);
  // Don't prevent process exit
  if (state.cleanupTimer && typeof state.cleanupTimer === "object" && "unref" in state.cleanupTimer) {
    state.cleanupTimer.unref();
  }
}

/**
 * Check rate limit for an IP. Returns true if under limit, false if exceeded.
 * When exceeded, writes a 429 response.
 */
export function checkRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  ensureCleanupTimer();

  const state = getDashboardAuthState();
  const ip = getRemoteIp(req);
  if (isLocalhost(ip)) {
    return true;
  }
  const now = Date.now();
  let entry = state.rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    state.rateLimitMap.set(ip, entry);
    return true;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    respondJson(res, 429, { error: "Rate limit exceeded" });
    return false;
  }
  return true;
}

/**
 * Reset rate limit state (for testing).
 */
export function resetRateLimits(): void {
  const state = getDashboardAuthState();
  state.rateLimitMap.clear();
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer);
    state.cleanupTimer = null;
  }
}

/**
 * Get the rate limit map (for testing).
 */
export function getRateLimitMap(): Map<string, RateLimitEntry> {
  return getDashboardAuthState().rateLimitMap;
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}
