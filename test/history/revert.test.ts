/**
 * Tests for change revert logic — eligibility checks and revert execution.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import {
  ensureHistoryTable,
  recordChange,
  getChange,
} from "../../src/history/store.js";
import {
  canRevert,
  revertChange,
} from "../../src/history/revert.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureHistoryTable(db);
  return db;
}

// ---------------------------------------------------------------------------
// canRevert
// ---------------------------------------------------------------------------

describe("canRevert", () => {
  it("returns reversible=true for a reversible structural change with before snapshot", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "op",
      before: { hourly: { cents: 100 } },
      after: { hourly: { cents: 200 } },
      reversible: true,
    }, db);

    const result = canRevert(record.id, db);
    expect(result.reversible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns reversible=false for a change marked non-reversible at record time", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "org",
      resourceId: "proj1",
      action: "domain_kill",
      provenance: "human",
      actor: "op",
      after: { reason: "EMERGENCY: test" },
      reversible: false,
    }, db);

    const result = canRevert(record.id, db);
    expect(result.reversible).toBe(false);
    expect(result.reason).toMatch(/non-reversible/i);
  });

  it("returns reversible=false for operational action type", () => {
    const db = makeDb();
    // Use domain_kill action — explicitly in OPERATIONAL_ACTIONS
    const record = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "domain_kill",  // operational action
      provenance: "human",
      actor: "op",
      before: { v: 1 },
      after: { v: 2 },
      reversible: true,   // marked reversible but action type overrides
    }, db);

    const result = canRevert(record.id, db);
    expect(result.reversible).toBe(false);
    expect(result.reason).toMatch(/operational/i);
  });

  it("returns reversible=false for an operational resource type", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "task",    // not in STRUCTURAL_RESOURCE_TYPES
      resourceId: "task-1",
      action: "update",
      provenance: "agent",
      actor: "cf-lead",
      before: { state: "OPEN" },
      after: { state: "IN_PROGRESS" },
      reversible: true,
    }, db);

    const result = canRevert(record.id, db);
    expect(result.reversible).toBe(false);
    expect(result.reason).toMatch(/operational/i);
  });

  it("returns reversible=false for an already-reverted change", () => {
    const db = makeDb();
    const original = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "op",
      before: { v: 1 },
      after: { v: 2 },
      reversible: true,
    }, db);

    // Perform the revert
    const result = revertChange("proj1", original.id, "op", db);
    expect(result.ok).toBe(true);

    // Now canRevert on the original should say it's already reverted
    const check = canRevert(original.id, db);
    expect(check.reversible).toBe(false);
    expect(check.reason).toMatch(/already reverted/i);
  });

  it("returns reversible=false when before snapshot is null (create action)", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "agent",
      resourceId: "agent-new",
      action: "create",
      provenance: "human",
      actor: "op",
      // no before — create action
      after: { id: "agent-new" },
      reversible: true,
    }, db);

    const result = canRevert(record.id, db);
    expect(result.reversible).toBe(false);
    expect(result.reason).toMatch(/before-snapshot/i);
  });

  it("returns reversible=false for unknown change ID", () => {
    const db = makeDb();
    const result = canRevert("no-such-id", db);
    expect(result.reversible).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("returns reversible=false for rule resource type with reversible=true but no db provided", () => {
    const result = canRevert("some-id");
    expect(result.reversible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// revertChange
// ---------------------------------------------------------------------------

describe("revertChange", () => {
  it("creates a revert record with swapped before/after", () => {
    const db = makeDb();
    const before = { hourly: { cents: 100 } };
    const after = { hourly: { cents: 200 } };

    const original = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "op",
      before,
      after,
      reversible: true,
    }, db);

    const result = revertChange("proj1", original.id, "op2", db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");

    expect(result.changeId).toBe(original.id);
    expect(result.revertChangeId).toMatch(/^[0-9a-f-]{36}$/);

    // Check the revert record
    const revertRecord = getChange(result.revertChangeId, db);
    expect(revertRecord).not.toBeNull();
    expect(revertRecord!.action).toBe("revert");
    expect(revertRecord!.resourceType).toBe("config");
    expect(revertRecord!.resourceId).toBe("budget");
    expect(revertRecord!.actor).toBe("op2");

    // before/after should be swapped: revert record's "after" is the restored state
    expect(JSON.parse(revertRecord!.after!)).toEqual(before);
    expect(JSON.parse(revertRecord!.before!)).toEqual(after);
  });

  it("marks the original record as reverted", () => {
    const db = makeDb();
    const original = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "op",
      before: { v: 1 },
      after: { v: 2 },
      reversible: true,
    }, db);

    const result = revertChange("proj1", original.id, "op", db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");

    const updated = getChange(original.id, db);
    expect(updated!.revertedBy).toBe(result.revertChangeId);
  });

  it("rejects a non-reversible change", () => {
    const db = makeDb();
    const original = recordChange("proj1", {
      resourceType: "org",
      resourceId: "proj1",
      action: "domain_kill",
      provenance: "human",
      actor: "op",
      after: { reason: "EMERGENCY: test" },
      reversible: false,
    }, db);

    const result = revertChange("proj1", original.id, "op", db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.reason).toMatch(/non-reversible/i);
  });

  it("rejects an already-reverted change (idempotency protection)", () => {
    const db = makeDb();
    const original = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "op",
      before: { v: 1 },
      after: { v: 2 },
      reversible: true,
    }, db);

    // First revert succeeds
    const first = revertChange("proj1", original.id, "op", db);
    expect(first.ok).toBe(true);

    // Second revert should fail
    const second = revertChange("proj1", original.id, "op", db);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("should not be ok");
    expect(second.reason).toMatch(/already reverted/i);
  });

  it("rejects operational action types explicitly", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "dispatch",  // operational action
      provenance: "system",
      actor: "system",
      before: { v: 1 },
      after: { v: 2 },
      reversible: true,
    }, db);

    const result = revertChange("proj1", record.id, "op", db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.reason).toMatch(/operational/i);
  });

  it("rejects when change ID does not exist", () => {
    const db = makeDb();
    const result = revertChange("proj1", "no-such-id", "op", db);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not be ok");
    expect(result.reason).toMatch(/not found/i);
  });

  it("preserves provenance from original record on the revert record", () => {
    const db = makeDb();
    const original = recordChange("proj1", {
      resourceType: "rule",
      resourceId: "rule-1",
      action: "update",
      provenance: "agent",
      actor: "cf-lead",
      before: { name: "old-rule" },
      after: { name: "new-rule" },
      reversible: true,
    }, db);

    const result = revertChange("proj1", original.id, "operator", db);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should be ok");

    const revertRecord = getChange(result.revertChangeId, db);
    expect(revertRecord!.provenance).toBe("agent");  // preserved from original
    expect(revertRecord!.actor).toBe("operator");    // new actor who performed revert
  });
});
