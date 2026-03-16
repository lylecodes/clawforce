/**
 * Tests for the HooksNamespace SDK module.
 *
 * Strategy: HooksNamespace is purely in-memory — no DB, no internal imports.
 * All tests construct the namespace directly and exercise register/execute/
 * unregister/clear and the three convenience methods.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HooksNamespace,
  type DispatchContext,
  type TransitionContext,
  type BudgetContext,
} from "../../src/sdk/hooks.js";

// ---- Constants ----

const DOMAIN = "test-hooks-project";

// ---- Tests ----

describe("HooksNamespace", () => {
  let ns: HooksNamespace;

  beforeEach(() => {
    ns = new HooksNamespace(DOMAIN);
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("stores arbitrary domain strings", () => {
      expect(new HooksNamespace("research-lab").domain).toBe("research-lab");
      expect(new HooksNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- 1. Register and execute a beforeDispatch hook ----------

  describe("beforeDispatch", () => {
    it("registers and executes a beforeDispatch hook", () => {
      const cb = vi.fn().mockReturnValue(undefined);
      ns.beforeDispatch(cb);

      const ctx: DispatchContext = { taskId: "t-1", agentId: "a-1", priority: 5 };
      const result = ns.execute("beforeDispatch", ctx);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(ctx);
      expect(result).toEqual({ blocked: false });
    });

    it("passes full DispatchContext to the callback", () => {
      let received: DispatchContext | undefined;
      ns.beforeDispatch((ctx) => { received = ctx; });

      const ctx: DispatchContext = { taskId: "t-99", agentId: "agent-x", priority: 10 };
      ns.execute("beforeDispatch", ctx);

      expect(received).toEqual(ctx);
    });
  });

  // ---------- 2. Hook returning { block: true } blocks execution ----------

  describe("blocking hooks", () => {
    it("a hook returning { block: true } causes execute to return blocked: true", () => {
      ns.beforeDispatch(() => ({ block: true, reason: "not allowed" }));

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("not allowed");
    });

    it("uses default reason 'Blocked by hook' when block: true with no reason", () => {
      ns.beforeDispatch(() => ({ block: true }));

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("Blocked by hook");
    });

    it("a hook returning { block: false } does not block", () => {
      ns.beforeDispatch(() => ({ block: false }));

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(false);
    });

    it("a hook returning void does not block", () => {
      ns.beforeDispatch(() => { /* no return */ });

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(false);
    });
  });

  // ---------- 3. Multiple hooks — first to block wins ----------

  describe("multiple hooks — first to block wins", () => {
    it("short-circuits on the first blocking hook", () => {
      const cb1 = vi.fn().mockReturnValue({ block: true, reason: "cb1 blocked" });
      const cb2 = vi.fn().mockReturnValue(undefined);

      ns.beforeDispatch(cb1);
      ns.beforeDispatch(cb2);

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("cb1 blocked");
      // cb2 must NOT have been called because cb1 already blocked
      expect(cb2).not.toHaveBeenCalled();
    });

    it("second hook can block when first passes", () => {
      const cb1 = vi.fn().mockReturnValue(undefined);
      const cb2 = vi.fn().mockReturnValue({ block: true, reason: "cb2 blocked" });

      ns.beforeDispatch(cb1);
      ns.beforeDispatch(cb2);

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("cb2 blocked");
      expect(cb1).toHaveBeenCalledTimes(1);
    });

    it("all passing hooks return blocked: false", () => {
      ns.beforeDispatch(() => undefined);
      ns.beforeDispatch(() => ({ block: false }));
      ns.beforeDispatch(() => undefined);

      const result = ns.execute("beforeDispatch", { taskId: "t-1" });

      expect(result.blocked).toBe(false);
    });
  });

  // ---------- 4. Hook errors don't propagate ----------

  describe("hook error isolation", () => {
    it("a throwing callback does not crash execute()", () => {
      ns.register("crash.test", () => { throw new Error("hook exploded"); });

      expect(() => ns.execute("crash.test", {})).not.toThrow();
    });

    it("execute returns blocked: false when the only hook throws", () => {
      ns.register("crash.test", () => { throw new Error("boom"); });

      const result = ns.execute("crash.test", {});

      expect(result.blocked).toBe(false);
    });

    it("subsequent good callbacks still run after a throwing callback", () => {
      const good = vi.fn().mockReturnValue(undefined);

      ns.register("crash.test", () => { throw new Error("throw 1"); });
      ns.register("crash.test", good);

      ns.execute("crash.test", {});

      expect(good).toHaveBeenCalledTimes(1);
    });

    it("a throwing hook does not prevent a later blocking hook from taking effect", () => {
      ns.register("crash.test", () => { throw new Error("throw first"); });
      ns.register("crash.test", () => ({ block: true, reason: "second blocked" }));

      const result = ns.execute("crash.test", {});

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("second blocked");
    });
  });

  // ---------- 5. Unregister removes a hook ----------

  describe("unregister", () => {
    it("unregistered callback is not called on execute", () => {
      const cb = vi.fn();
      ns.register("my.hook", cb);
      ns.unregister("my.hook", cb);

      ns.execute("my.hook", {});

      expect(cb).not.toHaveBeenCalled();
    });

    it("unregistering one callback does not affect others for the same hook", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      ns.register("my.hook", cb1);
      ns.register("my.hook", cb2);
      ns.unregister("my.hook", cb1);

      ns.execute("my.hook", {});

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it("unregister is a no-op for an unregistered callback", () => {
      const cb = vi.fn();
      expect(() => ns.unregister("nonexistent.hook", cb)).not.toThrow();
    });

    it("unregister is a no-op for an unknown hook name", () => {
      const cb = vi.fn();
      expect(() => ns.unregister("totally.unknown", cb)).not.toThrow();
    });
  });

  // ---------- 6. Clear removes all hooks ----------

  describe("clear", () => {
    it("clear removes all registered hooks", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      ns.register("hook.one", cb1);
      ns.register("hook.two", cb2);
      ns.clear();

      ns.execute("hook.one", {});
      ns.execute("hook.two", {});

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it("list() returns empty array after clear", () => {
      ns.register("hook.one", vi.fn());
      ns.register("hook.two", vi.fn());
      ns.clear();

      expect(ns.list()).toEqual([]);
    });

    it("new hooks can be registered after clear", () => {
      ns.register("hook.one", vi.fn());
      ns.clear();

      const cb = vi.fn();
      ns.register("hook.one", cb);
      ns.execute("hook.one", {});

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- 7. Execute with no hooks returns { blocked: false } ----------

  describe("execute with no hooks", () => {
    it("returns { blocked: false } for a hook name with no registrations", () => {
      const result = ns.execute("unregistered.hook", { someData: 42 });
      expect(result).toEqual({ blocked: false });
    });

    it("returns { blocked: false } for an empty namespace", () => {
      const fresh = new HooksNamespace("fresh-domain");
      const result = fresh.execute("beforeDispatch", { taskId: "t-1" });
      expect(result).toEqual({ blocked: false });
    });
  });

  // ---------- 8. Custom hook names via register/execute ----------

  describe("custom hook names", () => {
    it("custom hook registered via register() is executed via execute()", () => {
      const cb = vi.fn().mockReturnValue(undefined);
      ns.register("custom.approval.check", cb);

      const ctx = { requestId: "r-42", level: "high" };
      const result = ns.execute("custom.approval.check", ctx);

      expect(cb).toHaveBeenCalledWith(ctx);
      expect(result.blocked).toBe(false);
    });

    it("custom hook can block execution", () => {
      ns.register("custom.rate.limit", () => ({
        block: true,
        reason: "rate limit exceeded",
      }));

      const result = ns.execute("custom.rate.limit", { agentId: "a-1" });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("rate limit exceeded");
    });

    it("list() includes custom hook names", () => {
      ns.register("custom.hook.a", vi.fn());
      ns.register("custom.hook.b", vi.fn());

      const names = ns.list();

      expect(names).toContain("custom.hook.a");
      expect(names).toContain("custom.hook.b");
    });

    it("convenience methods appear in list() after registration", () => {
      ns.beforeDispatch(vi.fn());
      ns.beforeTransition(vi.fn());
      ns.onBudgetExceeded(vi.fn());

      const names = ns.list();

      expect(names).toContain("beforeDispatch");
      expect(names).toContain("beforeTransition");
      expect(names).toContain("onBudgetExceeded");
    });
  });

  // ---------- 9. beforeTransition and onBudgetExceeded convenience methods ----------

  describe("beforeTransition", () => {
    it("registers and executes a beforeTransition hook", () => {
      const cb = vi.fn().mockReturnValue(undefined);
      ns.beforeTransition(cb);

      const ctx: TransitionContext = {
        taskId: "t-1",
        fromState: "pending",
        toState: "running",
        actor: "scheduler",
      };
      const result = ns.execute("beforeTransition", ctx);

      expect(cb).toHaveBeenCalledWith(ctx);
      expect(result.blocked).toBe(false);
    });

    it("beforeTransition hook can block a transition", () => {
      ns.beforeTransition((ctx) => {
        if (ctx.toState === "cancelled") {
          return { block: true, reason: "cancellation not permitted" };
        }
      });

      const blocked = ns.execute("beforeTransition", {
        taskId: "t-1",
        fromState: "running",
        toState: "cancelled",
        actor: "api",
      });
      const allowed = ns.execute("beforeTransition", {
        taskId: "t-2",
        fromState: "running",
        toState: "completed",
        actor: "api",
      });

      expect(blocked.blocked).toBe(true);
      expect(blocked.reason).toBe("cancellation not permitted");
      expect(allowed.blocked).toBe(false);
    });
  });

  describe("onBudgetExceeded", () => {
    it("registers and executes an onBudgetExceeded hook", () => {
      const cb = vi.fn().mockReturnValue(undefined);
      ns.onBudgetExceeded(cb);

      const ctx: BudgetContext = { agentId: "a-1", costCents: 5000, remaining: -200 };
      const result = ns.execute("onBudgetExceeded", ctx);

      expect(cb).toHaveBeenCalledWith(ctx);
      expect(result.blocked).toBe(false);
    });

    it("onBudgetExceeded hook can block spending", () => {
      ns.onBudgetExceeded((ctx) => {
        if (ctx.remaining < -1000) {
          return { block: true, reason: "hard cap exceeded" };
        }
      });

      const softOver = ns.execute("onBudgetExceeded", {
        costCents: 100,
        remaining: -500,
      });
      const hardOver = ns.execute("onBudgetExceeded", {
        costCents: 200,
        remaining: -1500,
      });

      expect(softOver.blocked).toBe(false);
      expect(hardOver.blocked).toBe(true);
      expect(hardOver.reason).toBe("hard cap exceeded");
    });

    it("onBudgetExceeded works without an agentId (global budget)", () => {
      const cb = vi.fn().mockReturnValue(undefined);
      ns.onBudgetExceeded(cb);

      ns.execute("onBudgetExceeded", { costCents: 1000, remaining: -100 });

      expect(cb).toHaveBeenCalledWith({ costCents: 1000, remaining: -100 });
    });
  });
});
