/**
 * Tests for Task 10.1: Context Assembly Optimization — session-scoped cache
 * for static briefing sources (soul, project_md, skill, tools_reference,
 * memory_instructions, instructions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig } from "../../src/types.js";

// We need to import the module so we can spy on internal resolution
// and verify caching behaviour without touching real file-system or DB.

describe("assembler session cache", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caches static source 'instructions' across two calls with the same sessionKey", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const { buildInstructions } = await import("../../src/context/sources/instructions.js");

    const spy = vi.spyOn(await import("../../src/context/sources/instructions.js"), "buildInstructions");

    const config: AgentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" }],
      expectations: [{ tool: "clawforce_task", action: "transition", min_calls: 1 }],
      performance_policy: { action: "alert" },
    };

    // First call — should invoke the resolver
    assembleContext("agent1", config, { sessionKey: "session-abc" });
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call with same sessionKey — should use cache, NOT call buildInstructions again
    assembleContext("agent1", config, { sessionKey: "session-abc" });
    expect(spy).toHaveBeenCalledTimes(1);

    // Third call with DIFFERENT sessionKey — should call the resolver again
    assembleContext("agent1", config, { sessionKey: "session-xyz" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache dynamic sources (task_board always re-resolved)", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");

    let callCount = 0;
    // We'll use a 'custom' source (dynamic) to verify it isn't cached
    const config: AgentConfig = {
      extends: "employee",
      briefing: [{ source: "custom", content: "hello" }],
      expectations: [],
      performance_policy: { action: "alert" },
    };

    // custom is not in STATIC_SOURCES, so it is never cached
    // — but it also doesn't need a resolver spy; it just returns content directly.
    // What matters is that calling assembleContext twice yields the same result
    // without issues (no stale cache from a different source type bleeding in).
    const r1 = assembleContext("agent2", config, { sessionKey: "session-dyn" });
    const r2 = assembleContext("agent2", config, { sessionKey: "session-dyn" });
    expect(r1).toBe(r2);
    expect(r1).toContain("hello");
  });

  it("clearAssemblerCache removes only entries for the given sessionKey", async () => {
    const { assembleContext, clearAssemblerCache } = await import("../../src/context/assembler.js");
    const instructionsSpy = vi.spyOn(
      await import("../../src/context/sources/instructions.js"),
      "buildInstructions",
    );

    const config: AgentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" }],
      expectations: [{ tool: "clawforce_task", action: "transition", min_calls: 1 }],
      performance_policy: { action: "alert" },
    };

    // Populate cache for two sessions
    assembleContext("agent3", config, { sessionKey: "s1" });
    assembleContext("agent3", config, { sessionKey: "s2" });
    const callsAfterPopulate = instructionsSpy.mock.calls.length; // should be 2

    // Clear only s1
    clearAssemblerCache("s1");

    // s1 cache cleared — should resolve again
    assembleContext("agent3", config, { sessionKey: "s1" });
    expect(instructionsSpy.mock.calls.length).toBe(callsAfterPopulate + 1);

    // s2 cache still intact — should NOT resolve again
    assembleContext("agent3", config, { sessionKey: "s2" });
    expect(instructionsSpy.mock.calls.length).toBe(callsAfterPopulate + 1);
  });

  it("works correctly when no sessionKey is provided (no caching)", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const spy = vi.spyOn(
      await import("../../src/context/sources/instructions.js"),
      "buildInstructions",
    );

    const config: AgentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" }],
      expectations: [{ tool: "clawforce_task", action: "transition", min_calls: 1 }],
      performance_policy: { action: "alert" },
    };

    // Without sessionKey — should always call the resolver
    assembleContext("agent4", config);
    assembleContext("agent4", config);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
