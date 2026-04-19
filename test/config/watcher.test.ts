import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("config hot-reload", () => {
  it("detects agent changes in global config", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = {
      agents: {
        bot: { extends: "employee", persona: "old-persona" },
      },
    };
    const newConfig = {
      agents: {
        bot: { extends: "employee", persona: "new-persona" },
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

    const oldConfig = { agents: {}, defaults: { performance_policy: { action: "retry" } } };
    const newConfig = { agents: {}, defaults: { performance_policy: { action: "alert" } } };

    const diff = diffConfigs(oldConfig as any, newConfig as any);
    expect(diff.changed).toBe(true);
    expect(diff.defaultsChanged).toBe(true);
  });

  it("detects non-agent global changes", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = { agents: {}, adapter: "openclaw" };
    const newConfig = { agents: {}, adapter: "codex" };

    const diff = diffConfigs(oldConfig as any, newConfig as any);
    expect(diff.changed).toBe(true);
    expect(diff.otherChanged).toBe(true);
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

  it("detects manager changes in domain", async () => {
    const { diffDomainConfigs } = await import("../../src/config/watcher.js");

    const oldDomain = { domain: "test", agents: ["a"], manager: { agentId: "lead-a" } } as any;
    const newDomain = { domain: "test", agents: ["a"], manager: { agentId: "lead-b" } } as any;

    const diff = diffDomainConfigs(oldDomain, newDomain);
    expect(diff.changed).toBe(true);
    expect(diff.managerChanged).toBe(true);
  });

  it("loads a validated split-layout snapshot", async () => {
    const { loadConfigSnapshot } = await import("../../src/config/watcher.js");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-watcher-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), "agents:\n  lead:\n    extends: manager\n");
    fs.writeFileSync(path.join(tmpDir, "domains", "demo.yaml"), "domain: demo\nagents:\n  - lead\n");

    const snapshot = loadConfigSnapshot(tmpDir);
    expect(Object.keys(snapshot.global.agents)).toEqual(["lead"]);
    expect(snapshot.domains.get("demo")?.agents).toEqual(["lead"]);
  });

  it("marks added and removed domains in reload events", async () => {
    const { buildReloadEvent } = await import("../../src/config/watcher.js");

    const previous = {
      global: { agents: { lead: { extends: "manager" } } },
      domains: new Map(),
    };
    const next = {
      global: { agents: { lead: { extends: "manager" } } },
      domains: new Map([["demo", { domain: "demo", agents: ["lead"] }]]),
    };

    const added = buildReloadEvent(previous as any, next as any, { file: "demo.yaml", type: "domain", domainId: "demo" });
    expect(added.type).toBe("domain");
    expect((added.diff as any).domainAdded).toBe(true);
    expect((added.diff as any).agentsAdded).toEqual(["lead"]);

    const removed = buildReloadEvent(next as any, previous as any, { file: "demo.yaml", type: "domain", domainId: "demo" });
    expect((removed.diff as any).domainRemoved).toBe(true);
    expect((removed.diff as any).agentsRemoved).toEqual(["lead"]);
  });
});
