import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", publicKey: "test-key" })),
  verifyAction: vi.fn(() => true),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { writeAuditEntry, verifyAuditChain } = await import("../../src/audit.js");

/**
 * Write `n` audit entries with strictly increasing timestamps (1 ms apart)
 * so that ORDER BY created_at returns them in insertion order.
 */
function writeEntries(
  db: DatabaseSync,
  projectId: string,
  n: number,
  baseTime = 1_700_000_000_000,
): void {
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(baseTime + i);
    writeAuditEntry(
      {
        projectId,
        actor: `agent:${String.fromCharCode(97 + (i % 26))}`,
        action: i === 0 ? "task.create" : i === n - 1 ? "task.complete" : "task.update",
        targetType: "task",
        targetId: "t1",
      },
      db,
    );
  }
}

describe("audit chain integrity", () => {
  let db: DatabaseSync;
  const PROJECT = "chain-test";

  beforeEach(() => {
    vi.useFakeTimers();
    db = getMemoryDb();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { db.close(); } catch {}
  });

  it("multi-entry chain — write 3 entries, verify chain is intact", () => {
    writeEntries(db, PROJECT, 3);

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.brokenAt).toBeUndefined();
  });

  it("tampered entry — mutating an entry's hash breaks the chain", () => {
    writeEntries(db, PROJECT, 3);

    // Tamper with the second entry's stored hash
    const rows = db
      .prepare("SELECT id FROM audit_log WHERE project_id = ? ORDER BY created_at ASC")
      .all(PROJECT) as { id: string }[];
    const secondId = rows[1]!.id;
    db.prepare(
      "UPDATE audit_log SET entry_hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE id = ?",
    ).run(secondId);

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBeTruthy();
    expect(result.entries).toBe(3);
  });

  it("deleted entry — removing the middle entry breaks the chain", () => {
    writeEntries(db, PROJECT, 3);

    // Identify and delete the middle entry
    const rows = db
      .prepare("SELECT id FROM audit_log WHERE project_id = ? ORDER BY created_at ASC")
      .all(PROJECT) as { id: string }[];
    expect(rows).toHaveLength(3);
    const middleId = rows[1]!.id;
    db.prepare("DELETE FROM audit_log WHERE id = ?").run(middleId);

    // The surviving third entry's prev_hash points to the deleted entry's hash,
    // which no longer matches the first entry's hash — the chain must be broken.
    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(false);
    expect(result.entries).toBe(2);
  });

  it("genesis entry has no prev_hash", () => {
    vi.setSystemTime(1_700_000_000_000);
    writeAuditEntry(
      { projectId: PROJECT, actor: "agent:a", action: "task.create", targetType: "task", targetId: "t1" },
      db,
    );

    const rows = db
      .prepare("SELECT prev_hash FROM audit_log WHERE project_id = ? ORDER BY created_at ASC LIMIT 1")
      .all(PROJECT) as { prev_hash: string | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.prev_hash).toBeNull();
  });

  it("each entry's prev_hash matches the previous entry's entry_hash", () => {
    writeEntries(db, PROJECT, 3);

    const rows = db
      .prepare(
        "SELECT entry_hash, prev_hash FROM audit_log WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(PROJECT) as { entry_hash: string; prev_hash: string | null }[];

    expect(rows).toHaveLength(3);

    // First (genesis) entry: no prev_hash
    expect(rows[0]!.prev_hash).toBeNull();

    // Second entry's prev_hash must equal the first entry's entry_hash
    expect(rows[1]!.prev_hash).toBe(rows[0]!.entry_hash);

    // Third entry's prev_hash must equal the second entry's entry_hash
    expect(rows[2]!.prev_hash).toBe(rows[1]!.entry_hash);
  });

  it("different projects have independent chains", () => {
    const PROJECT_A = "chain-project-a";
    const PROJECT_B = "chain-project-b";
    const BASE = 1_700_000_000_000;

    // Write two entries per project with distinct timestamps
    vi.setSystemTime(BASE);
    writeAuditEntry(
      { projectId: PROJECT_A, actor: "agent:a", action: "task.create", targetType: "task", targetId: "ta1" },
      db,
    );
    vi.setSystemTime(BASE + 1);
    writeAuditEntry(
      { projectId: PROJECT_A, actor: "agent:a", action: "task.update", targetType: "task", targetId: "ta1" },
      db,
    );

    vi.setSystemTime(BASE + 2);
    writeAuditEntry(
      { projectId: PROJECT_B, actor: "agent:b", action: "task.create", targetType: "task", targetId: "tb1" },
      db,
    );
    vi.setSystemTime(BASE + 3);
    writeAuditEntry(
      { projectId: PROJECT_B, actor: "agent:b", action: "task.update", targetType: "task", targetId: "tb1" },
      db,
    );

    const resultA = verifyAuditChain(PROJECT_A, db);
    const resultB = verifyAuditChain(PROJECT_B, db);

    expect(resultA.intact).toBe(true);
    expect(resultA.entries).toBe(2);

    expect(resultB.intact).toBe(true);
    expect(resultB.entries).toBe(2);

    // Project B's genesis entry is truly independent — it has no prev_hash
    const rowsB = db
      .prepare(
        "SELECT prev_hash FROM audit_log WHERE project_id = ? ORDER BY created_at ASC LIMIT 1",
      )
      .all(PROJECT_B) as { prev_hash: string | null }[];
    expect(rowsB[0]!.prev_hash).toBeNull();
  });

  it("empty project chain is intact", () => {
    const result = verifyAuditChain("nonexistent-project", db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.brokenAt).toBeUndefined();
  });
});
