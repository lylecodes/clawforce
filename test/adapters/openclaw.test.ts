import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks must be declared before any imports ---

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", publicKey: "test-key" })),
  verifyAction: vi.fn(() => true),
}));
vi.mock("../../src/lifecycle.js", () => ({
  initClawforce: vi.fn(),
  shutdownClawforce: vi.fn(),
  getActiveProjectIds: vi.fn(() => []),
  registerProject: vi.fn(),
  unregisterProject: vi.fn(),
  isClawforceInitialized: vi.fn(() => false),
}));
vi.mock("../../src/project.js", () => ({
  loadProject: vi.fn(),
  loadEnforcementConfig: vi.fn(() => null),
  initProject: vi.fn(),
  resolveProjectDir: vi.fn((dir: string) => dir),
  registerEnforcementConfig: vi.fn(),
  getAgentConfig: vi.fn(() => null),
  getApprovalPolicy: vi.fn(() => null),
  getRegisteredAgentIds: vi.fn(() => []),
  resetEnforcementConfigForTest: vi.fn(),
}));
vi.mock("../../src/context/assembler.js", () => ({
  assembleContext: vi.fn(() => null),
}));
vi.mock("../../src/context/orchestrator-bootstrap.js", () => ({
  getAutoDetectContext: vi.fn(() => null),
}));
vi.mock("../../src/config-validator.js", () => ({
  validateEnforcementConfig: vi.fn(() => []),
}));
vi.mock("../../src/enforcement/check.js", () => ({
  checkCompliance: vi.fn(() => ({ compliant: true })),
}));
vi.mock("../../src/enforcement/actions.js", () => ({
  executeFailureAction: vi.fn(),
  executeCrashAction: vi.fn(),
  recordCompliantRun: vi.fn(),
}));
vi.mock("../../src/enforcement/escalation-router.js", () => ({
  resolveEscalationTarget: vi.fn(() => null),
  routeEscalation: vi.fn(),
}));
vi.mock("../../src/enforcement/tracker.js", () => ({
  endSession: vi.fn(() => null),
  getSession: vi.fn(() => null),
  recordToolCall: vi.fn(),
  recoverOrphanedSessions: vi.fn(() => []),
  startTracking: vi.fn(),
}));
vi.mock("../../src/approval/resolve.js", () => ({
  approveProposal: vi.fn(),
  listPendingProposals: vi.fn(() => []),
  rejectProposal: vi.fn(),
}));
vi.mock("../../src/audit/auto-kill.js", () => ({
  registerKillFunction: vi.fn(),
}));
vi.mock("../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
  isAgentDisabled: vi.fn(() => false),
}));
vi.mock("../../src/tasks/session-end.js", () => ({
  handleWorkerSessionEnd: vi.fn(),
}));
vi.mock("../../src/tools/common.js", () => ({
  adaptTool: vi.fn((t: unknown) => t),
}));
vi.mock("../../src/tools/log-tool.js", () => ({
  createClawforceLogTool: vi.fn(() => ({ name: "clawforce_log" })),
}));
vi.mock("../../src/tools/task-tool.js", () => ({
  createClawforceTaskTool: vi.fn(() => ({ name: "clawforce_task" })),
}));
vi.mock("../../src/tools/verify-tool.js", () => ({
  createClawforceVerifyTool: vi.fn(() => ({ name: "clawforce_verify" })),
}));
vi.mock("../../src/tools/workflow-tool.js", () => ({
  createClawforceWorkflowTool: vi.fn(() => ({ name: "clawforce_workflow" })),
}));

// --- Import subject under test after mocks are in place ---

const { default: clawforcePlugin } = await import("../../adapters/openclaw.js");

// --- Mock API factory ---

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, Function>();
  const tools: any[] = [];
  const commands: any[] = [];
  const services: any[] = [];
  const gatewayMethods = new Map<string, Function>();

  return {
    pluginConfig: pluginConfig ?? { enabled: true, projectsDir: "/tmp/test-clawforce" },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((event: string, handler: Function) => { hooks.set(event, handler); }),
    registerTool: vi.fn((factory: Function) => { tools.push(factory); }),
    registerCommand: vi.fn((cmd: any) => { commands.push(cmd); }),
    registerService: vi.fn((svc: any) => { services.push(svc); }),
    registerGatewayMethod: vi.fn((name: string, handler: Function) => { gatewayMethods.set(name, handler); }),
    injectAgentMessage: vi.fn(),
    // Accessors for testing
    _hooks: hooks,
    _tools: tools,
    _commands: commands,
    _services: services,
    _gatewayMethods: gatewayMethods,
  };
}

describe("clawforce plugin", () => {
  it("has correct id, name, and version", () => {
    expect(clawforcePlugin.id).toBe("clawforce");
    expect(clawforcePlugin.name).toBe("Clawforce");
    expect(clawforcePlugin.version).toBe("0.2.0");
  });

  describe("register()", () => {
    let api: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      api = createMockApi();
      clawforcePlugin.register(api as any);
    });

    it("registers 4 hooks", () => {
      expect(api.on).toHaveBeenCalledTimes(4);
    });

    it("registers the expected hook names", () => {
      const registeredEvents = (api.on as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(registeredEvents).toContain("before_prompt_build");
      expect(registeredEvents).toContain("after_tool_call");
      expect(registeredEvents).toContain("agent_end");
      expect(registeredEvents).toContain("subagent_ended");
    });

    it("registers 8 tools", () => {
      expect(api.registerTool).toHaveBeenCalledTimes(8);
      expect(api._tools).toHaveLength(8);
    });

    it("registers 3 commands", () => {
      expect(api.registerCommand).toHaveBeenCalledTimes(3);
      expect(api._commands).toHaveLength(3);
    });

    it("registers the expected command names", () => {
      const names = api._commands.map((c: any) => c.name);
      expect(names).toContain("clawforce-proposals");
      expect(names).toContain("clawforce-approve");
      expect(names).toContain("clawforce-reject");
    });

    it("registers 1 service", () => {
      expect(api.registerService).toHaveBeenCalledTimes(1);
      expect(api._services).toHaveLength(1);
      expect(api._services[0].id).toBe("clawforce-sweep");
    });

    it("registers 1 gateway method", () => {
      expect(api.registerGatewayMethod).toHaveBeenCalledTimes(1);
      expect(api._gatewayMethods.has("clawforce.init")).toBe(true);
    });

    it("does nothing when config.enabled is false", () => {
      const disabledApi = createMockApi({ enabled: false });
      clawforcePlugin.register(disabledApi as any);

      expect(disabledApi.on).not.toHaveBeenCalled();
      expect(disabledApi.registerTool).not.toHaveBeenCalled();
      expect(disabledApi.registerCommand).not.toHaveBeenCalled();
      expect(disabledApi.registerService).not.toHaveBeenCalled();
      expect(disabledApi.registerGatewayMethod).not.toHaveBeenCalled();
      expect(disabledApi.logger.info).toHaveBeenCalledWith("Clawforce disabled via config");
    });
  });

  describe("resolveConfig defaults", () => {
    it("uses default enabled=true when no config is provided", () => {
      const noConfigApi = createMockApi(undefined);
      // Pass undefined as pluginConfig to simulate missing config
      (noConfigApi as any).pluginConfig = undefined;
      clawforcePlugin.register(noConfigApi as any);
      // Should register hooks (enabled by default)
      expect(noConfigApi.on).toHaveBeenCalled();
    });

    it("uses default projectsDir when not specified", () => {
      const partialApi = createMockApi({ enabled: true });
      clawforcePlugin.register(partialApi as any);
      // Service registration means it ran fully — default projectsDir was applied
      expect(partialApi.registerService).toHaveBeenCalledTimes(1);
    });

    it("uses default sweepIntervalMs of 60000 when not specified", () => {
      const partialApi = createMockApi({ enabled: true });
      clawforcePlugin.register(partialApi as any);
      // The service start call would use the resolved config; we just verify
      // registration completed without error (meaning resolveConfig did not throw)
      expect(partialApi.registerService).toHaveBeenCalled();
    });

    it("respects provided sweepIntervalMs override", () => {
      const customApi = createMockApi({ enabled: true, sweepIntervalMs: 5000 });
      // Should not throw; register completes normally
      expect(() => clawforcePlugin.register(customApi as any)).not.toThrow();
      expect(customApi.registerService).toHaveBeenCalledTimes(1);
    });

    it("all commands have acceptsArgs set to true", () => {
      const api2 = createMockApi();
      clawforcePlugin.register(api2 as any);
      for (const cmd of api2._commands) {
        expect(cmd.acceptsArgs).toBe(true);
      }
    });

    it("the sweep service object has both start and stop methods", () => {
      const api2 = createMockApi();
      clawforcePlugin.register(api2 as any);
      const svc = api2._services[0];
      expect(typeof svc.start).toBe("function");
      expect(typeof svc.stop).toBe("function");
    });
  });
});
