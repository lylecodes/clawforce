import { beforeEach, describe, expect, it } from "vitest";
import {
  incrementTurnCount,
  getTurnCount,
  incrementToolCallCount,
  markMemoryWrite,
  hasMemoryWrite,
  shouldFlush,
  resetCycle,
  markFlushAttempted,
  hasFlushBeenAttempted,
  isSessionSubstantive,
  clearSession,
  clearAllSessions,
  isMemoryWriteCall,
  getFlushPrompt,
} from "../../src/memory/flush-tracker.js";

describe("flush-tracker", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  describe("turn counting", () => {
    it("starts at 0 for unknown sessions", () => {
      expect(getTurnCount("unknown")).toBe(0);
    });

    it("increments and returns new count", () => {
      expect(incrementTurnCount("s1")).toBe(1);
      expect(incrementTurnCount("s1")).toBe(2);
      expect(incrementTurnCount("s1")).toBe(3);
    });

    it("tracks sessions independently", () => {
      incrementTurnCount("s1");
      incrementTurnCount("s1");
      incrementTurnCount("s2");
      expect(getTurnCount("s1")).toBe(2);
      expect(getTurnCount("s2")).toBe(1);
    });
  });

  describe("memory write tracking", () => {
    it("defaults to no writes", () => {
      expect(hasMemoryWrite("s1")).toBe(false);
    });

    it("marks memory write", () => {
      markMemoryWrite("s1");
      expect(hasMemoryWrite("s1")).toBe(true);
    });

    it("resetCycle clears the write flag", () => {
      markMemoryWrite("s1");
      resetCycle("s1");
      expect(hasMemoryWrite("s1")).toBe(false);
    });
  });

  describe("shouldFlush", () => {
    it("returns false for unknown sessions", () => {
      expect(shouldFlush("unknown", 5)).toBe(false);
    });

    it("returns false when turn count is not at interval", () => {
      incrementTurnCount("s1"); // 1
      incrementTurnCount("s1"); // 2
      incrementTurnCount("s1"); // 3
      expect(shouldFlush("s1", 5)).toBe(false);
    });

    it("returns true at exact interval with no memory writes", () => {
      for (let i = 0; i < 15; i++) incrementTurnCount("s1");
      expect(shouldFlush("s1", 15)).toBe(true);
    });

    it("returns true at multiples of the interval", () => {
      for (let i = 0; i < 30; i++) incrementTurnCount("s1");
      expect(shouldFlush("s1", 15)).toBe(true);
    });

    it("returns false when memory has been written", () => {
      for (let i = 0; i < 15; i++) incrementTurnCount("s1");
      markMemoryWrite("s1");
      expect(shouldFlush("s1", 15)).toBe(false);
    });

    it("returns true again after resetCycle clears write flag", () => {
      for (let i = 0; i < 15; i++) incrementTurnCount("s1");
      markMemoryWrite("s1");
      resetCycle("s1");
      expect(shouldFlush("s1", 15)).toBe(true);
    });
  });

  describe("flush attempted tracking", () => {
    it("defaults to not attempted", () => {
      expect(hasFlushBeenAttempted("s1")).toBe(false);
    });

    it("marks flush as attempted", () => {
      markFlushAttempted("s1");
      expect(hasFlushBeenAttempted("s1")).toBe(true);
    });
  });

  describe("isSessionSubstantive", () => {
    it("returns false for unknown sessions", () => {
      expect(isSessionSubstantive("unknown", 3)).toBe(false);
    });

    it("returns false when tool calls below threshold", () => {
      incrementToolCallCount("s1");
      incrementToolCallCount("s1");
      expect(isSessionSubstantive("s1", 3)).toBe(false);
    });

    it("returns true when tool calls meet threshold", () => {
      incrementToolCallCount("s1");
      incrementToolCallCount("s1");
      incrementToolCallCount("s1");
      expect(isSessionSubstantive("s1", 3)).toBe(true);
    });

    it("returns true when tool calls exceed threshold", () => {
      for (let i = 0; i < 10; i++) incrementToolCallCount("s1");
      expect(isSessionSubstantive("s1", 3)).toBe(true);
    });
  });

  describe("clearSession", () => {
    it("removes all state for a session", () => {
      incrementTurnCount("s1");
      markMemoryWrite("s1");
      markFlushAttempted("s1");
      incrementToolCallCount("s1");

      clearSession("s1");

      expect(getTurnCount("s1")).toBe(0);
      expect(hasMemoryWrite("s1")).toBe(false);
      expect(hasFlushBeenAttempted("s1")).toBe(false);
      expect(isSessionSubstantive("s1", 1)).toBe(false);
    });
  });

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
  });
});
