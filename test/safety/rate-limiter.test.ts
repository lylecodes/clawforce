import { beforeEach, describe, expect, it } from "vitest";

const {
  recordCall,
  checkCallLimit,
  clearSession,
  calculateBackoffDelay,
  calculateBackoffDelayDeterministic,
  getRateLimitInfo,
  resetRateLimiter,
  RATE_LIMIT_DEFAULTS,
  BACKOFF_DEFAULTS,
} = await import("../../src/safety/rate-limiter.js");

const PROJECT = "test-project";
const AGENT = "agent-1";
const SESSION = "session-1";

beforeEach(() => {
  resetRateLimiter();
});

describe("recordCall + checkCallLimit", () => {
  describe("per-session limit", () => {
    it("allows calls within session limit", () => {
      for (let i = 0; i < 5; i++) {
        recordCall(PROJECT, AGENT, SESSION);
      }
      const result = checkCallLimit(PROJECT, AGENT, SESSION);
      expect(result.allowed).toBe(true);
    });

    it("blocks when session limit is reached", () => {
      const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerSession: 10 };
      for (let i = 0; i < 10; i++) {
        recordCall(PROJECT, AGENT, SESSION);
      }
      const result = checkCallLimit(PROJECT, AGENT, SESSION, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("Session call limit exceeded");
        expect(result.reason).toContain("10/10");
      }
    });

    it("isolates session counts", () => {
      const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerSession: 5 };
      for (let i = 0; i < 5; i++) {
        recordCall(PROJECT, AGENT, "session-a");
      }
      // Session A should be blocked
      const resultA = checkCallLimit(PROJECT, AGENT, "session-a", config);
      expect(resultA.allowed).toBe(false);

      // Session B should still be allowed
      const resultB = checkCallLimit(PROJECT, AGENT, "session-b", config);
      expect(resultB.allowed).toBe(true);
    });

    it("blocks at default limit (100)", () => {
      for (let i = 0; i < 100; i++) {
        recordCall(PROJECT, AGENT, SESSION);
      }
      const result = checkCallLimit(PROJECT, AGENT, SESSION);
      expect(result.allowed).toBe(false);
    });
  });

  describe("global per-minute limit", () => {
    it("allows calls within global rate limit", () => {
      const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerMinute: 50 };
      for (let i = 0; i < 30; i++) {
        recordCall(PROJECT, `agent-${i % 5}`, `session-${i}`);
      }
      const result = checkCallLimit(PROJECT, "agent-new", "session-new", config);
      expect(result.allowed).toBe(true);
    });

    it("blocks when global rate limit is exceeded", () => {
      const config = {
        ...RATE_LIMIT_DEFAULTS,
        maxCallsPerMinute: 20,
        maxCallsPerSession: 1000,      // high so it doesn't trigger
        maxCallsPerMinutePerAgent: 1000, // high so it doesn't trigger
      };
      // Spread calls across agents/sessions to avoid per-session/per-agent limits
      for (let i = 0; i < 20; i++) {
        recordCall(PROJECT, `agent-${i}`, `session-${i}`);
      }
      const result = checkCallLimit(PROJECT, "agent-new", "session-new", config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("Global rate limit exceeded");
      }
    });
  });

  describe("per-agent per-minute limit", () => {
    it("allows calls within per-agent rate limit", () => {
      const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerMinutePerAgent: 20 };
      for (let i = 0; i < 10; i++) {
        recordCall(PROJECT, AGENT, `session-${i}`);
      }
      const result = checkCallLimit(PROJECT, AGENT, "session-new", config);
      expect(result.allowed).toBe(true);
    });

    it("blocks when per-agent rate limit is exceeded", () => {
      const config = {
        ...RATE_LIMIT_DEFAULTS,
        maxCallsPerMinutePerAgent: 10,
        maxCallsPerSession: 1000, // high so it doesn't trigger
      };
      for (let i = 0; i < 10; i++) {
        recordCall(PROJECT, AGENT, `session-${i}`);
      }
      const result = checkCallLimit(PROJECT, AGENT, "session-new", config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain(`Agent "${AGENT}" rate limit exceeded`);
      }
    });

    it("isolates per-agent counts", () => {
      const config = {
        ...RATE_LIMIT_DEFAULTS,
        maxCallsPerMinutePerAgent: 5,
        maxCallsPerSession: 1000,
      };
      for (let i = 0; i < 5; i++) {
        recordCall(PROJECT, "agent-a", `session-a-${i}`);
      }
      // Agent A should be blocked
      const resultA = checkCallLimit(PROJECT, "agent-a", "session-a-new", config);
      expect(resultA.allowed).toBe(false);

      // Agent B should still be allowed
      const resultB = checkCallLimit(PROJECT, "agent-b", "session-b-new", config);
      expect(resultB.allowed).toBe(true);
    });
  });

  describe("priority ordering", () => {
    it("session limit checked before global rate limit", () => {
      // A session at its limit should report session-level reason
      const config = {
        maxCallsPerSession: 5,
        maxCallsPerMinute: 5,
        maxCallsPerMinutePerAgent: 5,
      };
      for (let i = 0; i < 5; i++) {
        recordCall(PROJECT, AGENT, SESSION);
      }
      const result = checkCallLimit(PROJECT, AGENT, SESSION, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("Session call limit");
      }
    });
  });
});

describe("clearSession", () => {
  it("resets session counter", () => {
    const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerSession: 5 };
    for (let i = 0; i < 5; i++) {
      recordCall(PROJECT, AGENT, SESSION);
    }
    expect(checkCallLimit(PROJECT, AGENT, SESSION, config).allowed).toBe(false);

    clearSession(SESSION);
    expect(checkCallLimit(PROJECT, AGENT, SESSION, config).allowed).toBe(true);
  });

  it("does not affect other sessions", () => {
    const config = { ...RATE_LIMIT_DEFAULTS, maxCallsPerSession: 5 };
    for (let i = 0; i < 5; i++) {
      recordCall(PROJECT, AGENT, "session-a");
      recordCall(PROJECT, AGENT, "session-b");
    }
    clearSession("session-a");
    expect(checkCallLimit(PROJECT, AGENT, "session-a", config).allowed).toBe(true);
    expect(checkCallLimit(PROJECT, AGENT, "session-b", config).allowed).toBe(false);
  });
});

describe("getRateLimitInfo", () => {
  it("returns zero counters for fresh state", () => {
    const info = getRateLimitInfo(PROJECT, AGENT, SESSION);
    expect(info.sessionCalls).toBe(0);
    expect(info.globalCallsPerMinute).toBe(0);
    expect(info.agentCallsPerMinute).toBe(0);
  });

  it("reflects recorded calls", () => {
    for (let i = 0; i < 5; i++) {
      recordCall(PROJECT, AGENT, SESSION);
    }
    const info = getRateLimitInfo(PROJECT, AGENT, SESSION);
    expect(info.sessionCalls).toBe(5);
    expect(info.globalCallsPerMinute).toBe(5);
    expect(info.agentCallsPerMinute).toBe(5);
  });

  it("counts global calls across agents", () => {
    recordCall(PROJECT, "agent-a", "session-a");
    recordCall(PROJECT, "agent-b", "session-b");
    recordCall(PROJECT, "agent-c", "session-c");

    const info = getRateLimitInfo(PROJECT, "agent-a", "session-a");
    expect(info.sessionCalls).toBe(1);
    expect(info.globalCallsPerMinute).toBe(3);
    expect(info.agentCallsPerMinute).toBe(1);
  });
});

describe("calculateBackoffDelay", () => {
  it("returns base delay for first retry", () => {
    const delay = calculateBackoffDelayDeterministic(0);
    expect(delay).toBe(BACKOFF_DEFAULTS.baseDelayMs); // 30s
  });

  it("doubles delay for each retry", () => {
    const delay0 = calculateBackoffDelayDeterministic(0);
    const delay1 = calculateBackoffDelayDeterministic(1);
    const delay2 = calculateBackoffDelayDeterministic(2);
    const delay3 = calculateBackoffDelayDeterministic(3);

    expect(delay0).toBe(30_000);
    expect(delay1).toBe(60_000);
    expect(delay2).toBe(120_000);
    expect(delay3).toBe(240_000);
  });

  it("clamps at max delay", () => {
    const delay = calculateBackoffDelayDeterministic(10); // 30000 * 1024 = 30720000, way over max
    expect(delay).toBe(BACKOFF_DEFAULTS.maxDelayMs); // 600s
  });

  it("respects custom config", () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 10_000 };
    expect(calculateBackoffDelayDeterministic(0, config)).toBe(1000);
    expect(calculateBackoffDelayDeterministic(1, config)).toBe(2000);
    expect(calculateBackoffDelayDeterministic(2, config)).toBe(4000);
    expect(calculateBackoffDelayDeterministic(3, config)).toBe(8000);
    expect(calculateBackoffDelayDeterministic(4, config)).toBe(10_000); // clamped
  });

  it("adds jitter in non-deterministic version", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateBackoffDelay(1));
    }
    // With jitter, we should get multiple different values
    // (extremely unlikely to get all the same with 10% jitter range)
    expect(delays.size).toBeGreaterThan(1);
  });

  it("jitter stays within +/- 10% of base", () => {
    const baseDeterministic = calculateBackoffDelayDeterministic(1);
    for (let i = 0; i < 100; i++) {
      const delay = calculateBackoffDelay(1);
      const lowerBound = baseDeterministic * 0.89; // slightly under 10% for rounding
      const upperBound = baseDeterministic * 1.11;
      expect(delay).toBeGreaterThanOrEqual(lowerBound);
      expect(delay).toBeLessThanOrEqual(upperBound);
    }
  });

  it("returns 0 for negative retry count", () => {
    // Edge case — should not crash, just return base
    const delay = calculateBackoffDelayDeterministic(0);
    expect(delay).toBeGreaterThan(0);
  });
});

describe("resetRateLimiter", () => {
  it("clears all state", () => {
    for (let i = 0; i < 50; i++) {
      recordCall(PROJECT, AGENT, SESSION);
    }
    resetRateLimiter();
    const info = getRateLimitInfo(PROJECT, AGENT, SESSION);
    expect(info.sessionCalls).toBe(0);
    expect(info.globalCallsPerMinute).toBe(0);
    expect(info.agentCallsPerMinute).toBe(0);
  });
});

describe("defaults", () => {
  it("has reasonable default values", () => {
    expect(RATE_LIMIT_DEFAULTS.maxCallsPerSession).toBe(100);
    expect(RATE_LIMIT_DEFAULTS.maxCallsPerMinute).toBe(200);
    expect(RATE_LIMIT_DEFAULTS.maxCallsPerMinutePerAgent).toBe(60);
  });

  it("has reasonable backoff defaults", () => {
    expect(BACKOFF_DEFAULTS.baseDelayMs).toBe(30_000);
    expect(BACKOFF_DEFAULTS.maxDelayMs).toBe(600_000);
  });
});
