// test/memory/review-context.test.ts
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("memory_review job preset", () => {
  it("exists in BUILTIN_JOB_PRESETS", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    expect(BUILTIN_JOB_PRESETS.memory_review).toBeDefined();
    expect(BUILTIN_JOB_PRESETS.memory_review.cron).toBe("0 18 * * *");
    expect(BUILTIN_JOB_PRESETS.memory_review.nudge).toContain("session transcripts");
  });

  it("memory_review preset has memory_review_context in briefing", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_JOB_PRESETS.memory_review.briefing as string[];
    expect(briefing).toContain("memory_review_context");
  });

  it("memory_review preset has memory_search expectation", async () => {
    const { BUILTIN_JOB_PRESETS } = await import("../../src/presets.js");
    const expectations = BUILTIN_JOB_PRESETS.memory_review.expectations as Array<{ tool: string }>;
    expect(expectations.some((e) => e.tool === "memory_search")).toBe(true);
  });
});

describe("review-context source", () => {
  it("buildReviewContext returns summary when no transcripts exist", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("Memory Review");
      expect(result).toContain("No session transcripts found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext includes aggressiveness guidance", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));

    try {
      const resultLow = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "low",
        projectDir: tmpDir,
      });
      expect(resultLow).toContain("explicit decisions");

      const resultHigh = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "high",
        projectDir: tmpDir,
      });
      expect(resultHigh).toContain("Everything potentially useful");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext reads JSONL transcript files", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const sessionsDir = path.join(tmpDir, "agents", "lead", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a fake transcript JSONL file modified "today"
    const transcriptFile = path.join(sessionsDir, "session-001.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "Fix the login bug" }),
      JSON.stringify({ role: "assistant", content: "I found the issue in auth.ts" }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("Fix the login bug");
      expect(result).toContain("auth.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext includes SOUL.md content when available", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const agentDir = path.join(tmpDir, "agents", "lead");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "SOUL.md"), "I am a careful engineer who values testing.");

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
      });
      expect(result).toContain("careful engineer");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("buildReviewContext truncates long transcripts", async () => {
    const { buildReviewContext } = await import("../../src/memory/review-context.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-review-"));
    const sessionsDir = path.join(tmpDir, "agents", "lead", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a large transcript
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ role: "user", content: `Message ${i}: ${"x".repeat(200)}` }));
    }
    fs.writeFileSync(path.join(sessionsDir, "session-big.jsonl"), lines.join("\n"));

    try {
      const result = buildReviewContext({
        agentId: "lead",
        scope: "self",
        aggressiveness: "medium",
        projectDir: tmpDir,
        maxTranscriptChars: 5000,
      });
      // Should be truncated
      expect(result.length).toBeLessThan(10000);
      expect(result).toContain("truncated");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
