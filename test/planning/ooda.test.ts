import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const {
  getLastWakeTime,
  buildDeltaReport,
  renderDeltaReport,
  buildOodaPrompt,
} = await import("../../src/planning/ooda.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-ooda";
const MANAGER = "agent:manager";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("getLastWakeTime", () => {
  it("returns null when no sessions exist", () => {
    const result = getLastWakeTime(PROJECT, MANAGER, db);
    expect(result).toBeNull();
  });

  it("returns the most recent session end time", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", PROJECT, MANAGER, "sess-1", "success", "first run", now - 3600_000, now - 3500_000);
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-2", PROJECT, MANAGER, "sess-2", "success", "second run", now - 1800_000, now - 1700_000);

    const result = getLastWakeTime(PROJECT, MANAGER, db);
    expect(result).toBe(now - 1700_000);
  });
});

describe("buildDeltaReport", () => {
  it("returns empty delta when nothing happened", () => {
    const report = buildDeltaReport(PROJECT, MANAGER, db);
    expect(report.lastWakeAt).toBeNull();
    expect(report.taskTransitions).toHaveLength(0);
    expect(report.newTasks).toHaveLength(0);
    expect(report.completedTasks).toHaveLength(0);
  });

  it("captures new tasks created since last wake", () => {
    // Record a session end 1 hour ago
    const oneHourAgo = Date.now() - 3600_000;
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", PROJECT, MANAGER, "sess-1", "success", "run", oneHourAgo - 100_000, oneHourAgo);

    // Create a task after last wake
    createTask({ projectId: PROJECT, title: "New task", createdBy: "agent:worker" }, db);

    const report = buildDeltaReport(PROJECT, MANAGER, db);
    expect(report.lastWakeAt).toBe(oneHourAgo);
    expect(report.newTasks).toHaveLength(1);
    expect(report.newTasks[0].title).toBe("New task");
  });

  it("captures completed tasks since last wake", () => {
    const oneHourAgo = Date.now() - 3600_000;
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", PROJECT, MANAGER, "sess-1", "success", "run", oneHourAgo - 100_000, oneHourAgo);

    // Create task before last wake
    const task = createTask({ projectId: PROJECT, title: "Complete me", createdBy: "agent:worker" }, db);
    // Transition through states to DONE
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker", assignedTo: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:reviewer" }, db);

    const report = buildDeltaReport(PROJECT, MANAGER, db);
    expect(report.completedTasks.length).toBeGreaterThanOrEqual(1);
    expect(report.completedTasks.some((t) => t.title === "Complete me")).toBe(true);
  });
});

describe("renderDeltaReport", () => {
  it("renders 'no changes' when nothing happened", () => {
    const report = buildDeltaReport(PROJECT, MANAGER, db);
    const rendered = renderDeltaReport(report);
    expect(rendered).toContain("No significant changes");
  });

  it("renders completed tasks", () => {
    const task = createTask({ projectId: PROJECT, title: "Test task", createdBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker", assignedTo: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:reviewer" }, db);

    const report = buildDeltaReport(PROJECT, MANAGER, db);
    const rendered = renderDeltaReport(report);
    expect(rendered).toContain("What Changed");
    expect(rendered).toContain("Completed");
    expect(rendered).toContain("Test task");
  });

  it("includes summary counts", () => {
    createTask({ projectId: PROJECT, title: "New task 1", createdBy: "agent:worker" }, db);
    createTask({ projectId: PROJECT, title: "New task 2", createdBy: "agent:worker" }, db);

    const report = buildDeltaReport(PROJECT, MANAGER, db);
    const rendered = renderDeltaReport(report);
    expect(rendered).toContain("Summary");
    expect(rendered).toContain("2 new");
  });
});

describe("buildOodaPrompt", () => {
  it("includes all OODA phases", () => {
    const prompt = buildOodaPrompt("my-project", []);
    expect(prompt).toContain("OBSERVE");
    expect(prompt).toContain("ORIENT");
    expect(prompt).toContain("DECIDE");
    expect(prompt).toContain("ACT");
    expect(prompt).toContain("RECORD");
    expect(prompt).toContain("my-project");
  });

  it("includes state hints when provided", () => {
    const prompt = buildOodaPrompt("my-project", ["3 OPEN tasks need assignment", "1 escalation"]);
    expect(prompt).toContain("3 OPEN tasks need assignment");
    expect(prompt).toContain("1 escalation");
  });

  it("mentions record_decision", () => {
    const prompt = buildOodaPrompt("my-project", []);
    expect(prompt).toContain("decision");
    expect(prompt).toContain("clawforce_log");
  });
});
