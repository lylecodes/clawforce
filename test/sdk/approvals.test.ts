/**
 * Tests for the ApprovalsNamespace SDK wrapper.
 *
 * Strategy: use the db override parameter on every method to pass a shared
 * in-memory DB. This keeps tests deterministic and isolated without needing
 * to mock the internal getDb() call or the audit/notification side-effects
 * in approveProposal/rejectProposal.
 *
 * Rows are inserted directly via db.prepare() to avoid depending on the
 * internal proposal creation path (which involves OpenClaw adapter calls).
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

const { getMemoryDb } = await import("../../src/db.js");
const { ApprovalsNamespace } = await import("../../src/sdk/approvals.js");

// ---- Constants ----

const DOMAIN = "test-approvals-project";

// ---- Helpers ----

function insertProposal(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    status: string;
    title: string;
    description: string;
    proposedBy: string;
    riskTier: string;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, approval_policy_snapshot, risk_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    DOMAIN,
    overrides.title ?? "Test proposal",
    overrides.description ?? "A description",
    overrides.proposedBy ?? "agent:worker",
    "session-key-1",
    overrides.status ?? "pending",
    '{"policy":"test"}',
    overrides.riskTier ?? "low",
    now,
  );
  return id;
}

function insertIntent(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    proposalId: string;
    taskId: string;
    toolName: string;
    status: string;
    agentId: string;
    category: string;
    riskTier: string;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  const proposalId = overrides.proposalId ?? crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    proposalId,
    DOMAIN,
    overrides.agentId ?? "agent:worker",
    overrides.taskId ?? null,
    overrides.toolName ?? "mcp:github:create_pr",
    JSON.stringify({ branch: "feat/x" }),
    overrides.category ?? "code:write",
    overrides.riskTier ?? "medium",
    overrides.status ?? "pending",
    now,
  );
  return id;
}

// ---- Tests ----

describe("ApprovalsNamespace", () => {
  let db: DatabaseSync;
  let ns: InstanceType<typeof ApprovalsNamespace>;

  beforeEach(() => {
    db = getMemoryDb();
    ns = new ApprovalsNamespace(DOMAIN);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("stores arbitrary domain strings", () => {
      expect(new ApprovalsNamespace("research-lab").domain).toBe("research-lab");
      expect(new ApprovalsNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- pending ----------

  describe("pending()", () => {
    it("returns an empty array when no proposals exist", () => {
      const result = ns.pending({ db });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it("returns pending proposals", () => {
      insertProposal(db, { title: "Approve me", status: "pending" });
      const result = ns.pending({ db });
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Approve me");
      expect(result[0]!.status).toBe("pending");
    });

    it("does not include resolved proposals", () => {
      insertProposal(db, { title: "Pending one", status: "pending" });
      insertProposal(db, { title: "Already approved", status: "approved" });
      insertProposal(db, { title: "Already rejected", status: "rejected" });

      const result = ns.pending({ db });
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Pending one");
    });

    it("returns proposals for this domain only", () => {
      // Insert a proposal for a different project directly
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, proposed_by, status, approval_policy_snapshot, risk_tier, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        "other-project",
        "Other project proposal",
        "agent:other",
        "pending",
        null,
        "low",
        Date.now(),
      );
      insertProposal(db, { title: "This domain proposal" });

      const result = ns.pending({ db });
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("This domain proposal");
    });

    it("orders by created_at DESC (most recent first)", () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, proposed_by, status, approval_policy_snapshot, risk_tier, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), DOMAIN, "Older proposal", "agent:a", "pending", null, "low", now - 1000);
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, proposed_by, status, approval_policy_snapshot, risk_tier, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), DOMAIN, "Newer proposal", "agent:b", "pending", null, "low", now);

      const result = ns.pending({ db });
      expect(result).toHaveLength(2);
      expect(result[0]!.title).toBe("Newer proposal");
      expect(result[1]!.title).toBe("Older proposal");
    });
  });

  // ---------- resolved ----------

  describe("resolved()", () => {
    beforeEach(() => {
      insertProposal(db, { title: "Pending one", status: "pending" });
      insertProposal(db, { title: "Approved one", status: "approved" });
      insertProposal(db, { title: "Rejected one", status: "rejected" });
    });

    it("returns all resolved proposals (approved + rejected) by default", () => {
      const result = ns.resolved({ db });
      expect(result).toHaveLength(2);
      const titles = result.map((p) => p.title);
      expect(titles).toContain("Approved one");
      expect(titles).toContain("Rejected one");
    });

    it("filters by status=approved", () => {
      const result = ns.resolved({ status: "approved", db });
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("approved");
      expect(result[0]!.title).toBe("Approved one");
    });

    it("filters by status=rejected", () => {
      const result = ns.resolved({ status: "rejected", db });
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("rejected");
      expect(result[0]!.title).toBe("Rejected one");
    });

    it("respects limit", () => {
      insertProposal(db, { title: "Approved two", status: "approved" });
      const result = ns.resolved({ status: "approved", limit: 1, db });
      expect(result).toHaveLength(1);
    });

    it("does not include pending proposals", () => {
      const result = ns.resolved({ db });
      const pending = result.filter((p) => p.status === "pending");
      expect(pending).toHaveLength(0);
    });

    it("returns empty array when no resolved proposals exist", () => {
      const emptyDb = getMemoryDb();
      try {
        const emptyNs = new ApprovalsNamespace(DOMAIN);
        const result = emptyNs.resolved({ db: emptyDb });
        expect(result).toHaveLength(0);
      } finally {
        try { emptyDb.close(); } catch { /* ok */ }
      }
    });
  });

  // ---------- get ----------

  describe("get()", () => {
    it("returns a proposal by id", () => {
      const id = insertProposal(db, { title: "Fetch me" });
      const result = ns.get(id, { db });
      expect(result).toBeDefined();
      expect(result!.id).toBe(id);
      expect(result!.title).toBe("Fetch me");
    });

    it("returns undefined for unknown id", () => {
      const result = ns.get("nonexistent-id", { db });
      expect(result).toBeUndefined();
    });

    it("returned proposal has the expected shape fields", () => {
      const id = insertProposal(db, { title: "Shape test", riskTier: "high" });
      const result = ns.get(id, { db });
      expect(result).toBeDefined();
      expect(typeof result!.id).toBe("string");
      expect(typeof result!.project_id).toBe("string");
      expect(typeof result!.title).toBe("string");
      expect(typeof result!.status).toBe("string");
      expect(typeof result!.created_at).toBe("number");
    });
  });

  // ---------- resolve ----------

  describe("resolve()", () => {
    it("approves a pending proposal", () => {
      const id = insertProposal(db, { title: "Approve me" });

      const result = ns.resolve(id, "approved", "Looks good", { db });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");
      expect(result!.user_feedback).toBe("Looks good");
      expect(typeof result!.resolved_at).toBe("number");
    });

    it("rejects a pending proposal", () => {
      const id = insertProposal(db, { title: "Reject me" });

      const result = ns.resolve(id, "rejected", "Too risky", { db });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("rejected");
      expect(result!.user_feedback).toBe("Too risky");
    });

    it("approves without feedback", () => {
      const id = insertProposal(db);
      const result = ns.resolve(id, "approved", undefined, { db });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");
      expect(result!.user_feedback).toBeNull();
    });

    it("returns null for nonexistent proposal", () => {
      const result = ns.resolve("no-such-id", "approved", undefined, { db });
      expect(result).toBeNull();
    });

    it("returns null when trying to resolve an already-resolved proposal", () => {
      const id = insertProposal(db);

      // First resolution succeeds
      const first = ns.resolve(id, "approved", undefined, { db });
      expect(first).not.toBeNull();

      // Second resolution on a non-pending row returns null
      const second = ns.resolve(id, "rejected", "too late", { db });
      expect(second).toBeNull();
    });

    it("proposal moves from pending to resolved — no longer returned by pending()", () => {
      const id = insertProposal(db, { title: "Will be approved" });

      expect(ns.pending({ db })).toHaveLength(1);
      ns.resolve(id, "approved", undefined, { db });
      expect(ns.pending({ db })).toHaveLength(0);
    });

    it("approved proposal appears in resolved() list", () => {
      const id = insertProposal(db, { title: "Check resolved" });
      ns.resolve(id, "approved", undefined, { db });

      const resolved = ns.resolved({ status: "approved", db });
      expect(resolved.some((p) => p.id === id)).toBe(true);
    });
  });

  // ---------- approvedForTask ----------

  describe("approvedForTask()", () => {
    it("returns an empty array when no approved intents exist for the task", () => {
      const result = ns.approvedForTask("task-xyz", { db });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it("returns approved intents for the given task", () => {
      const propId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        propId,
        DOMAIN,
        "agent:worker",
        "task-abc",
        "mcp:github:create_pr",
        JSON.stringify({ branch: "feat/x" }),
        "code:write",
        "medium",
        "approved",
        Date.now(),
      );

      const result = ns.approvedForTask("task-abc", { db });
      expect(result).toHaveLength(1);
      expect(result[0]!.toolName).toBe("mcp:github:create_pr");
      expect(result[0]!.status).toBe("approved");
      expect(result[0]!.taskId).toBe("task-abc");
    });

    it("does not return pending intents for the task", () => {
      insertIntent(db, { taskId: "task-filter", status: "pending" });
      const result = ns.approvedForTask("task-filter", { db });
      expect(result).toHaveLength(0);
    });

    it("does not return approved intents for a different task", () => {
      insertIntent(db, { taskId: "task-other", status: "approved" });
      const result = ns.approvedForTask("task-mine", { db });
      expect(result).toHaveLength(0);
    });

    it("each ToolCallIntent has the expected shape", () => {
      const propId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        propId,
        DOMAIN,
        "agent:worker",
        "task-shape",
        "mcp:stripe:charge",
        JSON.stringify({ amount: 100 }),
        "payment",
        "high",
        "approved",
        Date.now(),
      );

      const result = ns.approvedForTask("task-shape", { db });
      expect(result).toHaveLength(1);
      const intent = result[0]!;
      expect(typeof intent.id).toBe("string");
      expect(typeof intent.proposalId).toBe("string");
      expect(typeof intent.projectId).toBe("string");
      expect(typeof intent.agentId).toBe("string");
      expect(typeof intent.toolName).toBe("string");
      expect(typeof intent.toolParams).toBe("object");
      expect(typeof intent.category).toBe("string");
      expect(typeof intent.riskTier).toBe("string");
      expect(typeof intent.status).toBe("string");
      expect(typeof intent.createdAt).toBe("number");
    });
  });

  // ---------- intentForProposal ----------

  describe("intentForProposal()", () => {
    it("returns undefined when no intent exists for the proposal", () => {
      const result = ns.intentForProposal("nonexistent-proposal-id", { db });
      expect(result).toBeUndefined();
    });

    it("returns the tool call intent linked to a proposal", () => {
      const proposalId = crypto.randomUUID();
      const intentId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intentId,
        proposalId,
        DOMAIN,
        "agent:writer",
        "task-linked",
        "mcp:slack:send",
        JSON.stringify({ channel: "#general", text: "hello" }),
        "messaging:send",
        "low",
        "pending",
        Date.now(),
      );

      const result = ns.intentForProposal(proposalId, { db });
      expect(result).toBeDefined();
      expect(result!.id).toBe(intentId);
      expect(result!.proposalId).toBe(proposalId);
      expect(result!.toolName).toBe("mcp:slack:send");
      expect(result!.toolParams).toEqual({ channel: "#general", text: "hello" });
    });

    it("does not return intents from other projects", () => {
      const proposalId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tool_call_intents (id, proposal_id, project_id, agent_id, task_id, tool_name, tool_params, category, risk_tier, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        proposalId,
        "other-project",
        "agent:other",
        null,
        "mcp:any:tool",
        "{}",
        "other",
        "low",
        "pending",
        Date.now(),
      );

      const result = ns.intentForProposal(proposalId, { db });
      expect(result).toBeUndefined();
    });
  });

  // ---------- full resolve flow ----------

  describe("full approval flow", () => {
    it("pending → resolve(approved) → no longer pending, appears in resolved", () => {
      const id = insertProposal(db, { title: "Full flow proposal" });

      // Initially pending
      expect(ns.pending({ db })).toHaveLength(1);
      expect(ns.resolved({ db })).toHaveLength(0);

      // Resolve
      const updated = ns.resolve(id, "approved", "Ship it", { db });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("approved");

      // Now pending is empty and resolved has one entry
      expect(ns.pending({ db })).toHaveLength(0);
      const resolved = ns.resolved({ db });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.id).toBe(id);
      expect(resolved[0]!.status).toBe("approved");
    });

    it("pending → resolve(rejected) → feedback stored", () => {
      const id = insertProposal(db, { title: "Risky action" });

      const updated = ns.resolve(id, "rejected", "Do not proceed", { db });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("rejected");
      expect(updated!.user_feedback).toBe("Do not proceed");

      const fetched = ns.get(id, { db });
      expect(fetched!.status).toBe("rejected");
    });

    it("multiple concurrent pending proposals all retrievable", () => {
      insertProposal(db, { title: "Action A" });
      insertProposal(db, { title: "Action B" });
      insertProposal(db, { title: "Action C" });

      expect(ns.pending({ db })).toHaveLength(3);
    });

    it("resolving one of many pending proposals leaves the rest pending", () => {
      const idA = insertProposal(db, { title: "Action A" });
      insertProposal(db, { title: "Action B" });
      insertProposal(db, { title: "Action C" });

      ns.resolve(idA, "approved", undefined, { db });

      expect(ns.pending({ db })).toHaveLength(2);
      expect(ns.resolved({ db })).toHaveLength(1);
    });
  });
});
