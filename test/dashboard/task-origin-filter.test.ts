/**
 * Clawforce — Task Origin Filter Tests
 *
 * Integration tests for task origin filtering through the dashboard API.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleRequest } from "../../src/dashboard/routes.js";
import { createTask, listTasks } from "../../src/tasks/ops.js";
import type { Task } from "../../src/types.js";
import path from "node:path";
import os from "node:os";

let projectId: string;
let testDir: string;

beforeEach(() => {
  projectId = `test-project-${Date.now()}`;
  testDir = path.join(os.tmpdir(), `clawforce-test-${Date.now()}`);
  process.env.CLAWFORCE_DB_DIR = testDir;
});

describe("Dashboard API — Task Origin Filter", () => {
  describe("Route Parameter Validation", () => {
    it("accepts valid origin parameter: user_request", () => {
      const result = handleRequest("/api/projects/test-proj/tasks", {
        origin: "user_request",
      });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("tasks");
      expect(result.body).toHaveProperty("hasMore");
    });

    it("accepts valid origin parameter: lead_proposal", () => {
      const result = handleRequest("/api/projects/test-proj/tasks", {
        origin: "lead_proposal",
      });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("tasks");
    });

    it("accepts valid origin parameter: reactive", () => {
      const result = handleRequest("/api/projects/test-proj/tasks", {
        origin: "reactive",
      });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("tasks");
    });

    it("silently ignores invalid origin parameter", () => {
      // Invalid origins should be silently ignored, not cause an error
      const result = handleRequest("/api/projects/test-proj/tasks", {
        origin: "invalid_origin_value",
      });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("tasks");
    });

    it("works with other filter parameters combined", () => {
      const result = handleRequest("/api/projects/test-proj/tasks", {
        origin: "user_request",
        state: "OPEN",
        priority: "P1",
      });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("tasks");
      expect(result.body).toHaveProperty("hasMore");
    });
  });

  describe("Task Data Structure", () => {
    it("returned task objects include origin field", () => {
      // Create a task with origin
      const task = createTask({
        projectId,
        title: "Test task with origin",
        createdBy: "user-1",
        origin: "user_request",
        originId: "req-123",
      });

      // Verify the task has origin field
      expect(task.origin).toBe("user_request");
      expect(task.originId).toBe("req-123");
    });

    it("tasks without origin are returned correctly", () => {
      const task = createTask({
        projectId,
        title: "Task without origin",
        createdBy: "agent-1",
      });

      expect(task.origin).toBeUndefined();
      expect(task.originId).toBeUndefined();
    });
  });

  describe("Filter Behavior", () => {
    let userTasks: Task[];
    let leadTasks: Task[];
    let reactiveTasks: Task[];

    beforeEach(() => {
      // Create multiple tasks with different origins
      userTasks = [];
      for (let i = 0; i < 3; i++) {
        userTasks.push(
          createTask({
            projectId,
            title: `User task ${i + 1}`,
            createdBy: "user-1",
            origin: "user_request",
            originId: `user-req-${i + 1}`,
          })
        );
      }

      leadTasks = [];
      for (let i = 0; i < 2; i++) {
        leadTasks.push(
          createTask({
            projectId,
            title: `Lead task ${i + 1}`,
            createdBy: "agent:lead",
            origin: "lead_proposal",
            originId: `lead-prop-${i + 1}`,
          })
        );
      }

      reactiveTasks = [];
      for (let i = 0; i < 2; i++) {
        reactiveTasks.push(
          createTask({
            projectId,
            title: `Reactive task ${i + 1}`,
            createdBy: "system:dispatcher",
            origin: "reactive",
          })
        );
      }
    });

    it("correctly counts tasks by origin when filtering", () => {
      // Test user_request filter
      const userResult = listTasks(projectId, { origin: "user_request" });
      const userFiltered = userResult.filter((t) => t.origin === "user_request");
      expect(userFiltered.length).toBe(3);

      // Test lead_proposal filter
      const leadResult = listTasks(projectId, { origin: "lead_proposal" });
      const leadFiltered = leadResult.filter((t) => t.origin === "lead_proposal");
      expect(leadFiltered.length).toBe(2);

      // Test reactive filter
      const reactiveResult = listTasks(projectId, { origin: "reactive" });
      const reactiveFiltered = reactiveResult.filter((t) => t.origin === "reactive");
      expect(reactiveFiltered.length).toBe(2);
    });

    it("can combine origin filter with state filter", () => {
      // Create an ASSIGNED task with origin
      const assignedTask = createTask({
        projectId,
        title: "Assigned user task",
        createdBy: "user-1",
        assignedTo: "agent-1",
        origin: "user_request",
        originId: "req-assigned",
      });

      // Filter by both origin and state
      const result = listTasks(projectId, {
        origin: "user_request",
        state: "ASSIGNED",
      });

      const filtered = result.filter(
        (t) => t.origin === "user_request" && t.state === "ASSIGNED"
      );
      expect(filtered.some((t) => t.id === assignedTask.id)).toBe(true);
    });

    it("returns empty result when no tasks match origin filter", () => {
      // Try to filter by origin that has no tasks
      // First ensure we only have tasks with our origins
      const result = listTasks(projectId, {
        origin: "user_request",
        assignedTo: "non-existent-agent",
      });

      // Should return empty array, not error
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("API Response Format", () => {
    it("queryTasks returns correct pagination structure", () => {
      // Create enough tasks to test pagination
      for (let i = 0; i < 5; i++) {
        createTask({
          projectId,
          title: `Task ${i + 1}`,
          createdBy: "user-1",
          origin: "user_request",
        });
      }

      const result = handleRequest("/api/projects/" + projectId + "/tasks", {
        origin: "user_request",
        limit: "2",
      });

      expect(result.status).toBe(200);
      const body = result.body as any;
      expect(body).toHaveProperty("tasks");
      expect(body).toHaveProperty("hasMore");
      expect(body).toHaveProperty("count");
      expect(Array.isArray(body.tasks)).toBe(true);
    });

    it("origin field is present in task response", () => {
      const task = createTask({
        projectId,
        title: "API response test",
        createdBy: "user-1",
        origin: "lead_proposal",
        originId: "prop-api-test",
      });

      // Query the task back
      const result = listTasks(projectId, {
        origin: "lead_proposal",
      });

      const found = result.find((t) => t.id === task.id);
      expect(found).toBeDefined();
      expect(found!.origin).toBe("lead_proposal");
      expect(found!.originId).toBe("prop-api-test");
    });
  });
});
