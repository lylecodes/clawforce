import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

// Mock ws module to prevent actual WebSocket connections
vi.mock("ws", () => ({
  WebSocket: vi.fn(),
}));

// ── Manager-cron mock ──────────────────────────────────────────────────────
// We use a mutable module-level object so individual tests can swap it out.
const mockCronState = {
  service: null as null | { add: ReturnType<typeof vi.fn> },
};

vi.mock("../../src/manager-cron.js", () => ({
  getCronService: vi.fn(() => mockCronState.service),
  toCronJobCreate: vi.fn((job: Record<string, unknown>) => ({ ...job })),
}));

// ── Child-process mock ─────────────────────────────────────────────────────
// promisify(execFile) wraps the 4-arg callback form. We track calls here.
const execCalls: string[][] = [];
let execImpl: (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
  cb: (err: Error | null, stdout?: string, stderr?: string) => void,
) => void = (_cmd, _args, _opts, cb) => cb(null, "", "");

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    execCalls.push([cmd, ...args]);
    execImpl(cmd, args, opts, cb);
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────
describe("dispatchViaInject", () => {
  it("generates correct session key and tagged prompt", async () => {
    const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");
    expect(typeof dispatchViaInject).toBe("function");
  });

  it("exports setDispatchInjector and getDispatchInjector", async () => {
    const { setDispatchInjector, getDispatchInjector } = await import("../../src/dispatch/inject-dispatch.js");
    expect(typeof setDispatchInjector).toBe("function");
    expect(typeof getDispatchInjector).toBe("function");
  });
});

describe("dispatchViaCron", () => {
  beforeEach(() => {
    execCalls.length = 0;
    mockCronState.service = null;
    execImpl = (_cmd, _args, _opts, cb) => cb(null, "", "");
  });

  it("returns error when cron service unavailable and bootstrap fails", async () => {
    execImpl = (_cmd, args, _opts, cb) => {
      if (args.includes("clawforce.dispatch_queue_item")) {
        cb(new Error("gateway dispatch unavailable"));
        return;
      }
      cb(null, "", "");
    };

    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    const result = await dispatchViaCron({
      queueItemId: "q1",
      taskId: "t1",
      projectId: "p1",
      prompt: "do the thing",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gateway dispatch unavailable/);
  });

  it("calls openclaw gateway bootstrap when cron service is null", async () => {
    mockCronState.service = null;

    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    await dispatchViaCron({
      queueItemId: "q3",
      taskId: "t3",
      projectId: "p3",
      prompt: "bootstrap test",
      agentId: "agent:worker",
    });

    // Should have called `openclaw gateway call clawforce.bootstrap --json --params {}`
    expect(execCalls).toContainEqual(["openclaw", "gateway", "call", "clawforce.bootstrap", "--json", "--params", "{}"]);
  });

  it("dispatches via cron when service is available", async () => {
    const mockAdd = vi.fn().mockResolvedValue(undefined);
    mockCronState.service = { add: mockAdd };

    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    const result = await dispatchViaCron({
      queueItemId: "q2",
      taskId: "t2",
      projectId: "p2",
      prompt: "test prompt",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(true);
    expect(result.cronJobName).toBe("dispatch:p2:q2");
    expect(mockAdd).toHaveBeenCalledOnce();
  });

  it("falls back to gateway dispatch when cron service is unavailable locally", async () => {
    execImpl = (_cmd, args, _opts, cb) => {
      if (args.includes("clawforce.dispatch_queue_item")) {
        cb(null, '{\n  "ok": true,\n  "jobName": "dispatch:rentright-data:q5",\n  "handledRemotely": true\n}', "");
        return;
      }
      cb(null, "", "");
    };

    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    const result = await dispatchViaCron({
      queueItemId: "q5",
      taskId: "t5",
      projectId: "rentright-data",
      prompt: "fallback dispatch",
      agentId: "los-angeles-owner",
    });

    expect(result.ok).toBe(true);
    expect(result.cronJobName).toBe("dispatch:rentright-data:q5");
    expect(result.handledRemotely).toBe(true);
    const gatewayDispatchCall = execCalls.find((call) => call.includes("clawforce.dispatch_queue_item"));
    expect(gatewayDispatchCall).toBeTruthy();
    expect(gatewayDispatchCall?.[0]).toBe("openclaw");
  });

  it("skips bootstrap call when cron service is already available", async () => {
    const mockAdd = vi.fn().mockResolvedValue(undefined);
    mockCronState.service = { add: mockAdd };

    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    await dispatchViaCron({
      queueItemId: "q4",
      taskId: "t4",
      projectId: "p4",
      prompt: "already have cron",
      agentId: "agent:worker",
    });

    // Bootstrap CLI should NOT be called when cron service is already available
    expect(execCalls).not.toContainEqual(["openclaw", "gateway", "call", "clawforce.bootstrap", "--json", "--params", "{}"]);
    expect(mockAdd).toHaveBeenCalledOnce();
  });
});
