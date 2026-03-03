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

  function createTool(projectsDir?: string) {
    return createClawforceSetupTool({ projectsDir: projectsDir ?? tmpDir });
  }

  async function execute(params: Record<string, unknown>, projectsDir?: string) {
    const tool = createTool(projectsDir);
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
        if (agentId === "leon") return { projectId: "my-project", config: { role: "manager" as const, briefing: [], expectations: [], performance_policy: { action: "alert" as const } } };
        if (agentId === "coder") return { projectId: "my-project", config: { role: "employee" as const, briefing: [], expectations: [], performance_policy: { action: "alert" as const } } };
        return null;
      });

      const result = await execute({ action: "status" });

      expect(result.ok).toBe(true);
      expect(result.initialized).toBe(true);
      expect(result.project_count).toBe(1);
      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].id).toBe("my-project");
      expect(result.projects[0].agents).toHaveLength(2);
      expect(result.projects[0].agents[0]).toEqual({ id: "leon", role: "manager" });
      expect(result.projects[0].agents[1]).toEqual({ id: "coder", role: "employee" });
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
    role: orchestrator
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: get_approval_context
        min_calls: 1
    on_failure:
      action: alert
  worker:
    role: worker
    reports_to: orchestrator
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: [transition, fail]
        min_calls: 1
    on_failure:
      action: retry
      max_retries: 3
      then: alert
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.agent_preview).toHaveLength(2);
      expect(result.agent_preview[0].id).toBe("orchestrator");
      expect(result.agent_preview[0].role).toBe("manager");
      expect(result.agent_preview[1].id).toBe("worker");
      expect(result.agent_preview[1].role).toBe("employee");
    });

    it("catches missing agents section", async () => {
      const yaml = `
id: test-project
name: Test Project
dir: /tmp/test
`;
      const result = await execute({ action: "validate", yaml_content: yaml });

      expect(result.ok).toBe(true); // No hard errors, just warnings
      expect(result.issues.some((i: { message: string }) => i.message.includes("No workforce agents found"))).toBe(true);
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

    it("returns error for non-existent config_path", async () => {
      const result = await execute({ action: "validate", config_path: "/nonexistent/project.yaml" });

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Cannot read file");
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
      expect(result.agents[0]).toEqual({ id: "worker", role: "employee" });
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

  it("returns error for unknown action", async () => {
    const result = await execute({ action: "unknown" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unknown action");
  });
});
