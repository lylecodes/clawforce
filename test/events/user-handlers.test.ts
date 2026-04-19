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

const { getMemoryDb } = await import("../../src/db.js");
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { processEvents, getBuiltinHandler, registerBuiltinHandler, resetHandlerRegistryForTest } = await import("../../src/events/router.js");
const { createTask, listTasks } = await import("../../src/tasks/ops.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const project = await import("../../src/project.js");

describe("events/user-handlers", () => {
  let db: DatabaseSync;
  const PROJECT = "test-user-handlers";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function injectUserHandlers(handlers: Record<string, { actions: unknown[]; override_builtin?: boolean }>) {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue({
      eventHandlers: handlers,
    } as any);
  }

  it("user handlers run and create tasks from custom event types", () => {
    injectUserHandlers({
      "deployment_complete": {
        actions: [
          { action: "create_task", template: "Post-deploy check for {{payload.env}}" },
        ],
      },
    });

    ingestEvent(PROJECT, "deployment_complete", "webhook", { env: "production" }, undefined, db);
    const processed = processEvents(PROJECT, db);
    expect(processed).toBe(1);

    const tasks = listTasks(PROJECT, {}, db);
    expect(tasks.some(t => t.title === "Post-deploy check for production")).toBe(true);
  });

  it("built-in 'ignored' + user handlers → event marked 'handled'", () => {
    // Use a custom event type that built-in handler will ignore (handleCustom returns 'ignored')
    injectUserHandlers({
      "my_custom_event": {
        actions: [
          { action: "emit_event", event_type: "derived_from_custom" },
        ],
      },
    });

    ingestEvent(PROJECT, "my_custom_event", "tool", { data: 1 }, undefined, db);
    processEvents(PROJECT, db);

    // The original event should be marked "handled" not "ignored"
    const events = listEvents(PROJECT, { type: "my_custom_event" }, db);
    expect(events[0]!.status).toBe("handled");

    // And the derived event should exist
    const derived = listEvents(PROJECT, { type: "derived_from_custom" }, db);
    expect(derived).toHaveLength(1);
  });

  it("no user handlers configured → same behavior as before", () => {
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue(null);

    ingestEvent(PROJECT, "unknown_event_type", "tool", {}, undefined, db);
    processEvents(PROJECT, db);

    const events = listEvents(PROJECT, { type: "unknown_event_type" }, db);
    expect(events[0]!.status).toBe("ignored");
  });

  it("failed user action does not block other actions", () => {
    injectUserHandlers({
      "multi_action_event": {
        actions: [
          { action: "escalate", to: "manager" },  // Will fail — no manager registered
          { action: "create_task", template: "Should still succeed" },
        ],
      },
    });

    ingestEvent(PROJECT, "multi_action_event", "tool", {}, undefined, db);
    processEvents(PROJECT, db);

    // Second action should still have run
    const tasks = listTasks(PROJECT, {}, db);
    expect(tasks.some(t => t.title === "Should still succeed")).toBe(true);
  });

  it("user-defined event type (not in built-in EventType union) processes correctly", () => {
    injectUserHandlers({
      "acme_webhook_received": {
        actions: [
          { action: "create_task", template: "Handle ACME webhook: {{payload.hookId}}" },
        ],
      },
    });

    ingestEvent(PROJECT, "acme_webhook_received", "webhook", { hookId: "hook-99" }, undefined, db);
    processEvents(PROJECT, db);

    const events = listEvents(PROJECT, { type: "acme_webhook_received" }, db);
    expect(events[0]!.status).toBe("handled");

    const tasks = listTasks(PROJECT, {}, db);
    expect(tasks.some(t => t.title === "Handle ACME webhook: hook-99")).toBe(true);
  });

  it("multiple user handlers for same event type all execute", () => {
    injectUserHandlers({
      "build_failed": {
        actions: [
          { action: "create_task", template: "Fix build {{payload.buildNum}}" },
          { action: "emit_event", event_type: "build_failure_logged" },
        ],
      },
    });

    ingestEvent(PROJECT, "build_failed", "webhook", { buildNum: 123 }, undefined, db);
    processEvents(PROJECT, db);

    const tasks = listTasks(PROJECT, {}, db);
    expect(tasks.some(t => t.title === "Fix build 123")).toBe(true);

    const derivedEvents = listEvents(PROJECT, { type: "build_failure_logged" }, db);
    expect(derivedEvents).toHaveLength(1);
  });

  it("override_builtin=true skips built-in handler but runs user actions", () => {
    // dispatch_failed normally re-enqueues the task. With override_builtin,
    // the built-in re-enqueue should NOT happen, but user actions should run.
    const task = createTask({ projectId: PROJECT, title: "Override test", createdBy: "agent:pm" }, db);

    // Drain the auto-emitted task_created event
    processEvents(PROJECT, db);

    injectUserHandlers({
      "dispatch_failed": {
        override_builtin: true,
        actions: [
          { action: "emit_event", event_type: "custom_dispatch_failure_handled" },
        ],
      },
    });

    ingestEvent(PROJECT, "dispatch_failed", "internal", {
      taskId: task.id,
      error: "spawn failed",
    }, undefined, db);

    processEvents(PROJECT, db);

    // Built-in handler would have re-enqueued → queue should be empty
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBe(0);

    // User action should have run — derived event should exist
    const derived = listEvents(PROJECT, { type: "custom_dispatch_failure_handled" }, db);
    expect(derived).toHaveLength(1);

    // Original event should be marked "handled" (user actions ran)
    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events[0]!.status).toBe("handled");
  });

  it("override_builtin=false (default) runs both built-in and user actions", () => {
    const task = createTask({ projectId: PROJECT, title: "No override test", createdBy: "agent:pm" }, db);

    // Drain the auto-emitted task_created event
    processEvents(PROJECT, db);

    injectUserHandlers({
      "dispatch_failed": {
        actions: [
          { action: "emit_event", event_type: "also_notified" },
        ],
      },
    });

    ingestEvent(PROJECT, "dispatch_failed", "internal", {
      taskId: task.id,
      error: "spawn failed",
    }, undefined, db);

    processEvents(PROJECT, db);

    // Built-in handler should have re-enqueued the task
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBe(1);

    // User action should also have run
    const derived = listEvents(PROJECT, { type: "also_notified" }, db);
    expect(derived).toHaveLength(1);
  });

  it("getBuiltinHandler returns registered handlers", () => {
    const handler = getBuiltinHandler("task_completed");
    expect(handler).toBeTypeOf("function");

    const noHandler = getBuiltinHandler("nonexistent_type");
    expect(noHandler).toBeUndefined();
  });

  it("registerBuiltinHandler adds custom built-in handler", () => {
    const customHandler = vi.fn().mockReturnValue({ action: "handled" });
    registerBuiltinHandler("my_custom_builtin", customHandler);

    ingestEvent(PROJECT, "my_custom_builtin", "tool", { data: 1 }, undefined, db);
    processEvents(PROJECT, db);

    expect(customHandler).toHaveBeenCalledTimes(1);

    // Clean up
    resetHandlerRegistryForTest();
  });
});
