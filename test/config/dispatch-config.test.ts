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

describe("dispatch config normalization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-dispatch-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* already cleaned */ }
  });

  function writeConfig(content: string): string {
    const configPath = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(configPath, content);
    return configPath;
  }

  it("parses dispatch.mode field", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  mode: event-driven
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.mode).toBe("event-driven");
  });

  it("parses dispatch.budget_pacing with defaults", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  budget_pacing:
    enabled: true
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.budget_pacing).toBeDefined();
    expect(config?.dispatch?.budget_pacing?.enabled).toBe(true);
    expect(config?.dispatch?.budget_pacing?.reactive_reserve_pct).toBe(20);
    expect(config?.dispatch?.budget_pacing?.low_budget_threshold).toBe(10);
    expect(config?.dispatch?.budget_pacing?.critical_threshold).toBe(5);
  });

  it("parses custom budget_pacing values", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  budget_pacing:
    enabled: true
    reactive_reserve_pct: 30
    low_budget_threshold: 15
    critical_threshold: 3
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.budget_pacing?.reactive_reserve_pct).toBe(30);
    expect(config?.dispatch?.budget_pacing?.low_budget_threshold).toBe(15);
    expect(config?.dispatch?.budget_pacing?.critical_threshold).toBe(3);
  });

  it("parses dispatch.lead_schedule", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  lead_schedule:
    planning_sessions_per_day: 5
    planning_model: opus
    review_model: sonnet
    wake_on:
      - task_review_ready
      - task_failed
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.lead_schedule?.planning_sessions_per_day).toBe(5);
    expect(config?.dispatch?.lead_schedule?.planning_model).toBe("opus");
    expect(config?.dispatch?.lead_schedule?.review_model).toBe("sonnet");
    expect(config?.dispatch?.lead_schedule?.wake_on).toEqual(["task_review_ready", "task_failed"]);
  });

  it("parses dispatch.worker config", () => {
    const configPath = writeConfig(`
name: test
agents:
  worker:
    extends: employee
dispatch:
  worker:
    session_loop: true
    max_tasks_per_session: 3
    idle_timeout_ms: 60000
    wake_on:
      - task_assigned
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.worker?.session_loop).toBe(true);
    expect(config?.dispatch?.worker?.max_tasks_per_session).toBe(3);
    expect(config?.dispatch?.worker?.idle_timeout_ms).toBe(60000);
    expect(config?.dispatch?.worker?.wake_on).toEqual(["task_assigned"]);
  });

  it("parses dispatch.verifier config", () => {
    const configPath = writeConfig(`
name: test
agents:
  verifier:
    extends: verifier
dispatch:
  verifier:
    wake_on:
      - task_review_ready
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.verifier?.wake_on).toEqual(["task_review_ready"]);
  });

  it("applies defaults for missing worker sub-fields", () => {
    const configPath = writeConfig(`
name: test
agents:
  worker:
    extends: employee
dispatch:
  worker:
    session_loop: false
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.worker?.session_loop).toBe(false);
    expect(config?.dispatch?.worker?.max_tasks_per_session).toBe(5);
    expect(config?.dispatch?.worker?.idle_timeout_ms).toBe(300000);
  });

  it("applies defaults for missing lead_schedule sub-fields", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  lead_schedule:
    planning_model: opus
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.lead_schedule?.planning_sessions_per_day).toBe(3);
    expect(config?.dispatch?.lead_schedule?.planning_model).toBe("opus");
  });

  it("ignores invalid dispatch mode values", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
dispatch:
  mode: invalid_mode
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.dispatch?.mode).toBeUndefined();
  });

  it("parses dispatch_agent in event_handlers", () => {
    const configPath = writeConfig(`
name: test
agents:
  lead:
    extends: manager
event_handlers:
  task_assigned:
    - action: dispatch_agent
      agent_role: worker
      model: sonnet
      session_type: active
`);

    const config = loadWorkforceConfig(configPath);
    expect(config?.event_handlers?.task_assigned).toBeDefined();
    expect(config?.event_handlers?.task_assigned?.[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "worker",
      model: "sonnet",
      session_type: "active",
    });
  });
});
