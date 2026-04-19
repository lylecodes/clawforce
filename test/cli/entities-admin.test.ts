import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processAndDispatchMock = vi.fn();
const processEventsMock = vi.fn();
const initClawforceMock = vi.fn();
const shutdownClawforceMock = vi.fn();
const getClawforceHomeMock = vi.fn(() => "/tmp/clawforce-home");
const collectEntityExperimentSnapshotMock = vi.fn();
const reopenEntityIssueMock = vi.fn();
const replayWorkflowMutationImplementationTaskMock = vi.fn();
const resetIssueRemediationTasksMock = vi.fn();
const clearEntityCheckRunsMock = vi.fn();
const collectProjectEventQueueSnapshotMock = vi.fn();
const reclaimStaleEventsMock = vi.fn();
const requeueEventsMock = vi.fn();

vi.mock("../../src/dispatch/dispatcher.js", () => ({
  processAndDispatch: processAndDispatchMock,
}));

vi.mock("../../src/events/router.js", () => ({
  processEvents: processEventsMock,
}));

vi.mock("../../src/lifecycle.js", () => ({
  initClawforce: initClawforceMock,
  shutdownClawforce: shutdownClawforceMock,
}));

vi.mock("../../src/paths.js", () => ({
  getClawforceHome: getClawforceHomeMock,
  resolveClawforceHomeHint: vi.fn(),
}));

vi.mock("../../src/entities/admin.js", () => ({
  collectEntityExperimentSnapshot: collectEntityExperimentSnapshotMock,
  reopenEntityIssue: reopenEntityIssueMock,
  replayWorkflowMutationImplementationTask: replayWorkflowMutationImplementationTaskMock,
  resetIssueRemediationTasks: resetIssueRemediationTasksMock,
  clearEntityCheckRuns: clearEntityCheckRunsMock,
  collectProjectEventQueueSnapshot: collectProjectEventQueueSnapshotMock,
  shapeEntityExperimentSnapshot: vi.fn((snapshot) => ({
    ...snapshot,
    issues: snapshot.issues.map((issue: Record<string, unknown>) => ({
      ...issue,
      evidence: undefined,
      evidenceSummary: "flagged",
    })),
  })),
  shapeEventQueueSnapshot: vi.fn((snapshot) => ({
    ...snapshot,
    items: snapshot.items.map((event: Record<string, unknown>) => ({
      ...event,
      payload: undefined,
      payloadSummary: "event payload",
    })),
  })),
}));

vi.mock("../../src/events/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/events/store.js")>();
  return {
    ...actual,
    reclaimStaleEvents: reclaimStaleEventsMock,
    requeueEvents: requeueEventsMock,
  };
});

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
const origExistsSync = fs.existsSync.bind(fs);

function captureStart(): void {
  logOutput = [];
  console.log = (...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  };
}

function captureStop(): void {
  console.log = originalLog;
}

describe("cli entities admin", () => {
  beforeEach(() => {
    captureStart();
    vi.clearAllMocks();
    processAndDispatchMock.mockReset();
    processEventsMock.mockReset();
    vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
      const value = String(p);
      if (value === "/tmp/clawforce-home/rentright-data/clawforce.db") {
        return true;
      }
      return origExistsSync(p);
    });
    shutdownClawforceMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    captureStop();
  });

  it("renders entity snapshots in JSON mode", async () => {
    collectEntityExperimentSnapshotMock.mockReturnValue({
      projectId: "rentright-data",
      entityId: "entity-la",
      generatedAt: 1,
      entity: { id: "entity-la", kind: "jurisdiction", title: "Los Angeles", state: "shadow", health: "warning" },
      issueSummary: { openCount: 1, blockingOpenCount: 1, approvalRequiredCount: 0, pendingProposalCount: 0, highestSeverity: "high", suggestedHealth: "blocked", openIssueTypes: ["integrity_flag"], openBySeverity: { high: 1 } },
      issues: [{ id: "issue-1", issueType: "integrity_flag", severity: "high", status: "open", title: "Flagged", evidence: { verdict: "flagged" } }],
      transitions: [],
      tasks: [],
      reactiveTasks: [],
      checkRuns: [],
      simulatedActions: [],
      feedItems: [],
      decisionItems: [],
      events: { counts: { pending: 0, processing: 0, handled: 0, failed: 0, ignored: 0 }, items: [] },
    });

    await cli.cmdEntitiesManifest("rentright-data", [
      "entities",
      "snapshot",
      "--entity-id=entity-la",
    ], true);

    expect(initClawforceMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      projectsDir: "/tmp/clawforce-home",
      sweepIntervalMs: 0,
    }));
    expect(collectEntityExperimentSnapshotMock).toHaveBeenCalledWith("rentright-data", "entity-la", expect.any(Object));
    const parsed = JSON.parse(logOutput.join("\n")) as Record<string, unknown>;
    expect((parsed.entity as Record<string, unknown>).title).toBe("Los Angeles");
    expect((parsed.issues as Array<Record<string, unknown>>)[0]!.evidence).toBeUndefined();
    expect((parsed.issues as Array<Record<string, unknown>>)[0]!.evidenceSummary).toBe("flagged");
  });

  it("supports event queue admin actions in JSON mode", async () => {
    collectProjectEventQueueSnapshotMock
      .mockReturnValueOnce({
        projectId: "rentright-data",
        focus: "actionable",
        counts: { pending: 0, processing: 1, handled: 0, failed: 2, ignored: 0 },
        items: [{ id: "evt-1", type: "entity_issue_opened", status: "failed", source: "internal", createdAt: 1 }],
        generatedAt: 1,
      })
      .mockReturnValueOnce({
        projectId: "rentright-data",
        focus: "actionable",
        counts: { pending: 1, processing: 0, handled: 0, failed: 1, ignored: 0 },
        items: [{ id: "evt-1", type: "entity_issue_opened", status: "pending", source: "internal", createdAt: 1 }],
        generatedAt: 2,
      });
    reclaimStaleEventsMock.mockReturnValue(1);
    requeueEventsMock.mockReturnValue([
      { id: "evt-1", type: "entity_issue_opened", status: "failed" },
    ]);
    processEventsMock
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0);

    await cli.cmdEntitiesManifest("rentright-data", [
      "entities",
      "events",
      "--focus=actionable",
      "--status=failed",
      "--reclaim-stale",
      "--requeue",
      "--process",
    ], true);

    expect(collectProjectEventQueueSnapshotMock).toHaveBeenNthCalledWith(1, "rentright-data", expect.objectContaining({
      focus: "actionable",
      status: "failed",
    }));
    expect(collectProjectEventQueueSnapshotMock).toHaveBeenNthCalledWith(2, "rentright-data", expect.objectContaining({
      focus: "actionable",
      status: "failed",
    }));

    expect(reclaimStaleEventsMock).toHaveBeenCalledWith("rentright-data", undefined);
    expect(requeueEventsMock).toHaveBeenCalledWith("rentright-data", expect.objectContaining({
      status: "failed",
    }));
    expect(processEventsMock).toHaveBeenCalledTimes(2);

    const parsed = JSON.parse(logOutput.join("\n")) as Record<string, unknown>;
    const actions = parsed.actions as Record<string, unknown>;
    expect(actions.reclaimed).toBe(1);
    expect(actions.processed).toBe(2);
    expect(actions.dispatched).toBe(0);
    expect((actions.requeued as Array<Record<string, unknown>>)[0]!.previousStatus).toBe("failed");
    expect((parsed.after as Record<string, unknown>).items[0].payload).toBeUndefined();
    expect((parsed.after as Record<string, unknown>).items[0].payloadSummary).toBeDefined();
  });

  it("replays workflow-mutation implementation tasks in JSON mode", async () => {
    replayWorkflowMutationImplementationTaskMock.mockReturnValue({
      replayedTaskId: "task-new",
      previousTaskId: "task-old",
      proposalId: "proposal-1",
      sourceTaskId: "source-task",
      sourceIssueId: "issue-1",
      created: true,
      relinkedIssue: true,
      relinkedSourceTask: true,
    });
    processEventsMock
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0);

    await cli.cmdEntitiesManifest("rentright-data", [
      "entities",
      "replay-workflow-mutation",
      "--task-id=task-old",
      "--reason=rerun under corrected verifier logic",
    ], true);

    expect(replayWorkflowMutationImplementationTaskMock).toHaveBeenCalledWith({
      projectId: "rentright-data",
      taskId: "task-old",
      actor: "cli:cf",
      reason: "rerun under corrected verifier logic",
    });
    expect(processEventsMock).toHaveBeenCalledTimes(2);

    const parsed = JSON.parse(logOutput.join("\n")) as Record<string, unknown>;
    expect(parsed.replayedTaskId).toBe("task-new");
    expect(parsed.followOnEventsProcessed).toBe(1);
    expect(parsed.followOnDispatches).toBe(0);
  });
});
