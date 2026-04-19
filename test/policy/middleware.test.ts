import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { withPolicyCheck } = await import("../../src/policy/middleware.js");
const { registerPolicies, resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
const projectModule = await import("../../src/project.js");

describe("policy/middleware", () => {
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

  it("allows execution when no policies are configured", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: null,
    });

    const wrapped = withPolicyCheck(execute, {
      projectId: PROJECT,
      agentId: "agent:test",
      toolName: "clawforce_task",
    });

    const result = await wrapped({ action: "get" });
    expect(execute).toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text).ok).toBe(true);
  });

  it("blocks tool when action_scope policy denies it", async () => {
    // Register a policy that only allows clawforce_task
    registerPolicies(PROJECT, [
      {
        name: "worker-scope",
        type: "action_scope",
        target: "agent:worker",
        config: { allowed_tools: ["clawforce_task"] },
      },
    ], db);

    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: null,
    });

    const wrapped = withPolicyCheck(execute, {
      projectId: PROJECT,
      agentId: "agent:worker",
      toolName: "clawforce_setup", // Not in allowed list
    });

    const result = await wrapped({ action: "explain" });
    expect(execute).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("Policy violation");
  });

  it("blocks tool call via risk gate when risk config blocks high tier", async () => {
    // Set up risk config that blocks tool_call actions matching a pattern
    vi.spyOn(projectModule, "getExtendedProjectConfig").mockReturnValue({
      riskTiers: {
        enabled: true,
        defaultTier: "low",
        policies: {
          low: { gate: "none" },
          medium: { gate: "none" },
          high: { gate: "human_approval" }, // blocks
          critical: { gate: "human_approval" },
        },
        patterns: [
          {
            tier: "high" as const,
            match: { action_type: "tool_call", tool_name: "clawforce_setup" },
          },
        ],
      },
    });

    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: null,
    });

    const wrapped = withPolicyCheck(execute, {
      projectId: PROJECT,
      agentId: "agent:worker",
      toolName: "clawforce_setup",
    });

    const result = await wrapped({ action: "activate" });
    expect(execute).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.riskTier).toBe("high");
  });

  it("allows tool call when risk config is not enabled", async () => {
    vi.spyOn(projectModule, "getExtendedProjectConfig").mockReturnValue(null);

    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: null,
    });

    const wrapped = withPolicyCheck(execute, {
      projectId: PROJECT,
      agentId: "agent:worker",
      toolName: "clawforce_task",
    });

    const result = await wrapped({ action: "get" });
    expect(execute).toHaveBeenCalled();
  });
});
