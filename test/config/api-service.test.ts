import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: ["proj"], errors: [], warnings: [] })),
  reloadDomain: vi.fn((_baseDir: string, projectId: string) => ({
    domains: [projectId],
    errors: [],
    warnings: [],
  })),
  reloadDomains: vi.fn((baseDir: string, projectIds: Iterable<string>) => ({
    domains: [...projectIds],
    errors: [],
    warnings: [],
  })),
}));

const { createConfigService } = await import("../../src/config/api-service.js");
const { reloadDomain, initializeAllDomains } = await import("../../src/config/init.js");

describe("config api service", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-api-service-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function writeGlobal(config: Record<string, unknown>) {
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), YAML.stringify(config), "utf-8");
  }

  function writeDomain(domainId: string, config: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(tmpDir, "domains", `${domainId}.yaml`),
      YAML.stringify({ domain: domainId, ...config }),
      "utf-8",
    );
  }

  it("reads configs from the provided baseDir", () => {
    writeGlobal({ agents: { bot: { extends: "employee" } } });

    const service = createConfigService({ baseDir: tmpDir });
    const globalConfig = service.readGlobalConfig();

    expect(globalConfig.agents.bot).toEqual({ extends: "employee" });
  });

  it("persists merged domain updates and reloads only that domain", () => {
    writeGlobal({ agents: {} });
    writeDomain("proj", { agents: ["bot"], budget: { project: { dailyCents: 100 } } });

    const service = createConfigService({ baseDir: tmpDir });
    const result = service.saveDomainConfigChanges(
      "proj",
      { budget: { project: { dailyCents: 500 } }, safety: { maxSpawnDepth: 4 } },
      "user:test",
    );

    expect(result.ok).toBe(true);
    expect(reloadDomain).toHaveBeenCalledWith(tmpDir, "proj");

    const saved = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8"));
    expect(saved.budget.project.dailyCents).toBe(500);
    expect(saved.safety.maxSpawnDepth).toBe(4);
    expect(saved.agents).toEqual(["bot"]);
  });

  it("reloads all domains against the provided baseDir", () => {
    const service = createConfigService({ baseDir: tmpDir });
    const result = service.reloadAllDomains();

    expect(result.domains).toEqual(["proj"]);
    expect(initializeAllDomains).toHaveBeenCalledWith(tmpDir);
  });

  it("adds an agent to a domain and reloads that domain", () => {
    writeGlobal({ agents: { bot: { extends: "employee" } } });
    writeDomain("proj", { agents: [] });

    const service = createConfigService({ baseDir: tmpDir });
    const result = service.addAgentToDomain("proj", "bot", "user:test");

    expect(result.ok).toBe(true);
    expect(reloadDomain).toHaveBeenCalledWith(tmpDir, "proj");

    const saved = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8"));
    expect(saved.agents).toEqual(["bot"]);
  });

  it("preserves existing YAML comments when adding an agent through the service", () => {
    writeGlobal({ agents: { bot: { extends: "employee" } } });
    fs.writeFileSync(
      path.join(tmpDir, "domains", "proj.yaml"),
      [
        "domain: proj",
        "agents:",
        "  - lead # keep",
        "",
      ].join("\n"),
      "utf-8",
    );

    const service = createConfigService({ baseDir: tmpDir });
    const result = service.addAgentToDomain("proj", "bot", "user:test");

    expect(result.ok).toBe(true);
    const raw = fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8");
    expect(raw).toContain("- lead # keep");
    expect(raw).toContain("- bot");
  });

  it("removes an agent globally and from impacted domains", () => {
    writeGlobal({ agents: { doomed: { extends: "employee" }, keeper: { extends: "manager" } } });
    writeDomain("proj", { agents: ["doomed", "keeper"], manager: { enabled: true, agentId: "doomed" } });

    const service = createConfigService({ baseDir: tmpDir });
    const result = service.removeGlobalAgent("doomed", "user:test", true);

    expect(result.ok).toBe(true);
    expect(result.impactedDomains).toEqual(["proj"]);
    expect(reloadDomain).toHaveBeenCalledWith(tmpDir, "proj");

    const global = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    expect(global.agents.doomed).toBeUndefined();

    const domain = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "proj.yaml"), "utf-8"));
    expect(domain.agents).toEqual(["keeper"]);
    expect(domain.manager).toBeUndefined();
  });

  it("deletes a domain and reloads it to clear managed runtime state", () => {
    writeDomain("proj", { agents: ["bot"] });

    const service = createConfigService({ baseDir: tmpDir });
    const result = service.deleteDomain("proj", "user:test");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "domains", "proj.yaml"))).toBe(false);
    expect(reloadDomain).toHaveBeenCalledWith(tmpDir, "proj");
  });
});
