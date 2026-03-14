import { describe, expect, it } from "vitest";
import {
  isMemoryWriteCall,
  getFlushPrompt,
} from "../../src/memory/flush-tracker.js";

describe("flush-tracker", () => {
  describe("isMemoryWriteCall", () => {
    it("detects file-write tools targeting memory/ paths", () => {
      expect(isMemoryWriteCall("edit_file", { path: "/project/memory/notes.md" })).toBe(true);
      expect(isMemoryWriteCall("write_file", { file_path: "/home/.memory/data.json" })).toBe(true);
      expect(isMemoryWriteCall("create_file", { filename: "memory/test.md" })).toBe(true);
      expect(isMemoryWriteCall("write_to_file", { path: "memory/stuff" })).toBe(true);
    });

    it("ignores file-write tools not targeting memory paths", () => {
      expect(isMemoryWriteCall("edit_file", { path: "/project/src/index.ts" })).toBe(false);
      expect(isMemoryWriteCall("write_file", { path: "/tmp/test.txt" })).toBe(false);
    });

    it("detects memory-named tools with write actions", () => {
      expect(isMemoryWriteCall("memory_save", { action: "save" })).toBe(true);
      expect(isMemoryWriteCall("memory_tool", { action: "write" })).toBe(true);
      expect(isMemoryWriteCall("memory_tool", { action: "create" })).toBe(true);
      expect(isMemoryWriteCall("memory_tool", { action: "update" })).toBe(true);
      expect(isMemoryWriteCall("memory_tool", { action: "store" })).toBe(true);
      expect(isMemoryWriteCall("memory_tool", { action: "append" })).toBe(true);
    });

    it("ignores memory-named tools with read actions", () => {
      expect(isMemoryWriteCall("memory_search", { action: "search" })).toBe(false);
      expect(isMemoryWriteCall("memory_get", { action: "get" })).toBe(false);
    });

    it("ignores unrelated tools", () => {
      expect(isMemoryWriteCall("bash", { command: "echo hello" })).toBe(false);
      expect(isMemoryWriteCall("read_file", { path: "/memory/test" })).toBe(false);
    });

    it("handles null/undefined params gracefully", () => {
      expect(isMemoryWriteCall("edit_file", null)).toBe(false);
      expect(isMemoryWriteCall("memory_tool", undefined)).toBe(false);
    });
  });

  describe("getFlushPrompt", () => {
    it("returns a non-empty prompt string", () => {
      const prompt = getFlushPrompt();
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain("Memory Checkpoint");
      expect(prompt).toContain("memory_search");
    });

    it("appends file targets when provided", () => {
      const prompt = getFlushPrompt(["docs/notes.md", "memory/context.md"]);
      expect(prompt).toContain("Memory Checkpoint");
      expect(prompt).toContain("docs/notes.md");
      expect(prompt).toContain("memory/context.md");
      expect(prompt).toContain("Also update these files");
    });

    it("returns base prompt when fileTargets is empty array", () => {
      const base = getFlushPrompt();
      const withEmpty = getFlushPrompt([]);
      expect(withEmpty).toBe(base);
    });
  });
});
