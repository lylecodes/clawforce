import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

import { DatabaseSync } from "../../src/sqlite-driver.js";
import { createTask, listTasks } from "../../src/tasks/ops.js";
import { runMigrations } from "../../src/migrations.js";

describe("department/team task filtering", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    runMigrations(db);

    // Create tasks in different departments/teams
    createTask({ projectId: "proj1", title: "Eng task 1", createdBy: "mgr", department: "engineering", team: "frontend" }, db);
    createTask({ projectId: "proj1", title: "Eng task 2", createdBy: "mgr", department: "engineering", team: "backend" }, db);
    createTask({ projectId: "proj1", title: "Sales task 1", createdBy: "mgr", department: "sales", team: "lead-gen" }, db);
    createTask({ projectId: "proj1", title: "No dept task", createdBy: "mgr" }, db);
  });

  it("filters by department", () => {
    const tasks = listTasks("proj1", { department: "engineering" }, db);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.department === "engineering")).toBe(true);
  });

  it("filters by team", () => {
    const tasks = listTasks("proj1", { team: "frontend" }, db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.team).toBe("frontend");
  });

  it("filters by department and team", () => {
    const tasks = listTasks("proj1", { department: "engineering", team: "backend" }, db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Eng task 2");
  });

  it("returns empty for non-existent department", () => {
    const tasks = listTasks("proj1", { department: "hr" }, db);
    expect(tasks).toHaveLength(0);
  });

  it("returns all tasks without department/team filter", () => {
    const tasks = listTasks("proj1", {}, db);
    expect(tasks).toHaveLength(4);
  });
});
