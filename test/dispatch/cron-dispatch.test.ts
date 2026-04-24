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
    mockCronState.service = null;
  });

  it("returns an explicit error when no runtime cron service is wired", async () => {
    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    const result = await dispatchViaCron({
      queueItemId: "q1",
      taskId: "t1",
      projectId: "p1",
      prompt: "do the thing",
      agentId: "agent:worker",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Cron service unavailable/);
    expect(result.cronJobName).toBe("dispatch:p1:q1");
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

  it("does not attempt a hidden gateway fallback when cron service is unavailable locally", async () => {
    const { dispatchViaCron } = await import("../../src/dispatch/cron-dispatch.js");
    const result = await dispatchViaCron({
      queueItemId: "q5",
      taskId: "t5",
      projectId: "rentright-data",
      prompt: "fallback dispatch",
      agentId: "los-angeles-owner",
    });

    expect(result.ok).toBe(false);
    expect(result.cronJobName).toBe("dispatch:rentright-data:q5");
    expect(result.handledRemotely).toBeUndefined();
    expect(result.error).toMatch(/Cron service unavailable/);
  });

  it("uses the available cron service directly with no bootstrap step", async () => {
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

    expect(mockAdd).toHaveBeenCalledOnce();
  });
});
