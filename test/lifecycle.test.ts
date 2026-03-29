import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
  },
}));
vi.mock("../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: [], errors: [], warnings: [] })),
}));
vi.mock("../src/project.js", () => ({
  loadWorkforceConfig: vi.fn(() => null),
  registerWorkforceConfig: vi.fn(),
  loadProject: vi.fn(() => ({ id: "legacy", name: "legacy", dir: ".", agents: { project: "", workers: [] }, verification: { required: false }, defaults: { maxRetries: 3, priority: "P2" } })),
  initProject: vi.fn(),
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

const fsMod = await import("node:fs");
const fsMock = fsMod.default as unknown as { existsSync: ReturnType<typeof vi.fn>; readdirSync: ReturnType<typeof vi.fn> };
const { initializeAllDomains } = await import("../src/config/init.js");
const { loadWorkforceConfig, registerWorkforceConfig, loadProject, initProject } = await import("../src/project.js");
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
    fsMock.existsSync.mockImplementation(() => false);
    fsMock.readdirSync.mockImplementation(() => []);
  });

  // ---------- initClawforce ----------

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

    it("auto-activates legacy project.yaml directories at startup", () => {
      fsMock.existsSync.mockImplementation((p: unknown) => String(p) === "/tmp/test-projects" || String(p).endsWith("/legacy-a/project.yaml"));
      fsMock.readdirSync.mockReturnValue([{ name: "legacy-a", isDirectory: () => true }] as unknown[]);
      (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue({ name: "legacy-a", agents: {} });

      initClawforce(BASE_CONFIG);

      expect(loadWorkforceConfig).toHaveBeenCalledWith("/tmp/test-projects/legacy-a/project.yaml");
      expect(registerWorkforceConfig).toHaveBeenCalledWith("legacy-a", { name: "legacy-a", agents: {} }, "/tmp/test-projects/legacy-a");
      expect(initProject).not.toHaveBeenCalled();
    });

    it("falls back to legacy initProject when no workforce config is present", () => {
      fsMock.existsSync.mockImplementation((p: unknown) => String(p) === "/tmp/test-projects" || String(p).endsWith("/legacy-b/project.yaml"));
      fsMock.readdirSync.mockReturnValue([{ name: "legacy-b", isDirectory: () => true }] as unknown[]);
      (loadWorkforceConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

      initClawforce(BASE_CONFIG);

      expect(loadProject).toHaveBeenCalledWith("/tmp/test-projects/legacy-b/project.yaml");
      expect(initProject).toHaveBeenCalled();
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
          (c: unknown[]) => (c[0] as { projectId: string }).projectId
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

  // ---------- shutdownClawforce ----------

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

    it("is safe to call when never initialized", () => {
      expect(() => shutdownClawforce()).not.toThrow();
      expect(closeAllDbs).toHaveBeenCalledOnce();
    });

    it("allows re-initialization after shutdown", () => {
      initClawforce(BASE_CONFIG);
      shutdownClawforce();
      initClawforce({ ...BASE_CONFIG, projectsDir: "/tmp/re-init" });
      expect(isClawforceInitialized()).toBe(true);
      expect(setProjectsDir).toHaveBeenLastCalledWith("/tmp/re-init");
    });
  });

  // ---------- registerProject / unregisterProject / getActiveProjectIds ----------

  describe("project registry", () => {
    beforeEach(() => {
      // Drain any project IDs that leaked from prior suites since
      // shutdownClawforce() does not clear activeProjectIds.
      for (const id of getActiveProjectIds()) {
        unregisterProject(id);
      }
      initClawforce(BASE_CONFIG);
    });

    it("registers a project so it appears in getActiveProjectIds", () => {
      registerProject("proj-1");
      expect(getActiveProjectIds()).toContain("proj-1");
    });

    it("registers multiple projects", () => {
      registerProject("proj-a");
      registerProject("proj-b");
      const ids = getActiveProjectIds();
      expect(ids).toContain("proj-a");
      expect(ids).toContain("proj-b");
    });

    it("unregisters a project so it no longer appears", () => {
      registerProject("proj-1");
      unregisterProject("proj-1");
      expect(getActiveProjectIds()).not.toContain("proj-1");
    });

    it("unregistering a project that was not registered is a no-op", () => {
      expect(() => unregisterProject("nonexistent")).not.toThrow();
      expect(getActiveProjectIds()).not.toContain("nonexistent");
    });

    it("does not duplicate entries when the same project is registered twice", () => {
      registerProject("proj-dup");
      registerProject("proj-dup");
      const ids = getActiveProjectIds();
      expect(ids.filter((id) => id === "proj-dup")).toHaveLength(1);
    });

    it("returns an empty array when no projects are registered", () => {
      expect(getActiveProjectIds()).toHaveLength(0);
    });

    it("returns a snapshot array that does not reflect subsequent mutations", () => {
      registerProject("proj-snap");
      const snapshot = getActiveProjectIds();
      unregisterProject("proj-snap");
      expect(snapshot).toContain("proj-snap");
      expect(getActiveProjectIds()).not.toContain("proj-snap");
    });
  });

  // ---------- isClawforceInitialized ----------

  describe("isClawforceInitialized", () => {
    it("returns false before any initialization", () => {
      expect(isClawforceInitialized()).toBe(false);
    });

    it("returns true after successful initialization", () => {
      initClawforce(BASE_CONFIG);
      expect(isClawforceInitialized()).toBe(true);
    });

    it("returns false after shutdown", () => {
      initClawforce(BASE_CONFIG);
      shutdownClawforce();
      expect(isClawforceInitialized()).toBe(false);
    });

    it("returns false when init was skipped due to disabled config", () => {
      initClawforce({ ...BASE_CONFIG, enabled: false });
      expect(isClawforceInitialized()).toBe(false);
    });
  });
});
