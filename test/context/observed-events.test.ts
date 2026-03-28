import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/org.js", () => ({
  getTeamAgents: vi.fn((projectId: string, team: string) => {
    if (team === "dashboard") return ["dash-lead", "dash-worker", "dash-worker-2"];
    if (team === "core") return ["cf-lead", "cf-worker"];
    return [];
  }),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { renderObservedEvents, matchesPattern, matchesScope } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");

let db: ReturnType<typeof getMemoryDb>;
const DOMAIN = "test-observe";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("matchesPattern", () => {
  it("matches exact types", () => {
    expect(matchesPattern("budget.exceeded", "budget.exceeded")).toBe(true);
    expect(matchesPattern("budget.exceeded", "budget.warning")).toBe(false);
  });

  it("matches wildcard suffix", () => {
    expect(matchesPattern("budget.exceeded", "budget.*")).toBe(true);
    expect(matchesPattern("budget.warning", "budget.*")).toBe(true);
    expect(matchesPattern("task.completed", "budget.*")).toBe(false);
  });

  it("matches catch-all wildcard", () => {
    expect(matchesPattern("anything", "*")).toBe(true);
  });

  it("matches prefix without dot", () => {
    expect(matchesPattern("budget", "budget.*")).toBe(true);
  });
});

describe("matchesScope", () => {
  const makeEvent = (agentField: string, agentValue: string) => ({
    id: "e1",
    projectId: DOMAIN,
    type: "task.created",
    source: "internal" as const,
    payload: { [agentField]: agentValue },
    status: "pending" as const,
    createdAt: Date.now(),
  });

  it("passes when no scope is defined", () => {
    const event = makeEvent("agentId", "dash-worker");
    expect(matchesScope(event, undefined, DOMAIN)).toBe(true);
  });

  it("filters by team using agentId payload field", () => {
    const dashEvent = makeEvent("agentId", "dash-worker");
    const coreEvent = makeEvent("agentId", "cf-worker");

    expect(matchesScope(dashEvent, { team: "dashboard" }, DOMAIN)).toBe(true);
    expect(matchesScope(coreEvent, { team: "dashboard" }, DOMAIN)).toBe(false);
  });

  it("filters by team using assignedTo payload field", () => {
    const event = makeEvent("assignedTo", "dash-worker-2");
    expect(matchesScope(event, { team: "dashboard" }, DOMAIN)).toBe(true);
  });

  it("filters by specific agent", () => {
    const event = makeEvent("agentId", "dash-worker");
    expect(matchesScope(event, { agent: "dash-worker" }, DOMAIN)).toBe(true);
    expect(matchesScope(event, { agent: "cf-worker" }, DOMAIN)).toBe(false);
  });

  it("rejects events with no agent info when scope is set", () => {
    const event = {
      id: "e1",
      projectId: DOMAIN,
      type: "task.created",
      source: "internal" as const,
      payload: { data: "no-agent" },
      status: "pending" as const,
      createdAt: Date.now(),
    };
    expect(matchesScope(event, { team: "dashboard" }, DOMAIN)).toBe(false);
    expect(matchesScope(event, { agent: "dash-worker" }, DOMAIN)).toBe(false);
  });

  it("supports combined team and agent scope", () => {
    const event = makeEvent("agentId", "dash-worker");
    // dash-worker is in dashboard team and matches agent
    expect(matchesScope(event, { team: "dashboard", agent: "dash-worker" }, DOMAIN)).toBe(true);
    // dash-worker is in dashboard team but does not match agent
    expect(matchesScope(event, { team: "dashboard", agent: "dash-lead" }, DOMAIN)).toBe(false);
  });
});

describe("renderObservedEvents", () => {
  it("returns matching events for exact type patterns (backward compat)", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "dev-1", amount: 500 }, { db });
    events.emit("task.completed", { taskId: "t1" }, { db });

    const result = renderObservedEvents(DOMAIN, ["budget.exceeded"], 0, db);
    expect(result).toContain("budget.exceeded");
    expect(result).not.toContain("task.completed");
  });

  it("supports wildcard patterns (backward compat)", () => {
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

  it("filters by team scope with object entries", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("task.created", { assignedTo: "dash-worker", title: "Dashboard bug" }, { db });
    events.emit("task.created", { assignedTo: "cf-worker", title: "Core feature" }, { db });

    const result = renderObservedEvents(
      DOMAIN,
      [{ pattern: "task.*", scope: { team: "dashboard" } }],
      0,
      db,
    );
    expect(result).toContain("Dashboard bug");
    expect(result).not.toContain("Core feature");
  });

  it("filters by agent scope with object entries", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("task.completed", { agentId: "dash-worker", title: "Task A" }, { db });
    events.emit("task.completed", { agentId: "dash-worker-2", title: "Task B" }, { db });

    const result = renderObservedEvents(
      DOMAIN,
      [{ pattern: "task.*", scope: { agent: "dash-worker" } }],
      0,
      db,
    );
    expect(result).toContain("Task A");
    expect(result).not.toContain("Task B");
  });

  it("mixes plain strings and scoped entries", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("budget.exceeded", { agent: "anyone" }, { db });
    events.emit("task.created", { assignedTo: "dash-worker", title: "Dash task" }, { db });
    events.emit("task.created", { assignedTo: "cf-worker", title: "Core task" }, { db });

    const result = renderObservedEvents(
      DOMAIN,
      [
        "budget.exceeded",
        { pattern: "task.*", scope: { team: "dashboard" } },
      ],
      0,
      db,
    );
    // Plain string matches regardless of agent
    expect(result).toContain("budget.exceeded");
    // Scoped entry only matches dashboard team
    expect(result).toContain("Dash task");
    expect(result).not.toContain("Core task");
  });

  it("scoped entry with no matching agent in payload excludes event", () => {
    const events = new EventsNamespace(DOMAIN);
    events.emit("task.created", { data: "no-agent-info" }, { db });

    const result = renderObservedEvents(
      DOMAIN,
      [{ pattern: "task.*", scope: { team: "dashboard" } }],
      0,
      db,
    );
    expect(result).toContain("No observed events");
  });
});
