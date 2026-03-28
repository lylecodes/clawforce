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

// Mock initializeAllDomains since it requires DB and full lifecycle
vi.mock("../../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: ["test"], errors: [], warnings: [] })),
}));

const { createClawforceConfigTool } = await import("../../src/tools/config-tool.js");
const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");

describe("clawforce_config tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function createTool() {
    return createClawforceConfigTool({ baseDir: tmpDir });
  }

  async function execute(params: Record<string, unknown>) {
    const tool = createTool();
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  function scaffoldBase() {
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      YAML.stringify({ agents: {} }),
      "utf-8",
    );
  }

  function writeGlobalAgents(agents: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      YAML.stringify({ agents }),
      "utf-8",
    );
  }

  function writeDomain(name: string, config: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(tmpDir, "domains", `${name}.yaml`),
      YAML.stringify({ domain: name, ...config }),
      "utf-8",
    );
  }

  function readGlobal(): Record<string, unknown> {
    return YAML.parse(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
  }

  function readDomain(name: string): Record<string, unknown> {
    return YAML.parse(fs.readFileSync(path.join(tmpDir, "domains", `${name}.yaml`), "utf-8"));
  }

  // ─── Tool metadata ───

  it("has correct name and label", () => {
    const tool = createTool();
    expect(tool.name).toBe("clawforce_config");
    expect(tool.label).toBe("Config Management");
  });

  // ─── Domain Management ───

  describe("create_domain", () => {
    it("creates a new domain with agents", async () => {
      const result = await execute({
        action: "create_domain",
        domain: "my-project",
        agents: ["bot-a", "bot-b"],
        orchestrator: "bot-a",
        paths: ["~/workplace/my-project"],
      });

      expect(result.ok).toBe(true);
      expect(result.domain).toBe("my-project");
      expect(result.agents).toEqual(["bot-a", "bot-b"]);

      // Verify file on disk
      const domainConfig = readDomain("my-project");
      expect(domainConfig.domain).toBe("my-project");
      expect(domainConfig.agents).toEqual(["bot-a", "bot-b"]);
      expect(domainConfig.orchestrator).toBe("bot-a");
    });

    it("fails without agents", async () => {
      const result = await execute({
        action: "create_domain",
        domain: "empty",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("agents");
    });

    it("fails if domain already exists", async () => {
      scaffoldBase();
      writeDomain("existing", { agents: ["a"] });

      const result = await execute({
        action: "create_domain",
        domain: "existing",
        agents: ["b"],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already exists");
    });

    it("adds agent presets to global config", async () => {
      const result = await execute({
        action: "create_domain",
        domain: "team",
        agents: ["mgr", "worker"],
        config_data: {
          agent_presets: { mgr: "manager", worker: "employee" },
        },
      });

      expect(result.ok).toBe(true);
      const global = readGlobal();
      const agents = global.agents as Record<string, Record<string, unknown>>;
      expect(agents.mgr.extends).toBe("manager");
      expect(agents.worker.extends).toBe("employee");
    });
  });

  describe("update_domain", () => {
    it("updates domain fields with merge", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], paths: ["~/old"] });

      const result = await execute({
        action: "update_domain",
        domain: "proj",
        paths: ["~/new"],
        orchestrator: "a",
      });

      expect(result.ok).toBe(true);
      expect(result.updated_fields).toContain("paths");
      expect(result.updated_fields).toContain("orchestrator");

      const config = readDomain("proj");
      expect(config.paths).toEqual(["~/new"]);
      expect(config.orchestrator).toBe("a");
      expect(config.agents).toEqual(["a"]); // preserved
    });

    it("accepts config_data for complex fields", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "update_domain",
        domain: "proj",
        config_data: {
          budget: { project: { dailyCents: 500 } },
          safety: { maxSpawnDepth: 5 },
        },
      });

      expect(result.ok).toBe(true);
      const config = readDomain("proj");
      expect((config.budget as Record<string, unknown>).project).toEqual({ dailyCents: 500 });
    });

    it("fails for non-existent domain", async () => {
      scaffoldBase();
      const result = await execute({
        action: "update_domain",
        domain: "ghost",
        orchestrator: "x",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("does not exist");
    });

    it("fails with no updates", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "update_domain",
        domain: "proj",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("No updates");
    });
  });

  describe("delete_domain", () => {
    it("deletes a domain", async () => {
      scaffoldBase();
      writeDomain("doomed", { agents: ["a"] });

      const result = await execute({ action: "delete_domain", domain: "doomed" });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "domains", "doomed.yaml"))).toBe(false);
    });

    it("fails for non-existent domain", async () => {
      scaffoldBase();
      const result = await execute({ action: "delete_domain", domain: "ghost" });
      expect(result.ok).toBe(false);
    });
  });

  describe("list_domains", () => {
    it("lists active and inactive domains", async () => {
      scaffoldBase();
      writeDomain("active-1", { agents: ["a"] });
      writeDomain("active-2", { agents: ["b"], enabled: true });

      const result = await execute({ action: "list_domains" });
      expect(result.ok).toBe(true);
      expect(result.domains.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it("returns empty list when no domains exist", async () => {
      scaffoldBase();
      const result = await execute({ action: "list_domains" });
      expect(result.ok).toBe(true);
      expect(result.domains.length).toBe(0);
    });
  });

  // ─── Agent Management ───

  describe("add_agent", () => {
    it("adds agent to global config", async () => {
      scaffoldBase();

      const result = await execute({
        action: "add_agent",
        agent_id: "new-bot",
        extends: "employee",
        title: "Code Monkey",
        department: "engineering",
      });

      expect(result.ok).toBe(true);
      expect(result.added_to_global).toBe(true);

      const global = readGlobal();
      const agents = global.agents as Record<string, Record<string, unknown>>;
      expect(agents["new-bot"]).toBeDefined();
      expect(agents["new-bot"]!.extends).toBe("employee");
      expect(agents["new-bot"]!.title).toBe("Code Monkey");
    });

    it("adds agent to domain when domain specified", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["existing"] });

      const result = await execute({
        action: "add_agent",
        agent_id: "new-bot",
        domain: "proj",
        extends: "employee",
      });

      expect(result.ok).toBe(true);
      expect(result.added_to_domain).toBe(true);

      const domain = readDomain("proj");
      expect((domain.agents as string[]).includes("new-bot")).toBe(true);
    });

    it("defaults extends to employee", async () => {
      scaffoldBase();

      await execute({ action: "add_agent", agent_id: "bare-bot" });
      const global = readGlobal();
      const agents = global.agents as Record<string, Record<string, unknown>>;
      expect(agents["bare-bot"]!.extends).toBe("employee");
    });

    it("fails if agent already exists", async () => {
      scaffoldBase();
      writeGlobalAgents({ existing: { extends: "manager" } });

      const result = await execute({
        action: "add_agent",
        agent_id: "existing",
        extends: "employee",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already exists");
    });

    it("accepts config_data for extra fields", async () => {
      scaffoldBase();

      const result = await execute({
        action: "add_agent",
        agent_id: "rich-bot",
        extends: "manager",
        config_data: {
          skillCap: 5,
          contextBudgetChars: 100000,
        },
      });

      expect(result.ok).toBe(true);
      const global = readGlobal();
      const agents = global.agents as Record<string, Record<string, unknown>>;
      expect(agents["rich-bot"]!.skillCap).toBe(5);
    });
  });

  describe("remove_agent", () => {
    it("removes agent from global and all domains", async () => {
      scaffoldBase();
      writeGlobalAgents({ doomed: { extends: "employee" }, keeper: { extends: "manager" } });
      writeDomain("proj", { agents: ["doomed", "keeper"] });

      const result = await execute({ action: "remove_agent", agent_id: "doomed" });
      expect(result.ok).toBe(true);

      const global = readGlobal();
      expect((global.agents as Record<string, unknown>).doomed).toBeUndefined();

      const domain = readDomain("proj");
      expect((domain.agents as string[]).includes("doomed")).toBe(false);
      expect((domain.agents as string[]).includes("keeper")).toBe(true);
    });

    it("fails for non-existent agent", async () => {
      scaffoldBase();
      const result = await execute({ action: "remove_agent", agent_id: "ghost" });
      expect(result.ok).toBe(false);
    });
  });

  describe("update_agent", () => {
    it("updates specific agent fields via merge", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee", title: "Worker", department: "eng" } });

      const result = await execute({
        action: "update_agent",
        agent_id: "bot",
        title: "Senior Worker",
        model: "claude-opus-4",
      });

      expect(result.ok).toBe(true);
      expect(result.updated_fields).toContain("title");
      expect(result.updated_fields).toContain("model");

      const global = readGlobal();
      const agent = (global.agents as Record<string, Record<string, unknown>>).bot!;
      expect(agent.title).toBe("Senior Worker");
      expect(agent.model).toBe("claude-opus-4");
      expect(agent.department).toBe("eng"); // preserved
      expect(agent.extends).toBe("employee"); // preserved
    });

    it("fails for non-existent agent", async () => {
      scaffoldBase();
      const result = await execute({
        action: "update_agent",
        agent_id: "ghost",
        title: "X",
      });
      expect(result.ok).toBe(false);
    });

    it("fails with no updates", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee" } });

      const result = await execute({ action: "update_agent", agent_id: "bot" });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("No updates");
    });
  });

  // ─── Budget ───

  describe("set_budget", () => {
    it("sets budget on domain", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_budget",
        domain: "proj",
        config_data: {
          project: { dailyCents: 500 },
          agents: { a: { dailyCents: 200 } },
        },
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      const budget = domain.budget as Record<string, unknown>;
      expect((budget.project as Record<string, unknown>).dailyCents).toBe(500);
    });

    it("fails without config_data", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({ action: "set_budget", domain: "proj" });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("config_data");
    });
  });

  // ─── Policy Management ───

  describe("add_policy", () => {
    it("adds a policy to domain", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], policies: [] });

      const result = await execute({
        action: "add_policy",
        domain: "proj",
        config_data: {
          name: "cost-guard",
          type: "budget_limit",
          config: { maxDailyCents: 100 },
        },
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      const policies = domain.policies as Record<string, unknown>[];
      expect(policies.length).toBe(1);
      expect(policies[0]!.name).toBe("cost-guard");
    });

    it("rejects duplicate policy name", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], policies: [{ name: "dup", type: "x", config: {} }] });

      const result = await execute({
        action: "add_policy",
        domain: "proj",
        config_data: { name: "dup", type: "y", config: {} },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already exists");
    });
  });

  describe("remove_policy", () => {
    it("removes a policy by name", async () => {
      scaffoldBase();
      writeDomain("proj", {
        agents: ["a"],
        policies: [
          { name: "keep", type: "x", config: {} },
          { name: "remove-me", type: "y", config: {} },
        ],
      });

      const result = await execute({
        action: "remove_policy",
        domain: "proj",
        policy_name: "remove-me",
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      const policies = domain.policies as Record<string, unknown>[];
      expect(policies.length).toBe(1);
      expect(policies[0]!.name).toBe("keep");
    });

    it("fails if policy not found", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], policies: [] });

      const result = await execute({
        action: "remove_policy",
        domain: "proj",
        policy_name: "ghost",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("update_policy", () => {
    it("updates policy fields via merge", async () => {
      scaffoldBase();
      writeDomain("proj", {
        agents: ["a"],
        policies: [{ name: "guard", type: "budget", config: { max: 100, enabled: true } }],
      });

      const result = await execute({
        action: "update_policy",
        domain: "proj",
        policy_name: "guard",
        config_data: { config: { max: 200 } },
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      const policies = domain.policies as Record<string, unknown>[];
      const policy = policies[0] as Record<string, unknown>;
      expect(policy.name).toBe("guard"); // preserved
      expect(policy.type).toBe("budget"); // preserved
      // config is deep merged
      expect((policy.config as Record<string, unknown>).max).toBe(200);
    });
  });

  // ─── Safety & Profile ───

  describe("set_safety", () => {
    it("sets safety limits on domain", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_safety",
        domain: "proj",
        config_data: { maxSpawnDepth: 5, emergencyStop: true },
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      const safety = domain.safety as Record<string, unknown>;
      expect(safety.maxSpawnDepth).toBe(5);
      expect(safety.emergencyStop).toBe(true);
    });

    it("rejects unknown safety keys", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_safety",
        domain: "proj",
        config_data: { invalidKey: 123 },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Unknown safety keys");
    });
  });

  describe("set_profile", () => {
    it("sets operational profile", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_profile",
        domain: "proj",
        operational_profile: "high",
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      expect(domain.operational_profile).toBe("high");
    });

    it("rejects invalid profile", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_profile",
        domain: "proj",
        operational_profile: "extreme",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Invalid profile");
    });
  });

  // ─── Direction ───

  describe("set_direction", () => {
    it("writes DIRECTION.md for domain", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_direction",
        domain: "proj",
        direction_content: "vision: Build the best product\nautonomy: high\n",
      });

      expect(result.ok).toBe(true);
      expect(result.path).toBeDefined();
      // Should have written the file
      expect(fs.existsSync(result.path)).toBe(true);
      const content = fs.readFileSync(result.path, "utf-8");
      expect(content).toContain("Build the best product");
    });

    it("fails for non-existent domain", async () => {
      scaffoldBase();
      const result = await execute({
        action: "set_direction",
        domain: "ghost",
        direction_content: "anything",
      });
      expect(result.ok).toBe(false);
    });
  });

  // ─── Section ───

  describe("set_section", () => {
    it("sets arbitrary section on domain", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "set_section",
        domain: "proj",
        section: "channels",
        config_data: [{ name: "general", type: "topic" }],
      });

      expect(result.ok).toBe(true);
      const domain = readDomain("proj");
      expect(Array.isArray(domain.channels)).toBe(true);
    });

    it("sets section on global config when no domain", async () => {
      scaffoldBase();

      const result = await execute({
        action: "set_section",
        section: "defaults",
        config_data: { performance_policy: { action: "retry" } },
      });

      expect(result.ok).toBe(true);
      const global = readGlobal();
      expect(global.defaults).toBeDefined();
    });

    it("fails without config_data", async () => {
      scaffoldBase();
      const result = await execute({
        action: "set_section",
        section: "x",
      });
      expect(result.ok).toBe(false);
    });
  });

  // ─── Get Config ───

  describe("get_config", () => {
    it("returns full config by default", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee" } });
      writeDomain("proj", { agents: ["bot"] });

      const result = await execute({ action: "get_config" });

      expect(result.ok).toBe(true);
      expect(result.scope).toBe("full");
      expect(result.agent_count).toBe(1);
      expect(result.domain_count).toBe(1);
    });

    it("returns global config", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee" } });

      const result = await execute({ action: "get_config", scope: "global" });

      expect(result.ok).toBe(true);
      expect(result.config.agents.bot).toBeDefined();
    });

    it("returns domain config", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], budget: { project: { dailyCents: 100 } } });

      const result = await execute({
        action: "get_config",
        scope: "domain",
        domain: "proj",
      });

      expect(result.ok).toBe(true);
      expect(result.config.agents).toEqual(["a"]);
    });

    it("returns agent config with domain membership", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee", title: "Worker" } });
      writeDomain("proj", { agents: ["bot"] });

      const result = await execute({
        action: "get_config",
        scope: "agent",
        agent_id: "bot",
      });

      expect(result.ok).toBe(true);
      expect(result.definition.title).toBe("Worker");
      expect(result.domains).toContain("proj");
    });

    it("returns specific section", async () => {
      scaffoldBase();
      writeGlobalAgents({ bot: { extends: "employee" } });

      const result = await execute({
        action: "get_config",
        scope: "global",
        section: "agents",
      });

      expect(result.ok).toBe(true);
      expect(result.data.bot).toBeDefined();
    });

    it("fails for non-existent agent", async () => {
      scaffoldBase();
      const result = await execute({
        action: "get_config",
        scope: "agent",
        agent_id: "ghost",
      });
      expect(result.ok).toBe(false);
    });
  });

  // ─── Validate ───

  describe("validate", () => {
    it("validates global config", async () => {
      scaffoldBase();

      const result = await execute({ action: "validate", target: "global" });
      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
    });

    it("validates domain config", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      const result = await execute({
        action: "validate",
        target: "domain",
        domain: "proj",
      });
      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
    });

    it("runs full validation", async () => {
      scaffoldBase();
      // Full validation requires project.yaml which we don't have,
      // so it will report issues
      const result = await execute({ action: "validate", target: "full" });
      expect(result.ok).toBe(true);
      // The report will have issues since there's no project.yaml
      expect(result.issues).toBeDefined();
    });
  });

  // ─── Diff ───

  describe("diff", () => {
    it("previews domain changes without writing", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"], budget: { project: { dailyCents: 100 } } });

      const result = await execute({
        action: "diff",
        domain: "proj",
        config_data: { budget: { project: { dailyCents: 500 } } },
      });

      expect(result.ok).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.before.budget.project.dailyCents).toBe(100);
      expect(result.after.budget.project.dailyCents).toBe(500);

      // Verify file was NOT modified
      const actual = readDomain("proj");
      expect((actual.budget as Record<string, Record<string, unknown>>).project!.dailyCents).toBe(100);
    });

    it("previews global changes", async () => {
      scaffoldBase();

      const result = await execute({
        action: "diff",
        config_data: { defaults: { performance_policy: { action: "retry" } } },
      });

      expect(result.ok).toBe(true);
      expect(result.scope).toBe("global");
    });

    it("reports validation errors in preview", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      // Remove required agents field to trigger validation error
      const result = await execute({
        action: "diff",
        domain: "proj",
        config_data: { agents: "not-an-array" },
      });

      expect(result.ok).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  // ─── Reload ───

  describe("reload", () => {
    it("triggers runtime reload", async () => {
      scaffoldBase();
      const { initializeAllDomains } = await import("../../src/config/init.js");

      const result = await execute({ action: "reload" });

      expect(result.ok).toBe(true);
      expect(result.action).toBe("reload");
      expect(initializeAllDomains).toHaveBeenCalledWith(tmpDir);
    });
  });

  // ─── Audit Trail ───

  describe("audit trail", () => {
    it("emits diagnostic event on domain update", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      await execute({
        action: "update_domain",
        domain: "proj",
        orchestrator: "a",
        actor: "manager-bot",
      });

      expect(emitDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "config_updated",
          actor: "manager-bot",
          section: "domain",
        }),
      );
    });

    it("defaults actor to system", async () => {
      scaffoldBase();
      writeDomain("proj", { agents: ["a"] });

      await execute({
        action: "update_domain",
        domain: "proj",
        orchestrator: "a",
      });

      expect(emitDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "system",
        }),
      );
    });
  });

  // ─── Error handling ───

  describe("error handling", () => {
    it("returns error for unknown action", async () => {
      const result = await execute({ action: "destroy_everything" });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Unknown action");
    });

    it("returns error for missing required params", async () => {
      const result = await execute({});
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("action");
    });
  });
});
