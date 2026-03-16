/**
 * Integration tests: hooks wired into DispatchNamespace, TasksNamespace, BudgetNamespace.
 *
 * Strategy: use setProjectsDir with a temp directory so every namespace call to
 * getDb() gets an ephemeral file-based SQLite DB that is fully isolated from
 * other test suites. Within each describe block a fresh Clawforce instance and
 * HooksNamespace are created for each test so hooks don't bleed across cases.
 *
 * For namespace-level isolation tests (e.g. verifying the fallback no-op
 * constructor), namespaces are constructed directly with a shared hooks instance
 * passed via the getHooks parameter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const { HooksNamespace } = await import("../../src/sdk/hooks.js");
const { DispatchNamespace } = await import("../../src/sdk/dispatch.js");
const { TasksNamespace } = await import("../../src/sdk/tasks.js");
const { BudgetNamespace } = await import("../../src/sdk/budget.js");
const { Clawforce } = await import("../../src/sdk/index.js");

// ---- Test filesystem setup ----

let tmpDir: string;
let originalDir: string;

beforeAll(() => {
  originalDir = getProjectsDir();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-hooks-integration-"));
  setProjectsDir(tmpDir);
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

// ---- Helpers ----

let _counter = 0;
/** Generate a unique domain per test to avoid cross-test DB state pollution. */
function uniqueDomain() {
  return `hooks-int-${++_counter}`;
}

// ---------------------------------------------------------------------------
// 1. beforeDispatch hook blocks enqueue
// ---------------------------------------------------------------------------

describe("beforeDispatch — blocks enqueue when hook returns block: true", () => {
  it("returns null from enqueue when a beforeDispatch hook blocks", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeDispatch(() => ({ block: true, reason: "dispatching not allowed" }));

    const task = cf.tasks.create({ title: "Hook test", assignedTo: "agent:worker" });
    const result = cf.dispatch.enqueue(task.id);

    expect(result).toBeNull();
  });

  it("enqueues normally when beforeDispatch hook passes", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeDispatch(() => undefined); // pass through

    const task = cf.tasks.create({ title: "No block", assignedTo: "agent:worker" });
    const result = cf.dispatch.enqueue(task.id);

    expect(result).not.toBeNull();
    expect(result!.taskId).toBe(task.id);
    expect(result!.status).toBe("queued");
  });

  it("passes taskId, agentId, and priority into the hook context", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    let captured: Record<string, unknown> | undefined;
    cf.hooks.beforeDispatch((ctx) => { captured = ctx as Record<string, unknown>; });

    const task = cf.tasks.create({ title: "Context check", assignedTo: "agent:worker" });
    cf.dispatch.enqueue(task.id, { agentId: "agent:bob", priority: 1 });

    expect(captured).toBeDefined();
    expect(captured!.taskId).toBe(task.id);
    expect(captured!.agentId).toBe("agent:bob");
    expect(captured!.priority).toBe(1);
  });

  it("first blocking hook short-circuits — later hooks are not called", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const allowed = vi.fn().mockReturnValue(undefined);
    cf.hooks.beforeDispatch(() => ({ block: true, reason: "hard stop" }));
    cf.hooks.beforeDispatch(allowed);

    const task = cf.tasks.create({ title: "Short circuit", assignedTo: "agent:worker" });
    const result = cf.dispatch.enqueue(task.id);

    expect(result).toBeNull();
    expect(allowed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. beforeTransition hook blocks task transition
// ---------------------------------------------------------------------------

describe("beforeTransition — throws when hook returns block: true", () => {
  it("throws an error from transition() when a beforeTransition hook blocks", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeTransition(() => ({ block: true, reason: "audit freeze" }));

    const task = cf.tasks.create({ title: "Blocked task", assignedTo: "agent:worker" });

    expect(() => cf.tasks.transition(task.id, "IN_PROGRESS"))
      .toThrow("Transition blocked: audit freeze");
  });

  it("transitions normally when beforeTransition hook passes", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeTransition(() => undefined);

    const task = cf.tasks.create({ title: "Allowed transition", assignedTo: "agent:worker" });
    const updated = cf.tasks.transition(task.id, "IN_PROGRESS");

    expect(updated.state).toBe("IN_PROGRESS");
  });

  it("passes taskId, fromState, toState, and actor into the hook context", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    let captured: Record<string, unknown> | undefined;
    cf.hooks.beforeTransition((ctx) => { captured = ctx as Record<string, unknown>; });

    const task = cf.tasks.create({ title: "Context task", assignedTo: "agent:worker" });
    cf.tasks.transition(task.id, "IN_PROGRESS", { actor: "orchestrator" });

    expect(captured).toBeDefined();
    expect(captured!.taskId).toBe(task.id);
    expect(captured!.toState).toBe("IN_PROGRESS");
    expect(captured!.actor).toBe("orchestrator");
    expect(typeof captured!.fromState).toBe("string");
  });

  it("fromState is the task's actual current state", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const states: string[] = [];
    cf.hooks.beforeTransition((ctx) => { states.push(ctx.fromState); });

    const task = cf.tasks.create({ title: "State check", assignedTo: "agent:worker" });
    // task starts in ASSIGNED
    cf.tasks.transition(task.id, "IN_PROGRESS");

    expect(states[0]).toBe("ASSIGNED");
  });

  it("error message includes the hook's reason", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeTransition(() => ({ block: true, reason: "compliance hold" }));

    const task = cf.tasks.create({ title: "Hold task", assignedTo: "agent:worker" });

    expect(() => cf.tasks.transition(task.id, "IN_PROGRESS"))
      .toThrow("compliance hold");
  });
});

// ---------------------------------------------------------------------------
// 3. onBudgetExceeded hook fires when budget check fails
// ---------------------------------------------------------------------------

describe("onBudgetExceeded — fires when check() returns ok: false", () => {
  it("fires onBudgetExceeded hook when daily limit is exceeded", () => {
    const domain = uniqueDomain();
    const cf = Clawforce.init({ domain });
    const fired = vi.fn();
    cf.hooks.onBudgetExceeded(fired);

    // Set a tiny daily limit then force the counter over it via the SDK
    cf.budget.set({ daily: { cents: 1 } });
    // Access the underlying DB to force the counter over the limit
    const db = cf.db.raw();
    db.prepare("UPDATE budgets SET daily_spent_cents = 100 WHERE project_id = ?").run(domain);

    const result = cf.budget.check();

    expect(result.ok).toBe(false);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onBudgetExceeded when budget is within limits", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const fired = vi.fn();
    cf.hooks.onBudgetExceeded(fired);

    // No budget set → always ok
    const result = cf.budget.check();

    expect(result.ok).toBe(true);
    expect(fired).not.toHaveBeenCalled();
  });

  it("passes agentId and remaining into the hook context", () => {
    const domain = uniqueDomain();
    const cf = Clawforce.init({ domain });
    let captured: Record<string, unknown> | undefined;
    cf.hooks.onBudgetExceeded((ctx) => { captured = ctx as Record<string, unknown>; });

    cf.budget.set({ daily: { cents: 1 } });
    const db = cf.db.raw();
    db.prepare("UPDATE budgets SET daily_spent_cents = 100 WHERE project_id = ?").run(domain);

    cf.budget.check("agent:spender");

    expect(captured).toBeDefined();
    expect(captured!.agentId).toBe("agent:spender");
    expect(typeof captured!.remaining).toBe("number");
  });

  it("onBudgetExceeded hook fires even when returning block:true (hook is informational for check)", () => {
    const domain = uniqueDomain();
    const cf = Clawforce.init({ domain });
    const fired = vi.fn().mockReturnValue({ block: true, reason: "hard stop" });
    cf.hooks.onBudgetExceeded(fired);

    cf.budget.set({ daily: { cents: 1 } });
    const db = cf.db.raw();
    db.prepare("UPDATE budgets SET daily_spent_cents = 100 WHERE project_id = ?").run(domain);

    const result = cf.budget.check();
    expect(result.ok).toBe(false);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Hooks don't interfere when nothing is registered
// ---------------------------------------------------------------------------

describe("hooks don't interfere when no hooks are registered", () => {
  it("DispatchNamespace.enqueue works normally with no hooks registered", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const task = cf.tasks.create({ title: "No hooks", assignedTo: "agent:worker" });
    const result = cf.dispatch.enqueue(task.id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("queued");
  });

  it("TasksNamespace.transition works normally with no hooks registered", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const task = cf.tasks.create({ title: "No hooks transition", assignedTo: "agent:worker" });
    const updated = cf.tasks.transition(task.id, "IN_PROGRESS");

    expect(updated.state).toBe("IN_PROGRESS");
  });

  it("BudgetNamespace.check works normally with no hooks registered", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    expect(cf.budget.check().ok).toBe(true);
  });

  it("DispatchNamespace constructed without getHooks still works (fallback no-op hooks)", () => {
    const domain = uniqueDomain();
    // Construct directly — fallback HooksNamespace is created internally
    const ns = new DispatchNamespace(domain);
    // Create a task via Clawforce so it's in the same DB
    const cf = Clawforce.init({ domain });
    const task = cf.tasks.create({ title: "Fallback dispatch", assignedTo: "agent:worker" });

    const result = ns.enqueue(task.id);
    expect(result).not.toBeNull();
  });

  it("TasksNamespace constructed without getHooks still works (fallback no-op hooks)", () => {
    const domain = uniqueDomain();
    const cf = Clawforce.init({ domain });
    const task = cf.tasks.create({ title: "Fallback tasks", assignedTo: "agent:worker" });

    const ns = new TasksNamespace(domain);
    const updated = ns.transition(task.id, "IN_PROGRESS");
    expect(updated.state).toBe("IN_PROGRESS");
  });

  it("BudgetNamespace constructed without getHooks still works (fallback no-op hooks)", () => {
    const domain = uniqueDomain();
    const ns = new BudgetNamespace(domain);
    expect(ns.check().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Clawforce class wires the same hooks instance to all namespaces
// ---------------------------------------------------------------------------

describe("Clawforce class wires hooks to namespaces", () => {
  it("Clawforce.hooks returns a HooksNamespace", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    expect(cf.hooks).toBeInstanceOf(HooksNamespace);
  });

  it("blocking hook on cf.hooks prevents cf.dispatch.enqueue", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    cf.hooks.beforeDispatch(() => ({ block: true, reason: "wired correctly" }));

    const task = cf.tasks.create({ title: "Wire check", assignedTo: "agent:worker" });
    const result = cf.dispatch.enqueue(task.id);

    expect(result).toBeNull();
  });

  it("hook registered on cf.hooks fires during cf.tasks.transition", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    const spy = vi.fn().mockReturnValue(undefined);
    cf.hooks.beforeTransition(spy);

    const task = cf.tasks.create({ title: "Spy task", assignedTo: "agent:worker" });
    cf.tasks.transition(task.id, "IN_PROGRESS");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cf.hooks is the same instance across repeated accesses (lazy singleton)", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });
    expect(cf.hooks).toBe(cf.hooks);
  });

  it("hooks registered after namespace first access still fire", () => {
    const cf = Clawforce.init({ domain: uniqueDomain() });

    // Access dispatch first to initialize the lazy singleton
    const _ = cf.dispatch;

    // Register hook afterwards
    const spy = vi.fn().mockReturnValue(undefined);
    cf.hooks.beforeDispatch(spy);

    const task = cf.tasks.create({ title: "Late hook", assignedTo: "agent:worker" });
    cf.dispatch.enqueue(task.id);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
