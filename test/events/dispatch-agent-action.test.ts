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
const { executeAction, findAgentByRole } = await import("../../src/events/actions.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { registerWorkforceConfig } = await import("../../src/project.js");

import type { ClawforceEvent, EventActionConfig } from "../../src/types.js";

describe("dispatch_agent action", () => {
  let db: DatabaseSync;
  const PROJECT = "test-dispatch-agent";

  function makeEvent(overrides?: Partial<ClawforceEvent>): ClawforceEvent {
    return {
      id: "evt-dispatch-1",
      type: "task_assigned",
      source: "internal",
      projectId: PROJECT,
      payload: { taskId: "task-1" },
      status: "pending",
      createdAt: Date.now(),
      ...overrides,
    } as ClawforceEvent;
  }

  beforeEach(() => {
    db = getMemoryDb();

    // Register agents with workforce config
    registerWorkforceConfig(PROJECT, {
      name: "test-project",
      agents: {
        "cf-lead": {
          extends: "manager",
          title: "Lead",
          persona: "Test lead",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
        "cf-worker": {
          extends: "employee",
          title: "Worker",
          persona: "Test worker",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
        "cf-verifier": {
          extends: "verifier",
          title: "Verifier",
          persona: "Test verifier",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
    });

    // Create a task for dispatch
    createTask({
      projectId: PROJECT,
      title: "Test task for dispatch",
      description: "Acceptance criteria: test passes",
      createdBy: "test",
      assignedTo: "cf-worker",
    }, db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("resolves worker agent by role and enqueues", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "worker",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("dispatch_agent");
    expect(result.detail?.agentId).toBe("cf-worker");
    expect(result.detail?.queueItemId).toBeTruthy();
    expect(result.detail?.taskId).toBe("task-1");
  });

  it("resolves lead agent by role and enqueues", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "lead",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(true);
    expect(result.detail?.agentId).toBe("cf-lead");
    expect(result.detail?.queueItemId).toBeTruthy();
  });

  it("resolves verifier agent by role", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "verifier",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(true);
    expect(result.detail?.agentId).toBe("cf-verifier");
  });

  it("passes model override in enqueue payload", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "worker",
      model: "sonnet",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(true);

    // Verify the queue item was created with model in payload
    const items = db.prepare(
      "SELECT payload FROM dispatch_queue WHERE project_id = ? AND status = 'queued'",
    ).all(PROJECT) as { payload: string }[];
    expect(items.length).toBeGreaterThan(0);
    const payload = JSON.parse(items[0].payload);
    expect(payload.model).toBe("sonnet");
  });

  it("deduplicates when queue item already exists for task", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "worker",
    };

    // First enqueue
    const result1 = executeAction(event, config, db);
    expect(result1.ok).toBe(true);
    expect(result1.detail?.queueItemId).toBeTruthy();

    // Second enqueue — should deduplicate
    const result2 = executeAction(event, config, db);
    expect(result2.ok).toBe(true);
    expect(result2.detail?.deduplicated).toBe(true);
  });

  it("fails when agent role is not found", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "nonexistent_role",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No agent found");
  });

  it("fails when event has no taskId in payload", () => {
    const event = makeEvent({ payload: {} });
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "worker",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No taskId");
  });

  it("includes session_type in enqueue payload", () => {
    const event = makeEvent();
    const config: EventActionConfig = {
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "reactive",
    };

    const result = executeAction(event, config, db);
    expect(result.ok).toBe(true);

    const items = db.prepare(
      "SELECT payload FROM dispatch_queue WHERE project_id = ? AND status = 'queued'",
    ).all(PROJECT) as { payload: string }[];
    const payload = JSON.parse(items[0].payload);
    expect(payload.sessionType).toBe("reactive");
  });
});

describe("findAgentByRole", () => {
  const PROJECT = "test-role-lookup";

  beforeEach(() => {
    registerWorkforceConfig(PROJECT, {
      name: "test-role-project",
      agents: {
        "mgr-1": {
          extends: "manager",
          title: "Manager",
          persona: "Test manager",
          briefing: [{ source: "soul" }],
          expectations: [],
          coordination: { enabled: true },
        },
        "dev-1": {
          extends: "employee",
          title: "Developer",
          persona: "Test developer",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
    });
  });

  it("finds manager by 'lead' role alias", () => {
    expect(findAgentByRole(PROJECT, "lead")).toBe("mgr-1");
  });

  it("finds employee by 'worker' role alias", () => {
    expect(findAgentByRole(PROJECT, "worker")).toBe("dev-1");
  });

  it("finds manager by 'manager' preset name", () => {
    expect(findAgentByRole(PROJECT, "manager")).toBe("mgr-1");
  });

  it("returns undefined for unknown role", () => {
    expect(findAgentByRole(PROJECT, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for wrong project", () => {
    expect(findAgentByRole("wrong-project", "lead")).toBeUndefined();
  });
});
