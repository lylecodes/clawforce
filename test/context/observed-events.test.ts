import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");

let db: ReturnType<typeof getMemoryDb>;
const DOMAIN = "test-observe";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("renderObservedEvents", () => {
  it("returns matching events for exact type patterns", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1", amount: 500 }, { db });
    events.emit("task.completed", { taskId: "t1" }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.exceeded"], 0, db);
    expect(result).toContain("budget.exceeded");
    expect(result).not.toContain("task.completed");
  });

  it("supports wildcard patterns", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1" }, { db });
    events.emit("budget.warning", { agent: "dev-2" }, { db });
    events.emit("task.completed", { taskId: "t1" }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("budget.exceeded");
    expect(result).toContain("budget.warning");
    expect(result).not.toContain("task.completed");
  });

  it("filters by since timestamp", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { old: true }, { db });
    const after = Date.now();
    // Busy-wait at least 1ms to ensure the next event has a strictly later timestamp
    while (Date.now() <= after) { /* spin */ }
    events.emit("budget.exceeded", { new: true }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.*"], after, db);
    expect(result).toContain("new");
    expect(result).not.toContain("old");
  });

  it("returns empty message when no events match", () => {
    const result = renderObservedEvents(DOMAIN, ["budget.*"], 0, db);
    expect(result).toContain("No observed events");
  });
});
