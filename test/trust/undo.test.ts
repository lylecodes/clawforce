import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  registerUndo,
  findUndoable,
  findMostRecentUndoable,
  markUndoExecuted,
  expireUndoEntries,
  listRecentActions,
  getUndoEntry,
  renderRecentActions,
} = await import("../../src/trust/undo.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-undo";
const AGENT = "assistant";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("registerUndo", () => {
  it("registers an action with undo handler", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: { to: "user@example.com", subject: "Hello" },
      actionSummary: "Sent email to user@example.com",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: { messageId: "msg-123" },
    }, db);

    expect(entry.id).toBeDefined();
    expect(entry.status).toBe("available");
    expect(entry.undoToolName).toBe("mcp:gmail:unsend");
    expect(entry.expiresAt).toBeGreaterThan(entry.createdAt);
  });

  it("registers action without undo handler", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "social:post",
      toolName: "mcp:twitter:post",
      toolParams: { content: "Hello world" },
      actionSummary: "Posted tweet",
    }, db);

    expect(entry.status).toBe("not_available");
    expect(entry.undoToolName).toBeNull();
  });

  it("uses category-specific TTL", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    // email:send default TTL is 30s
    expect(entry.expiresAt - entry.createdAt).toBe(30_000);
  });

  it("accepts custom TTL", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
      ttlMs: 60_000,
    }, db);

    expect(entry.expiresAt - entry.createdAt).toBe(60_000);
  });
});

describe("findUndoable", () => {
  it("returns null when no undoable actions", () => {
    const result = findUndoable(PROJECT, "email:send", db);
    expect(result).toBeNull();
  });

  it("finds most recent undoable action for category", () => {
    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: { subject: "First" },
      actionSummary: "First email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: { id: "1" },
    }, db);

    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: { subject: "Second" },
      actionSummary: "Second email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: { id: "2" },
    }, db);

    const result = findUndoable(PROJECT, "email:send", db);
    expect(result).not.toBeNull();
    expect(result!.actionSummary).toBe("Second email");
  });

  it("skips expired entries", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Old email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
      ttlMs: 1, // 1ms TTL — expires immediately
    }, db);

    // Wait to ensure expiry
    const result = findUndoable(PROJECT, "email:send", db);
    // May or may not be expired depending on timing — force expire
    db.prepare("UPDATE undo_registry SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, entry.id);

    const result2 = findUndoable(PROJECT, "email:send", db);
    expect(result2).toBeNull();
  });
});

describe("findMostRecentUndoable", () => {
  it("finds across all categories", () => {
    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "calendar:create_event",
      toolName: "mcp:gcal:create",
      toolParams: {},
      actionSummary: "Created meeting",
      undoToolName: "mcp:gcal:delete",
      undoToolParams: {},
    }, db);

    const result = findMostRecentUndoable(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result!.actionSummary).toBe("Created meeting");
  });
});

describe("markUndoExecuted", () => {
  it("marks entry as executed", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    const result = markUndoExecuted(PROJECT, entry.id, db);
    expect(result).toBe(true);

    const updated = getUndoEntry(PROJECT, entry.id, db);
    expect(updated!.status).toBe("executed");
    expect(updated!.executedAt).toBeDefined();
  });

  it("returns false for non-available entry", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "social:post",
      toolName: "mcp:twitter:post",
      toolParams: {},
      actionSummary: "Posted",
    }, db);

    // status is "not_available" — can't execute undo
    const result = markUndoExecuted(PROJECT, entry.id, db);
    expect(result).toBe(false);
  });

  it("prevents double undo", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    markUndoExecuted(PROJECT, entry.id, db);
    const secondAttempt = markUndoExecuted(PROJECT, entry.id, db);
    expect(secondAttempt).toBe(false);
  });
});

describe("expireUndoEntries", () => {
  it("expires entries past TTL", () => {
    const entry = registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    // Backdate expires_at
    db.prepare("UPDATE undo_registry SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, entry.id);

    const expired = expireUndoEntries(PROJECT, db);
    expect(expired).toBe(1);

    const updated = getUndoEntry(PROJECT, entry.id, db);
    expect(updated!.status).toBe("expired");
  });

  it("does not expire non-expired entries", () => {
    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "calendar:create_event",
      toolName: "mcp:gcal:create",
      toolParams: {},
      actionSummary: "Created event",
      undoToolName: "mcp:gcal:delete",
      undoToolParams: {},
    }, db);

    const expired = expireUndoEntries(PROJECT, db);
    expect(expired).toBe(0);
  });
});

describe("listRecentActions", () => {
  it("returns empty array when no actions", () => {
    const actions = listRecentActions(PROJECT, 10, db);
    expect(actions).toHaveLength(0);
  });

  it("lists actions in reverse chronological order", () => {
    registerUndo({ projectId: PROJECT, agentId: AGENT, category: "a", toolName: "t1", toolParams: {}, actionSummary: "First" }, db);
    registerUndo({ projectId: PROJECT, agentId: AGENT, category: "b", toolName: "t2", toolParams: {}, actionSummary: "Second" }, db);

    const actions = listRecentActions(PROJECT, 10, db);
    expect(actions).toHaveLength(2);
    expect(actions[0]!.actionSummary).toBe("Second");
    expect(actions[1]!.actionSummary).toBe("First");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      registerUndo({ projectId: PROJECT, agentId: AGENT, category: "a", toolName: "t", toolParams: {}, actionSummary: `Action ${i}` }, db);
    }

    const actions = listRecentActions(PROJECT, 3, db);
    expect(actions).toHaveLength(3);
  });
});

describe("renderRecentActions", () => {
  it("returns null when no actions", () => {
    const md = renderRecentActions(PROJECT, 10, db);
    expect(md).toBeNull();
  });

  it("renders markdown with undo status", () => {
    registerUndo({
      projectId: PROJECT,
      agentId: AGENT,
      category: "email:send",
      toolName: "mcp:gmail:send",
      toolParams: {},
      actionSummary: "Sent email to boss",
      undoToolName: "mcp:gmail:unsend",
      undoToolParams: {},
    }, db);

    const md = renderRecentActions(PROJECT, 10, db);
    expect(md).not.toBeNull();
    expect(md).toContain("## Recent Actions");
    expect(md).toContain("Sent email to boss");
    expect(md).toContain("UNDO AVAILABLE");
  });
});
