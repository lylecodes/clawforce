import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

const { loadWorkforceConfig } = await import("../../src/project.js");

describe("configurable defaults normalization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-defaults-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* already cleaned */ }
  });

  function writeConfig(content: string): string {
    const configPath = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(configPath, content);
    return configPath;
  }

  // --- Sweep config (#1) ---

  it("parses sweep config with all fields", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
sweep:
  stale_threshold_ms: 7200000
  proposal_ttl_ms: 43200000
  stale_dispatch_timeout_ms: 300000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.sweep).toEqual({
      staleThresholdMs: 7200000,
      proposalTtlMs: 43200000,
      staleDispatchTimeoutMs: 300000,
    });
  });

  it("sweep config returns empty object when no fields set", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
sweep: {}
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.sweep).toEqual({});
  });

  it("sweep config is undefined when section omitted", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.sweep).toBeUndefined();
  });

  // --- Dispatch extensions (#2-5, #7) ---

  it("parses dispatch.global_max_concurrency", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  global_max_concurrency: 5
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.globalMaxConcurrency).toBe(5);
  });

  it("parses dispatch.task_lease_ms", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  task_lease_ms: 3600000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.taskLeaseMs).toBe(3600000);
  });

  it("parses dispatch.queue_lease_ms", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  queue_lease_ms: 600000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.queueLeaseMs).toBe(600000);
  });

  it("parses dispatch.max_dispatch_attempts", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  max_dispatch_attempts: 5
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.maxDispatchAttempts).toBe(5);
  });

  it("parses dispatch.role_aliases", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  role_aliases:
    lead: manager
    worker: employee
    supervisor: manager
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.roleAliases).toEqual({
      lead: "manager",
      worker: "employee",
      supervisor: "manager",
    });
  });

  // --- Lifecycle extensions (#6) ---

  it("parses lifecycle.worker_non_compliance_action = BLOCKED", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
lifecycle:
  worker_non_compliance_action: BLOCKED
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.lifecycle?.workerNonComplianceAction).toBe("BLOCKED");
  });

  it("parses lifecycle.worker_non_compliance_action = REVIEW", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
lifecycle:
  worker_non_compliance_action: REVIEW
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.lifecycle?.workerNonComplianceAction).toBe("REVIEW");
  });

  it("parses lifecycle.worker_non_compliance_action = FAILED", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
lifecycle:
  worker_non_compliance_action: FAILED
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.lifecycle?.workerNonComplianceAction).toBe("FAILED");
  });

  it("parses lifecycle.worker_non_compliance_action = alert_only", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
lifecycle:
  worker_non_compliance_action: alert_only
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.lifecycle?.workerNonComplianceAction).toBe("alert_only");
  });

  it("ignores invalid worker_non_compliance_action value", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
lifecycle:
  worker_non_compliance_action: INVALID
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.lifecycle?.workerNonComplianceAction).toBeUndefined();
  });

  // --- Context config (#8) ---

  it("parses context.default_budget_chars", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
context:
  default_budget_chars: 25000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.context?.defaultBudgetChars).toBe(25000);
  });

  // --- Trust config (#9) ---

  it("parses trust config with all fields", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
trust:
  tier_thresholds:
    high: 0.9
    medium: 0.6
  protected_categories:
    - financial
    - security
  min_decisions_for_suggestion: 20
  min_approval_rate: 0.98
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.trust).toEqual({
      tierThresholdHigh: 0.9,
      tierThresholdMedium: 0.6,
      protectedCategories: ["financial", "security"],
      minDecisionsForSuggestion: 20,
      minApprovalRate: 0.98,
    });
  });

  it("parses trust config with partial fields", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
trust:
  min_decisions_for_suggestion: 5
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.trust?.minDecisionsForSuggestion).toBe(5);
    expect(config?.trust?.tierThresholdHigh).toBeUndefined();
  });

  // --- Verification config (#10) ---

  it("parses verification.default_gate_timeout_seconds", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
verification:
  enabled: true
  default_gate_timeout_seconds: 180
  gates:
    - name: typecheck
      command: npx tsc --noEmit
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.verification?.defaultGateTimeoutSeconds).toBe(180);
  });

  // --- Memory config (#11) ---

  it("parses memory.review_transcript_max_chars", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
memory:
  review_transcript_max_chars: 100000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.memory?.reviewTranscriptMaxChars).toBe(100000);
  });

  // --- Combined config ---

  it("parses all new config sections together", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
sweep:
  stale_threshold_ms: 7200000
dispatch:
  global_max_concurrency: 5
  task_lease_ms: 3600000
  queue_lease_ms: 600000
  max_dispatch_attempts: 5
  role_aliases:
    supervisor: manager
lifecycle:
  worker_non_compliance_action: REVIEW
context:
  default_budget_chars: 25000
trust:
  tier_thresholds:
    high: 0.85
    medium: 0.55
  min_decisions_for_suggestion: 15
verification:
  default_gate_timeout_seconds: 180
memory:
  review_transcript_max_chars: 75000
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.sweep?.staleThresholdMs).toBe(7200000);
    expect(config?.dispatch?.globalMaxConcurrency).toBe(5);
    expect(config?.dispatch?.taskLeaseMs).toBe(3600000);
    expect(config?.dispatch?.queueLeaseMs).toBe(600000);
    expect(config?.dispatch?.maxDispatchAttempts).toBe(5);
    expect(config?.dispatch?.roleAliases).toEqual({ supervisor: "manager" });
    expect(config?.lifecycle?.workerNonComplianceAction).toBe("REVIEW");
    expect(config?.context?.defaultBudgetChars).toBe(25000);
    expect(config?.trust?.tierThresholdHigh).toBe(0.85);
    expect(config?.trust?.tierThresholdMedium).toBe(0.55);
    expect(config?.trust?.minDecisionsForSuggestion).toBe(15);
    expect(config?.verification?.defaultGateTimeoutSeconds).toBe(180);
    expect(config?.memory?.reviewTranscriptMaxChars).toBe(75000);
  });
});
