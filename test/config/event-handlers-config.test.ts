import { describe, expect, it, vi } from "vitest";

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

const { validateWorkforceConfig } = await import("../../src/config-validator.js");

import type { WorkforceConfig, AgentConfig } from "../../src/types.js";

function makeAgent(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    extends: "employee",
    expectations: [{ tool: "clawforce_log", action: "outcome", min_calls: 1 }],
    briefing: [],
    performance_policy: { action: "log" },
    ...overrides,
  } as AgentConfig;
}

function makeConfig(overrides?: Partial<WorkforceConfig>): WorkforceConfig {
  return {
    name: "test-project",
    agents: { "agent-1": makeAgent() },
    ...overrides,
  } as WorkforceConfig;
}

describe("config-validator/event-handlers", () => {
  it("valid event handlers produce no warnings", () => {
    const config = makeConfig({
      event_handlers: {
        "deploy_complete": [
          { action: "create_task", template: "Post-deploy check" },
        ],
        "build_failed": [
          { action: "notify", message: "Build failed!" },
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    const ehWarnings = warnings.filter(w => w.message.includes("event_handlers"));
    expect(ehWarnings).toHaveLength(0);
  });

  it("unknown action type generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "bogus_action" } as any,
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    const actionError = warnings.find(w => w.message.includes("unknown action"));
    expect(actionError).toBeTruthy();
    expect(actionError?.level).toBe("error");
  });

  it("create_task without template generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "create_task" } as any,
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("create_task") && w.message.includes("template"))).toBe(true);
  });

  it("notify without message generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "notify" } as any,
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("notify") && w.message.includes("message"))).toBe(true);
  });

  it("escalate without to generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "escalate" } as any,
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("escalate") && w.message.includes("\"to\""))).toBe(true);
  });

  it("emit_event without event_type generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "emit_event" } as any,
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("emit_event") && w.message.includes("event_type"))).toBe(true);
  });

  it("empty event type key generates error", () => {
    const config = makeConfig({
      event_handlers: {
        "": [{ action: "notify", message: "hi" }],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("empty event type"))).toBe(true);
  });

  it("unknown assign_to target generates warning", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "create_task", template: "Test", assign_to: "nonexistent-agent" },
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w =>
      w.message.includes("assign_to") && w.message.includes("nonexistent-agent") && w.level === "warn",
    )).toBe(true);
  });

  it("assign_to 'auto' does not generate warning", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "create_task", template: "Test", assign_to: "auto" },
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("assign_to"))).toBe(false);
  });

  it("unknown escalate target generates warning", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "escalate", to: "unknown-agent" },
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w =>
      w.message.includes("escalate") && w.message.includes("unknown-agent") && w.level === "warn",
    )).toBe(true);
  });

  it("escalate to 'manager' does not generate warning", () => {
    const config = makeConfig({
      event_handlers: {
        "test_event": [
          { action: "escalate", to: "manager" },
        ],
      },
    });

    const warnings = validateWorkforceConfig(config);
    expect(warnings.some(w => w.message.includes("escalate target"))).toBe(false);
  });
});
