import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processAndDispatchMock = vi.fn();
const initClawforceMock = vi.fn();
const shutdownClawforceMock = vi.fn();
const runEntityChecksMock = vi.fn();
const listEntityCheckRunsMock = vi.fn();
const getClawforceHomeMock = vi.fn(() => "/tmp/clawforce-home");

vi.mock("../../src/dispatch/dispatcher.js", () => ({
  processAndDispatch: processAndDispatchMock,
}));

vi.mock("../../src/lifecycle.js", () => ({
  initClawforce: initClawforceMock,
  shutdownClawforce: shutdownClawforceMock,
}));

vi.mock("../../src/entities/checks.js", () => ({
  runEntityChecks: runEntityChecksMock,
  listEntityCheckRuns: listEntityCheckRunsMock,
}));

vi.mock("../../src/paths.js", () => ({
  getClawforceHome: getClawforceHomeMock,
}));

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

const cli = await import("../../src/cli.js");

let logOutput: string[];
const originalLog = console.log;

function captureStart(): void {
  logOutput = [];
  console.log = (...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  };
}

function captureStop(): string {
  console.log = originalLog;
  return logOutput.join("\n");
}

describe("cli entities check", () => {
  beforeEach(() => {
    captureStart();
    vi.clearAllMocks();
    shutdownClawforceMock.mockResolvedValue(undefined);
    runEntityChecksMock.mockReturnValue({
      entity: {
        id: "entity-la",
        kind: "jurisdiction",
        title: "Los Angeles",
      },
      results: [
        {
          checkId: "pipeline_health",
          status: "issues",
          issueCount: 1,
          exitCode: 0,
          durationMs: 123,
          issues: [],
        },
      ],
    });
  });

  afterEach(() => {
    captureStop();
  });

  it("drains follow-on events and includes the count in JSON output", async () => {
    processAndDispatchMock
      .mockResolvedValueOnce({ eventsProcessed: 2, dispatched: 1 })
      .mockResolvedValueOnce({ eventsProcessed: 1, dispatched: 0 })
      .mockResolvedValueOnce({ eventsProcessed: 0, dispatched: 0 });

    await cli.cmdEntitiesManifest("rentright-data", [
      "entities",
      "check",
      "--entity-id=entity-la",
      "--actor=data-director",
    ], true);

    expect(initClawforceMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      projectsDir: "/tmp/clawforce-home",
      sweepIntervalMs: 0,
    }));
    expect(runEntityChecksMock).toHaveBeenCalledWith("rentright-data", "entity-la", {
      actor: "data-director",
      trigger: "cli",
      sourceType: "cli_command",
      sourceId: "cf entities check",
      checkIds: undefined,
    });
    expect(processAndDispatchMock).toHaveBeenCalledTimes(3);
    expect(processAndDispatchMock).toHaveBeenNthCalledWith(1, "rentright-data");
    expect(processAndDispatchMock).toHaveBeenNthCalledWith(2, "rentright-data");
    expect(processAndDispatchMock).toHaveBeenNthCalledWith(3, "rentright-data");
    expect(shutdownClawforceMock).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(logOutput.join("\n")) as Record<string, unknown>;
    expect(parsed.followOnEventsProcessed).toBe(3);
    expect(parsed.followOnDispatches).toBe(1);
    expect((parsed.entity as Record<string, unknown>).title).toBe("Los Angeles");
  });

  it("surfaces a foreign controller skip in JSON output", async () => {
    processAndDispatchMock.mockResolvedValueOnce({
      eventsProcessed: 0,
      dispatched: 0,
      controller: {
        skipped: true,
        ownerId: "controller:foreign",
        ownerLabel: "foreign-owner",
        purpose: "lifecycle",
        expiresAt: 123,
      },
    });

    await cli.cmdEntitiesManifest("rentright-data", [
      "entities",
      "check",
      "--entity-id=entity-la",
      "--actor=data-director",
    ], true);

    expect(processAndDispatchMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logOutput.join("\n")) as Record<string, unknown>;
    expect((parsed.followOnController as Record<string, unknown>).skipped).toBe(true);
    expect((parsed.followOnController as Record<string, unknown>).ownerLabel).toBe("foreign-owner");
  });
});
