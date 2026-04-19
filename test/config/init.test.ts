import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("domain-based initialization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(async () => {
    const { syncManagedDomainRoots } = await import("../../src/config/init.js");
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import(
      "../../src/project.js"
    );
    const { shutdownClawforce } = await import("../../src/lifecycle.js");
    const { resetManagerConfigForTest } = await import("../../src/manager-config.js");
    const { resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
    const { resetCustomTopicsForTest } = await import("../../src/skills/registry.js");
    await shutdownClawforce();
    syncManagedDomainRoots([]);
    clearRegistry();
    resetEnforcementConfigForTest();
    resetManagerConfigForTest();
    resetPolicyRegistryForTest();
    resetCustomTopicsForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("initializes all domains from config directory", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      ["domain: testdomain", "agents:", "  - worker"].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]).toBe("testdomain");
    expect(result.errors).toHaveLength(0);
  });

  it("reports claimed project directories for initialized domains", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    const workspaceDir = path.join(tmpDir, "workspace", "testdomain");
    fs.mkdirSync(workspaceDir, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      [
        "domain: testdomain",
        "paths:",
        `  - ${workspaceDir}`,
        "agents:",
        "  - worker",
      ].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.claimedProjectDirs).toContain(path.resolve(workspaceDir));
  });

  it("stores each domain database under its own config root", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getProjectStorageDir } = await import("../../src/db.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      ["domain: testdomain", "agents:", "  - worker"].join("\n"),
    );

    initializeAllDomains(tmpDir);
    expect(getProjectStorageDir("testdomain")).toBe(path.resolve(tmpDir));
  });

  it("rejects duplicate domain IDs loaded from different config roots", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-other-"));
    fs.mkdirSync(path.join(otherRoot, "domains"), { recursive: true });
    try {
      for (const root of [tmpDir, otherRoot]) {
        fs.writeFileSync(
          path.join(root, "config.yaml"),
          ["agents:", "  worker:", "    extends: employee"].join("\n"),
        );
        fs.writeFileSync(
          path.join(root, "domains", "shared.yaml"),
          ["domain: shared", "agents:", "  - worker"].join("\n"),
        );
      }

      const first = initializeAllDomains(tmpDir);
      const second = initializeAllDomains(otherRoot);

      expect(first.errors).toHaveLength(0);
      expect(second.errors.some((error) => error.includes("already managed"))).toBe(true);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("clearRegistry resets managed domain ownership between runs", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-reset-"));
    fs.mkdirSync(path.join(otherRoot, "domains"), { recursive: true });
    try {
      for (const root of [tmpDir, otherRoot]) {
        fs.writeFileSync(
          path.join(root, "config.yaml"),
          ["agents:", "  worker:", "    extends: employee"].join("\n"),
        );
        fs.writeFileSync(
          path.join(root, "domains", "shared.yaml"),
          ["domain: shared", "agents:", "  - worker"].join("\n"),
        );
      }

      const first = initializeAllDomains(tmpDir);
      expect(first.errors).toHaveLength(0);

      clearRegistry();
      resetEnforcementConfigForTest();

      const second = initializeAllDomains(otherRoot);
      expect(second.errors).toHaveLength(0);
      expect(second.domains).toContain("shared");
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("reports warnings for domains with undefined agents", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "bad.yaml"),
      [
        "domain: bad",
        "agents:",
        "  - worker",
        "  - ghost-agent",
      ].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("ghost-agent"))).toBe(true);
    // Should still initialize the domain (with available agents)
    expect(result.domains).toContain("bad");
  });

  it("populates existing agent config registry via bridge", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  my-bot:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "mydom.yaml"),
      ["domain: mydom", "agents:", "  - my-bot"].join("\n"),
    );

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("my-bot");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("mydom"); // domain becomes projectId in bridge
  });

  it("registers default scope policies through the shared activation path", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getPolicies } = await import("../../src/policy/registry.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  my-bot:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "mydom.yaml"),
      ["domain: mydom", "agents:", "  - my-bot"].join("\n"),
    );

    initializeAllDomains(tmpDir);

    const policies = getPolicies("mydom");
    expect(policies.some((policy) => policy.name === "default-scope:my-bot")).toBe(true);
  });

  it("returns error when global config is invalid", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      "agents: not-an-object\n",
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.domains).toHaveLength(0);
  });

  it("resolves agent preset inheritance", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  worker:",
      "    extends: employee",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry).not.toBeNull();
    // Employee preset should provide default values (e.g. title)
    expect(entry!.config.title).toBe("Employee");
  });

  it("does not apply model from global defaults (model is runtime-only, owned by OpenClaw)", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "defaults:",
      "  performance_policy:",
      "    action: retry",
      "agents:",
      "  worker:",
      "    extends: employee",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    // model field no longer exists on AgentConfig — runtime model comes from OpenClaw
    expect((entry!.config as Record<string, unknown>).model).toBeUndefined();
  });

  it("infers roles when extends is omitted", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  lead:",
        "    title: Engineering Lead",
        "  worker:",
        "    reports_to: lead",
        "    title: Developer",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      ["domain: testdomain", "agents:", "  - lead", "  - worker"].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.domains).toContain("testdomain");

    // getAgentConfig takes 1 arg (agentId), returns { projectId, config } | null
    const leadEntry = getAgentConfig("lead");
    const workerEntry = getAgentConfig("worker");
    expect(leadEntry?.config.extends).toBe("manager");
    expect(workerEntry?.config.extends).toBe("employee");
  });

  it("warns when no domain configs found", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  bot:", "    extends: employee"].join("\n"),
    );
    // No domain files

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings).toContain("No domain configs found");
  });

  it("unregisters a domain when its config is disabled", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");
    const { getActiveProjectIds } = await import("../../src/lifecycle.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    const domainPath = path.join(tmpDir, "domains", "testdomain.yaml");
    fs.writeFileSync(
      domainPath,
      ["domain: testdomain", "agents:", "  - worker"].join("\n"),
    );

    initializeAllDomains(tmpDir);
    expect(getAgentConfig("worker")?.projectId).toBe("testdomain");
    expect(getActiveProjectIds()).toContain("testdomain");

    fs.writeFileSync(
      domainPath,
      ["domain: testdomain", "enabled: false", "agents:", "  - worker"].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings.some((warning) => warning.includes("disabled"))).toBe(true);
    expect(getAgentConfig("worker")).toBeNull();
    expect(getActiveProjectIds()).not.toContain("testdomain");
  });

  it("unregisters a domain when its config file is removed", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");
    const { getActiveProjectIds } = await import("../../src/lifecycle.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    const domainPath = path.join(tmpDir, "domains", "testdomain.yaml");
    fs.writeFileSync(
      domainPath,
      ["domain: testdomain", "agents:", "  - worker"].join("\n"),
    );

    initializeAllDomains(tmpDir);
    expect(getAgentConfig("worker")?.projectId).toBe("testdomain");
    expect(getActiveProjectIds()).toContain("testdomain");

    fs.rmSync(domainPath);

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings).toContain("No domain configs found");
    expect(getAgentConfig("worker")).toBeNull();
    expect(getActiveProjectIds()).not.toContain("testdomain");
  });

  it("reloads only the requested domain runtime after a config change", async () => {
    const { initializeAllDomains, reloadDomains } = await import("../../src/config/init.js");
    const { getAgentConfig, getRegisteredAgentIds } = await import("../../src/project.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  alpha-worker:",
        "    extends: employee",
        "  alpha-reviewer:",
        "    extends: employee",
        "  beta-worker:",
        "    extends: employee",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "alpha.yaml"),
      ["domain: alpha", "agents:", "  - alpha-worker"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "beta.yaml"),
      ["domain: beta", "agents:", "  - beta-worker"].join("\n"),
    );

    initializeAllDomains(tmpDir);
    expect(getRegisteredAgentIds("alpha")).toEqual(["alpha-worker"]);
    expect(getRegisteredAgentIds("beta")).toEqual(["beta-worker"]);

    fs.writeFileSync(
      path.join(tmpDir, "domains", "alpha.yaml"),
      ["domain: alpha", "agents:", "  - alpha-worker", "  - alpha-reviewer"].join("\n"),
    );

    const result = reloadDomains(tmpDir, ["alpha"]);
    expect(result.errors).toEqual([]);
    expect(result.domains).toEqual(["alpha"]);
    expect(getRegisteredAgentIds("alpha")).toEqual(["alpha-worker", "alpha-reviewer"]);
    expect(getRegisteredAgentIds("beta")).toEqual(["beta-worker"]);
    expect(getAgentConfig("alpha-reviewer")?.projectId).toBe("alpha");
    expect(getAgentConfig("beta-worker")?.projectId).toBe("beta");
  });

  it("passes domain entities, skills, and advanced config through the split-config bridge", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getExtendedProjectConfig } = await import("../../src/project.js");
    const { getCustomTopics } = await import("../../src/skills/registry.js");

    const workspaceDir = path.join(tmpDir, "workspace", "rentright");
    fs.mkdirSync(path.join(workspaceDir, ".clawforce", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".clawforce", "skills", "jurisdiction-onboarding.md"),
      "# Jurisdiction Onboarding\n",
      "utf-8",
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  data-director:",
        "    extends: manager",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "rentright-data.yaml"),
      [
        "domain: rentright-data",
        "paths:",
        `  - ${workspaceDir}`,
        "agents:",
        "  - data-director",
        "dispatch:",
        "  mode: event-driven",
        "execution:",
        "  mode: dry_run",
        "  default_mutation_policy: simulate",
        "skills:",
        "  jurisdiction-onboarding:",
        '    title: "Jurisdiction Onboarding"',
        '    description: "Run the end-to-end onboarding workflow"',
        "    path: .clawforce/skills/jurisdiction-onboarding.md",
        "entities:",
        "  jurisdiction:",
        "    states:",
        "      proposed:",
        "        initial: true",
        "      active: {}",
        "    transitions:",
        "      - from: proposed",
        "        to: active",
        "    health:",
        "      values: [healthy, blocked]",
        "      default: healthy",
      ].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.errors).toEqual([]);

    const extConfig = getExtendedProjectConfig("rentright-data");
    expect(extConfig?.dispatch?.mode).toBe("event-driven");
    expect(extConfig?.execution?.mode).toBe("dry_run");
    expect(extConfig?.execution?.defaultMutationPolicy).toBe("simulate");
    expect(extConfig?.entities?.jurisdiction?.health?.default).toBe("healthy");
    expect(extConfig?.entities?.jurisdiction?.transitions).toEqual([
      expect.objectContaining({ from: "proposed", to: "active" }),
    ]);

    const customTopics = getCustomTopics("rentright-data");
    expect(customTopics).toHaveLength(1);
    expect(customTopics[0]?.id).toBe("jurisdiction-onboarding");
    expect(fs.existsSync(path.join(workspaceDir, "agents", "data-director", "SOUL.md"))).toBe(true);
  });

  it("unloads only the requested domain when it is disabled during targeted reload", async () => {
    const { initializeAllDomains, reloadDomain } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");
    const { getActiveProjectIds } = await import("../../src/lifecycle.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  alpha-worker:",
        "    extends: employee",
        "  beta-worker:",
        "    extends: employee",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "alpha.yaml"),
      ["domain: alpha", "agents:", "  - alpha-worker"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "beta.yaml"),
      ["domain: beta", "agents:", "  - beta-worker"].join("\n"),
    );

    initializeAllDomains(tmpDir);
    expect(getActiveProjectIds()).toEqual(expect.arrayContaining(["alpha", "beta"]));

    fs.writeFileSync(
      path.join(tmpDir, "domains", "alpha.yaml"),
      ["domain: alpha", "enabled: false", "agents:", "  - alpha-worker"].join("\n"),
    );

    const result = reloadDomain(tmpDir, "alpha");
    expect(result.warnings.some((warning) => warning.includes('Domain "alpha" is disabled'))).toBe(true);
    expect(getAgentConfig("alpha-worker")).toBeNull();
    expect(getActiveProjectIds()).not.toContain("alpha");
    expect(getAgentConfig("beta-worker")?.projectId).toBe("beta");
    expect(getActiveProjectIds()).toContain("beta");
  });
});
