import { describe, expect, it, vi, beforeEach } from "vitest";

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

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const projectModule = await import("../../src/project.js");
const trackerModule = await import("../../src/enforcement/tracker.js");
const cronModule = await import("../../src/manager-cron.js");
const { createClawforceOpsTool } = await import("../../src/tools/ops-tool.js");

function makeMockAgentConfig(overrides?: Partial<import("../../src/types.js").AgentConfig>) {
  return {
    extends: "manager",
    briefing: [{ source: "instructions" as const }, { source: "task_board" as const }],
    expectations: [{ tool: "clawforce_task", action: "list", min_calls: 1 }],
    performance_policy: { action: "alert" as const },
    ...overrides,
  };
}

describe("ops tool — job management actions", () => {
  let db: ReturnType<typeof getMemoryDb>;
  let tool: ReturnType<typeof createClawforceOpsTool>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);

    tool = createClawforceOpsTool({
      agentSessionKey: "manager-session",
      projectId: "test-project",
      projectDir: "/tmp/test",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  describe("list_jobs", () => {
    it("returns jobs for an agent", async () => {
      const config = makeMockAgentConfig({
        jobs: {
          triage: { cron: "5m", nudge: "Check escalations" },
          dispatch: { cron: "10m" },
        },
      });
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-1", {
        action: "list_jobs",
        project_id: "test-project",
        target_agent_id: "leon",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.jobs.triage.cron).toBe("5m");
      expect(parsed.jobs.dispatch.cron).toBe("10m");
    });

    it("returns empty when agent has no jobs", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-2", {
        action: "list_jobs",
        project_id: "test-project",
        target_agent_id: "leon",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(Object.keys(parsed.jobs)).toHaveLength(0);
    });

    it("returns error for unknown agent", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(undefined);

      const result = await tool.execute("call-3", {
        action: "list_jobs",
        project_id: "test-project",
        target_agent_id: "unknown",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("Agent not found");
    });
  });

  describe("create_job", () => {
    it("creates a job on a target agent", async () => {
      const config = makeMockAgentConfig();
      const entry = {
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      };

      // Mock: caller is manager, target reports to caller
      vi.spyOn(projectModule, "getAgentConfig").mockImplementation((agentId: string) => {
        if (agentId === "manager-session") return { ...entry, config: makeMockAgentConfig({ coordination: { enabled: true } }) };
        if (agentId === "worker-1") return { ...entry, config: makeMockAgentConfig({ extends: "employee", reports_to: "manager-session" }) };
        return undefined;
      });
      vi.spyOn(projectModule, "getRegisteredAgentIds").mockReturnValue(["manager-session", "worker-1"]);

      const result = await tool.execute("call-4", {
        action: "create_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
        job_config: JSON.stringify({ cron: "5m", nudge: "Do triage" }),
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.jobName).toBe("triage");
      expect(parsed.job.cron).toBe("5m");
      expect(parsed.note).toContain("Runtime change");
    });

    it("rejects invalid job name", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-5", {
        action: "create_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "Invalid Name!",
        job_config: "{}",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("Invalid job name");
    });

    it("rejects if job already exists", async () => {
      const config = makeMockAgentConfig({
        jobs: { triage: { cron: "5m" } },
      });
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-6", {
        action: "create_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
        job_config: "{}",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("already exists");
    });
  });

  describe("update_job", () => {
    it("merges updates with existing job", async () => {
      const config = makeMockAgentConfig({
        jobs: { triage: { cron: "5m", nudge: "Old nudge" } },
      });
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-7", {
        action: "update_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
        job_config: JSON.stringify({ nudge: "New nudge", cron: "10m" }),
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.job.nudge).toBe("New nudge");
      expect(parsed.job.cron).toBe("10m");
    });

    it("returns error for nonexistent job", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-8", {
        action: "update_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "nonexistent",
        job_config: "{}",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("not found");
    });
  });

  describe("delete_job", () => {
    it("removes a job from an agent", async () => {
      const config = makeMockAgentConfig({
        jobs: { triage: { cron: "5m" }, dispatch: { cron: "10m" } },
      });
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-9", {
        action: "delete_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.deleted).toBe(true);
      // Verify job was removed from config
      expect(config.jobs!["triage"]).toBeUndefined();
      expect(config.jobs!["dispatch"]).toBeDefined();
    });

    it("returns error for nonexistent job", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-10", {
        action: "delete_job",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "nonexistent",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
    });
  });

  describe("toggle_job_cron", () => {
    it("toggles cron via cron service", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });

      const mockCronService = {
        list: vi.fn().mockResolvedValue([
          { id: "cron-1", name: "job-test-project-manager-session-triage", enabled: true, agentId: "manager-session" },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue(undefined),
      };
      cronModule.setCronService(mockCronService);

      const result = await tool.execute("call-11", {
        action: "toggle_job_cron",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
        job_enabled: false,
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.cronEnabled).toBe(false);
      expect(mockCronService.update).toHaveBeenCalledWith("cron-1", { enabled: false });

      cronModule.setCronService(null);
    });

    it("returns error when cron service unavailable", async () => {
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config: makeMockAgentConfig(),
        projectDir: "/tmp/test",
      });
      cronModule.setCronService(null);

      const result = await tool.execute("call-12", {
        action: "toggle_job_cron",
        project_id: "test-project",
        target_agent_id: "manager-session",
        job_name: "triage",
        job_enabled: true,
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toContain("Cron service not available");
    });
  });

  describe("introspect", () => {
    it("returns the calling agent config summary", async () => {
      const config = makeMockAgentConfig({
        title: "VP Engineering",
        jobs: { triage: { cron: "5m" } },
      });
      vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        projectId: "test-project",
        config,
        projectDir: "/tmp/test",
      });

      const result = await tool.execute("call-13", {
        action: "introspect",
        project_id: "test-project",
      });

      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.ok).toBe(true);
      expect(parsed.extends).toBe("manager");
      expect(parsed.title).toBe("VP Engineering");
      expect(parsed.expectations).toHaveLength(1);
      expect(parsed.jobs).toEqual(["triage"]);
    });
  });
});

// Import afterEach at the top level
import { afterEach } from "vitest";
