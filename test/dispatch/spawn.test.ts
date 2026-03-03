import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn(() => ({ isDirectory: () => true })),
      existsSync: vi.fn(() => true),
    },
  };
});
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", publicKey: "test-key" })),
  verifyAction: vi.fn(() => true),
}));

// Dynamic imports after mocks are registered
const childProcess = await import("node:child_process");
const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { dispatchClaudeCode, dispatchAndTransition } = await import(
  "../../src/dispatch/spawn.js"
);
const { createTask, transitionTask, getTask } = await import(
  "../../src/tasks/ops.js"
);

const mockSpawn = vi.mocked(childProcess.spawn);

function createMockProcess(exitCode: number, stdout: string, stderr: string) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  // Simulate async output
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

function createErrorProcess(error: Error) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;

  setTimeout(() => {
    proc.emit("error", error);
  }, 10);

  return proc;
}

describe("dispatch/spawn", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  describe("buildTaskPrompt (via spawn args)", () => {
    it("includes task title in prompt", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Implement OAuth login",
          createdBy: "agent:pm",
        },
        db,
      );

      const proc = createMockProcess(0, "Done.", "");
      mockSpawn.mockReturnValue(proc);

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Add Google OAuth",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const fullPrompt = (args as string[]).at(-1)!;
      expect(fullPrompt).toContain("# Task: Implement OAuth login");
    });

    it("includes task description when present", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Fix the bug",
          description: "The login flow crashes on empty password",
          createdBy: "agent:pm",
        },
        db,
      );

      const proc = createMockProcess(0, "Fixed.", "");
      mockSpawn.mockReturnValue(proc);

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Fix it",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const fullPrompt = (args as string[]).at(-1)!;
      expect(fullPrompt).toContain("## Description");
      expect(fullPrompt).toContain("The login flow crashes on empty password");
    });

    it("includes tags when present", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Tagged task",
          createdBy: "agent:pm",
          tags: ["backend", "auth"],
        },
        db,
      );

      const proc = createMockProcess(0, "Done.", "");
      mockSpawn.mockReturnValue(proc);

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do the work",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const fullPrompt = (args as string[]).at(-1)!;
      expect(fullPrompt).toContain("Tags: backend, auth");
    });

    it("includes user prompt in Instructions section", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Some task",
          createdBy: "agent:pm",
        },
        db,
      );

      const proc = createMockProcess(0, "Done.", "");
      mockSpawn.mockReturnValue(proc);

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Refactor the auth module",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const fullPrompt = (args as string[]).at(-1)!;
      expect(fullPrompt).toContain("## Instructions");
      expect(fullPrompt).toContain("Refactor the auth module");
    });

    it("omits description section when task has no description", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Simple task",
          createdBy: "agent:pm",
        },
        db,
      );

      const proc = createMockProcess(0, "Done.", "");
      mockSpawn.mockReturnValue(proc);

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do it",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const fullPrompt = (args as string[]).at(-1)!;
      expect(fullPrompt).not.toContain("## Description");
    });
  });

  describe("dispatchClaudeCode — CLI args", () => {
    it("always passes --print and --output-format text", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain("--print");
      expect(args).toContain("--output-format");
      expect(args).toContain("json");
    });

    it("passes --profile when specified", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
        profile: "my-profile",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain("--profile");
      expect(args).toContain("my-profile");
    });

    it("passes --model when specified", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
        model: "claude-opus-4-6",
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-6");
    });

    it("passes --allowedTools for each tool when specified", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
        allowedTools: ["Bash", "Read"],
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      const argsArray = args as string[];
      const bashIdx = argsArray.indexOf("Bash");
      const readIdx = argsArray.indexOf("Read");
      expect(argsArray[bashIdx - 1]).toBe("--allowedTools");
      expect(argsArray[readIdx - 1]).toBe("--allowedTools");
    });

    it("passes --max-turns when specified", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
        maxTurns: 5,
      });

      const [, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain("--max-turns");
      expect(args).toContain("5");
    });

    it("spawns claude in the specified project directory", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "output", ""));

      await dispatchClaudeCode({
        task,
        projectDir: "/home/user/my-project",
        prompt: "Do work",
      });

      const [cmd, , opts] = mockSpawn.mock.calls[0]!;
      expect(cmd).toBe("claude");
      expect((opts as any).cwd).toBe("/home/user/my-project");
    });
  });

  describe("dispatchClaudeCode — execution results", () => {
    it("returns ok=true and captures stdout on exit code 0", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Success task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "Task completed successfully.", ""));

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Task completed successfully.");
      expect(result.stderr).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns ok=false and captures stderr on exit code 1", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Failing task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(1, "", "Error: command failed"));

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Error: command failed");
    });

    it("captures both stdout and stderr when both are emitted", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Task with both", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(
        createMockProcess(0, "main output", "some warnings"),
      );

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.stdout).toBe("main output");
      expect(result.stderr).toBe("some warnings");
    });

    it("attaches evidence when stdout is non-empty", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Evidence task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "Here is the output.", ""));

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.evidenceId).toBeTruthy();
    });

    it("does not attach evidence when stdout is empty", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Silent task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "", ""));

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.evidenceId).toBeUndefined();
    });

    it("does not attach evidence when stdout is only whitespace", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Whitespace task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(0, "   \n  ", ""));

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.evidenceId).toBeUndefined();
    });

    it("treats null exit code as exit code 1", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Null exit task", createdBy: "agent:pm" },
        db,
      );

      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      setTimeout(() => proc.emit("close", null), 10);
      mockSpawn.mockReturnValue(proc);

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("dispatchClaudeCode — spawn error", () => {
    it("returns ok=false when spawn emits an error event", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Spawn error task", createdBy: "agent:pm" },
        db,
      );

      mockSpawn.mockReturnValue(
        createErrorProcess(new Error("spawn ENOENT")),
      );

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Spawn error: spawn ENOENT");
    });

    it("includes any stderr collected before the error in result", async () => {
      const task = createTask(
        { projectId: PROJECT, title: "Partial output task", createdBy: "agent:pm" },
        db,
      );

      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      setTimeout(() => {
        proc.stderr.emit("data", Buffer.from("partial stderr\n"));
        proc.emit("error", new Error("broken pipe"));
      }, 10);
      mockSpawn.mockReturnValue(proc);

      const result = await dispatchClaudeCode({
        task,
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("partial stderr");
      expect(result.stderr).toContain("broken pipe");
    });
  });

  describe("dispatchAndTransition", () => {
    it("transitions task to REVIEW on successful dispatch with evidence", async () => {
      // Task must be IN_PROGRESS for the IN_PROGRESS → REVIEW transition
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Auto-transition task",
          createdBy: "agent:pm",
          assignedTo: "agent:worker",
        },
        db,
      );
      transitionTask(
        {
          projectId: PROJECT,
          taskId: task.id,
          toState: "IN_PROGRESS",
          actor: "agent:worker",
        },
        db,
      );

      mockSpawn.mockReturnValue(
        createMockProcess(0, "Work is done. Here are the results.", ""),
      );

      const result = await dispatchAndTransition({
        task: { ...task, state: "IN_PROGRESS" },
        projectDir: "/tmp/project",
        prompt: "Do work",
        profile: "default",
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceId).toBeTruthy();

      const updated = getTask(PROJECT, task.id, db);
      expect(updated!.state).toBe("REVIEW");
    });

    it("does not transition when dispatch fails (exit code 1)", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Failed dispatch task",
          createdBy: "agent:pm",
          assignedTo: "agent:worker",
        },
        db,
      );
      transitionTask(
        {
          projectId: PROJECT,
          taskId: task.id,
          toState: "IN_PROGRESS",
          actor: "agent:worker",
        },
        db,
      );

      mockSpawn.mockReturnValue(createMockProcess(1, "", "Error occurred"));

      const result = await dispatchAndTransition({
        task: { ...task, state: "IN_PROGRESS" },
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(false);

      const updated = getTask(PROJECT, task.id, db);
      expect(updated!.state).toBe("IN_PROGRESS");
    });

    it("does not transition when dispatch succeeds but stdout is empty (no evidence)", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "No output task",
          createdBy: "agent:pm",
          assignedTo: "agent:worker",
        },
        db,
      );
      transitionTask(
        {
          projectId: PROJECT,
          taskId: task.id,
          toState: "IN_PROGRESS",
          actor: "agent:worker",
        },
        db,
      );

      // Exit code 0 but no stdout — no evidenceId, so no transition
      mockSpawn.mockReturnValue(createMockProcess(0, "", ""));

      const result = await dispatchAndTransition({
        task: { ...task, state: "IN_PROGRESS" },
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(true);
      expect(result.evidenceId).toBeUndefined();

      const updated = getTask(PROJECT, task.id, db);
      expect(updated!.state).toBe("IN_PROGRESS");
    });

    it("returns the dispatch result regardless of transition outcome", async () => {
      const task = createTask(
        {
          projectId: PROJECT,
          title: "Return result task",
          createdBy: "agent:pm",
          assignedTo: "agent:worker",
        },
        db,
      );
      transitionTask(
        {
          projectId: PROJECT,
          taskId: task.id,
          toState: "IN_PROGRESS",
          actor: "agent:worker",
        },
        db,
      );

      mockSpawn.mockReturnValue(
        createMockProcess(0, "Output from claude.", ""),
      );

      const result = await dispatchAndTransition({
        task: { ...task, state: "IN_PROGRESS" },
        projectDir: "/tmp/project",
        prompt: "Do work",
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("Output from claude.");
    });
  });
});
