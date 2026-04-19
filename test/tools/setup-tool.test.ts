import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const lifecycleModule = await import("../../src/lifecycle.js");
const projectModule = await import("../../src/project.js");
const { createClawforceSetupTool } = await import("../../src/tools/setup-tool.js");
const { getPolicies, resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");

describe("clawforce_setup tool", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-test-"));
  });

  afterEach(async () => {
    await lifecycleModule.shutdownClawforce();
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    projectModule.resetEnforcementConfigForTest();
    resetPolicyRegistryForTest();
    vi.restoreAllMocks();
  });

  function createTool(projectsDir?: string, agentId?: string) {
    return createClawforceSetupTool({ projectsDir: projectsDir ?? tmpDir, agentId });
  }

  async function execute(params: Record<string, unknown>, projectsDir?: string, agentId?: string) {
    const tool = createTool(projectsDir, agentId);
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("explain", () => {
    it("returns full reference docs", async () => {
      const result = await execute({ action: "explain" });

      expect(result.ok).toBe(true);
      expect(result.explanation.summary).toBeDefined();
      expect(result.setup.root).toBe(tmpDir);
      expect(result.reference).toContain("config.yaml");
      expect(result.reference).toContain("domains/");
      expect(result.reference).toContain("manager");
      expect(result.reference).toContain("employee");
      expect(result.reference).toContain("expectations");
    });

    it("includes projectsDir in reference", async () => {
      const result = await execute({ action: "explain" }, "/custom/path");

      expect(result.reference).toContain("/custom/path");
    });

    it("includes agent ID guidance", async () => {
      const result = await execute({ action: "explain" });

      expect(result.reference).toContain("Agent IDs");
    });

    it("returns specific topic content when topic is provided", async () => {
      const result = await execute({ action: "explain", topic: "memory" });

      expect(result.ok).toBe(true);
      expect(result.topic).toBe("memory");
      expect(result.reference).toContain("memory");
    });

    it("returns error for unknown topic", async () => {
      const result = await execute({ action: "explain", topic: "nonexistent_topic" });

      expect(result.ok).toBe(true);
      // resolveSkillSource returns an error string for unknown topics
      expect(result.reference).toContain("Unknown skill topic");
    });

    it("returns full reference when topic is omitted", async () => {
      const result = await execute({ action: "explain" });

      expect(result.ok).toBe(true);
      expect(result.topic).toBeUndefined();
      expect(result.reference).toContain("config.yaml");
    });
  });

  describe("status", () => {
    it("returns empty state when nothing configured", async () => {
      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(false);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue([]);

      const result = await execute({ action: "status" });

      expect(result.ok).toBe(true);
      expect(result.initialized).toBe(false);
      expect(result.project_count).toBe(0);
      expect(result.projects).toEqual([]);
    });

    it("returns projects and agents when configured", async () => {
      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(true);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["my-project"]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue(["leon", "coder"]);
      vi.spyOn(projectModule, "getAgentConfig").mockImplementation((agentId: string) => {
        if (agentId === "leon") return { projectId: "my-project", config: { extends: "manager", briefing: [], expectations: [], performance_policy: { action: "alert" as const } } };
        if (agentId === "coder") return { projectId: "my-project", config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" as const } } };
        return null;
      });

      const result = await execute({ action: "status" });

      expect(result.ok).toBe(true);
      expect(result.initialized).toBe(true);
      expect(result.project_count).toBe(1);
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].id).toBe("my-project");
      expect(result.projects[0].agents).toHaveLength(2);
      expect(result.projects[0].agents[0]).toEqual({ id: "leon", extends: "manager" });
      expect(result.projects[0].agents[1]).toEqual({ id: "coder", extends: "employee" });
    });

    it("includes projects_dir path", async () => {
      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(false);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue([]);

      const result = await execute({ action: "status" }, "/custom/path");

      expect(result.ok).toBe(true);
      expect(result.projects_dir).toBe("/custom/path");
    });

    it("includes agent_id_help", async () => {
      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(false);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue([]);

      const result = await execute({ action: "status" });

      expect(result.agent_id_help).toBeDefined();
      expect(result.agent_id_help).toContain("Agent IDs");
    });

    it("shows hint when no projects configured", async () => {
      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(true);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue([]);

      const result = await execute({ action: "status" });

      expect(result.hint).toContain("explain");
    });

    it("detects inactive projects on disk", async () => {
      const domainsDir = path.join(tmpDir, "domains");
      fs.mkdirSync(domainsDir, { recursive: true });
      fs.writeFileSync(path.join(domainsDir, "my-project.yaml"), "domain: my-project\nagents: []\n", "utf-8");

      vi.spyOn(lifecycleModule, "isClawforceInitialized").mockReturnValue(true);
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue([]);

      const result = await execute({ action: "status" });

      expect(result.inactive_projects_on_disk).toContain("my-project");
    });
  });

  describe("validate", () => {
    it("validates valid yaml content", async () => {
      const yaml = `
name: Test Project

agents:
  manager:
    extends: manager
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: get_approval_context
        min_calls: 1
    performance_policy:
      action: alert
  worker:
    extends: employee
    reports_to: manager
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: [transition, fail]
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 3
      then: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.agent_preview).toHaveLength(2);
      expect(result.agent_preview[0].id).toBe("manager");
      expect(result.agent_preview[0].extends).toBe("manager");
      expect(result.agent_preview[1].id).toBe("worker");
      expect(result.agent_preview[1].extends).toBe("employee");
    });

    it("catches missing agents section", async () => {
      const yaml = `
name: Test Project
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.ok).toBe(false);
      expect(result.issues.some((i: { message: string }) => i.message.includes("agents object"))).toBe(true);
    });

    it("catches invalid YAML", async () => {
      const result = await execute({ action: "validate", yaml_content: "{{invalid yaml" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("YAML parse error");
    });

    it("catches missing extends field", async () => {
      const yaml = `
name: Test
agents:
  worker:
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.issues.some((i: { level: string; message: string }) =>
        i.level === "error" && i.message.includes("missing required field \"extends\"")
      )).toBe(true);
    });

    it("catches reports_to referencing non-existent agent", async () => {
      const yaml = `
name: Test
agents:
  worker:
    extends: employee
    reports_to: nonexistent
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.issues.some((i: { message: string }) =>
        i.message.includes("nonexistent")
      )).toBe(true);
    });

    it("validates from config_path", async () => {
      const yaml = `
name: Test
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: alert
`;
      const configPath = path.join(tmpDir, "workforce.yaml");
      fs.writeFileSync(configPath, yaml, "utf-8");

      const result = await execute({ action: "validate", config_path: configPath });

      expect(result.valid).toBe(true);
      expect(result.agent_preview).toHaveLength(1);
    });

    it("returns error when no yaml_content or config_path provided", async () => {
      const result = await execute({ action: "validate" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("yaml_content");
    });

    it("returns error for non-existent config_path outside projects dir", async () => {
      const result = await execute({ action: "validate", config_path: "/nonexistent/workforce.yaml" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("config_path must be within the projects directory");
    });

    it("returns error for non-existent config_path within projects dir", async () => {
      const configPath = path.join(tmpDir, "nonexistent", "workforce.yaml");
      const result = await execute({ action: "validate", config_path: configPath });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Cannot read file");
    });

    it("rejects config_path with path traversal outside projects dir", async () => {
      const result = await execute({ action: "validate", config_path: "../../../etc/passwd" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("config_path must be within the projects directory");
    });

    it("rejects config_path with absolute path outside projects dir", async () => {
      const result = await execute({ action: "validate", config_path: "/etc/passwd" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("config_path must be within the projects directory");
    });

    it("allows config_path within projects dir", async () => {
      const yaml = `
name: Test
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: alert
`;
      const configPath = path.join(tmpDir, "workforce.yaml");
      fs.writeFileSync(configPath, yaml, "utf-8");

      const result = await execute({ action: "validate", config_path: configPath });
      expect(result.valid).toBe(true);
    });
  });

  describe("activate", () => {
    function writeDomainConfig(projectId: string, opts?: { policies?: unknown[] }) {
      const domainsDir = path.join(tmpDir, "domains");
      fs.mkdirSync(domainsDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "config.yaml"), `
agents:
  worker:
    extends: employee
`, "utf-8");
      fs.writeFileSync(path.join(domainsDir, `${projectId}.yaml`), YAML.stringify({
        domain: projectId,
        agents: ["worker"],
        ...(opts?.policies ? { policies: opts.policies } : {}),
      }), "utf-8");
    }

    it("activates a valid project", async () => {
      const projectId = "test-project";
      writeDomainConfig(projectId);

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);

      const result = await execute({ action: "activate", project_id: projectId });

      expect(result.ok).toBe(true);
      expect(result.project_id).toBe(projectId);
      expect(result.reloaded).toBe(false);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toEqual({ id: "worker", extends: "employee" });
      expect(result.message).toContain("activated");
    });

    it("reloads an already-active project", async () => {
      const projectId = "active-project";
      writeDomainConfig(projectId);

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([projectId]);

      const result = await execute({ action: "activate", project_id: projectId });

      expect(result.ok).toBe(true);
      expect(result.reloaded).toBe(true);
      expect(result.message).toContain("reloaded");
    });

    it("reloads the requested domain on activate", async () => {
      const projectId = "active-project";
      writeDomainConfig(projectId);

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([projectId]);
      const reloadSpy = vi.spyOn(await import("../../src/config/init.js"), "reloadDomain");

      await execute({ action: "activate", project_id: projectId });

      expect(reloadSpy).toHaveBeenCalledWith(tmpDir, projectId);
    });

    it("registers policies on activate", async () => {
      const projectId = "policy-project";
      writeDomainConfig(projectId, {
        policies: [{
          name: "test-policy",
          type: "action_scope",
          config: { allowed_tools: ["clawforce_task"] },
        }],
      });

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);

      const result = await execute({ action: "activate", project_id: projectId });

      expect(result.ok).toBe(true);
      // Policies should be queryable
      const policies = getPolicies(projectId);
      expect(policies.length).toBeGreaterThan(0);
      // Should include both the explicit policy and the auto-generated scope policy
      const policyNames = policies.map((p: { name: string }) => p.name);
      expect(policyNames).toContain("test-policy");
      expect(policyNames.some((n: string) => n.startsWith("default-scope:"))).toBe(true);
    });

    it("replaces config-backed policies on reload instead of duplicating rows", async () => {
      const projectId = "policy-reload-project";
      writeDomainConfig(projectId, {
        policies: [{
          name: "test-policy",
          type: "action_scope",
          config: { allowed_tools: ["clawforce_task"] },
        }],
      });

      vi.spyOn(lifecycleModule, "getActiveProjectIds")
        .mockReturnValueOnce([])
        .mockReturnValueOnce([projectId]);

      const first = await execute({ action: "activate", project_id: projectId });
      const second = await execute({ action: "activate", project_id: projectId });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM policies WHERE project_id = ?",
      ).get(projectId) as { count: number };
      expect(row.count).toBe(2);
    });

    it("returns error when domain config is not found", async () => {
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);

      const result = await execute({ action: "activate", project_id: "nonexistent" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("No domain config found");
    });

    it("returns error for missing project_id param", async () => {
      const result = await execute({ action: "activate" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("project_id");
    });
  });

  describe("explain with agentId", () => {
    it("returns scoped tools content for employee agent", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockImplementation((agentId: string) => {
        if (agentId === "worker1") return {
          projectId: "proj1",
          config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" as const } },
        };
        return null;
      });

      const result = await execute({ action: "explain", topic: "tools" }, undefined, "worker1");

      expect(result.ok).toBe(true);
      expect(result.topic).toBe("tools");
      // Employee scope — no clawforce tools (auto-lifecycle), only memory tools
      expect(result.reference).toContain("memory_search");
      expect(result.reference).toContain("memory_get");
      expect(result.reference).not.toContain("clawforce_task");
      expect(result.reference).not.toContain("clawforce_ops");
      expect(result.reference).not.toContain("clawforce_workflow");
    });

    it("returns full tools content when no agentId", async () => {
      const result = await execute({ action: "explain", topic: "tools" });

      expect(result.ok).toBe(true);
      // Without agentId, should get full (manager-level) reference
      expect(result.reference).toContain("clawforce_task");
      expect(result.reference).toContain("clawforce_ops");
    });

    it("resolves non-tools topics using agent role", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockImplementation((agentId: string) => {
        if (agentId === "worker1") return {
          projectId: "proj1",
          config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" as const } },
        };
        return null;
      });

      // employees can access "roles" topic (available to all roles)
      const result = await execute({ action: "explain", topic: "roles" }, undefined, "worker1");
      expect(result.ok).toBe(true);
      expect(result.reference).toContain("manager");
    });
  });

  describe("scaffold", () => {
    it("creates a starter domain when scaffold mode is provided", async () => {
      const result = await execute({
        action: "scaffold",
        project_id: "starter-demo",
        mode: "new",
        paths: [tmpDir],
        mission: "Dogfood a clean starter workflow",
      });

      expect(result.ok).toBe(true);
      expect(result.project_id).toBe("starter-demo");
      expect(result.mode).toBe("new");
      expect(result.created_agent_ids).toContain("starter-demo-lead");
      expect(result.setup.targetDomainId).toBe("starter-demo");
      expect(fs.existsSync(path.join(tmpDir, "domains", "starter-demo.yaml"))).toBe(true);

      const globalConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
      expect(globalConfig.agents["starter-demo-lead"]).toBeDefined();
      expect(globalConfig.agents["starter-demo-builder"]).toBeDefined();
      expect(globalConfig.agents["starter-demo-lead"]?.workspace_paths).toEqual([tmpDir]);
      expect(globalConfig.agents["starter-demo-builder"]?.workspace_paths).toEqual([tmpDir]);
    });

    it("creates a workflow-capable onboarding starter domain", async () => {
      const result = await execute({
        action: "scaffold",
        project_id: "starter-onboarding",
        mode: "new",
        workflow: "data-source-onboarding",
        paths: [tmpDir],
      });

      expect(result.ok).toBe(true);
      expect(result.project_id).toBe("starter-onboarding");
      expect(result.setup.targetDomainId).toBe("starter-onboarding");

      const domainConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", "starter-onboarding.yaml"), "utf-8"));
      expect(domainConfig.workflows).toEqual(["data-source-onboarding"]);
      expect(domainConfig.execution).toEqual({
        mode: "dry_run",
        default_mutation_policy: "simulate",
      });
      expect(domainConfig.entities?.jurisdiction?.runtimeCreate).toBe(true);
      expect(domainConfig.entities?.jurisdiction?.issues?.types?.onboarding_request?.task?.enabled).toBe(true);
      expect(domainConfig.entities?.jurisdiction?.issues?.stateSignals?.[0]?.ownerAgentId).toBe("starter-onboarding-data-director");

      const globalConfig = YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
      expect(globalConfig.agents["starter-onboarding-data-director"]?.jobs?.["intake-triage"]).toBeDefined();
      expect(globalConfig.agents["starter-onboarding-source-onboarding-steward"]?.jobs?.["onboarding-backlog-sweep"]).toBeDefined();
      expect(globalConfig.agents["starter-onboarding-integrity-gatekeeper"]?.jobs?.["integrity-sweep"]).toBeDefined();
      expect(globalConfig.agents["starter-onboarding-production-sentinel"]?.jobs?.["production-watch"]).toBeDefined();
      expect(globalConfig.agents["starter-onboarding-data-director"]?.workspace_paths).toEqual([tmpDir]);
      expect(globalConfig.agents["starter-onboarding-source-onboarding-steward"]?.workspace_paths).toEqual([tmpDir]);
    });

    it("creates SOUL.md template for single agent", async () => {
      const projectDir = path.join(tmpDir, "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["my-project"]);

      const result = await execute({ action: "scaffold", project_id: "my-project", agent_id: "frontend-dev" });

      expect(result.ok).toBe(true);
      expect(result.scaffolded).toContain("frontend-dev");

      const soulPath = path.join(projectDir, "agents", "frontend-dev", "SOUL.md");
      expect(fs.existsSync(soulPath)).toBe(true);
      const content = fs.readFileSync(soulPath, "utf-8");
      expect(content).toContain("<!-- SOUL.md");
      expect(content).toContain("frontend-dev");
    });

    it("creates for all agents when no agent_id specified", async () => {
      const projectDir = path.join(tmpDir, "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["my-project"]);
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue(["worker1", "worker2"]);
      vi.spyOn(projectModule, "getAgentConfig").mockImplementation((agentId: string) => {
        if (agentId === "worker1" || agentId === "worker2") {
          return {
            projectId: "my-project",
            config: { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" as const } },
          };
        }
        return null;
      });

      const result = await execute({ action: "scaffold", project_id: "my-project" });

      expect(result.ok).toBe(true);
      expect(result.scaffolded).toContain("worker1");
      expect(result.scaffolded).toContain("worker2");
    });

    it("skips customized SOUL.md", async () => {
      const projectDir = path.join(tmpDir, "my-project");
      const agentDir = path.join(projectDir, "agents", "worker1");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), "# My Custom Agent\n\nI specialize in frontend.", "utf-8");

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["my-project"]);

      const result = await execute({ action: "scaffold", project_id: "my-project", agent_id: "worker1" });

      expect(result.ok).toBe(true);
      expect(result.skipped).toContain("worker1");
      expect(result.scaffolded).not.toContain("worker1");

      // Content should be unchanged
      const content = fs.readFileSync(path.join(agentDir, "SOUL.md"), "utf-8");
      expect(content).toBe("# My Custom Agent\n\nI specialize in frontend.");
    });

    it("auto-resolves single active project", async () => {
      const projectDir = path.join(tmpDir, "only-project");
      fs.mkdirSync(projectDir, { recursive: true });

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["only-project"]);

      const result = await execute({ action: "scaffold", agent_id: "worker1" });

      expect(result.ok).toBe(true);
      expect(result.project_id).toBe("only-project");
    });

    it("errors when multiple projects and no project_id", async () => {
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["proj1", "proj2"]);

      const result = await execute({ action: "scaffold" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("project_id");
    });

    it("errors when no active projects", async () => {
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);

      const result = await execute({ action: "scaffold" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("No active projects");
    });
  });

  it("returns error for unknown action", async () => {
    const result = await execute({ action: "unknown" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unknown action");
  });
});
