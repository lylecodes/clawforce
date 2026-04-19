import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { createClawforceLogTool } = await import("../../src/tools/log-tool.js");

describe("clawforce_log tool", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  // Override getDb to return in-memory db
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

  function createTool() {
    return createClawforceLogTool({
      agentSessionKey: "test-session",
      agentId: "test-agent",
    });
  }

  async function execute(params: Record<string, unknown>) {
    const tool = createTool();
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("write", () => {
    it("creates a knowledge entry", async () => {
      const result = await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Use SQLite for storage",
        content: "Decided to use SQLite because it's embedded and requires no external deps.",
        tags: ["architecture", "storage"],
      });

      expect(result.ok).toBe(true);
      expect(result.entry.id).toBeDefined();
      expect(result.entry.category).toBe("decision");
      expect(result.entry.title).toBe("Use SQLite for storage");
    });

    it("returns related entries for context", async () => {
      // Create a first entry
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "First decision",
        content: "First content",
      });

      // Create a second entry in the same category
      const result = await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Second decision",
        content: "Second content",
      });

      expect(result.ok).toBe(true);
      expect(result.related_entries).toHaveLength(1);
      expect(result.related_entries[0].title).toBe("First decision");
    });

    it("defaults category to context", async () => {
      const result = await execute({
        action: "write",
        project_id: PROJECT,
        title: "No category",
        content: "Some content",
      });

      expect(result.ok).toBe(true);
      expect(result.entry.category).toBe("context");
    });

    it("requires title and content", async () => {
      const result = await execute({
        action: "write",
        project_id: PROJECT,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Missing required parameter: title");
    });
  });

  describe("outcome", () => {
    it("creates an audit run entry", async () => {
      const result = await execute({
        action: "outcome",
        project_id: PROJECT,
        status: "success",
        summary: "Completed outreach campaign",
        details: "Sent 50 messages, 30 responses",
      });

      expect(result.ok).toBe(true);
      expect(result.audit_run.id).toBeDefined();
      expect(result.audit_run.status).toBe("success");
      expect(result.audit_run.summary).toBe("Completed outreach campaign");
    });

    it("defaults status to success", async () => {
      const result = await execute({
        action: "outcome",
        project_id: PROJECT,
        summary: "Done",
      });

      expect(result.audit_run.status).toBe("success");
    });
  });

  describe("search", () => {
    it("searches by query text", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Error handling pattern",
        content: "Always use try-catch with specific error types.",
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Unrelated thing",
        content: "Something completely different.",
      });

      const result = await execute({
        action: "search",
        project_id: PROJECT,
        query: "error handling",
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].title).toBe("Error handling pattern");
    });

    it("filters by category", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Pattern 1",
        content: "Content 1",
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Decision 1",
        content: "Content 2",
      });

      const result = await execute({
        action: "search",
        project_id: PROJECT,
        category: "pattern",
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].category).toBe("pattern");
    });

    it("filters by tags", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Architecture pattern",
        content: "Content",
        tags: ["architecture", "backend"],
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Frontend pattern",
        content: "Content",
        tags: ["frontend"],
      });

      const result = await execute({
        action: "search",
        project_id: PROJECT,
        tags: ["architecture"],
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].title).toBe("Architecture pattern");
    });

    it("does not match substring tags (exact match only)", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Rapid development",
        content: "Content",
        tags: ["rapid"],
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "API design",
        content: "Content",
        tags: ["api"],
      });

      // Searching for "api" should NOT match "rapid"
      const result = await execute({
        action: "search",
        project_id: PROJECT,
        tags: ["api"],
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].title).toBe("API design");
    });
  });

  describe("list", () => {
    it("lists recent entries", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Entry 1",
        content: "Content 1",
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Entry 2",
        content: "Content 2",
      });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
      const titles = result.entries.map((e: { title: string }) => e.title).sort();
      expect(titles).toEqual(["Entry 1", "Entry 2"]);
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await execute({
          action: "write",
          project_id: PROJECT,
          category: "context",
          title: `Entry ${i}`,
          content: `Content ${i}`,
        });
      }

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        limit: 3,
      });

      expect(result.entries).toHaveLength(3);
    });

    it("filters by category", async () => {
      await execute({
        action: "write",
        project_id: PROJECT,
        category: "decision",
        title: "Decision",
        content: "Content",
      });

      await execute({
        action: "write",
        project_id: PROJECT,
        category: "pattern",
        title: "Pattern",
        content: "Content",
      });

      const result = await execute({
        action: "list",
        project_id: PROJECT,
        category: "decision",
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].category).toBe("decision");
    });
  });
});
