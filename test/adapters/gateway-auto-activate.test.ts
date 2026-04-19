/**
 * Tests that gateway startup runs domain initialization and exposes the
 * registered projects through lifecycle state after restart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: [], errors: [], warnings: [] })),
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
  sweep: vi.fn(() =>
    Promise.resolve({
      stale: 0,
      autoBlocked: 0,
      deadlineExpired: 0,
      workflowsAdvanced: 0,
      escalated: 0,
      complianceBlocked: 0,
      stuckKilled: 0,
    })
  ),
}));

const { initializeAllDomains } = await import("../../src/config/init.js");
const {
  initClawforce,
  shutdownClawforce,
  getActiveProjectIds,
  registerProject,
} = await import("../../src/lifecycle.js");

const BASE_CONFIG = {
  enabled: true,
  projectsDir: "/tmp/test-auto-activate",
  sweepIntervalMs: 0,
  defaultMaxRetries: 3,
  verificationRequired: false,
};

describe("gateway startup: domain activation registers projects", () => {
  afterEach(() => {
    shutdownClawforce();
    vi.clearAllMocks();
  });

  it("getActiveProjectIds() is non-empty after startup with an initialized domain", () => {
    (initializeAllDomains as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      registerProject("workforce-proj");
      return { domains: ["workforce-proj"], errors: [], warnings: [] };
    });

    initClawforce(BASE_CONFIG);

    expect(getActiveProjectIds()).toContain("workforce-proj");
  });

  it("registers multiple domains on startup", () => {
    (initializeAllDomains as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      registerProject("project-a");
      registerProject("project-b");
      return { domains: ["project-a", "project-b"], errors: [], warnings: [] };
    });

    initClawforce(BASE_CONFIG);

    const ids = getActiveProjectIds();
    expect(ids).toContain("project-a");
    expect(ids).toContain("project-b");
  });

  it("delegates startup activation to initializeAllDomains", () => {
    initClawforce(BASE_CONFIG);

    expect(initializeAllDomains).toHaveBeenCalledWith("/tmp/test-auto-activate");
  });

  it("is idempotent - calling initClawforce twice does not double-register", () => {
    (initializeAllDomains as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      registerProject("idem-proj");
      return { domains: ["idem-proj"], errors: [], warnings: [] };
    });

    initClawforce(BASE_CONFIG);
    initClawforce(BASE_CONFIG);

    const ids = getActiveProjectIds();
    expect(ids.filter((id) => id === "idem-proj")).toHaveLength(1);
    expect(initializeAllDomains).toHaveBeenCalledTimes(1);
  });
});
