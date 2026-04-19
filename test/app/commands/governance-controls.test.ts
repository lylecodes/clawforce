import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  getDb: vi.fn(() => ({ name: "db" })),
}));

vi.mock("../../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
  enableAgent: vi.fn(),
}));

vi.mock("../../../src/history/store.js", () => ({
  getChange: vi.fn(),
  recordChange: vi.fn(),
}));

vi.mock("../../../src/history/revert.js", () => ({
  revertChange: vi.fn(),
}));

vi.mock("../../../src/locks/store.js", () => ({
  acquireLock: vi.fn(),
  getLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock("../../../src/app/commands/config-saves.js", () => ({
  runSaveConfigCommand: vi.fn(),
}));

const { writeAuditEntry } = await import("../../../src/audit.js");
const { disableAgent, enableAgent } = await import("../../../src/enforcement/disabled-store.js");
const { getChange, recordChange } = await import("../../../src/history/store.js");
const { revertChange } = await import("../../../src/history/revert.js");
const { acquireLock, getLock, releaseLock } = await import("../../../src/locks/store.js");
const { runSaveConfigCommand } = await import("../../../src/app/commands/config-saves.js");
const {
  runAcquireLockCommand,
  runReleaseLockCommand,
  runRevertHistoryChangeCommand,
} = await import("../../../src/app/commands/governance-controls.js");

describe("governance controls commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires a lock and records the structural change", () => {
    (acquireLock as any).mockReturnValue({
      id: "lock-1",
      projectId: "test-project",
      surface: "budget",
      lockedBy: "user",
      lockedAt: 123,
      updatedAt: 123,
      reason: "Hands off",
    });

    const result = runAcquireLockCommand("test-project", "budget", "user", "Hands off");

    expect(result).toEqual({
      ok: true,
      status: 201,
      lock: expect.objectContaining({
        surface: "budget",
        lockedBy: "user",
        reason: "Hands off",
      }),
    });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "test-project",
      actor: "user",
      action: "lock_acquire",
      targetId: "budget",
    }));
    expect(recordChange).toHaveBeenCalledWith("test-project", expect.objectContaining({
      resourceType: "lock",
      resourceId: "budget",
      action: "create",
      actor: "user",
      after: expect.objectContaining({
        lockedBy: "user",
        reason: "Hands off",
      }),
    }));
  });

  it("releases a lock using the existing lock snapshot for history", () => {
    (getLock as any).mockReturnValue({
      id: "lock-1",
      projectId: "test-project",
      surface: "rules",
      lockedBy: "owner",
      lockedAt: 111,
      updatedAt: 222,
      reason: "Editing",
    });

    const result = runReleaseLockCommand("test-project", "rules", "owner");

    expect(result).toEqual({
      ok: true,
      status: 200,
      surface: "rules",
    });
    expect(releaseLock).toHaveBeenCalledWith("test-project", "rules", "owner");
    expect(recordChange).toHaveBeenCalledWith("test-project", expect.objectContaining({
      resourceType: "lock",
      resourceId: "rules",
      action: "delete",
      before: {
        surface: "rules",
        lockedBy: "owner",
        lockedAt: 111,
        reason: "Editing",
      },
      after: null,
    }));
  });

  it("reverts config history changes through the shared config save command", () => {
    (revertChange as any).mockReturnValue({
      ok: true,
      changeId: "chg-1",
      revertChangeId: "rev-1",
    });
    (getChange as any).mockReturnValue({
      id: "chg-1",
      resourceType: "config",
      resourceId: "safety",
      before: JSON.stringify({ maxSpawnDepth: 4 }),
    });
    (runSaveConfigCommand as any).mockReturnValue({
      ok: true,
      section: "safety",
      persistedSection: "safety",
      persistedData: { maxSpawnDepth: 4 },
    });

    const result = runRevertHistoryChangeCommand("test-project", "chg-1", "user");

    expect(result).toEqual({
      ok: true,
      status: 200,
      changeId: "chg-1",
      revertChangeId: "rev-1",
      applied: true,
    });
    expect(runSaveConfigCommand).toHaveBeenCalledWith("test-project", {
      section: "safety",
      data: { maxSpawnDepth: 4 },
      actor: "user",
    });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "test-project",
      actor: "user",
      action: "history_revert",
      targetId: "chg-1",
    }));
    expect(disableAgent).not.toHaveBeenCalled();
    expect(enableAgent).not.toHaveBeenCalled();
  });
});
