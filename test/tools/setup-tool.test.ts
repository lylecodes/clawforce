import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
const trackerModule = await import("../../src/enforcement/tracker.js");
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

  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
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
      expect(result.reference).toContain("project.yaml");
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
      expect(result.reference).toContain("project.yaml");
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
      // Create a project dir with a project.yaml
      const projectDir = path.join(tmpDir, "my-project");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "project.yaml"), "id: my-project\nname: Test", "utf-8");

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
id: test-project
name: Test Project
dir: /tmp/test

agents:
  orchestrator:
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
    reports_to: orchestrator
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
      expect(result.agent_preview[0].id).toBe("orchestrator");
      expect(result.agent_preview[0].extends).toBe("manager");
      expect(result.agent_preview[1].id).toBe("worker");
      expect(result.agent_preview[1].extends).toBe("employee");
    });

    it("catches missing agents section", async () => {
      const yaml = `
id: test-project
name: Test Project
dir: /tmp/test
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.ok).toBe(true); // No hard errors, just warnings
      expect(result.issues.some((i: { message: string }) => i.message.includes("No workforce agents found") || i.message.includes("Use 'extends'"))).toBe(true);
    });

    it("catches invalid YAML", async () => {
      const result = await execute({ action: "validate", yaml_content: "{{invalid yaml" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("YAML parse error");
    });

    it("catches missing id field", async () => {
      const yaml = `
name: Test
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.issues.some((i: { level: string; message: string }) =>
        i.level === "error" && i.message.includes("id")
      )).toBe(true);
    });

    it("catches reports_to referencing non-existent agent", async () => {
      const yaml = `
id: test
name: Test
agents:
  worker:
    role: worker
    reports_to: nonexistent
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.issues.some((i: { message: string }) =>
        i.message.includes("nonexistent")
      )).toBe(true);
    });

    it("validates from config_path", async () => {
      const yaml = `
id: test-project
name: Test
dir: /tmp/test
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`;
      const configPath = path.join(tmpDir, "project.yaml");
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
      const result = await execute({ action: "validate", config_path: "/nonexistent/project.yaml" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("config_path must be within the projects directory");
    });

    it("returns error for non-existent config_path within projects dir", async () => {
      const configPath = path.join(tmpDir, "nonexistent", "project.yaml");
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
id: test-project
name: Test
dir: /tmp/test
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`;
      const configPath = path.join(tmpDir, "project.yaml");
      fs.writeFileSync(configPath, yaml, "utf-8");

      const result = await execute({ action: "validate", config_path: configPath });
      expect(result.valid).toBe(true);
    });
  });

  describe("activate", () => {
    it("activates a valid project", async () => {
      const projectId = "test-project";
      const projectDir = path.join(tmpDir, projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "project.yaml"), `
id: ${projectId}
name: Test Project
dir: ${tmpDir}
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`, "utf-8");

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "registerWorkforceConfig").mockImplementation(() => {});
      vi.spyOn(projectModule, "initProject").mockImplementation(() => {});
      vi.spyOn(trackerModule, "recoverOrphanedSessions").mockReturnValue([]);

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
      const projectDir = path.join(tmpDir, projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "project.yaml"), `
id: ${projectId}
name: Test
dir: ${tmpDir}
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`, "utf-8");

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([projectId]);
      vi.spyOn(projectModule, "registerWorkforceConfig").mockImplementation(() => {});
      vi.spyOn(trackerModule, "recoverOrphanedSessions").mockReturnValue([]);

      const result = await execute({ action: "activate", project_id: projectId });

      expect(result.ok).toBe(true);
      expect(result.reloaded).toBe(true);
      expect(result.message).toContain("reloaded");
    });

    it("does not call initProject on reload", async () => {
      const projectId = "active-project";
      const projectDir = path.join(tmpDir, projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "project.yaml"), `
id: ${projectId}
name: Test
dir: ${tmpDir}
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`, "utf-8");

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([projectId]);
      vi.spyOn(projectModule, "registerWorkforceConfig").mockImplementation(() => {});
      const initSpy = vi.spyOn(projectModule, "initProject").mockImplementation(() => {});
      vi.spyOn(trackerModule, "recoverOrphanedSessions").mockReturnValue([]);

      await execute({ action: "activate", project_id: projectId });

      expect(initSpy).not.toHaveBeenCalled();
    });

    it("registers policies on activate", async () => {
      const projectId = "policy-project";
      const projectDir = path.join(tmpDir, projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "project.yaml"), `
id: ${projectId}
name: Policy Project
dir: ${tmpDir}
agents:
  worker:
    role: worker
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
policies:
  - name: test-policy
    type: action_scope
    config:
      allowed_tools:
        - clawforce_task
`, "utf-8");

      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);
      vi.spyOn(projectModule, "registerWorkforceConfig").mockImplementation(() => {});
      vi.spyOn(projectModule, "initProject").mockImplementation(() => {});
      vi.spyOn(trackerModule, "recoverOrphanedSessions").mockReturnValue([]);

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

    it("returns error when project.yaml not found", async () => {
      vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue([]);

      const result = await execute({ action: "activate", project_id: "nonexistent" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("No project.yaml found");
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
      // Employee scope — should have task and log but not ops/workflow
      expect(result.reference).toContain("clawforce_task");
      expect(result.reference).toContain("clawforce_log");
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
