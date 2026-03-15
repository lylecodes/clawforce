import { describe, expect, it, vi, beforeEach } from "vitest";
import { SSEManager } from "../../src/dashboard/sse.js";
import type { SSEEventType } from "../../src/dashboard/sse.js";

describe("SSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  it("tracks connected clients by domain", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes as any);
    expect(manager.clientCount("test-domain")).toBe(1);
  });

  it("sends SSE headers and connection event on addClient", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes as any);
    expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(mockRes.writtenData).toContain("event: connected");
    expect(mockRes.writtenData).toContain("clientId");
  });

  it("removes client on close", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes as any);
    // Simulate close
    mockRes.emit("close");
    expect(manager.clientCount("test-domain")).toBe(0);
  });

  it("broadcasts typed events to domain clients", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes as any);
    manager.broadcast("test-domain", "budget:update", { spent: 100 });
    expect(mockRes.writtenData).toContain("event: budget:update");
    expect(mockRes.writtenData).toContain('"spent":100');
  });

  it("does not send to clients on different domains", () => {
    const mockRes = createMockResponse();
    manager.addClient("other-domain", mockRes as any);
    // Clear the initial connection event data
    mockRes.writtenData = "";
    manager.broadcast("test-domain", "task:update", {});
    expect(mockRes.writtenData).toBe("");
  });

  it("supports multiple clients on the same domain", () => {
    const mockRes1 = createMockResponse();
    const mockRes2 = createMockResponse();
    manager.addClient("test-domain", mockRes1 as any);
    manager.addClient("test-domain", mockRes2 as any);
    expect(manager.clientCount("test-domain")).toBe(2);

    // Clear initial data
    mockRes1.writtenData = "";
    mockRes2.writtenData = "";

    manager.broadcast("test-domain", "agent:status", { id: "a1" });
    expect(mockRes1.writtenData).toContain("event: agent:status");
    expect(mockRes2.writtenData).toContain("event: agent:status");
  });

  it("returns 0 for unknown domain", () => {
    expect(manager.clientCount("unknown")).toBe(0);
  });

  it("handles removeClient for nonexistent domain gracefully", () => {
    // Should not throw
    manager.removeClient("nonexistent", "any-id");
  });

  it("removes broken clients on broadcast error", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes as any);

    // Make write throw
    mockRes.write.mockImplementation(() => {
      throw new Error("connection reset");
    });

    manager.broadcast("test-domain", "task:update", {});
    expect(manager.clientCount("test-domain")).toBe(0);
  });
});

function createMockResponse() {
  const res = {
    writtenData: "",
    writeHead: vi.fn(),
    write: vi.fn((data: string) => {
      res.writtenData += data;
      return true;
    }),
    end: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    headersSent: false,
    _closeHandlers: [] as Function[],
  };
  res.on.mockImplementation((event: string, handler: Function) => {
    if (event === "close") res._closeHandlers.push(handler);
    return res;
  });
  res.emit.mockImplementation((event: string) => {
    if (event === "close") res._closeHandlers.forEach((h) => h());
  });
  return res;
}
