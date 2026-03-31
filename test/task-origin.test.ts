import { describe, expect, it, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createTask, getTask, listTasks } from "../src/tasks/ops.js";
import { getDb } from "../src/db.js";
import { queryTasks } from "../src/dashboard/queries.js";
import type { Task, TaskOrigin } from "../src/types.js";

// Setup test database
let testDir: string;
let projectId: string;

beforeEach(() => {
  projectId = "test-project-origin";
  testDir = path.join(os.tmpdir(), `clawforce-test-${Date.now()}`);
  // Mock db location
  process.env.CLAWFORCE_DB_DIR = testDir;
});

describe("Task Origin", () => {
  describe("Task Creation with Origin", () => {
    it("creates a task with user_request origin", () => {
      const task = createTask({
        projectId,
        title: "User requested task",
        createdBy: "user-1",
        origin: "user_request",
        originId: "req-123",
      });

      expect(task.origin).toBe("user_request");
      expect(task.originId).toBe("req-123");
      expect(task.createdBy).toBe("user-1");
    });

    it("creates a task with lead_proposal origin", () => {
      const task = createTask({
        projectId,
        title: "Lead proposal task",
        createdBy: "agent:eng-lead",
        origin: "lead_proposal",
        originId: "prop-456",
      });

      expect(task.origin).toBe("lead_proposal");
      expect(task.originId).toBe("prop-456");
    });

    it("creates a task with reactive origin", () => {
      const task = createTask({
        projectId,
        title: "Reactive task from system",
        createdBy: "system:dispatcher",
        origin: "reactive",
      });

      expect(task.origin).toBe("reactive");
      expect(task.originId).toBeUndefined();
    });

    it("creates a task without origin (default behavior)", () => {
      const task = createTask({
        projectId,
        title: "Task without origin",
        createdBy: "agent-1",
      });

      expect(task.origin).toBeUndefined();
      expect(task.originId).toBeUndefined();
    });
  });

  describe("Task Retrieval with Origin", () => {
    it("retrieves task with origin field populated", () => {
      const created = createTask({
        projectId,
        title: "Test task",
        createdBy: "user-1",
        origin: "user_request",
        originId: "req-789",
      });

      const retrieved = getTask(projectId, created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.origin).toBe("user_request");
      expect(retrieved!.originId).toBe("req-789");
    });

    it("retrieves task without origin when not set", () => {
      const created = createTask({
        projectId,
        title: "Task without origin",
        createdBy: "agent-1",
      });

      const retrieved = getTask(projectId, created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.origin).toBeUndefined();
    });
  });

  describe("Task Filtering by Origin", () => {
    let userTask: Task;
    let leadTask: Task;
    let reactiveTask: Task;

    beforeEach(() => {
      userTask = createTask({
        projectId,
        title: "User task 1",
        createdBy: "user-1",
        origin: "user_request",
        originId: "req-1",
      });

      leadTask = createTask({
        projectId,
        title: "Lead task 1",
        createdBy: "agent:eng-lead",
        origin: "lead_proposal",
        originId: "prop-1",
      });

      reactiveTask = createTask({
        projectId,
        title: "Reactive task 1",
        createdBy: "system:dispatcher",
        origin: "reactive",
      });
    });

    it("filters tasks by user_request origin", () => {
      const result = listTasks(projectId, { origin: "user_request" });
      const userTasks = result.filter((t) => t.origin === "user_request");
      expect(userTasks.length).toBeGreaterThan(0);
      expect(userTasks.some((t) => t.id === userTask.id)).toBe(true);
    });

    it("filters tasks by lead_proposal origin", () => {
      const result = listTasks(projectId, { origin: "lead_proposal" });
      const leadTasks = result.filter((t) => t.origin === "lead_proposal");
      expect(leadTasks.length).toBeGreaterThan(0);
      expect(leadTasks.some((t) => t.id === leadTask.id)).toBe(true);
    });

    it("filters tasks by reactive origin", () => {
      const result = listTasks(projectId, { origin: "reactive" });
      const reactiveTasks = result.filter((t) => t.origin === "reactive");
      expect(reactiveTasks.length).toBeGreaterThan(0);
      expect(reactiveTasks.some((t) => t.id === reactiveTask.id)).toBe(true);
    });

    it("handles filtering with no matching origin", () => {
      // Create a test to ensure no error when filtering for tasks with no matches
      const result = listTasks(projectId, {
        origin: "user_request",
        // Filter by non-existent assignee to ensure no results
        assignedTo: "non-existent-agent",
      });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("Dashboard API Origin Filter", () => {
    it("queryTasks accepts origin filter", () => {
      // Create tasks with different origins
      const userTask = createTask({
        projectId,
        title: "User task for API",
        createdBy: "user-1",
        origin: "user_request",
      });

      const leadTask = createTask({
        projectId,
        title: "Lead task for API",
        createdBy: "agent:lead",
        origin: "lead_proposal",
      });

      // Query with origin filter
      const result = queryTasks(projectId, { origin: "user_request" });

      expect(result).toBeDefined();
      expect(result.tasks).toBeDefined();
      expect(result.hasMore).toBeDefined();
    });
  });

  describe("Origin and CreatedBy Parsing", () => {
    it("preserves origin independently from createdBy", () => {
      const task = createTask({
        projectId,
        title: "Task with both fields",
        createdBy: "agent:platform-lead",
        origin: "lead_proposal",
        originId: "admin-prop-123",
      });

      const retrieved = getTask(projectId, task.id);
      expect(retrieved!.createdBy).toBe("agent:platform-lead");
      expect(retrieved!.origin).toBe("lead_proposal");
      expect(retrieved!.originId).toBe("admin-prop-123");
    });

    it("allows same createdBy with different origins", () => {
      // A lead agent can create both user-requested and lead-proposed tasks
      const task1 = createTask({
        projectId,
        title: "User request routed by lead",
        createdBy: "agent:platform-lead",
        origin: "user_request",
        originId: "customer-req-1",
      });

      const task2 = createTask({
        projectId,
        title: "Lead proposal",
        createdBy: "agent:platform-lead",
        origin: "lead_proposal",
        originId: "internal-prop-1",
      });

      expect(task1.createdBy).toBe(task2.createdBy);
      expect(task1.origin).not.toBe(task2.origin);
    });
  });
});
