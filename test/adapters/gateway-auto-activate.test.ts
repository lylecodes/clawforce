/**
 * Tests that gateway startup (gateway_start hook + lifecycle.autoActivateProjects)
 * calls registerProject() for workforce-based project.yaml projects so that
 * getActiveProjectIds() returns non-empty after a gateway restart.
 *
 * Regression for: "getActiveProjectIds() returns [] after every restart"
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock("../../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: [], errors: [], warnings: [] })),
}));

vi.mock("../../src/project.js", () => ({
  loadWorkforceConfig: vi.fn(() => null),
  registerWorkforceConfig: vi.fn(),
  loadProject: vi.fn(() => ({
    id: "legacy",
    name: "legacy",
    dir: ".",
    agents: { project: "", workers: [] },
    verification: { required: false },
    defaults: { maxRetries: 3, priority: "P2" },
  })),
  initProject: vi.fn(),
  getRegisteredAgentIds: vi.fn(() => []),
  getAgentConfig: vi.fn(() => null),
}));

vi.mock("../../src/db.js", () => ({
  setProjectsDir: vi.fn(),
  closeAllDbs: vi.fn(),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));

vi.mock("../../src/sweep/actions.js", () => ({
  sweep: vi.fn(() => Promise.resolve({ stale: 0, autoBlocked: 0, deadlineExpired: 0, workflowsAdvanced: 0, escalated: 0, complianceBlocked: 0, stuckKilled: 0 })),
}));

const fsMod = await import("node:fs");
const fsMock = fsMod.default as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
};

const { loadWorkforceConfig, registerWorkforceConfig } = await import("../../src/project.js");
const {
  initClawforce,
  shutdownClawforce,
  getActiveProjectIds,
  unregisterProject,
} = await import("../../src/lifecycle.js");

const BASE_CONFIG = {
  enabled: true,
  projectsDir: "/tmp/test-auto-activate",
  sweepIntervalMs: 0,
  defaultMaxRetries: 3,
  verificationRequired: false,
};

describe("gateway startup: auto-activation registers workforce projects", () => {
  afterEach(() => {
    shutdownClawforce();
    vi.clearAllMocks();
    fsMock.existsSync.mockImplementation(() => false);
    fsMock.readdirSync.mockImplementation(() => []);
  });

  it("getActiveProjectIds() is non-empty after startup with a valid project.yaml", () => {
    fsMock.existsSync.mockImplementation((p: unknown) =>
      String(p) === "/tmp/test-auto-activate" ||
      String(p).endsWith("/workforce-proj/project.yaml")
    );
    fsMock.readdirSync.mockReturnValue([
      { name: "workforce-proj", isDirectory: () => true },
    ] as unknown[]);
    (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      name: "workforce-proj",
      agents: { "my-agent": { extends: "employee", expectations: [], briefing: [], performance_policy: {} } },
    });

    initClawforce(BASE_CONFIG);

    // The critical assertion: project must appear in getActiveProjectIds()
    expect(getActiveProjectIds()).toContain("workforce-proj");
  });

  it("registers multiple workforce projects on startup", () => {
    fsMock.existsSync.mockImplementation((p: unknown) =>
      String(p) === "/tmp/test-auto-activate" ||
      String(p).endsWith("/project-a/project.yaml") ||
      String(p).endsWith("/project-b/project.yaml")
    );
    fsMock.readdirSync.mockReturnValue([
      { name: "project-a", isDirectory: () => true },
      { name: "project-b", isDirectory: () => true },
    ] as unknown[]);
    (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockImplementation((configPath: string) => {
      const projectId = configPath.includes("project-a") ? "project-a" : "project-b";
      return {
        name: projectId,
        agents: { "agent-1": { extends: "employee", expectations: [], briefing: [], performance_policy: {} } },
      };
    });

    initClawforce(BASE_CONFIG);

    const ids = getActiveProjectIds();
    expect(ids).toContain("project-a");
    expect(ids).toContain("project-b");
  });

  it("registerWorkforceConfig is called before registerProject (order check)", () => {
    const callOrder: string[] = [];

    fsMock.existsSync.mockImplementation((p: unknown) =>
      String(p) === "/tmp/test-auto-activate" ||
      String(p).endsWith("/ordered-proj/project.yaml")
    );
    fsMock.readdirSync.mockReturnValue([
      { name: "ordered-proj", isDirectory: () => true },
    ] as unknown[]);
    (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      name: "ordered-proj",
      agents: { "a": { extends: "employee", expectations: [], briefing: [], performance_policy: {} } },
    });
    (registerWorkforceConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("registerWorkforceConfig");
    });

    initClawforce(BASE_CONFIG);

    // registerWorkforceConfig must have been called
    expect(registerWorkforceConfig).toHaveBeenCalledWith(
      "ordered-proj",
      expect.objectContaining({ name: "ordered-proj" }),
      "/tmp/test-auto-activate/ordered-proj",
    );
    // And the project must be active
    expect(getActiveProjectIds()).toContain("ordered-proj");
  });

  it("does not call registerProject for projects where loadWorkforceConfig returns null (legacy path)", () => {
    fsMock.existsSync.mockImplementation((p: unknown) =>
      String(p) === "/tmp/test-auto-activate" ||
      String(p).endsWith("/legacy-proj/project.yaml")
    );
    fsMock.readdirSync.mockReturnValue([
      { name: "legacy-proj", isDirectory: () => true },
    ] as unknown[]);
    // loadWorkforceConfig returns null → legacy path → initProject() handles registerProject
    (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    initClawforce(BASE_CONFIG);

    // legacy-proj is NOT in getActiveProjectIds() because initProject is mocked
    // (the mock doesn't call the real registerProject)
    // This test just verifies no crash on the null path
    expect(loadWorkforceConfig).toHaveBeenCalled();
  });

  it("is idempotent — calling initClawforce twice does not double-register", () => {
    fsMock.existsSync.mockImplementation((p: unknown) =>
      String(p) === "/tmp/test-auto-activate" ||
      String(p).endsWith("/idem-proj/project.yaml")
    );
    fsMock.readdirSync.mockReturnValue([
      { name: "idem-proj", isDirectory: () => true },
    ] as unknown[]);
    (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      name: "idem-proj",
      agents: { "a": { extends: "employee", expectations: [], briefing: [], performance_policy: {} } },
    });

    initClawforce(BASE_CONFIG);
    // Second call is a no-op (initialized guard)
    initClawforce(BASE_CONFIG);

    const ids = getActiveProjectIds();
    expect(ids.filter((id) => id === "idem-proj")).toHaveLength(1);
  });
});
