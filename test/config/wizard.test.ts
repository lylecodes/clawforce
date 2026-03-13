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
      orchestrator: "lyle-pa",
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
});
