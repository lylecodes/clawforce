import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: [], errors: [], warnings: [] })),
}));
vi.mock("../src/db.js", () => ({
  setProjectsDir: vi.fn(),
  closeAllDbs: vi.fn(),
}));
vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  emitDiagnosticEvent: vi.fn(),
}));
vi.mock("../src/sweep/actions.js", () => ({
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

const { initializeAllDomains } = await import("../src/config/init.js");
const { setProjectsDir, closeAllDbs } = await import("../src/db.js");
const { sweep } = await import("../src/sweep/actions.js");
const {
  initClawforce,
  shutdownClawforce,
  registerProject,
  unregisterProject,
  getActiveProjectIds,
  isClawforceInitialized,
} = await import("../src/lifecycle.js");

import type { ClawforceConfig } from "../src/types.js";

const BASE_CONFIG: ClawforceConfig = {
  enabled: true,
  projectsDir: "/tmp/test-projects",
  sweepIntervalMs: 0,
  defaultMaxRetries: 3,
  verificationRequired: false,
};

describe("lifecycle", () => {
  afterEach(() => {
    shutdownClawforce();
    vi.clearAllMocks();
  });

  describe("initClawforce", () => {
    it("sets initialized to true when enabled", () => {
      initClawforce(BASE_CONFIG);
      expect(isClawforceInitialized()).toBe(true);
    });

    it("calls setProjectsDir with the configured directory", () => {
      initClawforce(BASE_CONFIG);
      expect(setProjectsDir).toHaveBeenCalledOnce();
      expect(setProjectsDir).toHaveBeenCalledWith("/tmp/test-projects");
    });

    it("does not double-init when called a second time", () => {
      initClawforce(BASE_CONFIG);
      initClawforce({ ...BASE_CONFIG, projectsDir: "/tmp/other" });
      expect(setProjectsDir).toHaveBeenCalledOnce();
      expect(setProjectsDir).toHaveBeenCalledWith("/tmp/test-projects");
    });

    it("is a no-op when config.enabled is false", () => {
      initClawforce({ ...BASE_CONFIG, enabled: false });
      expect(isClawforceInitialized()).toBe(false);
      expect(setProjectsDir).not.toHaveBeenCalled();
    });

    it("auto-initializes domain config at startup", () => {
      initClawforce(BASE_CONFIG);
      expect(initializeAllDomains).toHaveBeenCalledWith("/tmp/test-projects");
    });

    it("exposes domains registered during initialization", () => {
      (initializeAllDomains as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        registerProject("my-project");
        return { domains: ["my-project"], errors: [], warnings: [] };
      });

      initClawforce(BASE_CONFIG);

      expect(getActiveProjectIds()).toContain("my-project");
    });

    it("starts the sweep timer when sweepIntervalMs > 0", () => {
      vi.useFakeTimers();
      try {
        initClawforce({ ...BASE_CONFIG, sweepIntervalMs: 100 });
        registerProject("proj-timer");

        vi.advanceTimersByTime(100);

        expect(sweep).toHaveBeenCalledOnce();
        expect(sweep).toHaveBeenCalledWith({ projectId: "proj-timer" });
      } finally {
        unregisterProject("proj-timer");
        vi.useRealTimers();
      }
    });

    it("does not start a sweep timer when sweepIntervalMs is 0", () => {
      vi.useFakeTimers();
      try {
        initClawforce({ ...BASE_CONFIG, sweepIntervalMs: 0 });
        registerProject("proj-no-timer");

        vi.advanceTimersByTime(10_000);

        expect(sweep).not.toHaveBeenCalled();
      } finally {
        unregisterProject("proj-no-timer");
        vi.useRealTimers();
      }
    });

    it("sweeps all registered projects on each tick", () => {
      vi.useFakeTimers();
      try {
        initClawforce({ ...BASE_CONFIG, sweepIntervalMs: 50 });
        registerProject("proj-a");
        registerProject("proj-b");

        vi.advanceTimersByTime(50);

        expect(sweep).toHaveBeenCalledTimes(2);
        const calledWith = (sweep as ReturnType<typeof vi.fn>).mock.calls.map(
          (call: unknown[]) => (call[0] as { projectId: string }).projectId,
        );
        expect(calledWith).toContain("proj-a");
        expect(calledWith).toContain("proj-b");
      } finally {
        unregisterProject("proj-a");
        unregisterProject("proj-b");
        vi.useRealTimers();
      }
    });
  });

  describe("shutdownClawforce", () => {
    it("sets initialized to false", () => {
      initClawforce(BASE_CONFIG);
      expect(isClawforceInitialized()).toBe(true);
      shutdownClawforce();
      expect(isClawforceInitialized()).toBe(false);
    });

    it("calls closeAllDbs", () => {
      initClawforce(BASE_CONFIG);
      shutdownClawforce();
      expect(closeAllDbs).toHaveBeenCalledOnce();
    });

    it("clears the sweep timer so no further sweeps fire", () => {
      vi.useFakeTimers();
      try {
        initClawforce({ ...BASE_CONFIG, sweepIntervalMs: 100 });
        registerProject("proj-clear");

        shutdownClawforce();
        vi.advanceTimersByTime(500);

        expect(sweep).not.toHaveBeenCalled();
      } finally {
        unregisterProject("proj-clear");
        vi.useRealTimers();
      }
    });
  });
});
