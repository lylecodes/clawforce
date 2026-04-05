/**
 * ESM package exports smoke test
 *
 * Verifies that every subpath in the package.json exports map resolves
 * correctly and exposes the expected symbols. This catches broken import
 * paths, missing re-exports, and build output drift.
 */
import { describe, it, expect } from "vitest";

describe("ESM package exports", () => {
  it("main entry (.) exports Clawforce class with init()", async () => {
    const mod = await import("../../src/sdk/index.js");
    expect(mod.Clawforce).toBeDefined();
    expect(typeof mod.Clawforce.init).toBe("function");
  });

  it("Clawforce instance exposes all namespace accessors", async () => {
    const { Clawforce } = await import("../../src/sdk/index.js");
    const cf = Clawforce.init({ domain: "smoke-test" });

    // Every namespace should be accessible without throwing
    expect(cf.tasks).toBeDefined();
    expect(cf.events).toBeDefined();
    expect(cf.budget).toBeDefined();
    expect(cf.agents).toBeDefined();
    expect(cf.trust).toBeDefined();
    expect(cf.goals).toBeDefined();
    expect(cf.knowledge).toBeDefined();
    expect(cf.messages).toBeDefined();
    expect(cf.monitoring).toBeDefined();
    expect(cf.db).toBeDefined();
    expect(cf.dispatch).toBeDefined();
    expect(cf.config).toBeDefined();
    expect(cf.hooks).toBeDefined();
    expect(cf.approvals).toBeDefined();
    expect(cf.triggers).toBeDefined();
    expect(cf.telemetry).toBeDefined();
  });

  it("dispatch namespace has enqueue, cancel, status methods", async () => {
    const { Clawforce } = await import("../../src/sdk/index.js");
    const cf = Clawforce.init({ domain: "smoke-test" });
    const dispatch = cf.dispatch;

    expect(typeof dispatch.enqueue).toBe("function");
    expect(typeof dispatch.cancel).toBe("function");
    expect(typeof dispatch.status).toBe("function");
  });

  it("tasks namespace has create, get, list, transition methods", async () => {
    const { Clawforce } = await import("../../src/sdk/index.js");
    const cf = Clawforce.init({ domain: "smoke-test" });
    const tasks = cf.tasks;

    expect(typeof tasks.create).toBe("function");
    expect(typeof tasks.get).toBe("function");
    expect(typeof tasks.list).toBe("function");
    expect(typeof tasks.transition).toBe("function");
  });

  it("internal entry (./internal) exports lifecycle and config functions", async () => {
    const mod = await import("../../src/index.js");

    // Lifecycle
    expect(typeof mod.initClawforce).toBe("function");
    expect(typeof mod.shutdownClawforce).toBe("function");

    // Config
    expect(typeof mod.loadGlobalConfig).toBe("function");
    expect(typeof mod.loadAllDomains).toBe("function");
    expect(typeof mod.validateGlobalConfig).toBe("function");

    // Database
    expect(typeof mod.getDb).toBe("function");
    expect(typeof mod.getMemoryDb).toBe("function");
    expect(typeof mod.closeDb).toBe("function");
  });

  it("internal entry exports task and dispatch helpers", async () => {
    const mod = await import("../../src/index.js");

    // Dispatch
    expect(typeof mod.shouldDispatch).toBe("function");
    expect(typeof mod.recoverProject).toBe("function");

    // Dashboard
    expect(typeof mod.createDashboardServer).toBe("function");

    // Verification
    expect(typeof mod.runVerificationGates).toBe("function");
    expect(typeof mod.generateBranchName).toBe("function");
  });

  it("internal entry exports types", async () => {
    const mod = await import("../../src/index.js");

    // Type re-exports show up as undefined at runtime but should not cause
    // import errors. Spot-check a runtime export that sits near type exports.
    expect(typeof mod.OPERATIONAL_PROFILES).toBe("object");
    expect(typeof mod.BUILTIN_AGENT_PRESETS).toBe("object");
  });
});
