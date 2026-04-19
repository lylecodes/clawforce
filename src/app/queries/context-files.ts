import fs from "node:fs";
import path from "node:path";
import { getDomainContextDir } from "../../config/api-service.js";
import { getAgentConfig, getRegisteredAgentIds } from "../../project.js";

export type DomainContextQueryOptions = {
  includeDomainContext?: boolean;
};

export class ContextFileError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ContextFileError";
    this.status = status;
  }
}

function resolveContextFilePath(projectDir: string, relativePath: string): string {
  if (!relativePath || typeof relativePath !== "string") {
    throw new ContextFileError("Invalid path", 400);
  }

  if (path.isAbsolute(relativePath)) {
    throw new ContextFileError("Path must be relative", 403);
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) {
    throw new ContextFileError("Path traversal is not allowed", 403);
  }

  const resolvedPath = path.resolve(projectDir, relativePath);
  const normalizedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(normalizedProjectDir + path.sep) && resolvedPath !== normalizedProjectDir) {
    throw new ContextFileError("Path traversal is not allowed", 403);
  }

  return resolvedPath;
}

export function readContextFile(projectDir: string, relativePath: string) {
  const filePath = resolveContextFilePath(projectDir, relativePath);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ContextFileError("File not found", 404);
  }

  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  return {
    content,
    path: relativePath,
    lastModified: stat.mtimeMs,
  };
}

export function writeContextFile(projectDir: string, relativePath: string, content: string) {
  const filePath = resolveContextFilePath(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { ok: true as const };
}

export function resolveDomainProjectDir(projectId: string): string | null {
  const agentIds = getRegisteredAgentIds();
  for (const agentId of agentIds) {
    const entry = getAgentConfig(agentId);
    if (entry?.projectId === projectId && entry.projectDir) {
      return entry.projectDir;
    }
  }
  return null;
}

export function resolveContextRoots(
  projectId: string,
  options: DomainContextQueryOptions = {},
): string[] {
  const roots = [
    resolveDomainProjectDir(projectId),
    options.includeDomainContext ? getDomainContextDir(projectId) : null,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return Array.from(new Set(roots));
}

function resolveContextWriteRoot(
  projectId: string,
  relativePath: string,
  options: DomainContextQueryOptions = {},
): string | null {
  const roots = resolveContextRoots(projectId, options);
  if (roots.length === 0) return null;

  for (const root of roots) {
    try {
      readContextFile(root, relativePath);
      return root;
    } catch (error) {
      if (error instanceof ContextFileError && error.status === 404) continue;
      return root;
    }
  }

  return roots[0] ?? null;
}

export function readDomainContextFile(
  projectId: string,
  relativePath: string,
  options: DomainContextQueryOptions = {},
) {
  const roots = resolveContextRoots(projectId, options);
  if (roots.length === 0) {
    throw new ContextFileError("Project directory not found", 404);
  }

  for (const root of roots) {
    try {
      return readContextFile(root, relativePath);
    } catch (error) {
      if (error instanceof ContextFileError && error.status === 404) continue;
      if (error instanceof ContextFileError) throw error;
      throw new ContextFileError("Failed to read context file", 500);
    }
  }

  throw new ContextFileError("File not found", 404);
}

export function writeDomainContextFile(
  projectId: string,
  relativePath: string,
  content: string,
  options: DomainContextQueryOptions = {},
) {
  const root = resolveContextWriteRoot(projectId, relativePath, options);
  if (!root) {
    throw new ContextFileError("Project directory not found", 404);
  }

  try {
    return writeContextFile(root, relativePath, content);
  } catch (error) {
    if (error instanceof ContextFileError) throw error;
    throw new ContextFileError("Failed to write context file", 500);
  }
}
