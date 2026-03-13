import { describe, expect, it } from "vitest";

describe("config hot-reload", () => {
  it("detects agent changes in global config", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = {
      agents: {
        bot: { extends: "employee", model: "old-model" },
      },
    };
    const newConfig = {
      agents: {
        bot: { extends: "employee", model: "new-model" },
      },
    };

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.changed).toBe(true);
    expect(diff.agentChanges).toContain("bot");
  });

  it("detects no changes when configs are identical", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const config = { agents: { bot: { extends: "employee" } } };
    const diff = diffConfigs(config, config);
    expect(diff.changed).toBe(false);
    expect(diff.agentChanges).toHaveLength(0);
  });

  it("detects added and removed agents", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = { agents: { a: { extends: "employee" }, b: { extends: "employee" } } };
    const newConfig = { agents: { a: { extends: "employee" }, c: { extends: "manager" } } };

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.changed).toBe(true);
    expect(diff.agentChanges).toContain("b"); // removed
    expect(diff.agentChanges).toContain("c"); // added
  });

  it("detects defaults changes", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = { agents: {}, defaults: { model: "old" } };
    const newConfig = { agents: {}, defaults: { model: "new" } };

    const diff = diffConfigs(oldConfig as any, newConfig as any);
    expect(diff.changed).toBe(true);
    expect(diff.defaultsChanged).toBe(true);
  });

  it("detects domain config changes", async () => {
    const { diffDomainConfigs } = await import("../../src/config/watcher.js");

    const oldDomain = { domain: "test", agents: ["a"], budget: { daily: 5 } } as any;
    const newDomain = { domain: "test", agents: ["a", "b"], budget: { daily: 10 } } as any;

    const diff = diffDomainConfigs(oldDomain, newDomain);
    expect(diff.changed).toBe(true);
    expect(diff.agentsAdded).toContain("b");
    expect(diff.budgetChanged).toBe(true);
  });

  it("detects removed agents in domain", async () => {
    const { diffDomainConfigs } = await import("../../src/config/watcher.js");

    const oldDomain = { domain: "test", agents: ["a", "b"] } as any;
    const newDomain = { domain: "test", agents: ["a"] } as any;

    const diff = diffDomainConfigs(oldDomain, newDomain);
    expect(diff.changed).toBe(true);
    expect(diff.agentsRemoved).toContain("b");
  });

  it("detects rules changes in domain", async () => {
    const { diffDomainConfigs } = await import("../../src/config/watcher.js");

    const oldDomain = { domain: "test", agents: ["a"] } as any;
    const newDomain = { domain: "test", agents: ["a"], rules: [{ name: "r1" }] } as any;

    const diff = diffDomainConfigs(oldDomain, newDomain);
    expect(diff.changed).toBe(true);
    expect(diff.rulesChanged).toBe(true);
  });
});
