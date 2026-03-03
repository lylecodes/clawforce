import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

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
const { registerPolicies, resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
const { checkPolicies } = await import("../../src/policy/engine.js");
const { setBudget } = await import("../../src/budget.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
  resetPolicyRegistryForTest();
});

afterEach(() => {
  try { db.close(); } catch {}
  resetPolicyRegistryForTest();
});

describe("action_scope policy", () => {
  it("blocks denied tools", () => {
    registerPolicies("p1", [
      {
        name: "worker_scope",
        type: "action_scope",
        target: "worker-1",
        config: { denied_tools: ["clawforce_ops"] },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_ops",
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("denied");
      expect(result.policyId).toBeTruthy();
    }
  });

  it("allows non-denied tools", () => {
    registerPolicies("p1", [
      {
        name: "worker_scope",
        type: "action_scope",
        target: "worker-1",
        config: { denied_tools: ["clawforce_ops"] },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
    });

    expect(result.allowed).toBe(true);
  });

  it("enforces allowed tools list", () => {
    registerPolicies("p1", [
      {
        name: "strict_scope",
        type: "action_scope",
        target: "worker-1",
        config: { allowed_tools: ["clawforce_task", "clawforce_log"] },
      },
    ], db);

    const allowed = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
    });
    expect(allowed.allowed).toBe(true);

    const blocked = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_workflow",
    });
    expect(blocked.allowed).toBe(false);
  });

  it("skips policies targeting a different agent", () => {
    registerPolicies("p1", [
      {
        name: "other_scope",
        type: "action_scope",
        target: "orchestrator",
        config: { denied_tools: ["clawforce_task"] },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
    });

    expect(result.allowed).toBe(true);
  });
});

describe("transition_gate policy", () => {
  it("blocks gated transitions", () => {
    registerPolicies("p1", [
      {
        name: "p0_review_gate",
        type: "transition_gate",
        config: {
          transitions: [
            { from: "REVIEW", to: "DONE", conditions: { min_priority: "P1" } },
          ],
        },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
      toolAction: "transition",
      fromState: "REVIEW",
      toState: "DONE",
      taskPriority: "P0",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows transitions below min_priority threshold", () => {
    registerPolicies("p1", [
      {
        name: "p0_review_gate",
        type: "transition_gate",
        config: {
          transitions: [
            { from: "REVIEW", to: "DONE", conditions: { min_priority: "P1" } },
          ],
        },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
      toolAction: "transition",
      fromState: "REVIEW",
      toState: "DONE",
      taskPriority: "P3",
    });

    expect(result.allowed).toBe(true);
  });

  it("only evaluates on clawforce_task transition action", () => {
    registerPolicies("p1", [
      {
        name: "gate",
        type: "transition_gate",
        config: { transitions: [{ from: "REVIEW", to: "DONE" }] },
      },
    ], db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_log",
      toolAction: "write",
    });

    expect(result.allowed).toBe(true);
  });
});

describe("spend_limit policy", () => {
  it("blocks when budget exceeded", () => {
    registerPolicies("p1", [
      { name: "spend_check", type: "spend_limit", config: {} },
    ], db);

    setBudget({ projectId: "p1", config: { dailyLimitCents: 100 } }, db);
    db.prepare("UPDATE budgets SET daily_spent_cents = 200 WHERE project_id = 'p1'").run();

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
      dbOverride: db,
    });

    expect(result.allowed).toBe(false);
  });

  it("allows when within budget", () => {
    registerPolicies("p1", [
      { name: "spend_check", type: "spend_limit", config: {} },
    ], db);

    setBudget({ projectId: "p1", config: { dailyLimitCents: 5000 } }, db);

    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_task",
      dbOverride: db,
    });

    expect(result.allowed).toBe(true);
  });
});

describe("no policies", () => {
  it("allows everything when no policies are registered", () => {
    const result = checkPolicies({
      projectId: "p1",
      agentId: "worker-1",
      toolName: "clawforce_ops",
    });

    expect(result.allowed).toBe(true);
  });
});
