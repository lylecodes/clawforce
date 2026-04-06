import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/dashboard/server.js", () => ({
  createDashboardServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

const { serveDashboard } = await import("../../src/dashboard/plugin.js");
const { Clawforce } = await import("../../src/sdk/index.js");
const { createDashboardServer } = await import("../../src/dashboard/server.js");
const { safeLog } = await import("../../src/diagnostics.js");

describe("serveDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the existing dashboard server with the provided options", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cf = Clawforce.init({ domain: "proj1" });

    serveDashboard(cf, { port: 4321, host: "127.0.0.1", dashboardDir: "/tmp/dash" });
    await Promise.resolve();

    expect(createDashboardServer).toHaveBeenCalledWith({
      port: 4321,
      host: "127.0.0.1",
      dashboardDir: "/tmp/dash",
    });
    const server = (createDashboardServer as any).mock.results[0]!.value;
    expect(server.start).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '[clawforce-dashboard] Serving dashboard for domain "proj1" at http://127.0.0.1:4321/clawforce/',
    );

    logSpy.mockRestore();
  });

  it("logs startup failures through diagnostics", async () => {
    const start = vi.fn().mockRejectedValue(new Error("bind failed"));
    (createDashboardServer as any).mockReturnValueOnce({
      start,
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const cf = Clawforce.init({ domain: "proj1" });
    serveDashboard(cf);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(start).toHaveBeenCalled();
    expect(safeLog).toHaveBeenCalled();
  });
});
