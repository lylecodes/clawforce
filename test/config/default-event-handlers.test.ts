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

const { registerWorkforceConfig, getExtendedProjectConfig } = await import("../../src/project.js");

describe("default event handlers for event-driven mode", () => {
  it("injects default event handlers when dispatch.mode is event-driven", () => {
    registerWorkforceConfig("test-event-defaults", {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
        worker: {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        mode: "event-driven",
      },
    });

    const extConfig = getExtendedProjectConfig("test-event-defaults");
    expect(extConfig?.eventHandlers).toBeDefined();

    // Check default handlers are injected
    expect(extConfig?.eventHandlers?.task_review_ready).toBeDefined();
    expect(extConfig?.eventHandlers?.task_review_ready?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "reactive",
    });

    expect(extConfig?.eventHandlers?.task_failed).toBeDefined();
    expect(extConfig?.eventHandlers?.task_failed?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "reactive",
    });

    // task_assigned is intentionally NOT a default handler — the built-in
    // handleTaskAssigned() in router.ts already enqueues for dispatch.
    // Having both would cause double-dispatch.
    expect(extConfig?.eventHandlers?.task_assigned).toBeUndefined();

    expect(extConfig?.eventHandlers?.budget_changed).toBeDefined();
    expect(extConfig?.eventHandlers?.budget_changed?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "planning",
    });
  });

  it("user config overrides default handlers per event type", () => {
    registerWorkforceConfig("test-event-override", {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
      },
      dispatch: {
        mode: "event-driven",
      },
      event_handlers: {
        task_assigned: { actions: [
          { action: "notify", message: "Custom handler for task_assigned" },
        ] },
      },
    });

    const extConfig = getExtendedProjectConfig("test-event-override");

    // task_assigned should be overridden by user config
    expect(extConfig?.eventHandlers?.task_assigned?.actions).toHaveLength(1);
    expect(extConfig?.eventHandlers?.task_assigned?.actions[0]).toEqual({
      action: "notify",
      message: "Custom handler for task_assigned",
    });

    // Other defaults should still be present
    expect(extConfig?.eventHandlers?.task_review_ready?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "reactive",
    });

    expect(extConfig?.eventHandlers?.budget_changed?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "planning",
    });
  });

  it("does not inject defaults when mode is not event-driven", () => {
    registerWorkforceConfig("test-cron-mode", {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
      },
      dispatch: {
        mode: "cron",
      },
    });

    const extConfig = getExtendedProjectConfig("test-cron-mode");
    expect(extConfig?.eventHandlers).toBeUndefined();
  });

  it("does not inject defaults when no dispatch config", () => {
    registerWorkforceConfig("test-no-dispatch", {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
      },
    });

    const extConfig = getExtendedProjectConfig("test-no-dispatch");
    // No extended config should be set at all since no config sections are present
    // (no dispatch, no policies, etc.)
    expect(extConfig?.eventHandlers).toBeUndefined();
  });
});
