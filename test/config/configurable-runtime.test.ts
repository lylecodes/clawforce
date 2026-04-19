import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

// Mock auto-kill to avoid needing real abort controllers
vi.mock("../../src/audit/auto-kill.js", () => ({
  killAllStuckAgents: vi.fn(async () => 0),
}));

// Mock stuck detector
vi.mock("../../src/audit/stuck-detector.js", () => ({
  detectStuckAgents: vi.fn(() => []),
}));

// Mock dispatch modules to prevent actual spawning/cron creation
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn(() => "mock prompt"),
}));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async () => ({ ok: false, error: "mock: not available in tests" })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { registerWorkforceConfig, getExtendedProjectConfig } = await import("../../src/project.js");
const { sweep } = await import("../../src/sweep/actions.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { getEffectiveLifecycleConfig } = await import("../../src/safety.js");
const { getEffectiveVerificationConfig } = await import("../../src/verification/lifecycle.js");
const { runVerificationGates } = await import("../../src/verification/runner.js");

describe("configurable defaults runtime", () => {
  let db: DatabaseSync;
  const PROJECT = "config-runtime-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("extended project config stores sweep config", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      sweep: { staleThresholdMs: 1000, proposalTtlMs: 2000, staleDispatchTimeoutMs: 500 },
    });

    const extConfig = getExtendedProjectConfig(PROJECT);
    expect(extConfig?.sweep?.staleThresholdMs).toBe(1000);
    expect(extConfig?.sweep?.proposalTtlMs).toBe(2000);
    expect(extConfig?.sweep?.staleDispatchTimeoutMs).toBe(500);
  });

  it("extended project config stores trust config", () => {
    registerWorkforceConfig(PROJECT + "-trust", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      trust: { tierThresholdHigh: 0.9, tierThresholdMedium: 0.6, minDecisionsForSuggestion: 20, minApprovalRate: 0.98 },
    });

    const extConfig = getExtendedProjectConfig(PROJECT + "-trust");
    expect(extConfig?.trust?.tierThresholdHigh).toBe(0.9);
    expect(extConfig?.trust?.tierThresholdMedium).toBe(0.6);
    expect(extConfig?.trust?.minDecisionsForSuggestion).toBe(20);
    expect(extConfig?.trust?.minApprovalRate).toBe(0.98);
  });

  it("extended project config stores context config", () => {
    registerWorkforceConfig(PROJECT + "-ctx", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      context: { defaultBudgetChars: 25000 },
    });

    const extConfig = getExtendedProjectConfig(PROJECT + "-ctx");
    expect(extConfig?.context?.defaultBudgetChars).toBe(25000);
  });

  it("extended project config stores memory config", () => {
    registerWorkforceConfig(PROJECT + "-mem", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      memory: { reviewTranscriptMaxChars: 100000 },
    });

    const extConfig = getExtendedProjectConfig(PROJECT + "-mem");
    expect(extConfig?.memory?.reviewTranscriptMaxChars).toBe(100000);
  });

  it("extended project config stores dispatch extensions", () => {
    registerWorkforceConfig(PROJECT + "-disp", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      dispatch: {
        globalMaxConcurrency: 5,
        taskLeaseMs: 3600000,
        queueLeaseMs: 600000,
        maxDispatchAttempts: 5,
        roleAliases: { supervisor: "manager" },
      },
    });

    const extConfig = getExtendedProjectConfig(PROJECT + "-disp");
    expect(extConfig?.dispatch?.globalMaxConcurrency).toBe(5);
    expect(extConfig?.dispatch?.taskLeaseMs).toBe(3600000);
    expect(extConfig?.dispatch?.queueLeaseMs).toBe(600000);
    expect(extConfig?.dispatch?.maxDispatchAttempts).toBe(5);
    expect(extConfig?.dispatch?.roleAliases).toEqual({ supervisor: "manager" });
  });

  it("extended project config stores execution config", () => {
    registerWorkforceConfig(PROJECT + "-exec", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      execution: {
        mode: "dry_run",
        defaultMutationPolicy: "simulate",
        policies: {
          tools: {
            clawforce_entity: {
              actions: {
                create: "allow",
                transition: "require_approval",
              },
            },
          },
        },
      },
    });

    const extConfig = getExtendedProjectConfig(PROJECT + "-exec");
    expect(extConfig?.execution?.mode).toBe("dry_run");
    expect(extConfig?.execution?.defaultMutationPolicy).toBe("simulate");
    expect(extConfig?.execution?.policies?.tools?.clawforce_entity?.actions?.transition).toBe("require_approval");
  });

  it("effective lifecycle config includes workerNonComplianceAction with default", () => {
    registerWorkforceConfig(PROJECT + "-lc1", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
    });

    const lc = getEffectiveLifecycleConfig(PROJECT + "-lc1");
    expect(lc.workerNonComplianceAction).toBe("BLOCKED");
  });

  it("effective lifecycle config reads custom workerNonComplianceAction", () => {
    registerWorkforceConfig(PROJECT + "-lc2", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      lifecycle: { workerNonComplianceAction: "REVIEW" },
    });

    const lc = getEffectiveLifecycleConfig(PROJECT + "-lc2");
    expect(lc.workerNonComplianceAction).toBe("REVIEW");
  });

  it("effective verification config reads defaultGateTimeoutSeconds", () => {
    registerWorkforceConfig(PROJECT + "-vc", {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      verification: { enabled: true, defaultGateTimeoutSeconds: 180 },
    });

    const vc = getEffectiveVerificationConfig(PROJECT + "-vc");
    expect(vc.defaultGateTimeoutSeconds).toBe(180);
  });

  it("sweep uses config thresholds when available", async () => {
    // Register sweep config with very short thresholds
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { lead: { extends: "manager", briefing: [], expectations: [], performancePolicy: { action: "retry" } } },
      sweep: { staleThresholdMs: 100 },
    });

    // Create a task and backdate it
    const task = createTask({
      projectId: PROJECT,
      title: "stale task",
      createdBy: "test",
      priority: "P2",
    }, db);
    // Set updated_at to a long time ago
    db.prepare("UPDATE tasks SET state = 'IN_PROGRESS', updated_at = ? WHERE id = ?")
      .run(Date.now() - 200, task.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    // Task should be detected as stale with the 100ms threshold from config
    expect(result.stale).toBeGreaterThanOrEqual(1);
  });

  it("verification runner uses defaultGateTimeoutSeconds from options", () => {
    // runVerificationGates accepts defaultGateTimeoutSeconds in options
    // Testing that the option parameter is properly threaded through
    const gates = [
      { name: "test-gate", command: "echo hello" },
    ];
    const result = runVerificationGates(gates, process.cwd(), {
      totalTimeoutMs: 5000,
      defaultGateTimeoutSeconds: 60,
    });
    // The gate should run (echo is fast) — we're just verifying the option doesn't break anything
    expect(result.results.length).toBe(1);
    expect(result.results[0].name).toBe("test-gate");
  });
});
