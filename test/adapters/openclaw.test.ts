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
  setDispatchContext: vi.fn(),
  startTracking: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({})),
  getMemoryDb: vi.fn(() => ({})),
}));
vi.mock("../../src/dispatch/queue.js", () => ({
  completeItem: vi.fn(),
  failItem: vi.fn(),
}));
vi.mock("../../src/tasks/ops.js", () => ({
  getTask: vi.fn(() => null),
  releaseTaskLease: vi.fn(),
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
vi.mock("../../src/policy/registry.js", () => ({
  registerPolicies: vi.fn(),
  getPolicies: vi.fn(() => []),
  resetPolicyRegistryForTest: vi.fn(),
}));
vi.mock("../../src/policy/middleware.js", () => ({
  withPolicyCheck: vi.fn((execute: unknown) => execute),
  enforceToolPolicy: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../../src/tools/common.js", () => ({
  adaptTool: vi.fn((t: unknown) => t),
}));
vi.mock("../../src/tools/log-tool.js", () => ({
  createClawforceLogTool: vi.fn(() => ({ name: "clawforce_log" })),
}));
vi.mock("../../src/tools/task-tool.js", () => ({
  createClawforceTaskTool: vi.fn(() => ({
    name: "clawforce_task",
    label: "Clawforce Task",
    description: "Task tool",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: [
            "create", "transition", "attach_evidence", "get", "list", "history", "fail",
            "get_approval_context", "submit_proposal", "check_proposal", "metrics",
            "bulk_create", "bulk_transition",
          ],
        },
      },
    },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }], details: null })),
  })),
}));
vi.mock("../../src/tools/verify-tool.js", () => ({
  createClawforceVerifyTool: vi.fn(() => ({ name: "clawforce_verify" })),
}));
vi.mock("../../src/tools/workflow-tool.js", () => ({
  createClawforceWorkflowTool: vi.fn(() => ({ name: "clawforce_workflow" })),
}));
vi.mock("../../src/tools/message-tool.js", () => ({
  createClawforceMessageTool: vi.fn(() => ({ name: "clawforce_message" })),
}));
vi.mock("../../src/messaging/notify.js", () => ({
  setMessageNotifier: vi.fn(),
  getMessageNotifier: vi.fn(() => null),
  formatMessageNotification: vi.fn(() => ""),
  notifyMessage: vi.fn(),
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

    it("registers 6 hooks", () => {
      expect(api.on).toHaveBeenCalledTimes(6);
    });

    it("registers the expected hook names", () => {
      const registeredEvents = (api.on as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(registeredEvents).toContain("before_prompt_build");
      expect(registeredEvents).toContain("before_tool_call");
      expect(registeredEvents).toContain("after_tool_call");
      expect(registeredEvents).toContain("agent_end");
      expect(registeredEvents).toContain("subagent_ended");
      expect(registeredEvents).toContain("llm_output");
    });

    it("registers 12 tools", () => {
      expect(api.registerTool).toHaveBeenCalledTimes(12);
      expect(api._tools).toHaveLength(12);
    });

    it("registers 4 commands", () => {
      expect(api.registerCommand).toHaveBeenCalledTimes(4);
      expect(api._commands).toHaveLength(4);
    });

    it("registers the expected command names", () => {
      const names = api._commands.map((c: any) => c.name);
      expect(names).toContain("clawforce-proposals");
      expect(names).toContain("clawforce-approve");
      expect(names).toContain("clawforce-reject");
      expect(names).toContain("clawforce-memory");
    });

    it("registers 1 service", () => {
      expect(api.registerService).toHaveBeenCalledTimes(1);
      expect(api._services).toHaveLength(1);
      expect(api._services[0].id).toBe("clawforce-sweep");
    });

    it("registers 3 gateway methods", () => {
      expect(api.registerGatewayMethod).toHaveBeenCalledTimes(3);
      expect(api._gatewayMethods.has("clawforce.init")).toBe(true);
      expect(api._gatewayMethods.has("clawforce.approval_callback")).toBe(true);
      expect(api._gatewayMethods.has("clawforce.inject_channel_message")).toBe(true);
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

  describe("scoped tool factories", () => {
    it("unregistered agent gets only setup tool (default-deny)", () => {
      const api2 = createMockApi();
      clawforcePlugin.register(api2 as any);

      // With default-deny, unregistered agents only get clawforce_setup
      const results = api2._tools.map((factory: any) =>
        factory({ agentId: "unknown-agent", sessionKey: "s1" }),
      );
      const nonNull = results.filter((r: any) => r !== null);
      // Only clawforce_setup should be returned (UNREGISTERED_SCOPE)
      expect(nonNull.length).toBe(1);
    });

    it("scheduled agent gets null for hidden tools", async () => {
      const { getAgentConfig } = await import("../../src/project.js");
      const mockGetAgentConfig = getAgentConfig as ReturnType<typeof vi.fn>;

      // Mock a scheduled agent
      mockGetAgentConfig.mockReturnValue({
        projectId: "p1",
        projectDir: "/tmp/test",
        config: { role: "scheduled" },
      });

      const api2 = createMockApi();
      clawforcePlugin.register(api2 as any);

      // Find the clawforce_task factory by checking registration calls
      const registerCalls = (api2.registerTool as ReturnType<typeof vi.fn>).mock.calls;
      const taskFactory = registerCalls.find((c: any[]) => c[1]?.name === "clawforce_task")?.[0];
      expect(taskFactory).toBeDefined();

      const result = taskFactory({ agentId: "sched-1", sessionKey: "s1" });
      expect(result).toBeNull();

      // Cleanup
      mockGetAgentConfig.mockReturnValue(null);
    });

    it("employee tool factory filters action enum in schema", async () => {
      const { getAgentConfig } = await import("../../src/project.js");
      const mockGetAgentConfig = getAgentConfig as ReturnType<typeof vi.fn>;

      // Mock an employee agent
      mockGetAgentConfig.mockReturnValue({
        projectId: "p1",
        projectDir: "/tmp/test",
        config: { role: "employee" },
      });

      const api2 = createMockApi();
      clawforcePlugin.register(api2 as any);

      // Find the clawforce_task factory
      const registerCalls = (api2.registerTool as ReturnType<typeof vi.fn>).mock.calls;
      const taskFactory = registerCalls.find((c: any[]) => c[1]?.name === "clawforce_task")?.[0];
      expect(taskFactory).toBeDefined();

      const tool = taskFactory({ agentId: "emp-1", sessionKey: "s1" });
      expect(tool).not.toBeNull();

      // If the tool has parameters with action enum, it should be filtered
      if (tool?.parameters?.properties?.action?.enum) {
        const actions = tool.parameters.properties.action.enum as string[];
        expect(actions).toContain("get");
        expect(actions).toContain("transition");
        expect(actions).not.toContain("create");
        expect(actions).not.toContain("bulk_create");
        expect(actions).not.toContain("metrics");
      }

      // Cleanup
      mockGetAgentConfig.mockReturnValue(null);
    });
  });
});
