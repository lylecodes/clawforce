import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let projectDir = "";
let domainContextDir = "";

vi.mock("../../../src/project.js", () => ({
  getRegisteredAgentIds: vi.fn(() => projectDir ? ["lead"] : []),
  getAgentConfig: vi.fn((agentId: string) => {
    if (agentId !== "lead" || !projectDir) return null;
    return {
      projectId: "test-project",
      projectDir,
      config: {},
    };
  }),
}));

vi.mock("../../../src/config/api-service.js", () => ({
  getDomainContextDir: vi.fn(() => domainContextDir),
}));

const {
  ContextFileError,
  readDomainContextFile,
  writeDomainContextFile,
} = await import("../../../src/app/queries/context-files.js");

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("context file app queries", () => {
  beforeEach(() => {
    projectDir = createTempDir("clawforce-project-");
    domainContextDir = createTempDir("clawforce-context-");
  });

  afterEach(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    if (domainContextDir) fs.rmSync(domainContextDir, { recursive: true, force: true });
    projectDir = "";
    domainContextDir = "";
  });

  it("reads from the project directory by default", () => {
    fs.writeFileSync(path.join(projectDir, "DIRECTION.md"), "project copy", "utf8");

    const result = readDomainContextFile("test-project", "DIRECTION.md");

    expect(result.content).toBe("project copy");
    expect(result.path).toBe("DIRECTION.md");
  });

  it("falls back to the domain context directory when enabled", () => {
    fs.mkdirSync(path.join(domainContextDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(domainContextDir, "docs", "OPERATIONS.md"), "context copy", "utf8");

    const result = readDomainContextFile("test-project", "docs/OPERATIONS.md", {
      includeDomainContext: true,
    });

    expect(result.content).toBe("context copy");
  });

  it("writes back to the root that already owns the file", () => {
    fs.mkdirSync(path.join(domainContextDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(domainContextDir, "docs", "OPERATIONS.md"), "old", "utf8");

    writeDomainContextFile("test-project", "docs/OPERATIONS.md", "new", {
      includeDomainContext: true,
    });

    expect(fs.readFileSync(path.join(domainContextDir, "docs", "OPERATIONS.md"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(projectDir, "docs", "OPERATIONS.md"))).toBe(false);
  });

  it("throws a typed 404 when no roots are available", () => {
    projectDir = "";
    domainContextDir = "";

    try {
      readDomainContextFile("test-project", "DIRECTION.md", { includeDomainContext: true });
      expect.unreachable("expected readDomainContextFile to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextFileError);
      expect((error as ContextFileError).status).toBe(404);
    }
  });
});
