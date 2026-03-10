import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
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
const { enforceToolPolicy } = await import("../../src/policy/middleware.js");
const { registerPolicies, resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
const projectModule = await import("../../src/project.js");
const scopeModule = await import("../../src/scope.js");
const profilesModule = await import("../../src/profiles.js");
const riskClassifierModule = await import("../../src/risk/classifier.js");

describe("enforceToolPolicy", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetPolicyRegistryForTest();
  });

  afterEach(() => {
    try { db.close(); } catch {}
    resetPolicyRegistryForTest();
    vi.restoreAllMocks();
  });

  it("returns allowed when no policies block", () => {
    const result = enforceToolPolicy(
      { projectId: PROJECT, agentId: "agent:test", toolName: "some_mcp_tool" },
      { action: "read" },
    );
    expect(result.allowed).toBe(true);
  });

  it("returns policy violation when action_scope denies the tool", () => {
    registerPolicies(PROJECT, [
      {
        name: "worker-scope",
        type: "action_scope",
        target: "agent:worker",
        config: { allowed_tools: ["clawforce_task"] },
      },
    ], db);

    const result = enforceToolPolicy(
      { projectId: PROJECT, agentId: "agent:worker", toolName: "dangerous_mcp_tool" },
      { action: "delete" },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe("policy");
      expect(result.reason).toContain("Policy violation");
      expect(result.policyId).toBeTruthy();
    }
  });

  it("returns constraint violation when own_tasks_only is violated", () => {
    vi.spyOn(scopeModule, "resolveEffectiveScope").mockReturnValue({
      some_tool: { actions: "*", constraints: { own_tasks_only: true } },
    });

    vi.spyOn(profilesModule, "getConstraintsForTool").mockReturnValue({ own_tasks_only: true });

    // Create a task assigned to someone else
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
      VALUES ('task-1', '${PROJECT}', 'Test', 'OPEN', 'P2', 'agent:other', 'system', ${Date.now()}, ${Date.now()}, 0, 3)
    `).run();

    const result = enforceToolPolicy(
      { projectId: PROJECT, agentId: "agent:worker", toolName: "some_tool" },
      { action: "update", task_id: "task-1" },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe("constraint");
      expect(result.reason).toContain("own_tasks_only");
    }
  });

  it("returns risk gate block when risk tier triggers block", () => {
    vi.spyOn(projectModule, "getExtendedProjectConfig").mockReturnValue({
      riskTiers: {
        enabled: true,
        defaultTier: "low",
        policies: {
          low: { gate: "none" },
          medium: { gate: "none" },
          high: { gate: "human_approval" },
          critical: { gate: "human_approval" },
        },
        patterns: [
          {
            tier: "high" as const,
            match: { action_type: "tool_call", tool_name: "dangerous_tool" },
          },
        ],
      },
    });

    const result = enforceToolPolicy(
      { projectId: PROJECT, agentId: "agent:worker", toolName: "dangerous_tool" },
      { action: "execute" },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe("risk");
      expect(result.riskTier).toBe("high");
      expect(result.reason).toContain("approval");
    }
  });

  it("fails closed when risk classification throws", () => {
    vi.spyOn(projectModule, "getExtendedProjectConfig").mockReturnValue({
      riskTiers: {
        enabled: true,
        defaultTier: "low",
        policies: {
          low: { gate: "none" },
          medium: { gate: "none" },
          high: { gate: "human_approval" },
          critical: { gate: "human_approval" },
        },
        patterns: [],
      },
    });

    vi.spyOn(riskClassifierModule, "classifyRisk").mockImplementation(() => {
      throw new Error("Risk engine crashed");
    });

    const result = enforceToolPolicy(
      { projectId: PROJECT, agentId: "agent:worker", toolName: "some_tool" },
      { action: "run" },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.source).toBe("risk");
      expect(result.reason).toContain("Risk classification failed");
    }
  });
});
