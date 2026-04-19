import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function findWorkspaceClawforceHome(startDir: string): string | undefined {
  if (typeof fs.existsSync !== "function" || typeof fs.statSync !== "function") {
    return undefined;
  }
  let current = path.resolve(startDir);
  while (true) {
    if (path.basename(current) === ".clawforce" && fs.existsSync(current)) {
      return current;
    }
    const candidate = path.join(current, ".clawforce");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Resolve a path hint into a ClawForce home.
 *
 * Accepts either the `.clawforce` directory itself or any descendant workspace
 * path and walks upward until it finds `.clawforce`.
 */
export function resolveClawforceHomeHint(pathHint: string): string | undefined {
  const resolvedHint = path.resolve(pathHint);
  if (!fs.existsSync(resolvedHint)) {
    return path.basename(resolvedHint) === ".clawforce" ? resolvedHint : undefined;
  }
  return findWorkspaceClawforceHome(resolvedHint)
    ?? (path.basename(resolvedHint) === ".clawforce" ? resolvedHint : undefined);
}

/**
 * Resolve a set of path hints into unique ClawForce homes.
 */
export function resolveClawforceHomes(pathHints: Iterable<string>): string[] {
  const homes = new Set<string>();
  for (const hint of pathHints) {
    if (typeof hint !== "string" || hint.trim().length === 0) continue;
    const home = resolveClawforceHomeHint(hint);
    if (home) {
      homes.add(path.resolve(home));
    }
  }
  return [...homes].sort();
}

/** Resolve the ClawForce base directory, respecting CLAWFORCE_HOME env var. */
export function getClawforceHome(): string {
  if (process.env.CLAWFORCE_HOME) {
    return path.resolve(process.env.CLAWFORCE_HOME);
  }
  const workspaceHome = findWorkspaceClawforceHome(process.cwd());
  if (workspaceHome) {
    return workspaceHome;
  }
  return path.join(os.homedir(), ".clawforce");
}
