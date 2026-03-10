import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

// We test the assembler's resolveFile function indirectly through assembleContext
import { assembleContext } from "../../src/context/assembler.js";

describe("file glob support in assembler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-glob-test-"));
    // Create test files
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "guide-a.md"), "# Guide A\n\nContent A.", "utf-8");
    fs.writeFileSync(path.join(docsDir, "guide-b.md"), "# Guide B\n\nContent B.", "utf-8");
    fs.writeFileSync(path.join(docsDir, "readme.txt"), "Not a markdown file.", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves glob patterns to concatenated content", () => {
    const result = assembleContext("test-agent", {
      role: "employee",
      briefing: [
        { source: "file", path: "docs/*.md" },
      ],
      expectations: [],
      performance_policy: { action: "alert" },
    }, {
      projectDir: tmpDir,
    });

    expect(result).toContain("Guide A");
    expect(result).toContain("Guide B");
    // txt file should not be included
    expect(result).not.toContain("Not a markdown file");
  });

  it("resolves single file without glob", () => {
    const result = assembleContext("test-agent", {
      role: "employee",
      briefing: [
        { source: "file", path: "docs/guide-a.md" },
      ],
      expectations: [],
      performance_policy: { action: "alert" },
    }, {
      projectDir: tmpDir,
    });

    expect(result).toContain("Guide A");
    expect(result).not.toContain("Guide B");
  });
});
