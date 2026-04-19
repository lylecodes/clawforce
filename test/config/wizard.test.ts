import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("init wizard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-wizard-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds a new clawforce config directory", async () => {
    const { scaffoldConfigDir } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "domains"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "data"))).toBe(true);

    // config.yaml should have empty agents
    const content = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(content).toContain("agents");
  });

  it("scaffolding is idempotent", async () => {
    const { scaffoldConfigDir } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    // Write something to config
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), "agents:\n  bot:\n    extends: employee\n");

    // Scaffold again — should NOT overwrite
    scaffoldConfigDir(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(content).toContain("bot");
  });

  it("creates a new domain via initDomain", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, {
      name: "rentright",
      paths: ["~/workplace/rentright-api"],
      managerAgentId: "lyle-pa",
      agents: ["compliance-bot"],
    });

    const domainPath = path.join(tmpDir, "domains", "rentright.yaml");
    expect(fs.existsSync(domainPath)).toBe(true);
    const content = fs.readFileSync(domainPath, "utf-8");
    expect(content).toContain("domain: rentright");
    expect(content).toContain("compliance-bot");
    expect(content).toContain("lyle-pa");
    expect(content).toContain("~/workplace/rentright-api");
  });

  it("adds agent to global config if not present", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, {
      name: "test",
      agents: ["new-agent"],
      agentPresets: { "new-agent": "employee" },
    });

    const globalConfig = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(globalConfig).toContain("new-agent");
    expect(globalConfig).toContain("employee");
  });

  it("does not overwrite existing agent in global config", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    // Pre-add agent with custom model
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  existing-bot:",
      "    extends: manager",
      "    model: custom-model",
    ].join("\n"));

    initDomain(tmpDir, {
      name: "test",
      agents: ["existing-bot"],
      agentPresets: { "existing-bot": "employee" }, // tries to set as employee
    });

    const globalConfig = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(globalConfig).toContain("manager"); // keeps manager, not overwritten to employee
    expect(globalConfig).toContain("custom-model");
  });

  it("does not overwrite existing domain", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, { name: "existing", agents: ["a"] });

    expect(() => {
      initDomain(tmpDir, { name: "existing", agents: ["b"] });
    }).toThrow(/already exists/);
  });

  // --- Extended wizard operations ---

  it("updates domain fields via updateDomain", async () => {
    const { scaffoldConfigDir, initDomain, updateDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, { name: "proj", agents: ["a"] });

    updateDomain(tmpDir, "proj", {
      updates: { manager: { enabled: true, agentId: "a" }, paths: ["~/new-path"] },
    });

    const content = fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8");
    expect(content).toContain("agentId: a");
    expect(content).toContain("~/new-path");
    expect(content).toContain("domain: proj"); // preserved
  });

  it("updateDomain preserves existing fields", async () => {
    const { scaffoldConfigDir, initDomain, updateDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, { name: "proj", agents: ["a"], managerAgentId: "a" });

    updateDomain(tmpDir, "proj", { updates: { paths: ["~/x"] } });

    const YAML = (await import("yaml")).default;
    const content = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8"));
    expect(content.manager).toEqual({ enabled: true, agentId: "a" });
    expect(content.paths).toEqual(["~/x"]);
  });

  it("updateDomain throws for non-existent domain", async () => {
    const { scaffoldConfigDir, updateDomain } = await import("../../src/config/wizard.js");
    scaffoldConfigDir(tmpDir);

    expect(() => {
      updateDomain(tmpDir, "ghost", { updates: {} });
    }).toThrow(/does not exist/);
  });

  it("deletes domain via deleteDomain", async () => {
    const { scaffoldConfigDir, initDomain, deleteDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, { name: "doomed", agents: ["a"] });

    deleteDomain(tmpDir, "doomed");
    expect(fs.existsSync(path.join(tmpDir, "domains", "doomed.yaml"))).toBe(false);
  });

  it("deleteDomain throws for non-existent domain", async () => {
    const { scaffoldConfigDir, deleteDomain } = await import("../../src/config/wizard.js");
    scaffoldConfigDir(tmpDir);

    expect(() => {
      deleteDomain(tmpDir, "ghost");
    }).toThrow(/does not exist/);
  });

  it("adds agent to global config via addAgentToGlobal", async () => {
    const { scaffoldConfigDir, addAgentToGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    const added = addAgentToGlobal(tmpDir, "new-bot", { extends: "employee", title: "Worker" });

    expect(added).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(content).toContain("new-bot");
    expect(content).toContain("employee");
  });

  it("addAgentToGlobal is idempotent without force", async () => {
    const { scaffoldConfigDir, addAgentToGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "manager" });
    const secondAdd = addAgentToGlobal(tmpDir, "bot", { extends: "employee" });

    expect(secondAdd).toBe(false); // did not overwrite
    const YAML = (await import("yaml")).default;
    const config = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(config.agents.bot.extends).toBe("manager"); // original preserved
  });

  it("addAgentToGlobal overwrites with force", async () => {
    const { scaffoldConfigDir, addAgentToGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "manager" });
    const overwritten = addAgentToGlobal(tmpDir, "bot", { extends: "employee" }, true);

    expect(overwritten).toBe(true);
    const YAML = (await import("yaml")).default;
    const config = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(config.agents.bot.extends).toBe("employee");
  });

  it("addAgentToGlobal preserves unrelated comments in config.yaml", async () => {
    const { scaffoldConfigDir, addAgentToGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "# top comment",
        "agents:",
        "  keeper:",
        "    extends: manager",
        "# defaults comment",
        "defaults:",
        "  retries: 1",
        "",
      ].join("\n"),
      "utf-8",
    );

    addAgentToGlobal(tmpDir, "bot", { extends: "employee" });

    const raw = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(raw).toContain("# top comment");
    expect(raw).toContain("# defaults comment");
    expect(raw).toContain("bot:");
  });

  it("removes agent from global via removeAgentFromGlobal", async () => {
    const { scaffoldConfigDir, addAgentToGlobal, removeAgentFromGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "employee" });
    addAgentToGlobal(tmpDir, "keeper", { extends: "manager" });

    const removed = removeAgentFromGlobal(tmpDir, "bot");
    expect(removed).toBe(true);

    const YAML = (await import("yaml")).default;
    const config = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(config.agents.bot).toBeUndefined();
    expect(config.agents.keeper).toBeDefined();
  });

  it("removeAgentFromGlobal returns false for missing agent", async () => {
    const { scaffoldConfigDir, removeAgentFromGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    expect(removeAgentFromGlobal(tmpDir, "ghost")).toBe(false);
  });

  it("removeAgentFromGlobal cleans up domains when requested", async () => {
    const { scaffoldConfigDir, initDomain, addAgentToGlobal, removeAgentFromGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "employee" });
    addAgentToGlobal(tmpDir, "keeper", { extends: "manager" });
    initDomain(tmpDir, { name: "proj", agents: ["bot", "keeper"], managerAgentId: "bot" });

    removeAgentFromGlobal(tmpDir, "bot", true);

    const YAML = (await import("yaml")).default;
    const domain = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8"));
    expect(domain.agents).toEqual(["keeper"]);
    expect(domain.manager).toBeUndefined();
  });

  it("updates agent fields via updateAgentInGlobal", async () => {
    const { scaffoldConfigDir, addAgentToGlobal, updateAgentInGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "employee", title: "Worker" });

    updateAgentInGlobal(tmpDir, "bot", { title: "Senior Worker", model: "opus" });

    const YAML = (await import("yaml")).default;
    const config = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(config.agents.bot.title).toBe("Senior Worker");
    expect(config.agents.bot.model).toBe("opus");
    expect(config.agents.bot.extends).toBe("employee"); // preserved
  });

  it("updateAgentInGlobal throws for missing agent", async () => {
    const { scaffoldConfigDir, updateAgentInGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    expect(() => {
      updateAgentInGlobal(tmpDir, "ghost", { title: "X" });
    }).toThrow(/not found/);
  });

  it("updateAgentInGlobal can delete fields with null", async () => {
    const { scaffoldConfigDir, addAgentToGlobal, updateAgentInGlobal } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    addAgentToGlobal(tmpDir, "bot", { extends: "employee", title: "Worker", persona: "Helpful" });

    updateAgentInGlobal(tmpDir, "bot", { persona: null });

    const YAML = (await import("yaml")).default;
    const config = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(config.agents.bot.persona).toBeUndefined();
    expect(config.agents.bot.title).toBe("Worker"); // preserved
  });
});
