/**
 * SDK E2E: AI Town Simulation
 *
 * A single comprehensive integration test that exercises the SDK like a real
 * user would — proving all 14 namespaces work together as a cohesive whole.
 *
 * Strategy: use setProjectsDir with a temp directory so every namespace that
 * calls getDb() gets an ephemeral file-based SQLite DB. Reset + clean up in
 * afterAll for full isolation from other test suites.
 *
 * The "AI Town" scenario simulates NPCs (non-player characters) doing work:
 * they receive tasks, cook dinner, message each other, and accumulate trust.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
const { Clawforce } = await import("../../src/sdk/index.js");

// ---- Test setup ----

let tmpDir: string;
let originalDir: string;

describe("SDK E2E: AI Town Simulation", () => {
  let cf: Clawforce;

  beforeAll(() => {
    originalDir = getProjectsDir();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-e2e-town-"));
    setProjectsDir(tmpDir);

    cf = Clawforce.init({ domain: "e2e-town" });
  });

  afterAll(() => {
    resetDbForTest();
    setProjectsDir(originalDir);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ---------- 1. Full lifecycle: tasks → events → trust → knowledge → goals → monitoring → db ----------

  it("full lifecycle: tasks → events → budget → trust → knowledge", () => {
    // 1. Create a task for an NPC (with group, so she gets OPEN state first)
    const task = cf.tasks.create({
      title: "Cook dinner for family",
      assignedTo: "npc-alice",
      group: "household-1",
    });
    expect(task.id).toBeDefined();
    expect(task.group).toBe("household-1");
    // With assignedTo, task starts in ASSIGNED state
    expect(task.state).toBe("ASSIGNED");

    // 2. Subscribe to events
    const events: any[] = [];
    cf.events.on("*", (e) => events.push(e));

    // 3. Emit a custom game event
    cf.events.emit("npc_started_cooking", { agentId: "npc-alice", dish: "pasta" });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("npc_started_cooking");

    // 4. Transition the task: ASSIGNED → IN_PROGRESS
    const inProgress = cf.tasks.transition(task.id, "IN_PROGRESS", { actor: "npc-alice" });
    expect(inProgress.state).toBe("IN_PROGRESS");

    // 5. Record a trust decision (NPC did good work)
    cf.trust.record({
      agentId: "npc-alice",
      category: "cooking",
      decision: "approved",
    });

    // 6. Check trust score
    const score = cf.trust.score();
    expect(score.categories.cooking).toBeGreaterThan(0);

    // 7. Store a memory
    cf.knowledge.store({
      type: "memory",
      content: "Alice cooked pasta for dinner",
      agentId: "npc-alice",
      tags: ["cooking", "daily"],
    });

    // 8. Search knowledge
    const memories = cf.knowledge.search("pasta");
    expect(memories.length).toBeGreaterThan(0);

    // 9. Complete the task: IN_PROGRESS → REVIEW → DONE
    //    IN_PROGRESS → REVIEW requires evidence; attach it via the db escape hatch.
    //    REVIEW → DONE requires a verifier different from the assignee (no self-grading).
    cf.db.execute(
      "INSERT INTO evidence (id, task_id, type, content, content_hash, attached_by, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "ev-pasta-dinner",
        task.id,
        "text",
        "Alice cooked pasta — the family loved it",
        "abc123",
        "npc-alice",
        Date.now(),
      ]
    );
    cf.tasks.transition(task.id, "REVIEW", { actor: "npc-alice" });
    cf.tasks.transition(task.id, "DONE", { actor: "npc-manager" });

    const finishedTask = cf.tasks.get(task.id);
    expect(finishedTask?.state).toBe("DONE");

    // 10. Create a goal and link the task
    const goal = cf.goals.create({
      title: "Master Italian Cuisine",
      group: "household-1",
      owner: "npc-alice",
    });
    cf.goals.linkTask(task.id, goal.id);
    const goalTasks = cf.goals.tasks(goal.id);
    expect(goalTasks.length).toBe(1);

    // 11. Check monitoring
    const health = cf.monitoring.health();
    expect(health.tier).toBeDefined();

    // 12. Use the DB escape hatch
    const taskCount = cf.db.queryOne<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?",
      ["e2e-town"]
    );
    expect(taskCount!.cnt).toBeGreaterThanOrEqual(1);
  });

  // ---------- 2. Hooks block actions ----------

  it("hooks block actions", () => {
    // Register a hook that blocks transitions to CANCELLED
    const blocker = (ctx: any) => {
      if (ctx.toState === "CANCELLED") return { block: true, reason: "No cancellations allowed in testing" };
    };
    cf.hooks.beforeTransition(blocker);

    const task = cf.tasks.create({ title: "Test hook blocking", assignedTo: "npc-bob" });

    // This should be blocked — task is ASSIGNED, ASSIGNED → CANCELLED is valid in the state
    // machine but blocked by our hook
    expect(() => cf.tasks.transition(task.id, "CANCELLED", { actor: "npc-bob" }))
      .toThrow(/blocked|No cancellations/i);

    // Clean up so subsequent tests aren't affected
    cf.hooks.clear();
  });

  // ---------- 3. Messages between NPCs ----------

  it("messages between NPCs", () => {
    const msg = cf.messages.send({
      from: "npc-alice",
      to: "npc-bob",
      content: "Want to come over for dinner?",
      type: "direct",
    });
    expect(msg.id).toBeDefined();

    const pending = cf.messages.pending("npc-bob");
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((m) => m.content.includes("dinner"))).toBe(true);

    // markDelivered needs a db override in the internal layer, but markRead uses the domain db
    cf.messages.markRead(msg.id);
  });

  // ---------- 4. Dispatch queue lifecycle ----------

  it("dispatch queue lifecycle", () => {
    // Create a task in ASSIGNED state so it's dispatchable
    const task = cf.tasks.create({ title: "Go to work", assignedTo: "npc-alice" });

    const item = cf.dispatch.enqueue(task.id);
    expect(item).toBeDefined();

    const status = cf.dispatch.status();
    expect(status.queued).toBeGreaterThanOrEqual(1);

    const claimed = cf.dispatch.claimNext();
    expect(claimed).toBeDefined();

    cf.dispatch.complete(claimed!.id);
  });

  // ---------- 5. Events list and count (verifying persistence across tests) ----------

  it("events are persisted and queryable", () => {
    // Emit more events
    cf.events.emit("npc_arrived_home", { agentId: "npc-bob" });
    cf.events.emit("npc_arrived_home", { agentId: "npc-charlie" });

    // Should have at least 2 events of this type in the store
    const arrivals = cf.events.list({ type: "npc_arrived_home" });
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals.every((e) => e.type === "npc_arrived_home")).toBe(true);

    // Count
    const count = cf.events.count({ type: "npc_arrived_home" });
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // ---------- 6. Trust overrides and multi-category scoring ----------

  it("trust overrides and scoring", () => {
    // Record multiple decisions across categories
    cf.trust.record({ agentId: "npc-alice", category: "gardening", decision: "approved" });
    cf.trust.record({ agentId: "npc-alice", category: "gardening", decision: "approved" });
    cf.trust.record({ agentId: "npc-alice", category: "gardening", decision: "rejected" });

    const catStats = cf.trust.categoryStats("gardening");
    expect(catStats).not.toBeNull();
    expect(catStats.totalDecisions).toBe(3);
    expect(catStats.approved).toBe(2);

    // Apply an override
    const ov = cf.trust.override({
      category: "gardening",
      originalTier: "high",
      overrideTier: "medium",
      reason: "alice proved herself",
      decayAfterDays: 14,
    });
    expect(ov.status).toBe("active");

    // Verify override is listed
    const overrides = cf.trust.overrides();
    expect(overrides.some((o: any) => o.category === "gardening")).toBe(true);
  });

  // ---------- 7. Goal hierarchy and task linking ----------

  it("goal hierarchy with child goals", () => {
    const parentGoal = cf.goals.create({
      title: "Become a great chef",
      group: "household-1",
      owner: "npc-alice",
    });

    const childGoal = cf.goals.create({
      title: "Learn pasta from scratch",
      group: "household-1",
      owner: "npc-alice",
      parentGoalId: parentGoal.id,
    });
    expect(childGoal.id).toBeDefined();

    // Create and link a task to the child goal
    const subTask = cf.tasks.create({
      title: "Buy semolina flour",
      assignedTo: "npc-alice",
      goalId: childGoal.id,
    });
    expect(subTask.goalId).toBe(childGoal.id);

    // List goals
    const allGoals = cf.goals.list({ group: "household-1" });
    expect(allGoals.length).toBeGreaterThanOrEqual(2);

    // Child goals
    const children = cf.goals.children(parentGoal.id);
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children.some((g) => g.id === childGoal.id)).toBe(true);

    // Achieve the parent goal
    const achieved = cf.goals.achieve(parentGoal.id, "npc-manager");
    expect(achieved.status).toBe("achieved");
  });

  // ---------- 8. Knowledge across types and removal ----------

  it("knowledge multi-type and removal", () => {
    const factEntry = cf.knowledge.store({
      type: "fact",
      content: "Italy is the birthplace of pasta",
      agentId: "npc-alice",
      tags: ["cuisine", "geography"],
    });

    const ruleEntry = cf.knowledge.store({
      type: "rule",
      content: "Always salt the pasta water",
      agentId: "npc-alice",
      tags: ["cooking"],
    });

    // List by type
    const facts = cf.knowledge.list({ type: "fact" });
    expect(facts.some((e) => e.id === factEntry.id)).toBe(true);

    const rules = cf.knowledge.list({ type: "rule" });
    expect(rules.some((e) => e.id === ruleEntry.id)).toBe(true);

    // Get by ID
    const fetched = cf.knowledge.get(factEntry.id);
    expect(fetched?.content).toBe("Italy is the birthplace of pasta");

    // Remove and verify gone
    cf.knowledge.remove(ruleEntry.id);
    expect(cf.knowledge.get(ruleEntry.id)).toBeUndefined();
  });

  // ---------- 9. DB escape hatch: tables and raw queries ----------

  it("db escape hatch exposes tables and raw queries", () => {
    const tables = cf.db.tables();
    // The migrated DB should have all core tables
    expect(tables).toContain("tasks");
    expect(tables).toContain("goals");
    expect(tables).toContain("knowledge");
    expect(tables).toContain("events");

    // Raw multi-row query
    const knowledgeRows = cf.db.query<{ id: string; category: string }>(
      "SELECT id, category FROM knowledge WHERE project_id = ?",
      ["e2e-town"]
    );
    expect(Array.isArray(knowledgeRows)).toBe(true);
    expect(knowledgeRows.length).toBeGreaterThan(0);

    // Execute (mutation)
    const result = cf.db.execute(
      "INSERT INTO knowledge (id, project_id, category, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["test-raw-id", "e2e-town", "raw", "Raw insert", "Direct SQL insert via db.execute", Date.now()]
    );
    expect(result.changes).toBe(1);

    // Verify it's there
    const inserted = cf.knowledge.get("test-raw-id");
    expect(inserted).toBeDefined();
    expect(inserted?.type).toBe("raw");
  });

  // ---------- 10. Concurrency and dispatch queue status ----------

  it("dispatch concurrency settings", () => {
    const info = cf.dispatch.concurrency();
    expect(typeof info.active).toBe("number");
    expect(typeof info.max).toBe("number");
    expect(info.max).toBeGreaterThan(0);

    // Set and restore
    const original = info.max;
    cf.dispatch.setMaxConcurrency(original + 3);
    expect(cf.dispatch.concurrency().max).toBe(original + 3);
    cf.dispatch.setMaxConcurrency(original);
  });
});
