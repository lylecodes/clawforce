import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockRun = vi.fn();
const mockPrepare = vi.fn(() => ({ get: mockGet, run: mockRun, all: vi.fn(() => []) }));

vi.mock("../../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: mockPrepare,
  })),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("../../../src/audit.js", () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

const mockIngestEvent = vi.fn();
vi.mock("../../../src/events/store.js", () => ({
  ingestEvent: mockIngestEvent,
}));

const mockWriteDomainContextFile = vi.fn();
class MockContextFileError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
vi.mock("../../../src/app/queries/context-files.js", () => ({
  writeDomainContextFile: mockWriteDomainContextFile,
  ContextFileError: MockContextFileError,
}));

const {
  runIngestProjectEventCommand,
  runUpdateProjectBudgetLimitCommand,
  runWriteProjectContextFileCommand,
  setProjectBudgetLimit,
} = await import("../../../src/app/commands/project-controls.js");

describe("project-controls", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockRun.mockReset();
    mockPrepare.mockClear();
    mockWriteAuditEntry.mockReset();
    mockIngestEvent.mockReset();
    mockWriteDomainContextFile.mockReset();
  });

  it("updates existing project budget row and writes audit entry", () => {
    mockGet.mockReturnValueOnce({ id: "budget-1", daily_limit_cents: 20000 });

    const result = setProjectBudgetLimit("proj1", 50000, "dashboard:test");

    expect(result).toEqual({ ok: true, previousLimit: 20000, newLimit: 50000 });
    expect(mockRun).toHaveBeenCalledWith(50000, expect.any(Number), "budget-1");
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj1",
        actor: "dashboard:test",
        action: "budget.update_limit",
        targetType: "budget",
        targetId: "project",
      }),
      expect.any(Object),
    );
  });

  it("inserts project budget row when missing", () => {
    mockGet.mockReturnValueOnce(undefined);

    const result = setProjectBudgetLimit("proj1", 30000);

    expect(result).toEqual({ ok: true, previousLimit: null, newLimit: 30000 });
    expect(mockRun).toHaveBeenCalledWith(
      expect.stringMatching(/^budget-project-/),
      "proj1",
      30000,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
  });

  it("rejects invalid project budget payloads", () => {
    const result = runUpdateProjectBudgetLimitCommand("proj1", { dailyLimitCents: 12.5 });
    expect(result).toEqual({
      status: 400,
      body: { error: "dailyLimitCents must be an integer number" },
    });
  });

  it("ingests webhook events through the command boundary", () => {
    mockIngestEvent.mockReturnValueOnce({ id: "evt-1", deduplicated: false });

    const result = runIngestProjectEventCommand("proj1", {
      type: "deployment_complete",
      payload: { env: "prod" },
      dedup_key: "evt:1",
    });

    expect(mockIngestEvent).toHaveBeenCalledWith(
      "proj1",
      "deployment_complete",
      "webhook",
      { env: "prod" },
      "evt:1",
      expect.any(Object),
    );
    expect(result).toEqual({
      status: 201,
      body: { id: "evt-1", deduplicated: false },
    });
  });

  it("requires an event type for ingest", () => {
    const result = runIngestProjectEventCommand("proj1", {});
    expect(result).toEqual({
      status: 400,
      body: { error: "Missing required field: type" },
    });
  });

  it("writes project context files through the command boundary", () => {
    mockWriteDomainContextFile.mockReturnValueOnce({ ok: true });

    const result = runWriteProjectContextFileCommand("proj1", {
      path: "SOUL.md",
      content: "updated",
    });

    expect(mockWriteDomainContextFile).toHaveBeenCalledWith("proj1", "SOUL.md", "updated", {});
    expect(result).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("maps context file errors for writes", () => {
    mockWriteDomainContextFile.mockImplementationOnce(() => {
      throw new MockContextFileError("Path traversal is not allowed", 403);
    });

    const result = runWriteProjectContextFileCommand("proj1", {
      path: "../etc/passwd",
      content: "bad",
    });

    expect(result).toEqual({
      status: 403,
      body: { error: "Path traversal is not allowed" },
    });
  });
});
