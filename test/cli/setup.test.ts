import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const cli = await import("../../src/cli.js");
const configInit = await import("../../src/config/init.js");
const dbModule = await import("../../src/db.js");
const { cmdSetup, cmdConfig, cmdSweep, applyCliRootOverrideFromArgs } = cli;

describe("cli setup", () => {
  let tmpDir: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-cli-setup-"));
    process.env.CLAWFORCE_HOME = tmpDir;
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CLAWFORCE_HOME;
    consoleLog.mockRestore();
    consoleError.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobal(content: Record<string, unknown>) {
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), YAML.stringify(content), "utf-8");
  }

  function writeDomain(domainId: string, content: Record<string, unknown>) {
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "domains", `${domainId}.yaml`),
      YAML.stringify({ domain: domainId, ...content }),
      "utf-8",
    );
  }

  it("prints a formatted setup validation report", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        worker: { extends: "employee" },
      },
    });
    writeDomain("demo", {
      agents: ["lead", "worker"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    cmdSetup(["setup", "validate", `--root=${tmpDir}`, "--domain=demo"], false);

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog.mock.calls[0]?.[0]).toContain("## Setup Validate");
    expect(consoleLog.mock.calls[0]?.[0]).toContain("target_domain=demo");
  });

  it("prints json when requested", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });

    cmdSetup(["setup", "status", `--root=${tmpDir}`], true);

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.root).toBe(path.resolve(tmpDir));
    expect(payload.hasGlobalConfig).toBe(true);
  });

  it("returns structured explanation json for setup explain", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
      },
    });
    writeDomain("demo", {
      agents: ["lead"],
      paths: [tmpDir],
    });

    cmdSetup(["setup", "explain", `--root=${tmpDir}`, "--domain=demo"], true);

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.targetDomainId).toBe("demo");
    expect(payload.explanation.summary).toContain("warning");
    expect(payload.explanation.immediateActions.some((action: { id: string }) => action.id === "domain:demo:manager")).toBe(true);
  });

  it("scaffolds a starter domain from setup CLI", () => {
    cmdSetup([
      "setup",
      "scaffold",
      `--root=${tmpDir}`,
      "--domain=demo-startup",
      "--mode=new",
      `--path=${tmpDir}`,
    ], false);

    const output = consoleLog.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain('Created starter domain "demo-startup" (new).');
    expect(output).toContain("## Setup Status");
    expect(fs.existsSync(path.join(tmpDir, "domains", "demo-startup.yaml"))).toBe(true);

    const globalConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(globalConfig.agents["demo-startup-lead"]).toBeDefined();
    expect(globalConfig.agents["demo-startup-builder"]).toBeDefined();
    expect(globalConfig.agents["demo-startup-lead"]?.workspace_paths).toEqual([tmpDir]);
    expect(globalConfig.agents["demo-startup-builder"]?.workspace_paths).toEqual([tmpDir]);
  });

  it("returns scaffold output as json", () => {
    cmdSetup([
      "setup",
      "scaffold",
      `--root=${tmpDir}`,
      "--domain=governed-demo",
      "--mode=governance",
      "--existing-agent=lead",
      "--existing-agent=worker",
      "--lead-agent=lead",
    ], true);

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.ok).toBe(true);
    expect(payload.domainId).toBe("governed-demo");
    expect(payload.mode).toBe("governance");
    expect(payload.report.targetDomainId).toBe("governed-demo");
  });

  it("scaffolds a data-source-onboarding starter domain", () => {
    cmdSetup([
      "setup",
      "scaffold",
      `--root=${tmpDir}`,
      "--domain=demo-onboarding",
      "--mode=new",
      "--workflow=data-source-onboarding",
      `--path=${tmpDir}`,
    ], false);

    const output = consoleLog.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain('Created starter domain "demo-onboarding" (new).');
    expect(output).toContain("workflows=data-source-onboarding");

    const domainConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "demo-onboarding.yaml"), "utf-8"));
    expect(domainConfig.workflows).toEqual(["data-source-onboarding"]);
    expect(domainConfig.execution).toEqual({
      mode: "dry_run",
      default_mutation_policy: "simulate",
    });
    expect(domainConfig.entities?.jurisdiction?.runtimeCreate).toBe(true);
    expect(domainConfig.entities?.jurisdiction?.issues?.types?.onboarding_request?.task?.enabled).toBe(true);
    expect(domainConfig.entities?.jurisdiction?.issues?.stateSignals?.[0]?.id).toBe("proposed-onboarding-request");

    const globalConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(globalConfig.agents["demo-onboarding-data-director"]?.jobs?.["intake-triage"]).toBeDefined();
    expect(globalConfig.agents["demo-onboarding-source-onboarding-steward"]?.jobs?.["onboarding-backlog-sweep"]).toBeDefined();
    expect(globalConfig.agents["demo-onboarding-integrity-gatekeeper"]?.jobs?.["integrity-sweep"]).toBeDefined();
    expect(globalConfig.agents["demo-onboarding-production-sentinel"]?.jobs?.["production-watch"]).toBeDefined();
    expect(globalConfig.agents["demo-onboarding-data-director"]?.workspace_paths).toEqual([tmpDir]);
    expect(globalConfig.agents["demo-onboarding-source-onboarding-steward"]?.workspace_paths).toEqual([tmpDir]);
  });

  it("reloads one domain after config set", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    writeDomain("demo", { agents: ["lead"] });
    const reloadSpy = vi.spyOn(configInit, "reloadDomain").mockReturnValue({
      domains: ["demo"],
      errors: [],
      warnings: [],
      claimedProjectDirs: [],
    });

    cmdConfig("demo", ["config", "set", "manager.agentId", "lead"], false);

    expect(reloadSpy).toHaveBeenCalledWith(path.resolve(tmpDir), "demo");
    expect(consoleLog.mock.calls.some((call) => String(call[0]).includes("Reloaded domain=demo"))).toBe(true);
  });

  it("reloads all domains after global config set", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
      domains: ["demo"],
      errors: [],
      warnings: [],
      claimedProjectDirs: [],
    });

    cmdConfig("demo", ["config", "set", "agents.lead.title", "Lead", "--global"], false);

    expect(initSpy).toHaveBeenCalledWith(path.resolve(tmpDir));
    expect(consoleLog.mock.calls.some((call) => String(call[0]).includes("Reloaded domains=1"))).toBe(true);
  });

  it("applies a global --root override for non-setup commands", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-cli-setup-other-"));
    try {
      fs.writeFileSync(
        path.join(otherRoot, "config.yaml"),
        YAML.stringify({ agents: { lead: { extends: "employee" } } }),
        "utf-8",
      );
      process.env.CLAWFORCE_HOME = otherRoot;

      applyCliRootOverrideFromArgs(["config", `--root=${tmpDir}`]);
      cmdConfig("demo", ["config", "get", "agents.lead.extends", "--global"], false);

      expect(consoleLog).toHaveBeenCalledWith("manager");
      expect(process.env.CLAWFORCE_HOME).toBe(path.resolve(tmpDir));
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("loads project config before running a local sweep", async () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    writeDomain("demo", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });
    dbModule.setProjectsDir(path.resolve(tmpDir));
    const db = dbModule.getDb("demo");
    const initSpy = vi.spyOn(configInit, "initializeAllDomains");

    try {
      await cmdSweep("demo", true, { localOnly: true });

      expect(initSpy).toHaveBeenCalledWith(path.resolve(tmpDir));
      const payload = JSON.parse(String(consoleLog.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.projectId).toBe("demo");
      expect(payload.mode).toBe("local");
    } finally {
      db.close();
      dbModule.closeDb("demo");
    }
  });
});
