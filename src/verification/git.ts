/**
 * Clawforce — Git isolation for task branches
 *
 * Creates per-task branches, merges on completion, and cleans up.
 * Provides branch-level isolation so agents don't break main.
 */

import { execSync } from "node:child_process";

/**
 * Generate a branch name from a task ID and optional pattern.
 */
export function generateBranchName(taskId: string, pattern?: string): string {
  const short = taskId.slice(0, 8);
  const tmpl = pattern ?? "cf/task-{{taskIdShort}}";
  return tmpl.replace("{{taskId}}", taskId).replace("{{taskIdShort}}", short);
}

/**
 * Create a new branch for a task, checked out from a base branch.
 */
export function createTaskBranch(
  projectDir: string,
  taskId: string,
  baseBranch?: string,
  pattern?: string,
): { ok: boolean; branchName?: string; error?: string } {
  const branchName = generateBranchName(taskId, pattern);
  const base = baseBranch ?? "main";
  try {
    execSync(`git checkout ${base}`, { cwd: projectDir, stdio: "pipe" });
    execSync(`git checkout -b ${branchName}`, { cwd: projectDir, stdio: "pipe" });
    return { ok: true, branchName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Merge a task branch back into the base branch with --no-ff.
 * Aborts the merge and returns conflicted=true on conflict.
 */
export function mergeTaskBranch(
  projectDir: string,
  branchName: string,
  baseBranch?: string,
): { ok: boolean; conflicted: boolean; error?: string } {
  const base = baseBranch ?? "main";
  try {
    execSync(`git checkout ${base}`, { cwd: projectDir, stdio: "pipe" });
    execSync(`git merge ${branchName} --no-ff -m "Merge ${branchName}"`, { cwd: projectDir, stdio: "pipe" });
    return { ok: true, conflicted: false };
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    const stderrStr = (e.stderr as string) ?? "";
    const stdoutStr = (e.stdout as string) ?? "";
    const conflicted = stderrStr.includes("CONFLICT") || stdoutStr.includes("CONFLICT");
    if (conflicted) {
      try {
        execSync("git merge --abort", { cwd: projectDir, stdio: "pipe" });
      } catch { /* merge abort is best-effort */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, conflicted, error: message };
  }
}

/**
 * Force-delete a task branch.
 */
export function deleteTaskBranch(
  projectDir: string,
  branchName: string,
): { ok: boolean; error?: string } {
  try {
    execSync(`git branch -D ${branchName}`, { cwd: projectDir, stdio: "pipe" });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Discard a task branch: check out the base branch, then delete the task branch.
 */
export function discardTaskBranch(
  projectDir: string,
  branchName: string,
  baseBranch?: string,
): { ok: boolean; error?: string } {
  const base = baseBranch ?? "main";
  try {
    execSync(`git checkout ${base}`, { cwd: projectDir, stdio: "pipe" });
    execSync(`git branch -D ${branchName}`, { cwd: projectDir, stdio: "pipe" });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
