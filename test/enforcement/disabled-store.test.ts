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

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { disableAgent, isAgentDisabled, listDisabledAgents, enableAgent } = await import("../../src/enforcement/disabled-store.js");

let db: DatabaseSync;

beforeEach(() => {
  db = getMemoryDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db);
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
