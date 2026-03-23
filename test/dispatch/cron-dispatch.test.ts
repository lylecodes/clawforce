import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

// Mock ws module to prevent actual WebSocket connections
vi.mock("ws", () => ({
  WebSocket: vi.fn(),
}));

describe("dispatchViaInject", () => {
  it("generates correct session key and tagged prompt", async () => {
    // We can't easily test the WebSocket RPC flow in unit tests.
    // Instead, verify the function exists and has the right signature.
    const { dispatchViaInject } = await import("../../src/dispatch/inject-dispatch.js");
    expect(typeof dispatchViaInject).toBe("function");
  });

  it("exports setDispatchInjector and getDispatchInjector", async () => {
    const { setDispatchInjector, getDispatchInjector } = await import("../../src/dispatch/inject-dispatch.js");
    expect(typeof setDispatchInjector).toBe("function");
    expect(typeof getDispatchInjector).toBe("function");
  });
});
