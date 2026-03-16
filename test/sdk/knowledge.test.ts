/**
 * Tests for the KnowledgeNamespace SDK wrapper.
 *
 * Strategy: use setProjectsDir with a temp directory so getDb creates an
 * ephemeral file-based SQLite DB per test. Reset between tests via
 * resetDbForTest + tmpDir cleanup for full isolation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

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

// ---- Dynamic imports after mocks ----

const { setProjectsDir, getProjectsDir, resetDbForTest } = await import("../../src/db.js");
const { KnowledgeNamespace } = await import("../../src/sdk/knowledge.js");

// ---- Constants ----

const DOMAIN = "test-knowledge-ns";

// ---- Tests ----

describe("KnowledgeNamespace", () => {
  let tmpDir: string;
  let originalDir: string;
  let ns: InstanceType<typeof KnowledgeNamespace>;

  beforeEach(() => {
    originalDir = getProjectsDir();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-knowledge-test-"));
    setProjectsDir(tmpDir);
    ns = new KnowledgeNamespace(DOMAIN);
  });

  afterEach(() => {
    resetDbForTest();
    setProjectsDir(originalDir);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("accepts arbitrary domain strings", () => {
      expect(new KnowledgeNamespace("research-lab").domain).toBe("research-lab");
      expect(new KnowledgeNamespace("npc-memory").domain).toBe("npc-memory");
    });
  });

  // ---------- store ----------

  describe("store", () => {
    it("stores an entry and returns a KnowledgeEntry with an id", () => {
      const entry = ns.store({ type: "context", content: "Hello world" });
      expect(entry.id).toBeTruthy();
      expect(entry.type).toBe("context");
      expect(entry.content).toBe("Hello world");
      expect(typeof entry.createdAt).toBe("number");
      expect(Array.isArray(entry.tags)).toBe(true);
    });

    it("uses type as default title when no title provided", () => {
      const entry = ns.store({ type: "decision", content: "Do the thing" });
      expect(entry.title).toBe("decision");
    });

    it("uses provided title", () => {
      const entry = ns.store({ type: "pattern", content: "Always test", title: "Test Early" });
      expect(entry.title).toBe("Test Early");
    });

    it("assigns unique IDs to different entries", () => {
      const a = ns.store({ type: "context", content: "A" });
      const b = ns.store({ type: "context", content: "B" });
      expect(a.id).not.toBe(b.id);
    });

    it("stores tags and returns them on the entry", () => {
      const entry = ns.store({
        type: "pattern",
        content: "Cache results",
        tags: ["performance", "caching"],
      });
      expect(entry.tags).toEqual(["performance", "caching"]);
    });

    it("stores agentId and returns it on the entry", () => {
      const entry = ns.store({
        type: "context",
        content: "Agent found this",
        agentId: "agent:researcher",
      });
      expect(entry.agentId).toBe("agent:researcher");
    });

    it("stores taskId and returns it on the entry", () => {
      const entry = ns.store({
        type: "outcome",
        content: "Task result",
        taskId: "task-123",
      });
      expect(entry.taskId).toBe("task-123");
    });

    it("appends metadata as a JSON comment block in content", () => {
      const entry = ns.store({
        type: "context",
        content: "Some fact",
        metadata: { source: "web", confidence: 0.9 },
      });
      expect(entry.content).toContain("<!-- metadata:");
      expect(entry.content).toContain('"source":"web"');
    });

    it("does not add metadata block when metadata is empty", () => {
      const entry = ns.store({ type: "context", content: "Clean content", metadata: {} });
      expect(entry.content).toBe("Clean content");
    });

    it("returns empty tags array when no tags provided", () => {
      const entry = ns.store({ type: "context", content: "No tags" });
      expect(entry.tags).toEqual([]);
    });
  });

  // ---------- get ----------

  describe("get", () => {
    it("retrieves a stored entry by ID", () => {
      const stored = ns.store({ type: "decision", content: "Use approach X" });
      const fetched = ns.get(stored.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(stored.id);
      expect(fetched!.type).toBe("decision");
      expect(fetched!.content).toBe("Use approach X");
    });

    it("returns undefined for an unknown ID", () => {
      const result = ns.get("no-such-id");
      expect(result).toBeUndefined();
    });

    it("retrieves tags correctly from DB", () => {
      const stored = ns.store({ type: "context", content: "Tagged", tags: ["foo", "bar"] });
      const fetched = ns.get(stored.id);
      expect(fetched!.tags).toEqual(["foo", "bar"]);
    });

    it("retrieves agentId correctly from DB", () => {
      const stored = ns.store({ type: "context", content: "By agent", agentId: "agent:x" });
      const fetched = ns.get(stored.id);
      expect(fetched!.agentId).toBe("agent:x");
    });

    it("retrieves taskId correctly from DB", () => {
      const stored = ns.store({ type: "context", content: "For task", taskId: "task-abc" });
      const fetched = ns.get(stored.id);
      expect(fetched!.taskId).toBe("task-abc");
    });
  });

  // ---------- list ----------

  describe("list", () => {
    it("lists all entries when no filters provided", () => {
      ns.store({ type: "decision", content: "Decision 1", agentId: "agent:alice", tags: ["important"] });
      ns.store({ type: "pattern", content: "Pattern 1", agentId: "agent:bob" });
      ns.store({ type: "decision", content: "Decision 2", agentId: "agent:alice", tags: ["important", "urgent"] });
      const entries = ns.list();
      expect(entries.length).toBe(3);
    });

    it("filters by type", () => {
      ns.store({ type: "decision", content: "Decision 1" });
      ns.store({ type: "pattern", content: "Pattern 1" });
      ns.store({ type: "decision", content: "Decision 2" });
      const decisions = ns.list({ type: "decision" });
      expect(decisions.length).toBe(2);
      expect(decisions.every(e => e.type === "decision")).toBe(true);
    });

    it("filters by agentId", () => {
      ns.store({ type: "decision", content: "D1", agentId: "agent:alice" });
      ns.store({ type: "pattern", content: "P1", agentId: "agent:bob" });
      ns.store({ type: "decision", content: "D2", agentId: "agent:alice" });
      const aliceEntries = ns.list({ agentId: "agent:alice" });
      expect(aliceEntries.length).toBe(2);
      expect(aliceEntries.every(e => e.agentId === "agent:alice")).toBe(true);
    });

    it("filters by tags (matches any tag)", () => {
      ns.store({ type: "decision", content: "D1", tags: ["important"] });
      ns.store({ type: "pattern", content: "P1" });
      ns.store({ type: "decision", content: "D2", tags: ["important", "urgent"] });
      const tagged = ns.list({ tags: ["urgent"] });
      expect(tagged.length).toBe(1);
      expect(tagged[0]!.content).toBe("D2");
    });

    it("respects limit", () => {
      ns.store({ type: "context", content: "A" });
      ns.store({ type: "context", content: "B" });
      ns.store({ type: "context", content: "C" });
      const limited = ns.list({ limit: 1 });
      expect(limited.length).toBe(1);
    });

    it("combines type and agentId filters", () => {
      ns.store({ type: "decision", content: "D1", agentId: "agent:alice" });
      ns.store({ type: "pattern", content: "P1", agentId: "agent:alice" });
      ns.store({ type: "decision", content: "D2", agentId: "agent:alice" });
      ns.store({ type: "decision", content: "D3", agentId: "agent:bob" });
      const filtered = ns.list({ type: "decision", agentId: "agent:alice" });
      expect(filtered.length).toBe(2);
      expect(filtered.every(e => e.type === "decision" && e.agentId === "agent:alice")).toBe(true);
    });

    it("returns entries in descending createdAt order", () => {
      ns.store({ type: "context", content: "A" });
      ns.store({ type: "context", content: "B" });
      ns.store({ type: "context", content: "C" });
      const entries = ns.list();
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1]!.createdAt).toBeGreaterThanOrEqual(entries[i]!.createdAt);
      }
    });

    it("returns empty array when no entries exist", () => {
      expect(ns.list()).toHaveLength(0);
    });
  });

  // ---------- search ----------

  describe("search", () => {
    it("finds entries matching the query in content", () => {
      ns.store({ type: "context", content: "The sky is blue" });
      ns.store({ type: "context", content: "The grass is green" });
      ns.store({ type: "decision", content: "Blue team wins" });
      const results = ns.search("blue");
      expect(results.length).toBe(2);
      expect(results.every(e => e.content.toLowerCase().includes("blue"))).toBe(true);
    });

    it("finds entries matching the query in title", () => {
      ns.store({ type: "context", content: "irrelevant", title: "Blue Sky Thinking" });
      ns.store({ type: "context", content: "other content" });
      const results = ns.search("Blue Sky");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(e => e.title === "Blue Sky Thinking")).toBe(true);
    });

    it("returns empty array when no match", () => {
      ns.store({ type: "context", content: "Hello world" });
      const results = ns.search("nonexistent-zzzz-term");
      expect(results).toHaveLength(0);
    });

    it("filters by type alongside query", () => {
      ns.store({ type: "context", content: "The sky is blue" });
      ns.store({ type: "context", content: "The grass is green" });
      ns.store({ type: "decision", content: "Blue team wins" });
      const results = ns.search("blue", { type: "decision" });
      expect(results.length).toBe(1);
      expect(results[0]!.type).toBe("decision");
    });

    it("filters by agentId alongside query", () => {
      ns.store({ type: "context", content: "blue fact from alice", agentId: "agent:alice" });
      ns.store({ type: "context", content: "blue fact from bob", agentId: "agent:bob" });
      const results = ns.search("blue", { agentId: "agent:alice" });
      expect(results.length).toBe(1);
      expect(results[0]!.agentId).toBe("agent:alice");
    });

    it("respects limit option", () => {
      ns.store({ type: "context", content: "blue one" });
      ns.store({ type: "context", content: "blue two" });
      ns.store({ type: "context", content: "blue three" });
      const results = ns.search("blue", { limit: 1 });
      expect(results.length).toBe(1);
    });

    it("is case-insensitive via LIKE (SQLite default)", () => {
      ns.store({ type: "context", content: "The sky is BLUE" });
      const results = ns.search("blue");
      expect(results.length).toBe(1);
    });
  });

  // ---------- remove ----------

  describe("remove", () => {
    it("removes a stored entry by ID", () => {
      const entry = ns.store({ type: "context", content: "To be deleted" });
      ns.remove(entry.id);
      expect(ns.get(entry.id)).toBeUndefined();
    });

    it("is a no-op for an unknown ID (does not throw)", () => {
      expect(() => ns.remove("no-such-id")).not.toThrow();
    });

    it("only removes the targeted entry, not others", () => {
      const a = ns.store({ type: "context", content: "Keep me" });
      const b = ns.store({ type: "context", content: "Delete me" });
      ns.remove(b.id);
      expect(ns.get(a.id)).toBeDefined();
      expect(ns.get(b.id)).toBeUndefined();
    });

    it("entry no longer appears in list after removal", () => {
      const a = ns.store({ type: "context", content: "Keep" });
      const b = ns.store({ type: "context", content: "Gone" });
      ns.remove(b.id);
      const listed = ns.list();
      expect(listed.some(e => e.id === b.id)).toBe(false);
      expect(listed.some(e => e.id === a.id)).toBe(true);
    });
  });

  // ---------- integration ----------

  describe("integration: store → search → get → remove", () => {
    it("full lifecycle of a knowledge entry", () => {
      // Store
      const entry = ns.store({
        type: "pattern",
        title: "Retry pattern",
        content: "When network fails, retry with exponential backoff",
        tags: ["network", "reliability"],
        agentId: "agent:system",
      });
      expect(entry.id).toBeTruthy();

      // Search
      const found = ns.search("exponential backoff");
      expect(found.some(e => e.id === entry.id)).toBe(true);

      // Get
      const fetched = ns.get(entry.id);
      expect(fetched).toBeDefined();
      expect(fetched!.tags).toContain("network");
      expect(fetched!.agentId).toBe("agent:system");

      // List
      const listed = ns.list({ type: "pattern" });
      expect(listed.some(e => e.id === entry.id)).toBe(true);

      // Remove
      ns.remove(entry.id);
      expect(ns.get(entry.id)).toBeUndefined();
      expect(ns.list({ type: "pattern" }).some(e => e.id === entry.id)).toBe(false);
    });

    it("multiple entries with different types are independently filterable", () => {
      ns.store({ type: "decision", content: "Always use HTTPS", title: "Security decision" });
      ns.store({ type: "pattern", content: "Cache expensive calls", title: "Cache pattern" });
      ns.store({ type: "issue", content: "Rate limit hits daily", title: "Rate limit issue" });

      expect(ns.list({ type: "decision" })).toHaveLength(1);
      expect(ns.list({ type: "pattern" })).toHaveLength(1);
      expect(ns.list({ type: "issue" })).toHaveLength(1);
      expect(ns.list()).toHaveLength(3);
    });
  });
});
