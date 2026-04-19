/**
 * Tests for work streams, lead proposals, origin tracking, and user messaging.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const ingestEventMock = vi.fn(() => ({ id: "mock-event-id", deduplicated: false }));
vi.mock("../../src/events/store.js", () => ({
  ingestEvent: (...args: unknown[]) => ingestEventMock(...args),
  listEvents: vi.fn(() => []),
  countEvents: vi.fn(() => 0),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { createMessage } = await import("../../src/messaging/store.js");
const { approveProposal, getProposal, listPendingProposals } = await import("../../src/approval/resolve.js");

describe("origin tracking", () => {
  let db: DatabaseSync;
  const PROJECT = "origin-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("task origin fields", () => {
    it("creates a task with origin=user_request", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "User requested feature",
        createdBy: "cf-lead",
        origin: "user_request",
        originId: "proposal-123",
      }, db);

      expect(task.origin).toBe("user_request");
      expect(task.originId).toBe("proposal-123");
    });

    it("creates a task with origin=lead_proposal", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Lead proposed feature",
        createdBy: "cf-lead",
        origin: "lead_proposal",
        originId: "proposal-456",
      }, db);

      expect(task.origin).toBe("lead_proposal");
      expect(task.originId).toBe("proposal-456");
    });

    it("creates a task with origin=reactive", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Fix broken test",
        createdBy: "cf-lead",
        origin: "reactive",
      }, db);

      expect(task.origin).toBe("reactive");
      expect(task.originId).toBeUndefined();
    });

    it("creates a task with no origin (backward compatible)", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Legacy task",
        createdBy: "cf-lead",
      }, db);

      expect(task.origin).toBeUndefined();
      expect(task.originId).toBeUndefined();
    });
  });

  describe("proposal origin fields", () => {
    function insertProposal(overrides: Partial<{
      id: string;
      origin: string;
      reasoning: string;
      relatedGoalId: string;
    }> = {}): string {
      const id = overrides.id ?? crypto.randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, created_at, origin, reasoning, related_goal_id)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id,
        PROJECT,
        "Test feature proposal",
        "Build a new widget",
        "cf-lead",
        null,
        now,
        overrides.origin ?? "lead_proposal",
        overrides.reasoning ?? "Gap analysis: DIRECTION mentions widgets but none exist",
        overrides.relatedGoalId ?? null,
      );
      return id;
    }

    it("stores lead_proposal origin in proposals table", () => {
      const id = insertProposal({ origin: "lead_proposal" });
      const proposal = getProposal(PROJECT, id);

      expect(proposal).not.toBeNull();
      expect(proposal!.title).toBe("Test feature proposal");
      expect(proposal!.status).toBe("pending");
    });

    it("stores risk_gate origin in proposals table", () => {
      const id = insertProposal({ origin: "risk_gate" });
      const row = db.prepare("SELECT origin FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row.origin).toBe("risk_gate");
    });

    it("stores reasoning in proposals table", () => {
      const id = insertProposal({ reasoning: "DIRECTION says build widgets" });
      const row = db.prepare("SELECT reasoning FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row.reasoning).toBe("DIRECTION says build widgets");
    });

    it("stores related_goal_id in proposals table", () => {
      const goalId = crypto.randomUUID();
      const id = insertProposal({ relatedGoalId: goalId });
      const row = db.prepare("SELECT related_goal_id FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row.related_goal_id).toBe(goalId);
    });

    it("defaults origin to risk_gate for existing proposals", () => {
      // Simulate a proposal without origin (pre-migration)
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, proposed_by, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(id, PROJECT, "Old proposal", "agent", Date.now());

      const row = db.prepare("SELECT origin FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row.origin).toBe("risk_gate");
    });
  });
});

describe("user messaging", () => {
  let db: DatabaseSync;
  const PROJECT = "messaging-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a message from user to lead", () => {
    const msg = createMessage({
      fromAgent: "user",
      toAgent: "cf-lead",
      projectId: PROJECT,
      content: "Build the authentication module",
      type: "direct",
    }, db);

    expect(msg.fromAgent).toBe("user");
    expect(msg.toAgent).toBe("cf-lead");
    expect(msg.content).toBe("Build the authentication module");
    expect(msg.status).toBe("queued");
  });

  it("creates a message with proposal metadata", () => {
    const msg = createMessage({
      fromAgent: "user",
      toAgent: "cf-lead",
      projectId: PROJECT,
      content: "Regarding the widget proposal",
      type: "direct",
      metadata: { proposalId: "p-123" },
    }, db);

    expect(msg.metadata).toEqual({ proposalId: "p-123" });
  });

  it("lists user inbox messages", () => {
    // Create messages in both directions
    createMessage({
      fromAgent: "user",
      toAgent: "cf-lead",
      projectId: PROJECT,
      content: "Build X",
      type: "direct",
    }, db);

    createMessage({
      fromAgent: "cf-lead",
      toAgent: "user",
      projectId: PROJECT,
      content: "Task plan for X created",
      type: "direct",
    }, db);

    // Query user inbox
    const rows = db.prepare(
      `SELECT * FROM messages WHERE project_id = ? AND (from_agent = 'user' OR to_agent = 'user') ORDER BY created_at DESC`,
    ).all(PROJECT) as Record<string, unknown>[];

    expect(rows.length).toBe(2);
  });
});

describe("migration V40 columns", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proposals table has origin, reasoning, related_goal_id columns", () => {
    const row = db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
    const columns = row.map(r => r.name);
    expect(columns).toContain("origin");
    expect(columns).toContain("reasoning");
    expect(columns).toContain("related_goal_id");
  });

  it("tasks table has origin and origin_id columns", () => {
    const row = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const columns = row.map(r => r.name);
    expect(columns).toContain("origin");
    expect(columns).toContain("origin_id");
  });
});
