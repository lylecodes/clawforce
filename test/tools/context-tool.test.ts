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

import { createClawforceContextTool } from "../../src/tools/context-tool.js";

describe("clawforce_context tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-ctx-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.md"), "# Test File\n\nSome content.", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("get_file reads a project file", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "get_file",
      path: "test.md",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(true);
    expect(data.content).toContain("Test File");
    expect(data.content).toContain("Some content.");
  });

  it("get_file blocks path traversal", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "get_file",
      path: "../../../etc/passwd",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("traversal");
  });

  it("get_file returns error for missing file", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "get_file",
      path: "nonexistent.md",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("not found");
  });

  it("list_skills returns topic list", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "list_skills",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(true);
    expect(data.topics).toBeInstanceOf(Array);
    expect(data.topics.length).toBeGreaterThan(0);
    // Should have at least the built-in topics like "roles"
    expect(data.topics.some((t: { id: string }) => t.id === "roles")).toBe(true);
  });

  it("get_skill returns topic content", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "get_skill",
      topic: "roles",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(true);
    expect(data.content).toBeTruthy();
    expect(data.topic).toBe("roles");
  });

  it("get_skill returns error for unknown topic", async () => {
    const tool = createClawforceContextTool({
      projectId: "test-proj",
      projectDir: tmpDir,
    });

    const result = await tool.execute("call1", {
      action: "get_skill",
      topic: "nonexistent_topic",
    });

    const data = JSON.parse(result.content[0]!.text);
    expect(data.ok).toBe(true); // resolveSkillSource returns an error message string, not null
    // The content will contain "Unknown skill topic"
    expect(data.content).toContain("Unknown skill topic");
  });
});
