import type { DatabaseSync } from "node:sqlite";
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
const { executeAction } = await import("../../src/events/actions.js");
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { createTask, listTasks } = await import("../../src/tasks/ops.js");
const { createMessage, listMessages, getMessage } = await import("../../src/messaging/store.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

import type { ClawforceEvent, EventActionConfig } from "../../src/types.js";

describe("events/actions", () => {
  let db: DatabaseSync;
  const PROJECT = "test-actions";

  function makeEvent(overrides?: Partial<ClawforceEvent>): ClawforceEvent {
    return {
      id: "evt-test-1",
      type: "custom_event",
      source: "tool",
      projectId: PROJECT,
      payload: { runId: 42, branch: "main" },
      status: "claimed",
      dedupKey: null,
      createdAt: Date.now(),
      claimedAt: Date.now(),
      processedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  describe("create_task", () => {
    it("creates a task with interpolated title", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "create_task",
        template: "Deploy failed for {{payload.branch}}",
        priority: "P1",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.action).toBe("create_task");
      expect(result.detail?.title).toBe("Deploy failed for main");
      expect(result.detail?.taskId).toBeTruthy();

      const tasks = listTasks(PROJECT, {}, db);
      expect(tasks.some(t => t.title === "Deploy failed for main")).toBe(true);
    });

    it("deduplicates when non-terminal task with same title exists", () => {
      const event = makeEvent();
      createTask({
        projectId: PROJECT,
        title: "Existing task",
        createdBy: "test",
      }, db);

      const config: EventActionConfig = {
        action: "create_task",
        template: "Existing task",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.detail?.deduplicated).toBe(true);
    });

    it("interpolates description", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "create_task",
        template: "Task for run {{payload.runId}}",
        description: "Run ID: {{payload.runId}}, branch: {{payload.branch}}",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);

      const tasks = listTasks(PROJECT, {}, db);
      const task = tasks.find(t => t.title === "Task for run 42");
      expect(task?.description).toBe("Run ID: 42, branch: main");
    });

    it("defaults priority to P2", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "create_task",
        template: "Default priority task",
      };

      executeAction(event, config, db);
      const tasks = listTasks(PROJECT, {}, db);
      const task = tasks.find(t => t.title === "Default priority task");
      expect(task?.priority).toBe("P2");
    });
  });

  describe("notify", () => {
    it("creates notification message to specified agent", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "notify",
        message: "Build {{payload.runId}} completed",
        to: "agent-ops",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.action).toBe("notify");
      expect(result.detail?.to).toBe("agent-ops");

      const msg = getMessage(PROJECT, result.detail?.messageId as string, db);
      expect(msg).toBeTruthy();
      expect(msg?.content).toBe("Build 42 completed");
      expect(msg?.type).toBe("notification");
    });

    it("returns error when no target agent found", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "notify",
        message: "Hello",
        // No `to` and no manager registered
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No target agent");
    });
  });

  describe("escalate", () => {
    it("creates escalation message with urgent priority", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "escalate",
        to: "agent-lead",
        message: "Event {{event.type}} needs attention",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.action).toBe("escalate");
      expect(result.detail?.to).toBe("agent-lead");

      const msg = getMessage(PROJECT, result.detail?.messageId as string, db);
      expect(msg).toBeTruthy();
      expect(msg?.type).toBe("escalation");
      expect(msg?.priority).toBe("urgent");
      expect(msg?.content).toBe("Event custom_event needs attention");
    });

    it("returns error when no escalation target found", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "escalate",
        to: "manager",
        // No manager registered
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No escalation target");
    });
  });

  describe("enqueue_work", () => {
    it("enqueues work from payload.taskId", () => {
      // Create a task first
      const task = createTask({ projectId: PROJECT, title: "Enqueue me", createdBy: "test" }, db);
      const event = makeEvent({ payload: { taskId: task.id } });

      const config: EventActionConfig = {
        action: "enqueue_work",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.detail?.taskId).toBe(task.id);
      expect(result.detail?.queueItemId).toBeTruthy();
    });

    it("returns error when no taskId available", () => {
      const event = makeEvent({ payload: {} });
      const config: EventActionConfig = {
        action: "enqueue_work",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No taskId");
    });
  });

  describe("emit_event", () => {
    it("ingests follow-on event with interpolated payload", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "emit_event",
        event_type: "followup_{{event.type}}",
        event_payload: {
          originalRun: "{{payload.runId}}",
          source: "chained",
        },
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);
      expect(result.detail?.type).toBe("followup_custom_event");
      expect(result.detail?.deduplicated).toBe(false);

      const events = listEvents(PROJECT, { type: "followup_custom_event" }, db);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ originalRun: "42", source: "chained" });
    });

    it("copies source event payload when no event_payload specified", () => {
      const event = makeEvent();
      const config: EventActionConfig = {
        action: "emit_event",
        event_type: "derived_event",
      };

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(true);

      const events = listEvents(PROJECT, { type: "derived_event" }, db);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.runId).toBe(42);
      expect(events[0]!.payload.sourceEventId).toBe("evt-test-1");
    });
  });

  describe("unknown action", () => {
    it("returns error for unknown action type", () => {
      const event = makeEvent();
      const config = { action: "bogus" } as unknown as EventActionConfig;

      const result = executeAction(event, config, db);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Unknown action type");
    });
  });
});
