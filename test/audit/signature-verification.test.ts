import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Do NOT mock identity.js — we want real signatures for verification tests
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { writeAuditEntry, verifyAuditChain } = await import("../../src/audit.js");

let db: DatabaseSync;
const PROJECT = "sig-verify-test";

beforeEach(() => {
  vi.useFakeTimers();
  db = getMemoryDb();
});

afterEach(() => {
  vi.useRealTimers();
  try { db.close(); } catch {}
});

describe("audit signature verification", () => {
  it("verifyAuditChain returns signatureFailures: [] for valid entries", () => {
    vi.setSystemTime(1_700_000_000_000);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:alpha",
      action: "task.create",
      targetType: "task",
      targetId: "t1",
    }, db);

    vi.setSystemTime(1_700_000_000_001);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:alpha",
      action: "task.update",
      targetType: "task",
      targetId: "t1",
    }, db);

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.signatureFailures).toEqual([]);
  });

  it("detects tampered signatures", () => {
    vi.setSystemTime(1_700_000_000_000);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:beta",
      action: "task.create",
      targetType: "task",
      targetId: "t2",
    }, db);

    vi.setSystemTime(1_700_000_000_001);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:beta",
      action: "task.update",
      targetType: "task",
      targetId: "t2",
    }, db);

    // Corrupt the signature of the second entry
    const rows = db
      .prepare("SELECT id FROM audit_log WHERE project_id = ? ORDER BY created_at ASC")
      .all(PROJECT) as { id: string }[];
    const secondId = rows[1]!.id;
    db.prepare("UPDATE audit_log SET signature = 'deadbeef' WHERE id = ?").run(secondId);

    const result = verifyAuditChain(PROJECT, db);
    // Chain hashes are still valid, but signature verification should fail
    expect(result.intact).toBe(true);
    expect(result.signatureFailures).toContain(secondId);
    expect(result.signatureFailures).toHaveLength(1);
  });

  it("handles entries with null signatures (no failure — unsigned system entries)", () => {
    vi.setSystemTime(1_700_000_000_000);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "system",
      action: "system.init",
      targetType: "system",
      targetId: "sys",
    }, db);

    // Manually set signature to null to simulate unsigned system entry
    const rows = db
      .prepare("SELECT id FROM audit_log WHERE project_id = ? ORDER BY created_at ASC")
      .all(PROJECT) as { id: string }[];
    db.prepare("UPDATE audit_log SET signature = NULL WHERE id = ?").run(rows[0]!.id);

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(true);
    expect(result.signatureFailures).toEqual([]);
  });

  it("still detects broken hash chains", () => {
    vi.setSystemTime(1_700_000_000_000);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:gamma",
      action: "task.create",
      targetType: "task",
      targetId: "t3",
    }, db);

    vi.setSystemTime(1_700_000_000_001);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:gamma",
      action: "task.update",
      targetType: "task",
      targetId: "t3",
    }, db);

    vi.setSystemTime(1_700_000_000_002);
    writeAuditEntry({
      projectId: PROJECT,
      actor: "agent:gamma",
      action: "task.complete",
      targetType: "task",
      targetId: "t3",
    }, db);

    // Tamper with the second entry's hash to break the chain
    const rows = db
      .prepare("SELECT id FROM audit_log WHERE project_id = ? ORDER BY created_at ASC")
      .all(PROJECT) as { id: string }[];
    const secondId = rows[1]!.id;
    db.prepare(
      "UPDATE audit_log SET entry_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id = ?",
    ).run(secondId);

    const result = verifyAuditChain(PROJECT, db);
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBeTruthy();
  });
});
