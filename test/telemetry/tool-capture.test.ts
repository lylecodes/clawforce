import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  flushToolCallDetails,
  getToolCallDetails,
  truncateField,
} = await import("../../src/telemetry/tool-capture.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-telemetry";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("truncateField", () => {
  it("returns short strings unchanged", () => {
    const input = "hello world";
    expect(truncateField(input)).toBe(input);
  });

  it("truncates long strings with metadata", () => {
    const longStr = "x".repeat(20_000);
    const result = truncateField(longStr);
    const parsed = JSON.parse(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalSize).toBe(20_000);
    expect(parsed.content.length).toBeLessThan(10_240);
  });

  it("does not truncate strings exactly at the limit", () => {
    const exact = "a".repeat(10 * 1024);
    expect(truncateField(exact)).toBe(exact);
  });
});

describe("flushToolCallDetails", () => {
  it("inserts tool call details in batch", () => {
    const calls = [
      {
        toolName: "clawforce_task",
        action: "list" as string | null,
        input: '{"action":"list"}',
        output: '{"ok":true}',
        sequenceNumber: 0,
        durationMs: 50,
        success: true,
        timestamp: Date.now(),
      },
      {
        toolName: "clawforce_log",
        action: "write" as string | null,
        input: '{"action":"write","content":"test"}',
        output: '{"ok":true}',
        sequenceNumber: 1,
        durationMs: 30,
        success: true,
        timestamp: Date.now(),
      },
    ];

    const inserted = flushToolCallDetails("sess-1", PROJECT, "agent-1", calls, undefined, db);
    expect(inserted).toBe(2);
  });

  it("returns 0 for empty buffer", () => {
    const inserted = flushToolCallDetails("sess-empty", PROJECT, "agent-1", [], undefined, db);
    expect(inserted).toBe(0);
  });

  it("handles failed tool calls", () => {
    const calls = [
      {
        toolName: "external_tool",
        action: null,
        input: '{"param":"value"}',
        output: "",
        sequenceNumber: 0,
        durationMs: 100,
        success: false,
        errorMessage: "Connection timeout",
        timestamp: Date.now(),
      },
    ];

    flushToolCallDetails("sess-err", PROJECT, "agent-1", calls, "task-1", db);

    const details = getToolCallDetails(PROJECT, "sess-err", db);
    expect(details).toHaveLength(1);
    expect(details[0]!.success).toBe(false);
    expect(details[0]!.errorMessage).toBe("Connection timeout");
    expect(details[0]!.taskId).toBe("task-1");
  });

  it("truncates large input/output fields", () => {
    const largeInput = "i".repeat(20_000);
    const largeOutput = "o".repeat(20_000);

    const calls = [
      {
        toolName: "big_tool",
        action: null,
        input: largeInput,
        output: largeOutput,
        sequenceNumber: 0,
        durationMs: 200,
        success: true,
        timestamp: Date.now(),
      },
    ];

    flushToolCallDetails("sess-big", PROJECT, "agent-1", calls, undefined, db);

    const details = getToolCallDetails(PROJECT, "sess-big", db);
    expect(details).toHaveLength(1);

    const inputParsed = JSON.parse(details[0]!.input);
    expect(inputParsed.truncated).toBe(true);
    expect(inputParsed.originalSize).toBe(20_000);
  });
});

describe("getToolCallDetails", () => {
  it("returns calls ordered by sequence number", () => {
    const calls = Array.from({ length: 5 }, (_, i) => ({
      toolName: `tool-${i}`,
      action: null,
      input: `input-${i}`,
      output: `output-${i}`,
      sequenceNumber: i,
      durationMs: 10 * i,
      success: true,
      timestamp: Date.now(),
    }));

    flushToolCallDetails("sess-order", PROJECT, "agent-1", calls, undefined, db);

    const details = getToolCallDetails(PROJECT, "sess-order", db);
    expect(details).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(details[i]!.sequenceNumber).toBe(i);
      expect(details[i]!.toolName).toBe(`tool-${i}`);
    }
  });

  it("returns empty array for unknown session", () => {
    const details = getToolCallDetails(PROJECT, "nonexistent", db);
    expect(details).toHaveLength(0);
  });
});
