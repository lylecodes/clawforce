import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { getMemoryDb } = await import("../../src/db.js");
const { createClawforceMemoryTool, deriveAgentScopes } = await import("../../src/tools/memory-tool.js");

describe("clawforce_memory tool", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  let getDbMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    getDbMock = vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
  });

  function createTool(opts?: { agentId?: string; agentConfig?: Parameters<typeof createClawforceMemoryTool>[0] extends { agentConfig?: infer C } ? C : never }) {
    return createClawforceMemoryTool({
      agentSessionKey: "test-session",
      agentId: opts?.agentId ?? "test-agent",
      agentConfig: opts?.agentConfig,
    });
  }

  async function execute(params: Record<string, unknown>, opts?: Parameters<typeof createTool>[0]) {
    const tool = createTool(opts);
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("save", () => {
    it("creates a memory entry", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
        category: "learning",
        title: "API rate limits at 100 req/min",
        content: "Discovered that the external API rate limits at 100 requests per minute. Need to batch.",
      });

      expect(result.ok).toBe(true);
      expect(result.entry.id).toBeDefined();
      expect(result.entry.category).toBe("learning");
      expect(result.entry.title).toBe("API rate limits at 100 req/min");
      expect(result.entry.scope).toBe("agent:test-agent");
      expect(result.entry.confidence).toBe(0.7);
    });

    it("uses custom scope when provided", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:outreach",
        title: "LinkedIn limits",
        content: "LinkedIn limits connection requests to 100/week.",
      });

      expect(result.ok).toBe(true);
      expect(result.entry.scope).toBe("team:outreach");
    });

    it("clamps confidence to 0-1 range", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
        title: "High confidence",
        content: "Very sure about this.",
        confidence: 1.5,
      });

      expect(result.ok).toBe(true);
      expect(result.entry.confidence).toBe(1.0);
    });

    it("defaults category to learning", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
        title: "No category",
        content: "Some learning",
      });

      expect(result.ok).toBe(true);
      expect(result.entry.category).toBe("learning");
    });

    it("rejects invalid category", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
        category: "invalid",
        title: "Bad category",
        content: "Content",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Invalid category");
    });

    it("requires title and content", async () => {
      const result = await execute({
        action: "save",
        project_id: PROJECT,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Missing required parameter: title");
    });

    it("marks superseded entry as deprecated", async () => {
      // Create first entry
      const first = await execute({
        action: "save",
        project_id: PROJECT,
        title: "Old info",
        content: "Outdated content",
      });

      // Supersede it
      const second = await execute({
        action: "save",
        project_id: PROJECT,
        title: "Updated info",
        content: "New content",
        supersedes: first.entry.id,
      });

      expect(second.ok).toBe(true);

      // Old entry should be deprecated — shouldn't show in list
      const listed = await execute({
        action: "list",
        project_id: PROJECT,
        scope: "agent:test-agent",
      });

      const ids = listed.memories.map((m: { id: string }) => m.id);
      expect(ids).toContain(second.entry.id);
      expect(ids).not.toContain(first.entry.id);
    });

    it("returns related memories for context", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "First learning",
        content: "Content 1",
      });

      const result = await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "Second learning",
        content: "Content 2",
      });

      expect(result.ok).toBe(true);
      expect(result.related_memories).toHaveLength(1);
      expect(result.related_memories[0].title).toBe("First learning");
    });
  });

  describe("recall", () => {
    it("recalls memories by derived scopes", async () => {
      // Save a team-scoped memory
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:outreach",
        title: "Team learning",
        content: "Shared knowledge",
      });

      // Save an agent-scoped memory
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:lead-gen",
        title: "Personal learning",
        content: "My own note",
      });

      // Recall as an agent with team:outreach config
      const result = await execute(
        {
          action: "recall",
          project_id: PROJECT,
        },
        {
          agentId: "lead-gen",
          agentConfig: { role: "scheduled", team: "outreach", briefing: [], expectations: [], performance_policy: { action: "alert" } },
        },
      );

      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.scopes_queried).toContain("agent:lead-gen");
      expect(result.scopes_queried).toContain("team:outreach");
      expect(result.scopes_queried).toContain("role:scheduled");
    });

    it("filters by explicit scope", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "Sales learning",
        content: "Content",
      });

      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:engineering",
        title: "Engineering learning",
        content: "Content",
      });

      const result = await execute({
        action: "recall",
        project_id: PROJECT,
        scope: "team:sales",
      });

      expect(result.count).toBe(1);
      expect(result.memories[0].title).toBe("Sales learning");
    });

    it("filters by query text", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:test-agent",
        title: "API rate limits",
        content: "The API limits to 100 req/min",
      });

      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:test-agent",
        title: "Database optimization",
        content: "Use connection pooling",
      });

      const result = await execute({
        action: "recall",
        project_id: PROJECT,
        query: "rate limit",
      });

      expect(result.count).toBe(1);
      expect(result.memories[0].title).toBe("API rate limits");
    });

    it("excludes deprecated entries", async () => {
      const saved = await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:test-agent",
        title: "Will be deprecated",
        content: "Old content",
      });

      await execute({
        action: "deprecate",
        project_id: PROJECT,
        memory_id: saved.entry.id,
      });

      const result = await execute({
        action: "recall",
        project_id: PROJECT,
      });

      expect(result.count).toBe(0);
    });

    it("orders by quality signal (confidence * validation_count)", async () => {
      // Low quality
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:test-agent",
        title: "Low quality",
        content: "Unsure about this",
        confidence: 0.3,
      });

      // High quality
      const high = await execute({
        action: "save",
        project_id: PROJECT,
        scope: "agent:test-agent",
        title: "High quality",
        content: "Very confident",
        confidence: 0.9,
      });

      // Validate the high quality one to boost it further
      await execute({
        action: "validate",
        project_id: PROJECT,
        memory_id: high.entry.id,
      });

      const result = await execute({
        action: "recall",
        project_id: PROJECT,
      });

      expect(result.memories[0].title).toBe("High quality");
      expect(result.memories[1].title).toBe("Low quality");
    });
  });

  describe("validate", () => {
    it("bumps validation count and timestamp", async () => {
      const saved = await execute({
        action: "save",
        project_id: PROJECT,
        title: "Validated memory",
        content: "Content",
      });

      const result = await execute({
        action: "validate",
        project_id: PROJECT,
        memory_id: saved.entry.id,
      });

      expect(result.ok).toBe(true);
      expect(result.memory.validation_count).toBe(2);
    });

    it("rejects non-existent memory", async () => {
      const result = await execute({
        action: "validate",
        project_id: PROJECT,
        memory_id: "non-existent-id",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("rejects deprecated memory", async () => {
      const saved = await execute({
        action: "save",
        project_id: PROJECT,
        title: "Deprecated",
        content: "Content",
      });

      await execute({
        action: "deprecate",
        project_id: PROJECT,
        memory_id: saved.entry.id,
      });

      const result = await execute({
        action: "validate",
        project_id: PROJECT,
        memory_id: saved.entry.id,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("deprecated");
    });
  });

  describe("deprecate", () => {
    it("marks entry as deprecated", async () => {
      const saved = await execute({
        action: "save",
        project_id: PROJECT,
        title: "To deprecate",
        content: "Content",
      });

      const result = await execute({
        action: "deprecate",
        project_id: PROJECT,
        memory_id: saved.entry.id,
      });

      expect(result.ok).toBe(true);
      expect(result.deprecated).toBe(saved.entry.id);
    });

    it("rejects non-existent memory", async () => {
      const result = await execute({
        action: "deprecate",
        project_id: PROJECT,
        memory_id: "non-existent",
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("list", () => {
    it("lists non-deprecated memories", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "Entry 1",
        content: "Content 1",
      });

      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "Entry 2",
        content: "Content 2",
      });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        scope: "team:sales",
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
    });

    it("filters by scope", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:sales",
        title: "Sales",
        content: "Content",
      });

      await execute({
        action: "save",
        project_id: PROJECT,
        scope: "team:eng",
        title: "Engineering",
        content: "Content",
      });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        scope: "team:eng",
      });

      expect(result.count).toBe(1);
      expect(result.memories[0].title).toBe("Engineering");
    });

    it("filters by category", async () => {
      await execute({
        action: "save",
        project_id: PROJECT,
        category: "pattern",
        title: "Pattern",
        content: "Content",
      });

      await execute({
        action: "save",
        project_id: PROJECT,
        category: "warning",
        title: "Warning",
        content: "Content",
      });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        category: "warning",
      });

      expect(result.count).toBe(1);
      expect(result.memories[0].category).toBe("warning");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await execute({
          action: "save",
          project_id: PROJECT,
          title: `Entry ${i}`,
          content: `Content ${i}`,
        });
      }

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        limit: 3,
      });

      expect(result.count).toBe(3);
    });
  });

  describe("deriveAgentScopes", () => {
    it("returns agent scope by default", () => {
      const scopes = deriveAgentScopes("my-agent");
      expect(scopes).toEqual(["agent:my-agent"]);
    });

    it("includes role scope", () => {
      const scopes = deriveAgentScopes("my-agent", {
        role: "employee",
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
      });
      expect(scopes).toContain("agent:my-agent");
      expect(scopes).toContain("role:employee");
    });

    it("includes team and department scopes", () => {
      const scopes = deriveAgentScopes("my-agent", {
        role: "scheduled",
        team: "outreach",
        department: "sales",
        briefing: [],
        expectations: [],
        performance_policy: { action: "alert" },
      });
      expect(scopes).toContain("agent:my-agent");
      expect(scopes).toContain("role:scheduled");
      expect(scopes).toContain("team:outreach");
      expect(scopes).toContain("dept:sales");
    });
  });
});
