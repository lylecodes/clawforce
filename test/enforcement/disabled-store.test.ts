import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

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
  disableAgent, isAgentDisabled, listDisabledAgents, enableAgent,
  disableScope, enableScope, isAgentEffectivelyDisabled, listDisabledScopes,
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

describe("disabled-store", () => {
  it("disables and detects an agent", () => {
    expect(isAgentDisabled("proj1", "agent-a")).toBe(false);
    disableAgent("proj1", "agent-a", "non-compliant");
    expect(isAgentDisabled("proj1", "agent-a")).toBe(true);
  });

  it("enables a disabled agent", () => {
    disableAgent("proj1", "agent-a", "crashed");
    expect(isAgentDisabled("proj1", "agent-a")).toBe(true);

    enableAgent("proj1", "agent-a");
    expect(isAgentDisabled("proj1", "agent-a")).toBe(false);
  });

  it("lists disabled agents for a project", () => {
    disableAgent("proj1", "agent-a", "reason A");
    disableAgent("proj1", "agent-b", "reason B");
    disableAgent("proj2", "agent-c", "reason C");

    const list = listDisabledAgents("proj1");
    expect(list).toHaveLength(2);
    expect(list.map(a => a.agentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(list[0]!.reason).toBeTruthy();
    expect(list[0]!.disabledAt).toBeGreaterThan(0);
  });

  it("does not cross projects", () => {
    disableAgent("proj1", "agent-a", "reason");
    expect(isAgentDisabled("proj2", "agent-a")).toBe(false);
  });

  it("handles double-disable gracefully (INSERT OR REPLACE)", () => {
    disableAgent("proj1", "agent-a", "first");
    disableAgent("proj1", "agent-a", "second");

    const list = listDisabledAgents("proj1");
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe("second");
  });

  it("enable on non-disabled agent is a no-op", () => {
    enableAgent("proj1", "agent-x");
    expect(isAgentDisabled("proj1", "agent-x")).toBe(false);
  });
});

describe("disabled-scopes", () => {
  it("disables and enables a team scope", () => {
    disableScope("proj1", "team", "frontend", "maintenance", "admin");

    const list = listDisabledScopes("proj1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scopeType).toBe("team");
    expect(list[0]!.scopeValue).toBe("frontend");
    expect(list[0]!.reason).toBe("maintenance");
    expect(list[0]!.disabledBy).toBe("admin");
    expect(list[0]!.disabledAt).toBeGreaterThan(0);

    enableScope("proj1", "team", "frontend");
    expect(listDisabledScopes("proj1")).toHaveLength(0);
  });

  it("disables and enables a department scope", () => {
    disableScope("proj1", "department", "engineering", "reorg");

    const list = listDisabledScopes("proj1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scopeType).toBe("department");
    expect(list[0]!.scopeValue).toBe("engineering");

    enableScope("proj1", "department", "engineering");
    expect(listDisabledScopes("proj1")).toHaveLength(0);
  });

  it("disables an agent via scope", () => {
    disableScope("proj1", "agent", "agent-a", "bad behavior", "manager");

    const list = listDisabledScopes("proj1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scopeType).toBe("agent");
    expect(list[0]!.scopeValue).toBe("agent-a");
  });

  it("handles double-disable scope gracefully (INSERT OR REPLACE)", () => {
    disableScope("proj1", "team", "frontend", "first reason");
    disableScope("proj1", "team", "frontend", "second reason");

    const list = listDisabledScopes("proj1");
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe("second reason");
  });

  it("does not cross projects", () => {
    disableScope("proj1", "team", "frontend", "reason");

    const proj1List = listDisabledScopes("proj1");
    const proj2List = listDisabledScopes("proj2");
    expect(proj1List).toHaveLength(1);
    expect(proj2List).toHaveLength(0);
  });

  it("lists multiple scopes for a project", () => {
    disableScope("proj1", "agent", "agent-a", "reason1");
    disableScope("proj1", "team", "backend", "reason2");
    disableScope("proj1", "department", "engineering", "reason3");

    const list = listDisabledScopes("proj1");
    expect(list).toHaveLength(3);
    const types = list.map(s => s.scopeType).sort();
    expect(types).toEqual(["agent", "department", "team"]);
  });

  it("enable on non-disabled scope is a no-op", () => {
    enableScope("proj1", "team", "nonexistent");
    expect(listDisabledScopes("proj1")).toHaveLength(0);
  });
});

describe("isAgentEffectivelyDisabled", () => {
  it("returns true when agent is in legacy disabled_agents table", () => {
    mockGetAgentConfig.mockReturnValue(null);
    disableAgent("proj1", "agent-a", "legacy disable");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("returns true when agent has a disabled_scopes agent-level entry", () => {
    mockGetAgentConfig.mockReturnValue(null);
    disableScope("proj1", "agent", "agent-a", "scope disable");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("returns true when agent's team is disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    disableScope("proj1", "team", "frontend", "team maintenance");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("returns true when agent's department is disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    disableScope("proj1", "department", "engineering", "dept shutdown");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);
  });

  it("returns false when nothing is disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("uses opts.team and opts.department when provided (avoids getAgentConfig call)", () => {
    mockGetAgentConfig.mockReturnValue(null); // Would return null if called
    disableScope("proj1", "team", "backend", "reason");

    // Without opts — agent config not found, no team to check
    expect(isAgentEffectivelyDisabled("proj1", "agent-b")).toBe(false);

    // With opts — team is matched
    expect(isAgentEffectivelyDisabled("proj1", "agent-b", undefined, { team: "backend" })).toBe(true);
  });

  it("returns false when a different team is disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    disableScope("proj1", "team", "backend", "backend down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("returns false when a different department is disabled", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    disableScope("proj1", "department", "sales", "sales down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("checks all layers in priority order", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });

    // Legacy agent disable → true
    disableAgent("proj1", "agent-a", "legacy");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Remove legacy, add scope agent → true
    enableAgent("proj1", "agent-a");
    disableScope("proj1", "agent", "agent-a", "scope");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Remove scope agent, add team → true
    enableScope("proj1", "agent", "agent-a");
    disableScope("proj1", "team", "frontend", "team down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Remove team, add department → true
    enableScope("proj1", "team", "frontend");
    disableScope("proj1", "department", "engineering", "dept down");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Remove department → false
    enableScope("proj1", "department", "engineering");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("does not cross projects for scope checks", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend" },
    });
    disableScope("proj2", "team", "frontend", "reason");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("detects domain-level disable in single consolidated query", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });
    disableScope("proj1", "domain", "proj1", "domain shutdown");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Enabling domain re-enables agent
    enableScope("proj1", "domain", "proj1");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false);
  });

  it("handles multiple scope types disabled simultaneously", () => {
    mockGetAgentConfig.mockReturnValue({
      projectId: "proj1",
      config: { team: "frontend", department: "engineering" },
    });

    // Disable at all scope levels
    disableScope("proj1", "domain", "proj1", "domain");
    disableScope("proj1", "department", "engineering", "dept");
    disableScope("proj1", "team", "frontend", "team");
    disableScope("proj1", "agent", "agent-a", "agent");
    disableAgent("proj1", "agent-a", "legacy");

    // Should still return true with everything disabled
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    // Remove scopes one by one — still disabled via others
    enableScope("proj1", "domain", "proj1");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    enableScope("proj1", "department", "engineering");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    enableScope("proj1", "team", "frontend");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true);

    enableScope("proj1", "agent", "agent-a");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(true); // legacy still active

    enableAgent("proj1", "agent-a");
    expect(isAgentEffectivelyDisabled("proj1", "agent-a")).toBe(false); // finally clear
  });

  it("works with only team provided in opts (no department)", () => {
    mockGetAgentConfig.mockReturnValue(null);
    disableScope("proj1", "team", "backend", "reason");

    expect(isAgentEffectivelyDisabled("proj1", "agent-x", undefined, { team: "backend" })).toBe(true);
    expect(isAgentEffectivelyDisabled("proj1", "agent-x", undefined, { team: "frontend" })).toBe(false);
  });

  it("works with only department provided in opts (no team)", () => {
    mockGetAgentConfig.mockReturnValue(null);
    disableScope("proj1", "department", "engineering", "reason");

    expect(isAgentEffectivelyDisabled("proj1", "agent-x", undefined, { department: "engineering" })).toBe(true);
    expect(isAgentEffectivelyDisabled("proj1", "agent-x", undefined, { department: "sales" })).toBe(false);
  });

  it("consolidated query correctly handles agent with no team/department config", () => {
    // Agent has no config at all — only agent-level and domain-level should be checked
    mockGetAgentConfig.mockReturnValue(null);

    // Team/dept disables should NOT affect this agent (no team/dept to match)
    disableScope("proj1", "team", "frontend", "team reason");
    disableScope("proj1", "department", "engineering", "dept reason");
    expect(isAgentEffectivelyDisabled("proj1", "agent-orphan")).toBe(false);

    // But agent-level disable SHOULD affect it
    disableScope("proj1", "agent", "agent-orphan", "direct disable");
    expect(isAgentEffectivelyDisabled("proj1", "agent-orphan")).toBe(true);
  });
});
