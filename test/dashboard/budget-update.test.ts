import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGet = vi.fn();
const mockRun = vi.fn();
const mockPrepare = vi.fn(() => ({ get: mockGet, run: mockRun, all: vi.fn(() => []) }));

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: mockPrepare,
  })),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("../../src/audit.js", () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

const { updateBudgetLimit } = await import("../../src/dashboard/queries.js");

describe("updateBudgetLimit", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockRun.mockReset();
    mockPrepare.mockClear();
    mockWriteAuditEntry.mockReset();
  });

  it("updates existing project budget row and writes audit entry", () => {
    mockGet.mockReturnValueOnce({ id: "budget-1", daily_limit_cents: 20000 });

    const result = updateBudgetLimit("proj1", 50000, "dashboard:test");

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

    const result = updateBudgetLimit("proj1", 30000);

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
});
