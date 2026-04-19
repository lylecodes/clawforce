import type { DatabaseSync } from "../../src/sqlite-driver.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const { assembleContext } = await import("../../src/context/assembler.js");
const { createTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { registerWorkerAssignment, resetWorkerRegistryForTest } = await import("../../src/worker-registry.js");
import type { AgentConfig } from "../../src/types.js";

describe("context sources", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  const PROJECT = "ctx-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-ctx-"));
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
    resetWorkerRegistryForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("project_md", () => {
    it("injects PROJECT.md content when available", () => {
      fs.writeFileSync(path.join(tmpDir, "PROJECT.md"), "# My Project\n\nBuild a thing.");

      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "project_md" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toContain("Project Charter");
      expect(result).toContain("Build a thing");
    });

    it("returns empty when no PROJECT.md exists", () => {
      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "project_md" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toBe("");
    });

    it("returns empty when no projectDir", () => {
      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "project_md" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config);
      expect(result).toBe("");
    });
  });

  describe("task_board", () => {
    it("renders active tasks grouped by state", () => {
      createTask({ projectId: PROJECT, title: "Task A", createdBy: "agent:a" }, db);
      createTask({ projectId: PROJECT, title: "Task B", createdBy: "agent:a" }, db);

      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "task_board" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toContain("Work Board");
      expect(result).toContain("Task A");
      expect(result).toContain("Task B");
      expect(result).toContain("OPEN");
    });

    it("shows summary counts and limits listed tasks to 50", () => {
      // Create 55 tasks
      for (let i = 0; i < 55; i++) {
        createTask({ projectId: PROJECT, title: `Task ${i}`, createdBy: "agent:a" }, db);
      }

      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "task_board" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT, projectDir: tmpDir });
      // Builder's renderTaskBoard shows total counts in a summary line
      expect(result).toContain("**Total:** 55");
      expect(result).toContain("OPEN: 55");
      // Only 50 tasks listed (LIMIT 50)
      expect(result).toContain("Task 0");
      expect(result).toContain("Task 49");
      expect(result).not.toContain("Task 50");
    });

    it("returns empty for project with no tasks", () => {
      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "task_board" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toBe("");
    });
  });

  describe("assigned_task", () => {
    it("injects assigned task details with evidence", () => {
      const task = createTask({ projectId: PROJECT, title: "Implement auth", description: "Add JWT auth", createdBy: "agent:a" }, db);
      registerWorkerAssignment("worker-1", PROJECT, task.id);
      attachEvidence({
        projectId: PROJECT,
        taskId: task.id,
        type: "output",
        content: "auth.ts file created",
        attachedBy: "worker-1",
      }, db);

      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "assigned_task" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("worker-1", config, { projectId: PROJECT });
      expect(result).toContain("Your Assignment");
      expect(result).toContain("Implement auth");
      expect(result).toContain("Add JWT auth");
      expect(result).toContain("auth.ts file created");
    });

    it("prefers the dispatched task id over the agent-global assignment", () => {
      const staleTask = createTask({ projectId: PROJECT, title: "Old assignment", description: "stale", createdBy: "agent:a" }, db);
      const liveTask = createTask({ projectId: PROJECT, title: "Live dispatch", description: "current", createdBy: "agent:a" }, db);
      registerWorkerAssignment("worker-1", PROJECT, staleTask.id);

      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "assigned_task" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("worker-1", config, {
        projectId: PROJECT,
        taskId: liveTask.id,
      });
      expect(result).toContain("Live dispatch");
      expect(result).toContain("current");
      expect(result).not.toContain("Old assignment");
    });

    it("returns empty when not assigned", () => {
      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "assigned_task" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("unassigned-agent", config, { projectId: PROJECT });
      expect(result).toBe("");
    });
  });

  describe("knowledge", () => {
    it("injects knowledge entries", () => {
      db.prepare(
        "INSERT INTO knowledge (id, project_id, category, title, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("k1", PROJECT, "architecture", "DB Schema", "We use SQLite for storage.", '["db","sqlite"]', Date.now());

      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "knowledge" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT });
      expect(result).toContain("Knowledge Base");
      expect(result).toContain("DB Schema");
      expect(result).toContain("SQLite");
    });

    it("filters by category", () => {
      db.prepare(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("k1", PROJECT, "architecture", "Arch note", "Architecture content", Date.now());
      db.prepare(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("k2", PROJECT, "process", "Process note", "Process content", Date.now());

      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "knowledge", filter: { category: ["architecture"] } }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT });
      expect(result).toContain("Arch note");
      expect(result).not.toContain("Process note");
    });

    it("returns empty when no knowledge exists", () => {
      const config: AgentConfig = {
        extends: "manager",
        briefing: [{ source: "knowledge" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("leon", config, { projectId: PROJECT });
      expect(result).toBe("");
    });
  });

  describe("file", () => {
    it("injects file content", () => {
      fs.writeFileSync(path.join(tmpDir, "config.yaml"), "key: value\ndb: sqlite");

      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "file", path: "config.yaml" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("agent-1", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toContain("File: config.yaml");
      expect(result).toContain("key: value");
    });

    it("blocks path traversal", () => {
      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "file", path: "../../../etc/passwd" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("agent-1", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toBe("");
    });

    it("returns empty for missing file", () => {
      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "file", path: "nonexistent.txt" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("agent-1", config, { projectId: PROJECT, projectDir: tmpDir });
      expect(result).toBe("");
    });

    it("returns empty without projectDir", () => {
      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "file", path: "config.yaml" }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("agent-1", config);
      expect(result).toBe("");
    });
  });

  describe("skill context source", () => {
    it("returns role-filtered table of contents", () => {
      const config: AgentConfig = {
        extends: "employee",
        briefing: [{ source: "skill" as any }],
        expectations: [],
        performance_policy: { action: "alert" },
      };

      const result = assembleContext("agent-1", config);
      expect(result).toContain("System Knowledge");
      expect(result).toContain("roles");
    });
  });
});
