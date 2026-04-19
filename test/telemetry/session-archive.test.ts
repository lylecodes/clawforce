import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  archiveSession,
  extractSessionArchiveDiagnostics,
  getSessionArchive,
  listSessionArchives,
} = await import("../../src/telemetry/session-archive.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-telemetry";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("archiveSession", () => {
  it("creates a session archive record", () => {
    const archive = archiveSession({
      sessionKey: "sess-1",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now() - 60_000,
      toolCallCount: 5,
      errorCount: 0,
    }, db);

    expect(archive.id).toBeDefined();
    expect(archive.outcome).toBe("compliant");
    expect(archive.toolCallCount).toBe(5);
    expect(archive.createdAt).toBeGreaterThan(0);
  });

  it("compresses and decompresses transcript", () => {
    const transcript = JSON.stringify([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    archiveSession({
      sessionKey: "sess-transcript",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now() - 60_000,
      transcript,
    }, db);

    const retrieved = getSessionArchive(PROJECT, "sess-transcript", db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.transcript).toBe(transcript);
  });

  it("compresses and decompresses context content", () => {
    const contextContent = "## Agent Instructions\n\nYou are a helpful assistant.\n\n## Tasks\n\n- Complete the review";

    archiveSession({
      sessionKey: "sess-ctx",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now() - 60_000,
      contextContent,
    }, db);

    const retrieved = getSessionArchive(PROJECT, "sess-ctx", db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.contextContent).toBe(contextContent);
  });

  it("stores cost and token data", () => {
    archiveSession({
      sessionKey: "sess-cost",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now() - 60_000,
      totalCostCents: 42,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      model: "claude-opus-4-6",
      provider: "anthropic",
    }, db);

    const retrieved = getSessionArchive(PROJECT, "sess-cost", db);
    expect(retrieved!.totalCostCents).toBe(42);
    expect(retrieved!.totalInputTokens).toBe(1000);
    expect(retrieved!.totalOutputTokens).toBe(500);
    expect(retrieved!.model).toBe("claude-opus-4-6");
    expect(retrieved!.provider).toBe("anthropic");
  });
});

describe("getSessionArchive", () => {
  it("returns null for non-existent session", () => {
    const result = getSessionArchive(PROJECT, "nonexistent", db);
    expect(result).toBeNull();
  });
});

describe("listSessionArchives", () => {
  it("lists archives with pagination", () => {
    const baseTime = Date.now() - 300_000;
    for (let i = 0; i < 5; i++) {
      archiveSession({
        sessionKey: `sess-list-${i}`,
        agentId: "agent-1",
        projectId: PROJECT,
        outcome: i % 2 === 0 ? "compliant" : "non_compliant",
        startedAt: baseTime + i * 60_000,
      }, db);
    }

    const all = listSessionArchives(PROJECT, undefined, db);
    expect(all).toHaveLength(5);

    const limited = listSessionArchives(PROJECT, { limit: 2 }, db);
    expect(limited).toHaveLength(2);

    const paged = listSessionArchives(PROJECT, { limit: 2, offset: 2 }, db);
    expect(paged).toHaveLength(2);
  });

  it("filters by agent", () => {
    archiveSession({
      sessionKey: "sess-a1",
      agentId: "agent-a",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now(),
    }, db);
    archiveSession({
      sessionKey: "sess-b1",
      agentId: "agent-b",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now(),
    }, db);

    const filtered = listSessionArchives(PROJECT, { agentId: "agent-a" }, db);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.agentId).toBe("agent-a");
  });

  it("filters by outcome", () => {
    archiveSession({
      sessionKey: "sess-ok",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "compliant",
      startedAt: Date.now(),
    }, db);
    archiveSession({
      sessionKey: "sess-fail",
      agentId: "agent-1",
      projectId: PROJECT,
      outcome: "non_compliant",
      startedAt: Date.now(),
    }, db);

    const compliant = listSessionArchives(PROJECT, { outcome: "compliant" }, db);
    expect(compliant).toHaveLength(1);
    expect(compliant[0]!.outcome).toBe("compliant");
  });

  it("filters by task id", () => {
    archiveSession({
      sessionKey: "sess-task-a",
      agentId: "agent-1",
      projectId: PROJECT,
      taskId: "task-a",
      outcome: "compliant",
      startedAt: Date.now(),
    }, db);
    archiveSession({
      sessionKey: "sess-task-b",
      agentId: "agent-1",
      projectId: PROJECT,
      taskId: "task-b",
      outcome: "compliant",
      startedAt: Date.now(),
    }, db);

    const filtered = listSessionArchives(PROJECT, { taskId: "task-a" }, db);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.taskId).toBe("task-a");
  });
});

describe("extractSessionArchiveDiagnostics", () => {
  it("parses compact execution diagnostics from compliance detail", () => {
    const diagnostics = extractSessionArchiveDiagnostics({
      complianceDetail: JSON.stringify({
      complianceObserved: false,
      compliant: false,
      exitCode: 0,
        signal: null,
        terminatedReason: "controller_shutdown",
        timeoutMs: 120000,
        logicalCompletion: true,
        summarySynthetic: true,
      observedWork: false,
      resultSource: "synthetic",
        outputFilePresent: false,
        outputChars: 0,
        stdoutChars: 0,
        stderrChars: 68,
        promptChars: 1024,
      finalPromptChars: 2048,
      mcpBridgeDisabled: true,
      configOverrideCount: 3,
      binary: "codex",
      cwd: "/tmp/project",
      stderrLooksLikeLaunchTranscript: true,
      stderr: "Reading additional input from stdin...\nOpenAI Codex v0.118.0",
    }),
    });

    expect(diagnostics).toMatchObject({
      complianceObserved: false,
      exitCode: 0,
      signal: null,
      terminatedReason: "controller_shutdown",
      timeoutMs: 120000,
      logicalCompletion: true,
      summarySynthetic: true,
      observedWork: false,
      resultSource: "synthetic",
      stderrChars: 68,
      promptChars: 1024,
      finalPromptChars: 2048,
      mcpBridgeDisabled: true,
      configOverrideCount: 3,
      binary: "codex",
      cwd: "/tmp/project",
      stderrLooksLikeLaunchTranscript: true,
    });
    expect(diagnostics?.stderrPreview).toContain("Reading additional input from stdin");
  });

  it("returns null for malformed compliance detail", () => {
    expect(extractSessionArchiveDiagnostics({ complianceDetail: "{not-json" })).toBeNull();
  });
});
