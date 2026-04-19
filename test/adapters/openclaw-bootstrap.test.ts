import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/agent-sync.js", () => ({
  syncAgentsToOpenClaw: vi.fn(async () => ({
    synced: 1,
    skipped: 0,
    errors: [],
    collisions: [],
  })),
}));
vi.mock("../../src/config/init.js", () => ({
  initializeAllDomains: vi.fn(() => ({ domains: ["alpha"], errors: [], warnings: [], claimedProjectDirs: [] })),
  syncManagedDomainRoots: vi.fn(),
}));
vi.mock("../../src/config/openclaw-reader.js", () => ({
  clearOpenClawConfigCache: vi.fn(),
  setOpenClawConfig: vi.fn(),
}));
vi.mock("../../src/config/watcher.js", () => ({
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
}));
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
}));
vi.mock("../../src/dispatch/restart-recovery.js", () => ({
  recoverProject: vi.fn(() => ({
    staleTasks: 0,
    failedDispatches: 0,
    releasedLeases: 0,
  })),
}));
vi.mock("../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
}));
vi.mock("../../src/lifecycle.js", () => ({
  initClawforce: vi.fn(),
  shutdownClawforce: vi.fn(async () => {}),
}));
vi.mock("../../src/project.js", () => ({
  getAgentConfig: vi.fn((agentId: string) => ({
    projectId: "alpha",
    projectDir: "/tmp/alpha",
    config: { title: agentId },
  })),
  getRegisteredAgentIds: vi.fn(() => ["lead"]),
}));
vi.mock("../../src/sqlite-driver.js", () => ({
  probeDatabaseDriverCompatibility: vi.fn(() => ({ ok: true })),
}));

const { createManagedRuntimeController } = await import("../../adapters/openclaw-bootstrap.js");
const { syncAgentsToOpenClaw } = await import("../../src/agent-sync.js");
const { initializeAllDomains, syncManagedDomainRoots } = await import("../../src/config/init.js");
const { clearOpenClawConfigCache, setOpenClawConfig } = await import("../../src/config/openclaw-reader.js");
const { startConfigWatcher, stopConfigWatcher } = await import("../../src/config/watcher.js");
const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");
const { recoverProject } = await import("../../src/dispatch/restart-recovery.js");
const { disableAgent } = await import("../../src/enforcement/disabled-store.js");
const { initClawforce, shutdownClawforce } = await import("../../src/lifecycle.js");
const { getAgentConfig, getRegisteredAgentIds } = await import("../../src/project.js");
const { probeDatabaseDriverCompatibility } = await import("../../src/sqlite-driver.js");

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createRuntimeConfig() {
  return {
    loadConfig: vi.fn(() => ({ agents: { list: [] } })),
    writeConfigFile: vi.fn(async () => {}),
  };
}

describe("createManagedRuntimeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bootstraps once, reloads domains, syncs agents, and starts the watcher", async () => {
    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: true,
      },
      logger,
      runtimeConfig,
    });

    await controller.bootstrap("startup");
    await controller.bootstrap("startup");

    expect(initClawforce).toHaveBeenCalledTimes(1);
    expect(initClawforce).toHaveBeenCalledWith({
      enabled: true,
      projectsDir: "/tmp/projects",
      sweepIntervalMs: 60_000,
      defaultMaxRetries: 3,
      verificationRequired: true,
      autoInitialize: false,
    });
    expect(syncManagedDomainRoots).toHaveBeenCalledWith(["/tmp/configs"]);
    expect(initializeAllDomains).toHaveBeenCalledTimes(1);
    expect(initializeAllDomains).toHaveBeenCalledWith("/tmp/configs");
    expect(getRegisteredAgentIds).toHaveBeenCalledTimes(1);
    expect(getAgentConfig).toHaveBeenCalledWith("lead");
    expect(syncAgentsToOpenClaw).toHaveBeenCalledTimes(1);
    expect(setOpenClawConfig).toHaveBeenCalledWith({ agents: { list: [] } });
    expect(recoverProject).toHaveBeenCalledWith("alpha");
    expect(startConfigWatcher).toHaveBeenCalledTimes(1);
  });

  it("binds and unbinds managed roots through OpenClaw config", async () => {
    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        managedRoots: ["/tmp/configs"],
        discoverWorkspaceRoots: false,
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: false,
      },
      logger,
      runtimeConfig,
    });

    await controller.bindManagedRoot("/tmp/rentright/.clawforce", "test bind");
    expect(runtimeConfig.writeConfigFile).toHaveBeenCalledTimes(1);
    const boundConfig = runtimeConfig.writeConfigFile.mock.calls[0]![0] as {
      plugins?: { entries?: Record<string, { config?: { managedRoots?: string[] } }> };
    };
    expect(boundConfig.plugins?.entries?.clawforce?.config?.managedRoots).toContain("/tmp/configs");
    expect(boundConfig.plugins?.entries?.clawforce?.config?.managedRoots).toContain("/tmp/rentright/.clawforce");

    runtimeConfig.loadConfig.mockReturnValue(boundConfig);
    await controller.unbindManagedRoot("/tmp/rentright/.clawforce", "test unbind");
    const unboundConfig = runtimeConfig.writeConfigFile.mock.calls[1]![0] as {
      plugins?: { entries?: Record<string, { config?: { managedRoots?: string[] } }> };
    };
    expect(unboundConfig.plugins?.entries?.clawforce?.config?.managedRoots).toEqual(["/tmp/configs"]);
  });

  it("refreshes cached OpenClaw config even when agent sync is disabled", async () => {
    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: false,
      },
      logger,
      runtimeConfig,
    });

    await controller.bootstrap("startup");

    expect(syncAgentsToOpenClaw).not.toHaveBeenCalled();
    expect(setOpenClawConfig).toHaveBeenCalledWith({ agents: { list: [] } });
  });

  it("reports hosted runtime compatibility failures without syncing agents or watchers", async () => {
    vi.mocked(probeDatabaseDriverCompatibility).mockReturnValueOnce({
      ok: false,
      code: "node_abi_mismatch",
      message: "native addon mismatch",
      guidance: "Rebuild dependencies with the host runtime.",
    });

    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: true,
      },
      logger,
      runtimeConfig,
    });

    await controller.bootstrap("startup");

    expect(syncManagedDomainRoots).toHaveBeenCalledWith([]);
    expect(initializeAllDomains).not.toHaveBeenCalled();
    expect(syncAgentsToOpenClaw).not.toHaveBeenCalled();
    expect(startConfigWatcher).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("compatibility error: native addon mismatch"),
    );
  });

  it("disables an agent through the persistent store and emits diagnostics", async () => {
    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: true,
      },
      logger,
      runtimeConfig,
    });

    await controller.handleDisable("lead");

    expect(disableAgent).toHaveBeenCalledWith("alpha", "lead", "Underperforming or unresponsive");
    expect(emitDiagnosticEvent).toHaveBeenCalledWith({ type: "agent_disabled", agentId: "lead" });
  });

  it("stops watcher/runtime state cleanly and clears cached config", async () => {
    const logger = createLogger();
    const runtimeConfig = createRuntimeConfig();
    const controller = createManagedRuntimeController({
      config: {
        projectsDir: "/tmp/projects",
        managedConfigDir: "/tmp/configs",
        sweepIntervalMs: 60_000,
        defaultMaxRetries: 3,
        syncAgents: true,
      },
      logger,
      runtimeConfig,
    });

    await controller.bootstrap("startup");
    await controller.stop();

    expect(stopConfigWatcher).toHaveBeenCalledTimes(1);
    expect(clearOpenClawConfigCache).toHaveBeenCalledTimes(1);
    expect(shutdownClawforce).toHaveBeenCalledTimes(1);
  });
});
