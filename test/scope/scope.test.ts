import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const projectModule = await import("../../src/project.js");
const { registerPolicies, resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
const { resolveEffectiveScope, resolveEffectiveScopeForProject, UNREGISTERED_SCOPE } = await import("../../src/scope.js");
const { DEFAULT_ACTION_SCOPES } = await import("../../src/profiles.js");

describe("resolveEffectiveScope", () => {
  afterEach(() => {
    resetPolicyRegistryForTest();
    vi.restoreAllMocks();
  });

  it("returns UNREGISTERED_SCOPE for unregistered agent", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(null);

    const scope = resolveEffectiveScope("unknown-agent");
    expect(scope).toEqual(UNREGISTERED_SCOPE);
    expect(scope).toEqual({ clawforce_setup: ["explain", "status"] });
  });

  it("returns role defaults when no custom policies", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj1",
      config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
    });

    const scope = resolveEffectiveScope("worker1");

    expect(scope).toEqual(DEFAULT_ACTION_SCOPES.employee);
  });

  it("uses custom action_scope policy when present", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj1",
      config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
    });

    registerPolicies("proj1", [
      {
        name: "custom-scope",
        type: "action_scope",
        target: "worker1",
        config: {
          allowed_tools: {
            clawforce_task: ["get", "list"],
            clawforce_log: "*",
          },
        },
      },
    ]);

    const scope = resolveEffectiveScope("worker1");

    expect(scope).toEqual({
      clawforce_task: ["get", "list"],
      clawforce_log: "*",
    });
  });

  it("handles legacy string[] format", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj1",
      config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
    });

    registerPolicies("proj1", [
      {
        name: "legacy-scope",
        type: "action_scope",
        target: "worker1",
        config: {
          allowed_tools: ["clawforce_task", "clawforce_log"],
        },
      },
    ]);

    const scope = resolveEffectiveScope("worker1");

    expect(scope).toEqual({
      clawforce_task: "*",
      clawforce_log: "*",
    });
  });

  it("falls back when no policy matches", () => {
    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      projectId: "proj1",
      config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
    });

    // Register policy for a different agent
    registerPolicies("proj1", [
      {
        name: "other-scope",
        type: "action_scope",
        target: "other-agent",
        config: {
          allowed_tools: { clawforce_ops: "*" },
        },
      },
    ]);

    const scope = resolveEffectiveScope("worker1");

    expect(scope).toEqual(DEFAULT_ACTION_SCOPES.employee);
  });
});

describe("resolveEffectiveScopeForProject", () => {
  afterEach(() => {
    resetPolicyRegistryForTest();
  });

  it("returns role defaults when no policies", () => {
    const scope = resolveEffectiveScopeForProject("proj1", "agent1", "manager");
    expect(scope).toEqual(DEFAULT_ACTION_SCOPES.manager);
  });

  it("returns custom scope from policy", () => {
    registerPolicies("proj1", [
      {
        name: "custom",
        type: "action_scope",
        target: "agent1",
        config: {
          allowed_tools: { clawforce_log: ["write"] },
        },
      },
    ]);

    const scope = resolveEffectiveScopeForProject("proj1", "agent1", "manager");

    expect(scope).toEqual({ clawforce_log: ["write"] });
  });
});
