import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

// Mock getAgentConfig for isAgentEffectivelyDisabled lookups
const mockGetAgentConfig = vi.fn();
vi.mock("../../src/project.js", async () => {
  const actual = await vi.importActual("../../src/project.js");
  return {
    ...(actual as Record<string, unknown>),
    getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
  };
});

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const {
  disableDomain, enableDomain, isDomainDisabled, getDomainDisableInfo,
  isAgentEffectivelyDisabled, disableAgent, enableAgent,
  listDisabledScopes,
} = await import("../../src/enforcement/disabled-store.js");

let db: DatabaseSync;

beforeEach(() => {
  db = getMemoryDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  mockGetAgentConfig.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch {}
});

describe("domain-level disable", () => {
  it("disableDomain creates a domain scope entry", () => {
    expect(isDomainDisabled("proj1")).toBe(false);

    disableDomain("proj1", "maintenance window", "admin");

    expect(isDomainDisabled("proj1")).toBe(true);

    const scopes = listDisabledScopes("proj1");
    const domainScope = scopes.find(s => s.scopeType === "domain");
    expect(domainScope).toBeDefined();
    expect(domainScope!.scopeValue).toBe("proj1");
    expect(domainScope!.reason).toBe("maintenance window");
    expect(domainScope!.disabledBy).toBe("admin");
  });

  it("enableDomain removes the domain scope entry", () => {
    disableDomain("proj1", "test");
    expect(isDomainDisabled("proj1")).toBe(true);

    enableDomain("proj1");
    expect(isDomainDisabled("proj1")).toBe(false);
  });

  it("getDomainDisableInfo returns details when disabled", () => {
    disableDomain("proj1", "shutting down", "ops");

    const info = getDomainDisableInfo("proj1");
    expect(info).not.toBeNull();
    expect(info!.reason).toBe("shutting down");
    expect(info!.disabledBy).toBe("ops");
    expect(info!.scopeType).toBe("domain");
    expect(info!.disabledAt).toBeGreaterThan(0);
  });

  it("getDomainDisableInfo returns null when not disabled", () => {
    const info = getDomainDisableInfo("proj1");
    expect(info).toBeNull();
  });

  it("does not cross projects", () => {
    disableDomain("proj1", "down");
    expect(isDomainDisabled("proj1")).toBe(true);
    expect(isDomainDisabled("proj2")).toBe(false);
  });

  it("handles double-disable gracefully (INSERT OR REPLACE)", () => {
    disableDomain("proj1", "first reason", "admin1");
    disableDomain("proj1", "second reason", "admin2");

    expect(isDomainDisabled("proj1")).toBe(true);
    const info = getDomainDisableInfo("proj1");
    expect(info!.reason).toBe("second reason");
    expect(info!.disabledBy).toBe("admin2");
  });

  it("enable on non-disabled domain is a no-op", () => {
    enableDomain("proj1");
    expect(isDomainDisabled("proj1")).toBe(false);
  });
});

describe("isAgentEffectivelyDisabled with domain scope", () => {
  it("returns true when domain is disabled (even if agent is individually enabled)", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });

    disableDomain("proj1", "domain down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("returns false when domain is enabled and agent is not disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });

    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("domain disable takes precedence over everything", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend" },
    });

    // Domain disabled — agent should be disabled regardless
    disableDomain("proj1", "domain down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Re-enable domain, agent should be enabled
    enableDomain("proj1");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);

    // Disable agent individually — should still be disabled
    disableAgent("proj1", "agent-a", "bad agent");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Re-enable agent
    enableAgent("proj1", "agent-a");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);

    // Disable domain again
    disableDomain("proj1", "domain down again");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("domain disable does not affect other projects", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj2",
      config: { team: "frontend" },
    });

    disableDomain("proj1", "proj1 down");
    expect(isAgentEffectivelyDisabled("proj2", "agent-a")).toBe(false);
  });
});
