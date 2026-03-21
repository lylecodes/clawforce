/**
 * Tests for the trigger processor (fireTrigger).
 *
 * Uses in-memory DB and registers trigger configs via registerWorkforceConfig
 * to exercise the full fire flow: lookup → enabled → cooldown → conditions →
 * template → create task → ingest event.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (before dynamic imports) ----

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

// ---- Dynamic imports ----

const { getMemoryDb } = await import("../../src/db.js");
const { fireTrigger, clearCooldowns, getTriggerDefinitions } = await import("../../src/triggers/processor.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { listTasks } = await import("../../src/tasks/ops.js");
const { listEvents } = await import("../../src/events/store.js");

import type { WorkforceConfig, TriggerDefinition } from "../../src/types.js";

// ---- Helpers ----

const DOMAIN = "test-triggers";

function makeWorkforceConfig(triggers: Record<string, TriggerDefinition>): WorkforceConfig {
  return {
    name: "trigger-test",
    agents: {
      worker: {
        extends: "employee",
        briefing: [],
        expectations: [{ tool: "clawforce_log", action: "outcome", min_calls: 1 }],
        performance_policy: { action: "alert" },
      },
    },
    triggers,
  };
}

// ---- Tests ----

describe("fireTrigger", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();
    clearCooldowns();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    resetEnforcementConfigForTest();
  });

  // --- trigger not found ---

  it("returns error when trigger does not exist", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({}));
    const result = fireTrigger(DOMAIN, "nonexistent", {}, "sdk", db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not found");
  });

  // --- disabled trigger ---

  it("returns error when trigger is disabled", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      my_trigger: { enabled: false, task_template: "Test" },
    }));
    const result = fireTrigger(DOMAIN, "my_trigger", {}, "sdk", db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  // --- source restriction ---

  it("returns error when source is not allowed", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      webhook_only: {
        sources: ["webhook"],
        task_template: "Webhook event",
      },
    }));
    const result = fireTrigger(DOMAIN, "webhook_only", {}, "cli", db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  it("passes when source is in allowed list", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      webhook_only: {
        sources: ["webhook", "sdk"],
        task_template: "Webhook event",
      },
    }));
    const result = fireTrigger(DOMAIN, "webhook_only", {}, "sdk", db);
    expect(result.ok).toBe(true);
  });

  // --- conditions ---

  it("returns error when conditions are not met", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      cond_trigger: {
        conditions: [{ field: "status", operator: "==", value: "failed" }],
        task_template: "Failed build",
      },
    }));
    const result = fireTrigger(DOMAIN, "cond_trigger", { status: "success" }, "sdk", db);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Conditions not met");
    expect(result.conditionsResult).toBeDefined();
    expect(result.conditionsResult!.pass).toBe(false);
  });

  it("fires when conditions are met", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      cond_trigger: {
        conditions: [{ field: "status", operator: "==", value: "failed" }],
        task_template: "Build failed for {{payload.branch}}",
      },
    }));
    const result = fireTrigger(DOMAIN, "cond_trigger", { status: "failed", branch: "main" }, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.title).toBe("Build failed for main");
  });

  // --- create_task action (default) ---

  it("creates a task with interpolated template", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      deploy: {
        task_template: "Deploy {{payload.env}} failed",
        task_description: "Error: {{payload.error}}",
        task_priority: "P1",
        assign_to: "worker",
        tags: ["deploy", "urgent"],
      },
    }));

    const result = fireTrigger(DOMAIN, "deploy", { env: "production", error: "timeout" }, "webhook", db);
    expect(result.ok).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.title).toBe("Deploy production failed");
    expect(result.task!.description).toBe("Error: timeout");
    expect(result.task!.priority).toBe("P1");
    expect(result.task!.assignedTo).toBe("worker");
    expect(result.task!.tags).toEqual(["deploy", "urgent"]);

    // Verify task is persisted in DB
    const tasks = listTasks(DOMAIN, {}, db);
    expect(tasks.some(t => t.title === "Deploy production failed")).toBe(true);
  });

  it("uses default title when no template is provided", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      simple: {},
    }));
    const result = fireTrigger(DOMAIN, "simple", {}, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task!.title).toBe("Trigger: simple");
  });

  it("uses default priority P2 when not specified", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      basic: { task_template: "Basic trigger" },
    }));
    const result = fireTrigger(DOMAIN, "basic", {}, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task!.priority).toBe("P2");
  });

  // --- emit_event action ---

  it("emits an event when action is emit_event", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      event_trigger: {
        action: "emit_event",
      },
    }));
    const result = fireTrigger(DOMAIN, "event_trigger", { key: "val" }, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task).toBeUndefined();

    // Should have both the action event and the audit event
    const events = listEvents(DOMAIN, {}, db);
    const triggerEvents = events.filter(e => e.type === "trigger:event_trigger");
    expect(triggerEvents.length).toBe(1);
  });

  // --- none action ---

  it("does not create task or extra event when action is none", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      noop: { action: "none" },
    }));
    const result = fireTrigger(DOMAIN, "noop", {}, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task).toBeUndefined();

    const tasks = listTasks(DOMAIN, {}, db);
    expect(tasks.length).toBe(0);
  });

  // --- enqueue action ---

  it("creates task and enqueues it when action is enqueue", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      enqueue_trigger: {
        action: "enqueue",
        task_template: "Queued work",
      },
    }));
    const result = fireTrigger(DOMAIN, "enqueue_trigger", {}, "sdk", db);
    expect(result.ok).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.title).toBe("Queued work");

    // Verify task was created
    const tasks = listTasks(DOMAIN, {}, db);
    expect(tasks.some(t => t.title === "Queued work")).toBe(true);
  });

  // --- audit event ---

  it("ingests a trigger_fired audit event on success", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      audit_test: { task_template: "Audit" },
    }));
    const result = fireTrigger(DOMAIN, "audit_test", { key: "val" }, "cli", db);
    expect(result.ok).toBe(true);
    expect(result.eventId).toBeTruthy();

    const events = listEvents(DOMAIN, {}, db);
    const auditEvents = events.filter(e => e.type === "trigger_fired");
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0]!.payload.triggerName).toBe("audit_test");
    expect(auditEvents[0]!.payload.source).toBe("cli");
  });

  // --- cooldown ---

  it("suppresses trigger during cooldown window", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      cooldown_test: {
        task_template: "Cooldown",
        cooldownMs: 60_000,
      },
    }));

    // First fire should succeed
    const first = fireTrigger(DOMAIN, "cooldown_test", {}, "sdk", db);
    expect(first.ok).toBe(true);

    // Second fire within cooldown window should fail
    const second = fireTrigger(DOMAIN, "cooldown_test", {}, "sdk", db);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("cooldown");
  });

  it("allows fire after cooldown is cleared", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      cooldown_clear: {
        task_template: "Cooldown clear",
        cooldownMs: 60_000,
      },
    }));

    fireTrigger(DOMAIN, "cooldown_clear", {}, "sdk", db);
    clearCooldowns();
    const result = fireTrigger(DOMAIN, "cooldown_clear", {}, "sdk", db);
    expect(result.ok).toBe(true);
  });

  // --- no cooldown ---

  it("fires multiple times when no cooldown is set", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      no_cooldown: { task_template: "No cooldown" },
    }));

    const r1 = fireTrigger(DOMAIN, "no_cooldown", {}, "sdk", db);
    const r2 = fireTrigger(DOMAIN, "no_cooldown", {}, "sdk", db);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  // --- metadata ---

  it("stores trigger metadata on created task", () => {
    registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
      meta_test: { task_template: "Meta test" },
    }));
    const result = fireTrigger(DOMAIN, "meta_test", { source_data: "xyz" }, "webhook", db);
    expect(result.ok).toBe(true);
    expect(result.task!.metadata).toBeDefined();
    expect(result.task!.metadata!.triggerName).toBe("meta_test");
    expect(result.task!.metadata!.triggerSource).toBe("webhook");
  });
});

// ---------- getTriggerDefinitions ----------

describe("getTriggerDefinitions", () => {
  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("returns empty object when no triggers are configured", () => {
    registerWorkforceConfig("no-triggers", {
      name: "no-triggers",
      agents: {},
    });
    expect(getTriggerDefinitions("no-triggers")).toEqual({});
  });

  it("returns trigger definitions when configured", () => {
    registerWorkforceConfig("with-triggers", makeWorkforceConfig({
      deploy_fail: { task_template: "Deploy failed", severity: "high" },
      ci_broken: { task_template: "CI broken" },
    }));
    const defs = getTriggerDefinitions("with-triggers");
    expect(Object.keys(defs)).toEqual(["deploy_fail", "ci_broken"]);
    expect(defs.deploy_fail!.severity).toBe("high");
  });
});

// Helper function used in tests
function makeWorkforceConfigHelper(triggers: Record<string, TriggerDefinition>): WorkforceConfig {
  return makeWorkforceConfig(triggers);
}
