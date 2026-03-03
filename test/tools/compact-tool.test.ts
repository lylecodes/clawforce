import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { createClawforceCompactTool } = await import("../../src/tools/compact-tool.js");
const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");

describe("clawforce_compact tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-compact-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTool(overrides?: { agentId?: string }) {
    return createClawforceCompactTool({
      projectDir: tmpDir,
      agentSessionKey: "test-session",
      agentId: overrides?.agentId ?? "test-agent",
    });
  }

  function parseResult(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0]!.text);
  }

  describe("read_doc", () => {
    it("reads an existing file", async () => {
      fs.writeFileSync(path.join(tmpDir, "notes.md"), "# Notes\n\nSome content.");
      const tool = createTool();
      const result = await tool.execute("call-1", { action: "read_doc", file_path: "notes.md" });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.exists).toBe(true);
      expect(parsed.content).toContain("# Notes");
      expect(parsed.content).toContain("Some content");
    });

    it("returns exists: false for missing file", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", { action: "read_doc", file_path: "missing.md" });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.exists).toBe(false);
      expect(parsed.content).toBeNull();
    });

    it("truncates files over 10KB", async () => {
      const bigContent = "x".repeat(15_000);
      fs.writeFileSync(path.join(tmpDir, "big.md"), bigContent);
      const tool = createTool();
      const result = await tool.execute("call-1", { action: "read_doc", file_path: "big.md" });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.content.length).toBeLessThan(bigContent.length);
      expect(parsed.content).toContain("…(truncated)");
    });

    it("blocks path traversal", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "read_doc",
        file_path: "../../../etc/passwd",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("outside the project directory");
    });

    it("reads files in subdirectories", async () => {
      fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "docs", "arch.md"), "Architecture doc");
      const tool = createTool();
      const result = await tool.execute("call-1", { action: "read_doc", file_path: "docs/arch.md" });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.content).toBe("Architecture doc");
    });
  });

  describe("update_doc", () => {
    it("creates a new file", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "update_doc",
        file_path: "PROJECT.md",
        content: "# Project\n\nUpdated status.",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBe("PROJECT.md");
      expect(parsed.previous_size).toBe(0);
      expect(parsed.new_size).toBeGreaterThan(0);

      // Verify file was written
      const written = fs.readFileSync(path.join(tmpDir, "PROJECT.md"), "utf-8");
      expect(written).toBe("# Project\n\nUpdated status.");
    });

    it("updates an existing file and reports sizes", async () => {
      const original = "# Old content";
      fs.writeFileSync(path.join(tmpDir, "doc.md"), original);

      const tool = createTool();
      const newContent = "# Updated content\n\nWith more details.";
      const result = await tool.execute("call-1", {
        action: "update_doc",
        file_path: "doc.md",
        content: newContent,
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.previous_size).toBe(Buffer.byteLength(original));
      expect(parsed.new_size).toBe(Buffer.byteLength(newContent));
    });

    it("creates parent directories if needed", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "update_doc",
        file_path: "docs/deep/nested/file.md",
        content: "Nested content",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "docs/deep/nested/file.md"))).toBe(true);
    });

    it("blocks path traversal", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "update_doc",
        file_path: "../../outside.md",
        content: "malicious",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("outside the project directory");
    });

    it("emits diagnostic event on update", async () => {
      const tool = createTool({ agentId: "leon" });
      await tool.execute("call-1", {
        action: "update_doc",
        file_path: "PROJECT.md",
        content: "Updated.",
      });
      expect(emitDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "compaction_update",
          agentId: "leon",
          filePath: "PROJECT.md",
        }),
      );
    });

    it("requires content parameter", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "update_doc",
        file_path: "doc.md",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("content");
    });
  });

  describe("unknown action", () => {
    it("returns error for unknown action", async () => {
      const tool = createTool();
      const result = await tool.execute("call-1", {
        action: "delete_doc",
        file_path: "doc.md",
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("Unknown action");
    });
  });
});
