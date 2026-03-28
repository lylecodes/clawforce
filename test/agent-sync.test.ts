import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawAgentEntry,
  mergeAgentEntry,
  syncAgentsToOpenClaw,
  toNamespacedAgentId,
  parseNamespacedAgentId,
  isNamespacedAgentId,
  type OpenClawAgentEntry,
  type OpenClawConfigSubset,
} from "../src/agent-sync.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "employee",
    briefing: [{ source: "instructions" }],
    expectations: [],
    performance_policy: { action: "alert" },
    ...overrides,
  };
}

// --- buildOpenClawAgentEntry ---

describe("buildOpenClawAgentEntry", () => {
  it("maps title to name and identity.name", () => {
    const entry = buildOpenClawAgentEntry(
      "eng-lead",
      makeAgentConfig({ title: "VP of Engineering" }),
    );
    expect(entry.id).toBe("eng-lead");
    expect(entry.name).toBe("VP of Engineering");
    expect(entry.identity).toEqual({ name: "VP of Engineering" });
  });

  it("does not set model (model lives in OpenClaw config, not Clawforce)", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig(),
    );
    expect(entry.model).toBeUndefined();
  });

  it("maps projectDir to workspace", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig(),
      "/home/user/project",
    );
    expect(entry.workspace).toBe("/home/user/project");
  });

  it("sets subagents.allowAgents for manager role", () => {
    const entry = buildOpenClawAgentEntry(
      "mgr",
      makeAgentConfig({ extends: "manager", coordination: { enabled: true } }),
    );
    expect(entry.subagents).toEqual({ allowAgents: ["*"] });
  });

  it("does not set subagents for non-manager roles", () => {
    const entry = buildOpenClawAgentEntry(
      "worker",
      makeAgentConfig({ extends: "employee" }),
    );
    expect(entry.subagents).toBeUndefined();
  });

  it("handles minimal config (just id)", () => {
    const entry = buildOpenClawAgentEntry("bare", makeAgentConfig());
    expect(entry.id).toBe("bare");
    expect(entry.name).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.workspace).toBeUndefined();
    expect(entry.identity).toBeUndefined();
  });
});

// --- mergeAgentEntry ---

describe("mergeAgentEntry", () => {
  it("preserves all existing user fields (user-wins)", () => {
    const existing: OpenClawAgentEntry = {
      id: "agent1",
      name: "Custom Name",
      model: "my-custom-model",
      workspace: "/custom/path",
    };
    const incoming: OpenClawAgentEntry = {
      id: "agent1",
      name: "Auto Name",
      model: { primary: "claude-opus-4-6" },
      workspace: "/auto/path",
      identity: { name: "Auto Name" },
    };
    const merged = mergeAgentEntry(existing, incoming);

    expect(merged.name).toBe("Custom Name");
    // model is in CLAWFORCE_WINS — incoming (ClawForce) wins over existing user config
    expect(merged.model).toEqual({ primary: "claude-opus-4-6" });
    expect(merged.workspace).toBe("/custom/path");
    // identity was missing in existing, so it gets filled
    expect(merged.identity).toEqual({ name: "Auto Name" });
  });

  it("fills in missing fields from incoming", () => {
    const existing: OpenClawAgentEntry = { id: "agent1" };
    const incoming: OpenClawAgentEntry = {
      id: "agent1",
      name: "Bot",
      model: { primary: "gpt-4o" },
      identity: { name: "Bot" },
    };
    const merged = mergeAgentEntry(existing, incoming);

    expect(merged.name).toBe("Bot");
    expect(merged.model).toEqual({ primary: "gpt-4o" });
    expect(merged.identity).toEqual({ name: "Bot" });
  });

  it("empty existing entry gets fully populated", () => {
    const existing: OpenClawAgentEntry = { id: "x" };
    const incoming: OpenClawAgentEntry = {
      id: "x",
      name: "X Agent",
      workspace: "/ws",
      subagents: { allowAgents: ["*"] },
    };
    const merged = mergeAgentEntry(existing, incoming);

    expect(merged).toEqual({
      id: "x",
      name: "X Agent",
      workspace: "/ws",
      subagents: { allowAgents: ["*"] },
    });
  });
});

// --- CLAWFORCE_WINS behavior ---

describe("CLAWFORCE_WINS fields", () => {
  it("model in CLAWFORCE_WINS always overrides existing OpenClaw value", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      model: "user-preferred-model",
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      model: { primary: "anthropic/claude-opus-4-6" },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });

  it("model is overridden even when existing has a complex model object", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      model: { primary: "old-model", fallbacks: ["fallback1"] },
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      model: { primary: "new-model" },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.model).toEqual({ primary: "new-model" });
  });

  it("model is NOT overridden when incoming model is undefined", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      model: "user-preferred-model",
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.model).toBe("user-preferred-model");
  });
});

describe("non-CLAWFORCE_WINS fields (user-wins)", () => {
  it("name preserves existing user value", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      name: "User Custom Name",
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      name: "ClawForce Auto Name",
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.name).toBe("User Custom Name");
  });

  it("workspace preserves existing user value", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      workspace: "/user/custom/path",
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      workspace: "/clawforce/auto/path",
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.workspace).toBe("/user/custom/path");
  });

  it("identity preserves existing user value", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      identity: { name: "Custom Identity", emoji: "🤖" },
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      identity: { name: "Auto Identity" },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.identity).toEqual({ name: "Custom Identity", emoji: "🤖" });
  });

  it("subagents preserves existing user value", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      subagents: { allowAgents: ["agent-a", "agent-b"] },
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      subagents: { allowAgents: ["*"] },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.subagents).toEqual({ allowAgents: ["agent-a", "agent-b"] });
  });
});

// --- buildOpenClawAgentEntry additional coverage ---

describe("buildOpenClawAgentEntry — extended", () => {
  it("maps title to both name and identity.name", () => {
    const entry = buildOpenClawAgentEntry(
      "lead",
      makeAgentConfig({ title: "Team Lead" }),
    );
    expect(entry.name).toBe("Team Lead");
    expect(entry.identity).toEqual({ name: "Team Lead" });
  });

  it("maps coordination.enabled to subagents (even without manager extends)", () => {
    const entry = buildOpenClawAgentEntry(
      "coordinator",
      makeAgentConfig({ extends: "employee", coordination: { enabled: true } }),
    );
    expect(entry.subagents).toEqual({ allowAgents: ["*"] });
  });

  it("maps model string to model.primary", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig({ model: "anthropic/claude-sonnet-4-6" }),
    );
    expect(entry.model).toEqual({ primary: "anthropic/claude-sonnet-4-6" });
  });

  it("does not set model when agent has no model", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig({}),
    );
    expect(entry.model).toBeUndefined();
  });

  it("does not set name or identity when title is missing", () => {
    const entry = buildOpenClawAgentEntry(
      "bare",
      makeAgentConfig({}),
    );
    expect(entry.name).toBeUndefined();
    expect(entry.identity).toBeUndefined();
  });

  it("does not set workspace when projectDir is missing", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig({}),
    );
    expect(entry.workspace).toBeUndefined();
  });
});

// --- mergeAgentEntry — extended ---

describe("mergeAgentEntry — extended", () => {
  it("merge with empty incoming (except id) returns existing unchanged", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      name: "Bot",
      workspace: "/ws",
      model: "my-model",
    };
    const incoming: OpenClawAgentEntry = { id: "bot1" };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged).toEqual(existing);
  });

  it("merge with empty existing fills all incoming fields", () => {
    const existing: OpenClawAgentEntry = { id: "bot1" };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      name: "Auto Bot",
      workspace: "/auto",
      model: { primary: "opus" },
      identity: { name: "Auto Bot" },
      subagents: { allowAgents: ["*"] },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.name).toBe("Auto Bot");
    expect(merged.workspace).toBe("/auto");
    expect(merged.model).toEqual({ primary: "opus" });
    expect(merged.identity).toEqual({ name: "Auto Bot" });
    expect(merged.subagents).toEqual({ allowAgents: ["*"] });
  });

  it("preserves extra fields on existing entry that are not in incoming", () => {
    const existing: OpenClawAgentEntry = {
      id: "bot1",
      name: "Bot",
      customField: "preserved",
      anotherField: 42,
    };
    const incoming: OpenClawAgentEntry = {
      id: "bot1",
      model: { primary: "new" },
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.customField).toBe("preserved");
    expect(merged.anotherField).toBe(42);
    expect(merged.model).toEqual({ primary: "new" });
  });

  it("id always comes from existing", () => {
    const existing: OpenClawAgentEntry = { id: "original-id" };
    const incoming: OpenClawAgentEntry = { id: "different-id", name: "Bot" };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.id).toBe("original-id");
  });
});

// --- syncAgentsToOpenClaw ---

describe("syncAgentsToOpenClaw", () => {
  function makeMocks(initialConfig: OpenClawConfigSubset = {}) {
    const config = structuredClone(initialConfig);
    const loadConfig = vi.fn(() => config);
    const writeConfigFile = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn() };
    return { config, loadConfig, writeConfigFile, logger };
  }

  it("first sync creates agents in empty config", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bot1", config: makeAgentConfig({ title: "Bot One" }) },
        { agentId: "bot2", config: makeAgentConfig({ extends: "manager", coordination: { enabled: true }, title: "Manager" }), projectDir: "/proj" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);

    const written = writeConfigFile.mock.calls[0]![0] as OpenClawConfigSubset;
    expect(written.agents!.list).toHaveLength(2);
    expect(written.agents!.list![0]!.id).toBe("bot1");
    expect(written.agents!.list![0]!.name).toBe("Bot One");
    expect(written.agents!.list![1]!.id).toBe("bot2");
    expect(written.agents!.list![1]!.subagents).toEqual({ allowAgents: ["*"] });
    expect(written.agents!.list![1]!.workspace).toBe("/proj");
  });

  it("idempotent re-sync skips and does not write", async () => {
    const existingConfig: OpenClawConfigSubset = {
      agents: {
        list: [
          { id: "bot1", name: "Bot One", identity: { name: "Bot One" } },
        ],
      },
    };
    const { loadConfig, writeConfigFile, logger } = makeMocks(existingConfig);

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bot1", config: makeAgentConfig({ title: "Bot One" }) },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("merge preserves existing customizations", async () => {
    const existingConfig: OpenClawConfigSubset = {
      agents: {
        list: [
          { id: "bot1", name: "My Custom Name", model: "custom-model" },
        ],
      },
    };
    const { loadConfig, writeConfigFile, logger } = makeMocks(existingConfig);

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bot1", config: makeAgentConfig({ title: "Auto Name" }), projectDir: "/ws" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    // workspace was missing, so it should be filled in → counts as synced
    expect(result.synced).toBe(1);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);

    const written = writeConfigFile.mock.calls[0]![0] as OpenClawConfigSubset;
    const agent = written.agents!.list![0]!;
    expect(agent.name).toBe("My Custom Name"); // preserved
    expect(agent.model).toBe("custom-model"); // preserved
    expect(agent.workspace).toBe("/ws"); // filled in
    expect(agent.identity).toEqual({ name: "Auto Name" }); // filled in
  });

  it("error in one agent does not block others", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    // Monkey-patch loadConfig to return config, but make one agent blow up
    // by using a getter that throws on a specific property access
    const badConfig = makeAgentConfig({ title: "Good" });
    const goodConfig = makeAgentConfig({ title: "Also Good" });

    // Simulate an error by passing a config where buildOpenClawAgentEntry will throw
    const throwingConfig = new Proxy(badConfig, {
      get(target, prop) {
        if (prop === "title") throw new Error("bad agent config");
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bad-bot", config: throwingConfig as AgentConfig },
        { agentId: "good-bot", config: goodConfig },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad-bot");
    expect(result.synced).toBe(1); // good-bot still synced
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("empty agents list is a no-op", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    const result = await syncAgentsToOpenClaw({
      agents: [],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("config write failure caught gracefully", async () => {
    const { loadConfig, logger } = makeMocks({});
    const writeConfigFile = vi.fn(async () => { throw new Error("disk full"); });

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bot1", config: makeAgentConfig({ title: "Bot" }) },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(1); // it was synced in memory
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("disk full");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("config load failure caught gracefully", async () => {
    const loadConfig = vi.fn(() => { throw new Error("config corrupt"); });
    const writeConfigFile = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "bot1", config: makeAgentConfig({ title: "Bot" }) },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("config corrupt");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });
});

// --- Namespace utilities ---

describe("toNamespacedAgentId", () => {
  it("builds domain:agentId format", () => {
    expect(toNamespacedAgentId("demo-company", "backend")).toBe("demo-company:backend");
  });

  it("returns as-is when already namespaced with the same domain", () => {
    expect(toNamespacedAgentId("demo-company", "demo-company:backend")).toBe("demo-company:backend");
  });

  it("double-namespaces when domain differs", () => {
    // This is correct — if you pass a different domain, it wraps again
    expect(toNamespacedAgentId("other", "demo-company:backend")).toBe("other:demo-company:backend");
  });
});

describe("parseNamespacedAgentId", () => {
  it("parses domain:agentId into parts", () => {
    const result = parseNamespacedAgentId("demo-company:backend");
    expect(result).toEqual({ domain: "demo-company", agentId: "backend" });
  });

  it("returns null for bare IDs (no separator)", () => {
    expect(parseNamespacedAgentId("backend")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseNamespacedAgentId("")).toBeNull();
  });

  it("returns null for trailing colon", () => {
    expect(parseNamespacedAgentId("domain:")).toBeNull();
  });

  it("returns null for leading colon", () => {
    expect(parseNamespacedAgentId(":agentId")).toBeNull();
  });

  it("handles multi-colon IDs (parses on first colon)", () => {
    const result = parseNamespacedAgentId("domain:agent:extra");
    expect(result).toEqual({ domain: "domain", agentId: "agent:extra" });
  });
});

describe("isNamespacedAgentId", () => {
  it("returns true for namespaced IDs", () => {
    expect(isNamespacedAgentId("demo-company:backend")).toBe(true);
  });

  it("returns false for bare IDs", () => {
    expect(isNamespacedAgentId("backend")).toBe(false);
  });

  it("returns false for leading colon", () => {
    expect(isNamespacedAgentId(":backend")).toBe(false);
  });

  it("returns false for trailing colon", () => {
    expect(isNamespacedAgentId("domain:")).toBe(false);
  });
});

// --- buildOpenClawAgentEntry with domain ---

describe("buildOpenClawAgentEntry — namespace isolation", () => {
  it("namespaces agent ID when domain is provided", () => {
    const entry = buildOpenClawAgentEntry(
      "backend",
      makeAgentConfig({ title: "Backend Dev" }),
      "/proj",
      "demo-company",
    );
    expect(entry.id).toBe("demo-company:backend");
    expect(entry.clawforce_domain).toBe("demo-company");
    expect(entry.name).toBe("Backend Dev");
  });

  it("does not namespace when domain is omitted", () => {
    const entry = buildOpenClawAgentEntry(
      "backend",
      makeAgentConfig({ title: "Backend Dev" }),
    );
    expect(entry.id).toBe("backend");
    expect(entry.clawforce_domain).toBeUndefined();
  });

  it("clawforce-dev domain namespaces correctly", () => {
    const entry = buildOpenClawAgentEntry(
      "cf-lead",
      makeAgentConfig({ extends: "manager", coordination: { enabled: true }, title: "CF Lead" }),
      "/clawforce",
      "clawforce-dev",
    );
    expect(entry.id).toBe("clawforce-dev:cf-lead");
    expect(entry.clawforce_domain).toBe("clawforce-dev");
    expect(entry.subagents).toEqual({ allowAgents: ["*"] });
  });

  it("preserves all other fields when domain is provided", () => {
    const entry = buildOpenClawAgentEntry(
      "coder",
      makeAgentConfig({ model: "anthropic/claude-sonnet-4-6", allowedTools: ["Read", "Write"] }),
      "/workspace",
      "my-domain",
    );
    expect(entry.id).toBe("my-domain:coder");
    expect(entry.workspace).toBe("/workspace");
    expect(entry.model).toEqual({ primary: "anthropic/claude-sonnet-4-6" });
    expect(entry.allowedTools).toEqual(["Read", "Write"]);
    expect(entry.clawforce_domain).toBe("my-domain");
  });
});

// --- syncAgentsToOpenClaw with domain namespacing ---

describe("syncAgentsToOpenClaw — namespace isolation", () => {
  function makeMocks(initialConfig: OpenClawConfigSubset = {}) {
    const config = structuredClone(initialConfig);
    const loadConfig = vi.fn(() => config);
    const writeConfigFile = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn() };
    return { config, loadConfig, writeConfigFile, logger };
  }

  it("syncs agents with namespaced IDs when domain is provided", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "backend", config: makeAgentConfig({ title: "Backend" }), domain: "demo-company" },
        { agentId: "frontend", config: makeAgentConfig({ title: "Frontend" }), domain: "demo-company" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(2);
    expect(result.collisions).toHaveLength(0);
    const written = writeConfigFile.mock.calls[0]![0] as OpenClawConfigSubset;
    expect(written.agents!.list![0]!.id).toBe("demo-company:backend");
    expect(written.agents!.list![0]!.clawforce_domain).toBe("demo-company");
    expect(written.agents!.list![1]!.id).toBe("demo-company:frontend");
  });

  it("agents from different domains do not collide", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "backend", config: makeAgentConfig({ title: "Backend A" }), domain: "company-a" },
        { agentId: "backend", config: makeAgentConfig({ title: "Backend B" }), domain: "company-b" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.synced).toBe(2);
    expect(result.collisions).toHaveLength(0);
    const written = writeConfigFile.mock.calls[0]![0] as OpenClawConfigSubset;
    expect(written.agents!.list).toHaveLength(2);
    expect(written.agents!.list![0]!.id).toBe("company-a:backend");
    expect(written.agents!.list![1]!.id).toBe("company-b:backend");
  });

  it("detects collision when namespaced ID exists from different domain", async () => {
    const existingConfig: OpenClawConfigSubset = {
      agents: {
        list: [
          { id: "shared:backend", clawforce_domain: "domain-a", name: "Backend A" },
        ],
      },
    };
    const { loadConfig, writeConfigFile, logger } = makeMocks(existingConfig);

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "backend", config: makeAgentConfig({ title: "Backend B" }), domain: "shared" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    // The incoming agent has domain "shared" which produces "shared:backend"
    // The existing entry has id "shared:backend" but clawforce_domain "domain-a"
    // This is a cross-domain collision
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toContain("domain-a");
    expect(result.skipped).toBe(1);
    expect(result.synced).toBe(0);
    // Should NOT overwrite the existing entry
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("same domain re-sync merges normally (no collision)", async () => {
    const existingConfig: OpenClawConfigSubset = {
      agents: {
        list: [
          { id: "demo:backend", clawforce_domain: "demo", name: "Old Name" },
        ],
      },
    };
    const { loadConfig, writeConfigFile, logger } = makeMocks(existingConfig);

    const result = await syncAgentsToOpenClaw({
      agents: [
        { agentId: "backend", config: makeAgentConfig({ title: "New Name" }), projectDir: "/ws", domain: "demo" },
      ],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.collisions).toHaveLength(0);
    expect(result.synced).toBe(1); // workspace was filled in
    const written = writeConfigFile.mock.calls[0]![0] as OpenClawConfigSubset;
    expect(written.agents!.list![0]!.name).toBe("Old Name"); // user-wins
    expect(written.agents!.list![0]!.workspace).toBe("/ws"); // filled in
    expect(written.agents!.list![0]!.clawforce_domain).toBe("demo"); // domain preserved
  });

  it("result.collisions is empty array when no collisions", async () => {
    const { loadConfig, writeConfigFile, logger } = makeMocks({});

    const result = await syncAgentsToOpenClaw({
      agents: [],
      loadConfig,
      writeConfigFile,
      logger,
    });

    expect(result.collisions).toHaveLength(0);
  });
});
