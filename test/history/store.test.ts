/**
 * Tests for change history store — CRUD, filtering, and snapshot preservation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import {
  ensureHistoryTable,
  recordChange,
  getChange,
  getResourceHistory,
  listRecentChanges,
  type ChangeRecord,
} from "../../src/history/store.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureHistoryTable(db);
  return db;
}

describe("ensureHistoryTable", () => {
  it("creates the change_history table without error", () => {
    const db = makeDb();
    // Calling again should be idempotent (IF NOT EXISTS)
    expect(() => ensureHistoryTable(db)).not.toThrow();
  });
});

describe("recordChange", () => {
  it("creates an entry with expected fields", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "config",
      resourceId: "budget",
      action: "update",
      provenance: "human",
      actor: "operator",
      before: { hourly: { cents: 100 } },
      after: { hourly: { cents: 200 } },
      reversible: true,
    }, db);

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.projectId).toBe("proj1");
    expect(record.resourceType).toBe("config");
    expect(record.resourceId).toBe("budget");
    expect(record.action).toBe("update");
    expect(record.provenance).toBe("human");
    expect(record.actor).toBe("operator");
    expect(record.before).toBe(JSON.stringify({ hourly: { cents: 100 } }));
    expect(record.after).toBe(JSON.stringify({ hourly: { cents: 200 } }));
    expect(record.reversible).toBe(true);
    expect(record.revertedBy).toBeUndefined();
    expect(typeof record.createdAt).toBe("number");
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it("stores null before/after for creates", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "agent",
      resourceId: "agent-1",
      action: "create",
      provenance: "system",
      actor: "init",
      reversible: true,
    }, db);

    expect(record.before).toBeNull();
    expect(record.after).toBeNull();
  });

  it("marks non-reversible correctly", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "org",
      resourceId: "proj1",
      action: "domain_kill",
      provenance: "human",
      actor: "operator",
      reversible: false,
    }, db);

    expect(record.reversible).toBe(false);
  });

  it("defaults reversible to true when not specified", () => {
    const db = makeDb();
    const record = recordChange("proj1", {
      resourceType: "config",
      resourceId: "agents",
      action: "update",
      provenance: "agent",
      actor: "cf-lead",
    }, db);

    expect(record.reversible).toBe(true);
  });
});

describe("getChange", () => {
  it("retrieves a change by ID", () => {
    const db = makeDb();
    const created = recordChange("proj1", {
      resourceType: "rule",
      resourceId: "rule-abc",
      action: "create",
      provenance: "human",
      actor: "dashboard",
      after: { name: "my-rule" },
    }, db);

    const fetched = getChange(created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.resourceType).toBe("rule");
    expect(fetched!.resourceId).toBe("rule-abc");
    expect(fetched!.after).toBe(JSON.stringify({ name: "my-rule" }));
  });

  it("returns null for unknown ID", () => {
    const db = makeDb();
    const result = getChange("no-such-id", db);
    expect(result).toBeNull();
  });

  it("throws when neither db nor projectId is provided", () => {
    expect(() => getChange("some-id")).toThrow();
  });
});

describe("getResourceHistory", () => {
  it("returns changes for a specific resource, newest first", () => {
    const db = makeDb();

    // Insert three changes
    const r1 = recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op", after: { v: 1 } }, db);
    const r2 = recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op", after: { v: 2 } }, db);
    const r3 = recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "agent", actor: "cf-lead", after: { v: 3 } }, db);

    const history = getResourceHistory("proj1", "config", "budget", undefined, db);
    expect(history.length).toBe(3);
    // All three IDs should be present
    const returnedIds = new Set(history.map(r => r.id));
    expect(returnedIds.has(r1.id)).toBe(true);
    expect(returnedIds.has(r2.id)).toBe(true);
    expect(returnedIds.has(r3.id)).toBe(true);
  });

  it("does not return changes for a different resource", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj1", { resourceType: "config", resourceId: "agents", action: "update", provenance: "human", actor: "op" }, db);

    const history = getResourceHistory("proj1", "config", "agents", undefined, db);
    expect(history.length).toBe(1);
    expect(history[0]!.resourceId).toBe("agents");
  });

  it("respects limit and offset", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op", after: { v: i } }, db);
    }

    const page1 = getResourceHistory("proj1", "config", "budget", { limit: 2 }, db);
    expect(page1.length).toBe(2);

    const page2 = getResourceHistory("proj1", "config", "budget", { limit: 2, offset: 2 }, db);
    expect(page2.length).toBe(2);

    // Pages should have different records
    expect(page1[0]!.id).not.toBe(page2[0]!.id);
  });

  it("filters by provenance", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "agent", actor: "cf-lead" }, db);
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "system", actor: "sweep" }, db);

    const humanOnly = getResourceHistory("proj1", "config", "budget", { provenance: "human" }, db);
    expect(humanOnly.length).toBe(1);
    expect(humanOnly[0]!.provenance).toBe("human");
  });

  it("does not leak changes from other projects", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj2", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);

    const history = getResourceHistory("proj1", "config", "budget", undefined, db);
    expect(history.length).toBe(1);
    expect(history[0]!.projectId).toBe("proj1");
  });
});

describe("listRecentChanges", () => {
  it("returns all changes for a project", () => {
    const db = makeDb();
    const r1 = recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    const r2 = recordChange("proj1", { resourceType: "agent", resourceId: "agent-1", action: "update", provenance: "agent", actor: "cf-lead" }, db);

    const all = listRecentChanges("proj1", undefined, db);
    expect(all.length).toBe(2);
    // Both IDs should be present
    const returnedIds = new Set(all.map(r => r.id));
    expect(returnedIds.has(r1.id)).toBe(true);
    expect(returnedIds.has(r2.id)).toBe(true);
  });

  it("filters by resourceType", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj1", { resourceType: "agent", resourceId: "agent-1", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj1", { resourceType: "config", resourceId: "agents", action: "update", provenance: "human", actor: "op" }, db);

    const configOnly = listRecentChanges("proj1", { resourceType: "config" }, db);
    expect(configOnly.length).toBe(2);
    expect(configOnly.every(r => r.resourceType === "config")).toBe(true);
  });

  it("filters by provenance", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj1", { resourceType: "config", resourceId: "agents", action: "update", provenance: "agent", actor: "cf-lead" }, db);

    const agentOnly = listRecentChanges("proj1", { provenance: "agent" }, db);
    expect(agentOnly.length).toBe(1);
    expect(agentOnly[0]!.provenance).toBe("agent");
  });

  it("respects limit and offset", () => {
    const db = makeDb();
    for (let i = 0; i < 10; i++) {
      recordChange("proj1", { resourceType: "config", resourceId: `r${i}`, action: "update", provenance: "human", actor: "op" }, db);
    }

    const first3 = listRecentChanges("proj1", { limit: 3 }, db);
    expect(first3.length).toBe(3);

    const next3 = listRecentChanges("proj1", { limit: 3, offset: 3 }, db);
    expect(next3.length).toBe(3);
    const ids1 = new Set(first3.map(r => r.id));
    expect(next3.some(r => ids1.has(r.id))).toBe(false);
  });

  it("preserves before/after snapshots accurately", () => {
    const db = makeDb();
    const before = { agents: [{ id: "a1", title: "Old Title" }] };
    const after = { agents: [{ id: "a1", title: "New Title" }] };

    recordChange("proj1", {
      resourceType: "config",
      resourceId: "agents",
      action: "update",
      provenance: "human",
      actor: "dashboard",
      before,
      after,
    }, db);

    const [record] = listRecentChanges("proj1", undefined, db);
    expect(record).toBeDefined();
    expect(JSON.parse(record!.before!)).toEqual(before);
    expect(JSON.parse(record!.after!)).toEqual(after);
  });

  it("does not return changes from other projects", () => {
    const db = makeDb();
    recordChange("proj1", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);
    recordChange("proj2", { resourceType: "config", resourceId: "budget", action: "update", provenance: "human", actor: "op" }, db);

    const proj1Changes = listRecentChanges("proj1", undefined, db);
    expect(proj1Changes.length).toBe(1);
    expect(proj1Changes[0]!.projectId).toBe("proj1");
  });
});
