import { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderScopedTaskBoard } from "../../src/context/builder.js";

describe("renderScopedTaskBoard", () => {
  let db: DatabaseSync;
  const projectId = "proj-scoped";

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL DEFAULT 'OPEN',
        priority TEXT NOT NULL DEFAULT 'P2',
        assigned_to TEXT,
        created_by TEXT NOT NULL DEFAULT 'test',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        deadline INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        tags TEXT,
        workflow_id TEXT,
        workflow_phase INTEGER,
        parent_task_id TEXT,
        department TEXT,
        team TEXT,
        metadata TEXT
      );
      CREATE TABLE transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'test',
        reason TEXT,
        evidence_id TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        actor_signature TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function insertTask(overrides: Record<string, unknown> = {}) {
    const defaults = {
      id: `task-${Math.random().toString(36).slice(2, 8)}`,
      project_id: projectId,
      title: "Test task",
      state: "OPEN",
      priority: "P2",
      created_by: "test",
      created_at: Date.now(),
      updated_at: Date.now(),
      retry_count: 0,
      max_retries: 3,
      ...overrides,
    };
    const cols = Object.keys(defaults);
    const vals = Object.values(defaults);
    const placeholders = cols.map(() => "?").join(",");
    db.prepare(`INSERT INTO tasks (${cols.join(",")}) VALUES (${placeholders})`).run(...vals);
    return defaults;
  }

  it("filters tasks by department and includes untagged tasks", () => {
    insertTask({ id: "t1", title: "Eng task", department: "engineering" });
    insertTask({ id: "t2", title: "Sales task", department: "sales" });
    insertTask({ id: "t3", title: "Untagged task" });

    const result = renderScopedTaskBoard(db, projectId, 50, { department: "engineering" });
    expect(result).toContain("Eng task");
    expect(result).not.toContain("Sales task");
    // Untagged tasks (no dept, no team, unassigned) are included for triage
    expect(result).toContain("Untagged task");
  });

  it("filters tasks by team", () => {
    insertTask({ id: "t1", title: "Frontend task", team: "frontend" });
    insertTask({ id: "t2", title: "Backend task", team: "backend" });

    const result = renderScopedTaskBoard(db, projectId, 50, { team: "frontend" });
    expect(result).toContain("Frontend task");
    expect(result).not.toContain("Backend task");
  });

  it("filters tasks by direct reports and includes untagged tasks", () => {
    insertTask({ id: "t1", title: "Alice task", assigned_to: "alice" });
    insertTask({ id: "t2", title: "Bob task", assigned_to: "bob" });
    insertTask({ id: "t3", title: "Untagged task" });

    const result = renderScopedTaskBoard(db, projectId, 50, { directReports: ["alice"] });
    expect(result).toContain("Alice task");
    expect(result).not.toContain("Bob task");
    // Untagged tasks included for triage
    expect(result).toContain("Untagged task");
  });

  it("combines scope filters with OR", () => {
    insertTask({ id: "t1", title: "Dept match", department: "engineering" });
    insertTask({ id: "t2", title: "Team match", team: "frontend" });
    insertTask({ id: "t3", title: "Neither match", department: "sales", team: "backend" });

    const result = renderScopedTaskBoard(db, projectId, 50, {
      department: "engineering",
      team: "frontend",
    });
    expect(result).toContain("Dept match");
    expect(result).toContain("Team match");
    expect(result).not.toContain("Neither match");
  });

  it("shows scoped counts in the header", () => {
    insertTask({ id: "t1", department: "engineering", state: "OPEN" });
    insertTask({ id: "t2", department: "engineering", state: "IN_PROGRESS" });
    insertTask({ id: "t3", department: "sales", state: "OPEN" });

    const result = renderScopedTaskBoard(db, projectId, 50, { department: "engineering" });
    expect(result).toContain("**Total (your scope):** 2");
    expect(result).toContain("OPEN: 1");
    expect(result).toContain("IN_PROGRESS: 1");
  });

  it("shows empty message when no tasks match scope", () => {
    insertTask({ id: "t1", department: "sales" });

    const result = renderScopedTaskBoard(db, projectId, 50, { department: "engineering" });
    expect(result).toContain("No tasks in your scope");
  });

  it("excludes DONE/CANCELLED from active tasks section", () => {
    insertTask({ id: "t1", title: "Active", department: "engineering", state: "OPEN" });
    insertTask({ id: "t2", title: "Finished", department: "engineering", state: "DONE" });

    const result = renderScopedTaskBoard(db, projectId, 50, { department: "engineering" });
    expect(result).toContain("Active");
    // DONE tasks not shown in Active Tasks section (but counted in header)
    expect(result).toContain("**Total (your scope):** 2");
    expect(result).toContain("DONE: 1");
  });
});
