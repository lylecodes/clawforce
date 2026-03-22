import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const {
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
} = await import("../../src/project.js");

const {
  getEffectiveVerificationConfig,
  runVerificationIfConfigured,
} = await import("../../src/verification/lifecycle.js");

describe("verification/lifecycle", () => {
  const PROJECT = "test-verify-lifecycle";

  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("returns disabled when no verification is configured", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
    });

    const config = getEffectiveVerificationConfig(PROJECT);

    expect(config.enabled).toBe(false);
    expect(config.gates).toEqual([]);
  });

  it("returns enabled when verification config is registered", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
      verification: {
        enabled: true,
        gates: [
          { name: "typecheck", command: "echo ok", required: true },
        ],
        total_timeout_seconds: 120,
      },
    });

    const config = getEffectiveVerificationConfig(PROJECT);

    expect(config.enabled).toBe(true);
    expect(config.gates).toHaveLength(1);
    expect(config.gates![0]!.name).toBe("typecheck");
    expect(config.total_timeout_seconds).toBe(120);
  });

  it("returns git config when specified", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
      verification: {
        enabled: true,
        gates: [],
        git: {
          enabled: true,
          base_branch: "develop",
          auto_merge: true,
          delete_after_merge: true,
        },
      },
    });

    const config = getEffectiveVerificationConfig(PROJECT);

    expect(config.git?.enabled).toBe(true);
    expect(config.git?.base_branch).toBe("develop");
    expect(config.git?.auto_merge).toBe(true);
    expect(config.git?.delete_after_merge).toBe(true);
  });

  it("runVerificationIfConfigured returns null when disabled", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
    });

    const result = runVerificationIfConfigured(PROJECT, "/tmp");

    expect(result).toBeNull();
  });

  it("runVerificationIfConfigured returns null when no projectDir", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
      verification: {
        enabled: true,
        gates: [{ name: "test", command: "echo ok", required: true }],
      },
    });

    const result = runVerificationIfConfigured(PROJECT, undefined);

    expect(result).toBeNull();
  });

  it("runVerificationIfConfigured runs gates when configured", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {},
      verification: {
        enabled: true,
        gates: [
          { name: "echo-test", command: "echo ok", required: true },
        ],
      },
    });

    const result = runVerificationIfConfigured(PROJECT, process.cwd());

    expect(result).not.toBeNull();
    expect(result!.result.allRequiredPassed).toBe(true);
    expect(result!.formatted).toContain("echo-test (PASS)");
  });
});
