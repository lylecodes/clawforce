import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateBranchName,
  createTaskBranch,
  mergeTaskBranch,
  deleteTaskBranch,
  discardTaskBranch,
} from "../../src/verification/git.js";

describe("verification/git", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temp git repo for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-git-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "pipe" });
    // Create initial commit on main
    fs.writeFileSync(path.join(tmpDir, "README.md"), "initial");
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync("git commit -m 'initial'", { cwd: tmpDir, stdio: "pipe" });
    // Ensure we're on main
    try {
      execSync("git branch -M main", { cwd: tmpDir, stdio: "pipe" });
    } catch { /* already named main */ }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  describe("generateBranchName", () => {
    it("generates default branch name from task ID", () => {
      const name = generateBranchName("abcdefgh-1234-5678-9012-ijklmnopqrst");
      expect(name).toBe("cf/task-abcdefgh");
    });

    it("uses custom pattern with taskId", () => {
      const name = generateBranchName("abcdefgh-1234", "feature/{{taskId}}");
      expect(name).toBe("feature/abcdefgh-1234");
    });

    it("uses custom pattern with taskIdShort", () => {
      const name = generateBranchName("abcdefgh-1234", "fix/{{taskIdShort}}");
      expect(name).toBe("fix/abcdefgh");
    });
  });

  describe("createTaskBranch", () => {
    it("creates a branch from main", () => {
      const result = createTaskBranch(tmpDir, "test-task-1234");

      expect(result.ok).toBe(true);
      expect(result.branchName).toBe("cf/task-test-tas");

      // Verify we're on the new branch
      const currentBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
      expect(currentBranch).toBe("cf/task-test-tas");
    });

    it("fails gracefully for non-existent base branch", () => {
      const result = createTaskBranch(tmpDir, "test-task", "nonexistent-branch");

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("mergeTaskBranch", () => {
    it("merges a branch with changes back to main", () => {
      // Create branch and add a file
      createTaskBranch(tmpDir, "merge-test");
      fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "new content");
      execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "pipe" });

      const result = mergeTaskBranch(tmpDir, "cf/task-merge-te");

      expect(result.ok).toBe(true);
      expect(result.conflicted).toBe(false);

      // Verify we're back on main and the file exists
      const currentBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
      expect(currentBranch).toBe("main");
      expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(true);
    });

    it("detects merge conflicts", () => {
      // Create branch and modify README
      createTaskBranch(tmpDir, "conflict-test");
      fs.writeFileSync(path.join(tmpDir, "README.md"), "branch version");
      execSync("git add . && git commit -m 'branch change'", { cwd: tmpDir, stdio: "pipe" });

      // Go back to main and make a conflicting change
      execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });
      fs.writeFileSync(path.join(tmpDir, "README.md"), "main version");
      execSync("git add . && git commit -m 'main change'", { cwd: tmpDir, stdio: "pipe" });

      const result = mergeTaskBranch(tmpDir, "cf/task-conflict");

      expect(result.ok).toBe(false);
      expect(result.conflicted).toBe(true);
    });
  });

  describe("deleteTaskBranch", () => {
    it("deletes a branch", () => {
      createTaskBranch(tmpDir, "delete-test");
      execSync("git checkout main", { cwd: tmpDir, stdio: "pipe" });

      const result = deleteTaskBranch(tmpDir, "cf/task-delete-t");

      expect(result.ok).toBe(true);

      // Verify branch is gone
      const branches = execSync("git branch", { cwd: tmpDir, encoding: "utf-8" });
      expect(branches).not.toContain("cf/task-delete-t");
    });

    it("fails gracefully for non-existent branch", () => {
      const result = deleteTaskBranch(tmpDir, "nonexistent-branch");

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("discardTaskBranch", () => {
    it("checks out main and deletes the branch", () => {
      createTaskBranch(tmpDir, "discard-test");
      // We're on the task branch now
      const currentBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
      expect(currentBranch).toBe("cf/task-discard-");

      const result = discardTaskBranch(tmpDir, "cf/task-discard-");

      expect(result.ok).toBe(true);

      // Verify we're on main
      const afterBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
      expect(afterBranch).toBe("main");
    });
  });
});
