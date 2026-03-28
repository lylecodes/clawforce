import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenClawAgentEntry,
  mergeAgentEntry,
  syncAgentsToOpenClaw,
  cleanupBootstrapFiles,
  cleanupAllBootstrapFiles,
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

// --- CO-1: Bootstrap config propagation ---

describe("CO-1: bootstrapConfig propagation", () => {
  it("maps bootstrapConfig to OpenClaw agent entry", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig({
        bootstrapConfig: { maxChars: 8000, totalMaxChars: 30000 },
      }),
    );
    expect(entry.bootstrapMaxChars).toBe(8000);
    expect(entry.bootstrapTotalMaxChars).toBe(30000);
  });

  it("omits bootstrapConfig fields when not set", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig(),
    );
    expect(entry.bootstrapMaxChars).toBeUndefined();
    expect(entry.bootstrapTotalMaxChars).toBeUndefined();
  });

  it("partial bootstrapConfig only sets defined fields", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig({
        bootstrapConfig: { maxChars: 5000 },
      }),
    );
    expect(entry.bootstrapMaxChars).toBe(5000);
    expect(entry.bootstrapTotalMaxChars).toBeUndefined();
  });

  it("bootstrapConfig wins over existing in merge (ClawForce-wins)", () => {
    const existing: OpenClawAgentEntry = {
      id: "worker1",
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 150000,
    };
    const incoming: OpenClawAgentEntry = {
      id: "worker1",
      bootstrapMaxChars: 8000,
      bootstrapTotalMaxChars: 30000,
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.bootstrapMaxChars).toBe(8000);
    expect(merged.bootstrapTotalMaxChars).toBe(30000);
  });
});

// --- CO-2: Bootstrap file cleanup ---

describe("CO-2: cleanupBootstrapFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  function setupTmpDir(files: string[]): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    for (const f of files) {
      fs.writeFileSync(path.join(tmpDir, f), `# ${f}\nTest content`, "utf-8");
    }
    return tmpDir;
  }

  it("deletes excluded bootstrap files that exist", () => {
    const dir = setupTmpDir(["AGENTS.md", "HEARTBEAT.md", "SOUL.md"]);
    const result = cleanupBootstrapFiles(dir, ["AGENTS.md", "HEARTBEAT.md"]);

    expect(result.deleted).toEqual(["AGENTS.md", "HEARTBEAT.md"]);
    expect(result.errors).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "HEARTBEAT.md"))).toBe(false);
    // SOUL.md should be preserved
    expect(fs.existsSync(path.join(dir, "SOUL.md"))).toBe(true);
  });

  it("skips non-existent files without error", () => {
    const dir = setupTmpDir(["SOUL.md"]);
    const result = cleanupBootstrapFiles(dir, ["AGENTS.md", "IDENTITY.md"]);

    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-bootstrap filenames (safety)", () => {
    const dir = setupTmpDir(["README.md", "package.json"]);
    const result = cleanupBootstrapFiles(dir, ["README.md", "package.json", "../../etc/passwd"]);

    expect(result.deleted).toHaveLength(0);
    expect(result.skipped).toEqual(["README.md", "package.json", "../../etc/passwd"]);
    // Files should still exist
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true);
  });

  it("handles all standard bootstrap file names", () => {
    const allFiles = ["AGENTS.md", "IDENTITY.md", "HEARTBEAT.md", "BOOTSTRAP.md", "USER.md", "TOOLS.md", "MEMORY.md", "MEMORIES.md"];
    const dir = setupTmpDir(allFiles);
    const result = cleanupBootstrapFiles(dir, allFiles);

    expect(result.deleted).toEqual(allFiles);
    for (const f of allFiles) {
      expect(fs.existsSync(path.join(dir, f))).toBe(false);
    }
  });
});

describe("CO-2: cleanupAllBootstrapFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it("cleans up bootstrap files for agents with excludes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-batch-"));
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "test", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "HEARTBEAT.md"), "test", "utf-8");

    const result = cleanupAllBootstrapFiles([
      {
        agentId: "worker",
        config: makeAgentConfig({
          bootstrapExcludeFiles: ["AGENTS.md", "HEARTBEAT.md"],
        }),
        projectDir: tmpDir,
      },
      {
        agentId: "no-exclude",
        config: makeAgentConfig(),
        projectDir: tmpDir,
      },
    ]);

    expect(result.deleted).toEqual(["worker:AGENTS.md", "worker:HEARTBEAT.md"]);
  });

  it("skips agents without projectDir", () => {
    const result = cleanupAllBootstrapFiles([
      {
        agentId: "no-dir",
        config: makeAgentConfig({
          bootstrapExcludeFiles: ["AGENTS.md"],
        }),
        // no projectDir
      },
    ]);

    expect(result.deleted).toHaveLength(0);
  });
});

// --- CO-3: Allowed tools propagation ---

describe("CO-3: allowedTools propagation", () => {
  it("maps allowedTools to OpenClaw agent entry", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig({
        allowedTools: ["Bash", "Read", "Edit", "Write", "WebSearch"],
      }),
    );
    expect(entry.allowedTools).toEqual(["Bash", "Read", "Edit", "Write", "WebSearch"]);
  });

  it("omits allowedTools when not set", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig(),
    );
    expect(entry.allowedTools).toBeUndefined();
  });

  it("empty allowedTools is not propagated", () => {
    const entry = buildOpenClawAgentEntry(
      "worker1",
      makeAgentConfig({ allowedTools: [] }),
    );
    expect(entry.allowedTools).toBeUndefined();
  });

  it("allowedTools wins over existing in merge (ClawForce-wins)", () => {
    const existing: OpenClawAgentEntry = {
      id: "worker1",
      allowedTools: ["Bash", "Read", "Edit", "Write", "WebSearch", "WebFetch"],
    };
    const incoming: OpenClawAgentEntry = {
      id: "worker1",
      allowedTools: ["Bash", "Read", "WebSearch"],
    };
    const merged = mergeAgentEntry(existing, incoming);
    expect(merged.allowedTools).toEqual(["Bash", "Read", "WebSearch"]);
  });
});
