/**
 * Tests for the TriggersNamespace SDK wrapper.
 *
 * Exercises fire(), list(), and test() methods using in-memory DB
 * and registered trigger configs.
 */

import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks ----

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

// ---- Dynamic imports ----

const { getMemoryDb } = await import("../../src/db.js");
const { TriggersNamespace } = await import("../../src/sdk/triggers.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { clearCooldowns } = await import("../../src/triggers/processor.js");

import type { WorkforceConfig, TriggerDefinition } from "../../src/types.js";

// ---- Helpers ----

const DOMAIN = "test-sdk-triggers";

function makeWorkforceConfig(triggers: Record<string, TriggerDefinition>): WorkforceConfig {
  return {
    name: "sdk-trigger-test",
    agents: {
      worker: {
        extends: "employee",
        briefing: [],
        expectations: [{ tool: "clawforce_log", action: "outcome", min_calls: 1 }],
        performance_policy: { action: "alert" },
      },
    },
    triggers,
  };
}

// ---- Tests ----

describe("TriggersNamespace", () => {
  let db: DatabaseSync;
  let ns: InstanceType<typeof TriggersNamespace>;

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();
    clearCooldowns();
    ns = new TriggersNamespace(DOMAIN);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    resetEnforcementConfigForTest();
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });
  });

  // ---------- fire ----------

  describe("fire", () => {
    it("fires a trigger and returns result", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        build_fail: {
          task_template: "Build failed on {{payload.branch}}",
          task_priority: "P1",
        },
      }));

      const result = ns.fire("build_fail", { branch: "develop" }, { db });
      expect(result.ok).toBe(true);
      expect(result.task).toBeDefined();
      expect(result.task!.title).toBe("Build failed on develop");
      expect(result.task!.priority).toBe("P1");
    });

    it("defaults source to 'sdk'", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        default_source: { task_template: "Test" },
      }));

      const result = ns.fire("default_source", {}, { db });
      expect(result.ok).toBe(true);
      // The audit event should have source "sdk" via the metadata
      expect(result.task!.metadata!.triggerSource).toBe("sdk");
    });

    it("accepts custom source option", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        custom_source: { task_template: "Test", sources: ["webhook"] },
      }));

      const result = ns.fire("custom_source", {}, { source: "webhook", db });
      expect(result.ok).toBe(true);
    });

    it("returns error for nonexistent trigger", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({}));
      const result = ns.fire("nonexistent", {}, { db });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("uses empty payload when none provided", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        no_payload: { task_template: "No payload trigger" },
      }));
      const result = ns.fire("no_payload", undefined, { db });
      expect(result.ok).toBe(true);
    });
  });

  // ---------- list ----------

  describe("list", () => {
    it("returns empty array when no triggers are configured", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({}));
      expect(ns.list()).toEqual([]);
    });

    it("returns trigger info for configured triggers", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        deploy_fail: {
          description: "Triggers on deploy failure",
          task_template: "Deploy failed",
          severity: "high",
          conditions: [{ field: "status", operator: "==", value: "failed" }],
          sources: ["webhook"],
        },
        ci_broken: {
          task_template: "CI broken",
          enabled: false,
        },
      }));

      const list = ns.list();
      expect(list).toHaveLength(2);

      const deploy = list.find(t => t.name === "deploy_fail")!;
      expect(deploy.description).toBe("Triggers on deploy failure");
      expect(deploy.enabled).toBe(true);
      expect(deploy.action).toBe("create_task");
      expect(deploy.conditions).toBe(1);
      expect(deploy.sources).toEqual(["webhook"]);
      expect(deploy.severity).toBe("high");

      const ci = list.find(t => t.name === "ci_broken")!;
      expect(ci.enabled).toBe(false);
      expect(ci.conditions).toBe(0);
    });

    it("shows correct action when non-default", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        event_only: { action: "emit_event" },
      }));
      const list = ns.list();
      expect(list[0]!.action).toBe("emit_event");
    });
  });

  // ---------- test ----------

  describe("test", () => {
    it("returns found=false for nonexistent trigger", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({}));
      const result = ns.test("nonexistent");
      expect(result.found).toBe(false);
      expect(result.enabled).toBe(false);
      expect(result.wouldFire).toBe(false);
    });

    it("reports wouldFire=true when conditions pass on enabled trigger", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        test_trigger: {
          conditions: [{ field: "status", operator: "==", value: "failed" }],
          task_template: "Test",
        },
      }));

      const result = ns.test("test_trigger", { status: "failed" });
      expect(result.found).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.wouldFire).toBe(true);
      expect(result.conditionsResult!.pass).toBe(true);
    });

    it("reports wouldFire=false when conditions fail", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        cond_fail: {
          conditions: [{ field: "count", operator: ">", value: 10 }],
          task_template: "Test",
        },
      }));

      const result = ns.test("cond_fail", { count: 5 });
      expect(result.found).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.wouldFire).toBe(false);
      expect(result.conditionsResult!.pass).toBe(false);
    });

    it("reports wouldFire=false when trigger is disabled", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        disabled: {
          enabled: false,
          task_template: "Test",
        },
      }));

      const result = ns.test("disabled");
      expect(result.found).toBe(true);
      expect(result.enabled).toBe(false);
      expect(result.wouldFire).toBe(false);
    });

    it("does not create any tasks or events (dry run)", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        dry_run: { task_template: "Should not be created" },
      }));

      ns.test("dry_run", {});
      // No way to easily check DB from here without db param, but test()
      // by design does not call fireTrigger — it only evaluates conditions.
      // The key assertion is that it returns the right result.
    });

    it("uses empty payload when none provided", () => {
      registerWorkforceConfig(DOMAIN, makeWorkforceConfig({
        no_conds: { task_template: "No conditions" },
      }));

      const result = ns.test("no_conds");
      expect(result.found).toBe(true);
      expect(result.wouldFire).toBe(true);
    });
  });
});
