import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { writeAuditEntry, queryAuditLog, verifyAuditChain } = await import("../../src/audit.js");
const { verifyAction } = await import("../../src/identity.js");

describe("writeAuditEntry", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it("writes an audit entry and returns it", () => {
    const entry = writeAuditEntry({
      projectId: "proj1",
      actor: "agent:leon",
      action: "task_create",
      targetType: "task",
      targetId: "task-001",
    }, db);

    expect(entry.id).toBeDefined();
    expect(entry.projectId).toBe("proj1");
    expect(entry.actor).toBe("agent:leon");
    expect(entry.action).toBe("task_create");
    expect(entry.targetType).toBe("task");
    expect(entry.targetId).toBe("task-001");
    expect(entry.entryHash).toBeDefined();
    expect(entry.createdAt).toBeGreaterThan(0);
  });

  it("includes detail when provided", () => {
    const entry = writeAuditEntry({
      projectId: "proj1",
      actor: "agent:leon",
      action: "task_create",
      targetType: "task",
      targetId: "task-001",
      detail: "Created new task",
    }, db);

    expect(entry.detail).toBe("Created new task");
  });

  it("links entries via hash chain", () => {
    const entry1 = writeAuditEntry({
      projectId: "proj1",
      actor: "agent:leon",
      action: "task_create",
      targetType: "task",
      targetId: "task-001",
    }, db);

    const entry2 = writeAuditEntry({
      projectId: "proj1",
      actor: "agent:coder",
      action: "task_transition",
      targetType: "task",
      targetId: "task-001",
    }, db);

    // First entry has no prev_hash, second links to first
    expect(entry1.prevHash).toBeUndefined();
    expect(entry2.prevHash).toBe(entry1.entryHash);
  });

  it("signs the entry", () => {
    const entry = writeAuditEntry({
      projectId: "proj1",
      actor: "agent:leon",
      action: "task_create",
      targetType: "task",
      targetId: "task-001",
    }, db);

    expect(entry.signature).toBe("mock-sig");
  });
});

describe("queryAuditLog", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    writeAuditEntry({ projectId: "proj1", actor: "agent:leon", action: "task_create", targetType: "task", targetId: "task-001" }, db);
    writeAuditEntry({ projectId: "proj1", actor: "agent:coder", action: "task_transition", targetType: "task", targetId: "task-001" }, db);
    writeAuditEntry({ projectId: "proj1", actor: "agent:leon", action: "log_write", targetType: "knowledge", targetId: "k-001" }, db);
    writeAuditEntry({ projectId: "proj2", actor: "agent:other", action: "task_create", targetType: "task", targetId: "task-010" }, db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it("filters by project", () => {
    const entries = queryAuditLog({ projectId: "proj1" }, db);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.projectId === "proj1")).toBe(true);
  });

  it("filters by actor", () => {
    const entries = queryAuditLog({ projectId: "proj1", actor: "agent:leon" }, db);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.actor === "agent:leon")).toBe(true);
  });

  it("filters by action", () => {
    const entries = queryAuditLog({ projectId: "proj1", action: "task_create" }, db);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("task_create");
  });

  it("filters by targetType", () => {
    const entries = queryAuditLog({ projectId: "proj1", targetType: "knowledge" }, db);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.targetType).toBe("knowledge");
  });

  it("filters by since/until", () => {
    const now = Date.now();
    const entries = queryAuditLog({ projectId: "proj1", since: now - 1000, until: now + 1000 }, db);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("respects limit", () => {
    const entries = queryAuditLog({ projectId: "proj1", limit: 1 }, db);
    expect(entries).toHaveLength(1);
  });
});

describe("verifyAuditChain", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it("validates intact chain", () => {
    writeAuditEntry({ projectId: "proj1", actor: "a", action: "create", targetType: "t", targetId: "1" }, db);
    writeAuditEntry({ projectId: "proj1", actor: "b", action: "update", targetType: "t", targetId: "1" }, db);
    writeAuditEntry({ projectId: "proj1", actor: "c", action: "delete", targetType: "t", targetId: "1" }, db);

    const result = verifyAuditChain("proj1", db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.signatureFailures).toHaveLength(0);
  });

  it("detects tampered entry", () => {
    writeAuditEntry({ projectId: "proj1", actor: "a", action: "create", targetType: "t", targetId: "1" }, db);
    const entry2 = writeAuditEntry({ projectId: "proj1", actor: "b", action: "update", targetType: "t", targetId: "1" }, db);

    // Tamper with the entry hash
    db.prepare("UPDATE audit_log SET entry_hash = 'tampered' WHERE id = ?").run(entry2.id);

    const result = verifyAuditChain("proj1", db);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(entry2.id);
  });

  it("detects signature failures", () => {
    writeAuditEntry({ projectId: "proj1", actor: "a", action: "create", targetType: "t", targetId: "1" }, db);

    vi.mocked(verifyAction).mockReturnValueOnce(false);
    const result = verifyAuditChain("proj1", db);
    // The chain structure is intact, but the signature fails
    expect(result.intact).toBe(true);
    expect(result.signatureFailures.length).toBeGreaterThan(0);
  });

  it("returns intact for empty log", () => {
    const result = verifyAuditChain("proj1", db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(0);
  });
});
