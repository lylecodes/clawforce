/**
 * Phase A workspace query tests.
 *
 * Structure:
 * - `queryProjectWorkspace`, `queryWorkflowTopology`,
 *   `queryWorkflowStageInspector`: integration-style against a real in-memory
 *   SQLite DB with real workflows/tasks (same pattern as test/workflow.test.ts).
 * - `queryScopedWorkspaceFeed`: filtering logic with a mocked attention
 *   builder so feed behavior is deterministic and independent of the rest of
 *   the attention pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import type { AttentionItem, AttentionSummary } from "../../src/attention/types.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

// We want queryProjectWorkspace to fall back gracefully when health/safety
// hit an un-registered project — stub them to deterministic defaults.
vi.mock("../../src/app/queries/domain-monitoring.js", () => ({
  queryDomainHealth: vi.fn(() => ({ tier: "ok", alertsFired: 0, emergencyStop: false, domainEnabled: true })),
}));

vi.mock("../../src/safety.js", () => ({
  isEmergencyStopActive: vi.fn(() => false),
}));

// For feed tests we swap the attention builder with a controllable stub.
// Wrapping lets us mutate the summary between tests without re-importing.
let mockSummary: AttentionSummary = {
  projectId: "ws-test",
  items: [],
  counts: { actionNeeded: 0, watching: 0, fyi: 0 },
  generatedAt: 1000,
};
const buildAttentionSummaryMock = vi.fn(() => mockSummary);

vi.mock("../../src/attention/builder.js", () => ({
  buildAttentionSummary: buildAttentionSummaryMock,
  buildDecisionInboxFromSummary: vi.fn((s: AttentionSummary) => s),
  buildDecisionInboxSummary: vi.fn(() => mockSummary),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createWorkflow, addTaskToPhase } = await import("../../src/workflow.js");
const { createWorkflowDraftSession, setWorkflowDraftSessionVisibility } = await import("../../src/workspace/drafts.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const {
  queryProjectWorkspace,
  queryWorkflowDraftSession,
  queryWorkflowDraftSessions,
  queryWorkflowTopology,
  queryWorkflowStageInspector,
  queryScopedWorkspaceFeed,
} = await import("../../src/workspace/queries.js");
const { deriveStageKey, deriveDraftStageKey } = await import("../../src/workspace/types.js");

const DOMAIN = "ws-test";

function freshItem(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    id: overrides.id ?? `item-${Math.random()}`,
    projectId: DOMAIN,
    urgency: overrides.urgency ?? "watching",
    actionability: overrides.actionability ?? overrides.urgency ?? "watching",
    kind: overrides.kind ?? "info",
    severity: overrides.severity ?? "normal",
    automationState: overrides.automationState ?? "auto_handled",
    category: overrides.category ?? "task",
    title: overrides.title ?? "item",
    summary: overrides.summary ?? "",
    destination: overrides.destination ?? "/",
    detectedAt: overrides.detectedAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 1000,
    ...overrides,
  };
}

function completeTask(db: DatabaseSync, taskId: string) {
  transitionTask({ projectId: DOMAIN, taskId, toState: "ASSIGNED", actor: "agent:a" }, db);
  transitionTask({ projectId: DOMAIN, taskId, toState: "IN_PROGRESS", actor: "agent:a" }, db);
  attachEvidence({ projectId: DOMAIN, taskId, type: "output", content: "done", attachedBy: "agent:a" }, db);
  transitionTask({ projectId: DOMAIN, taskId, toState: "REVIEW", actor: "agent:a" }, db);
  transitionTask({ projectId: DOMAIN, taskId, toState: "DONE", actor: "agent:verifier", verificationRequired: false }, db);
}

describe("queryProjectWorkspace", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    mockSummary = {
      projectId: DOMAIN,
      items: [],
      counts: { actionNeeded: 3, watching: 1, fyi: 0 },
      generatedAt: 1000,
    };
    buildAttentionSummaryMock.mockClear();
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  it("returns explicit project scope with real workflows and an operator summary", () => {
    const wfA = createWorkflow({
      projectId: DOMAIN,
      name: "Alpha",
      phases: [{ name: "Build" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);
    createWorkflow({
      projectId: DOMAIN,
      name: "Beta",
      phases: [{ name: "Plan" }],
      createdBy: "agent:pm",
    }, db);

    const t = createTask({ projectId: DOMAIN, title: "Work", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wfA.id, phase: 0, taskId: t.id }, db);

    const result = queryProjectWorkspace(DOMAIN, db);

    expect(result.scope).toEqual({ kind: "project", domainId: DOMAIN });
    expect(result.domainId).toBe(DOMAIN);
    expect(result.workflows.map((w) => w.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(result.draftSessions).toEqual([]);

    expect(result.operator.workflowCount).toBe(2);
    expect(result.operator.activeWorkflowCount).toBe(2);
    expect(result.operator.openTaskCount).toBe(1);
    expect(result.operator.actionNeededCount).toBe(3);
    expect(result.operator.healthTier).toBe("ok");
    expect(result.operator.emergencyStop).toBe(false);
    expect(typeof result.operator.generatedAt).toBe("number");
  });

  it("each workflow entry carries explicit workflow-scoped scope and start/end edges", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Grid",
      phases: [{ name: "One" }, { name: "Two" }, { name: "Three" }],
      createdBy: "agent:pm",
    }, db);

    const result = queryProjectWorkspace(DOMAIN, db);
    const entry = result.workflows[0]!;

    expect(entry.scope).toEqual({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id });
    expect(entry.hasDraftOverlays).toBe(false);
    expect(entry.stages).toHaveLength(3);
    expect(entry.stages.map((s) => s.stageKey)).toEqual([
      deriveStageKey(wf.id, 0),
      deriveStageKey(wf.id, 1),
      deriveStageKey(wf.id, 2),
    ]);

    // edges include virtual Start and End
    expect(entry.edges[0]).toEqual({ fromStageKey: null, toStageKey: deriveStageKey(wf.id, 0) });
    expect(entry.edges[entry.edges.length - 1]).toEqual({
      fromStageKey: deriveStageKey(wf.id, 2),
      toStageKey: null,
    });
    expect(entry.edges.some((e) => e.branchLabel != null)).toBe(false);
  });

  it("returns an empty workspace when the domain has no workflows", () => {
    const result = queryProjectWorkspace(DOMAIN, db);
    expect(result.workflows).toEqual([]);
    expect(result.operator.workflowCount).toBe(0);
    expect(result.operator.activeWorkflowCount).toBe(0);
    expect(result.draftSessions).toEqual([]);
  });
});

describe("queryWorkflowTopology", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  it("returns null for an unknown workflow id", () => {
    expect(queryWorkflowTopology(DOMAIN, "no-such-wf", db)).toBeNull();
  });

  it("returns null when the workflow belongs to a different domain", () => {
    const wf = createWorkflow({
      projectId: "some-other-domain",
      name: "X",
      phases: [{ name: "A" }],
      createdBy: "agent:pm",
    }, db);
    expect(queryWorkflowTopology(DOMAIN, wf.id, db)).toBeNull();
  });

  it("returns stages matching workflow phases and connects them with linear edges", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Pipeline",
      phases: [{ name: "Build" }, { name: "Test", gateCondition: "any_done" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);

    const topology = queryWorkflowTopology(DOMAIN, wf.id, db);
    expect(topology).not.toBeNull();
    expect(topology!.scope).toEqual({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id });
    expect(topology!.liveState).toBe("active");
    expect(topology!.currentPhase).toBe(0);
    expect(topology!.hasDraftOverlays).toBe(false);
    expect(topology!.draftSessions).toEqual([]);
    expect(topology!.draftOverlays).toEqual([]);
    expect(topology!.stages.map((s) => s.label)).toEqual(["Build", "Test", "Ship"]);
    expect(topology!.stages[1]!.gateCondition).toBe("any_done");
    expect(topology!.stages[0]!.isCurrent).toBe(true);
    expect(topology!.stages[1]!.isCurrent).toBe(false);
    expect(topology!.createdBy).toBe("agent:pm");
  });

  it("stages reflect live task activity", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Pipeline",
      phases: [{ name: "Build" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);

    const t1 = createTask({ projectId: DOMAIN, title: "T1", createdBy: "agent:pm", assignedTo: "agent-dev" }, db);
    const t2 = createTask({ projectId: DOMAIN, title: "T2", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

    transitionTask({ projectId: DOMAIN, taskId: t1.id, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: DOMAIN, taskId: t1.id, toState: "IN_PROGRESS", actor: "agent:a" }, db);

    const topology = queryWorkflowTopology(DOMAIN, wf.id, db)!;
    expect(topology.stages[0]!.taskCount).toBe(2);
    expect(topology.stages[0]!.liveState).toBe("running");
    expect(topology.stages[0]!.primaryAgent).toEqual({ agentId: "agent-dev", label: "agent-dev" });
    expect(topology.stages[1]!.taskCount).toBe(0);
    expect(topology.stages[1]!.liveState).toBe("upcoming");
  });
});

describe("workflow draft sessions — Phase B core reads", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    mockSummary = {
      projectId: DOMAIN,
      items: [],
      counts: { actionNeeded: 0, watching: 0, fyi: 0 },
      generatedAt: 1500,
    };
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  it("queryProjectWorkspace surfaces real draft-session inventory", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Alpha",
      phases: [{ name: "Build" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);

    createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wf.id,
      title: "Insert verify stage",
      createdBy: "agent:pm",
      draftWorkflow: {
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "Verify", taskIds: [], gateCondition: "all_resolved" },
          { name: "Ship", taskIds: [], gateCondition: "all_done" },
        ],
      },
    }, db);

    const workspace = queryProjectWorkspace(DOMAIN, db);
    expect(workspace.draftSessions).toHaveLength(1);
    expect(workspace.draftSessions[0]!.scope.kind).toBe("draft");
    expect(workspace.draftSessions[0]!.workflowId).toBe(wf.id);
    expect(workspace.draftSessions[0]!.overlayVisibility).toBe("visible");
    expect(workspace.draftSessions[0]!.changeSummary.addedStages).toBe(1);
    expect(workspace.draftSessions[0]!.changeSummary.movedStages).toBe(1);
    expect(workspace.draftSessions[0]!.affectedStageCount).toBe(2);
    expect(workspace.workflows[0]!.hasDraftOverlays).toBe(true);
  });

  it("queryWorkflowTopology surfaces workflow draft inventory and visible overlays", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Pipeline",
      phases: [{ name: "Build" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);

    const visible = createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wf.id,
      title: "Insert verify stage",
      createdBy: "agent:pm",
      draftWorkflow: {
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "Verify", taskIds: [], gateCondition: "all_resolved" },
          { name: "Ship", taskIds: [], gateCondition: "all_done" },
        ],
      },
      overlayVisibility: "visible",
    }, db);

    createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wf.id,
      title: "Rename ship stage",
      createdBy: "agent:pm",
      draftWorkflow: {
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "Release", taskIds: [], gateCondition: "all_done" },
        ],
      },
      overlayVisibility: "hidden",
    }, db);

    const topology = queryWorkflowTopology(DOMAIN, wf.id, db)!;
    expect(topology.draftSessions).toHaveLength(2);
    expect(topology.hasDraftOverlays).toBe(true);
    expect(topology.draftOverlays).toHaveLength(2);
    expect(topology.draftOverlays[0]).toEqual({
      draftSessionId: visible.id,
      workflowId: wf.id,
      kind: "added",
      draftStageKey: deriveDraftStageKey(visible.id, 1),
      draftPhaseIndex: 1,
      label: "Verify",
      description: undefined,
    });
    expect(topology.draftOverlays[1]).toEqual({
      draftSessionId: visible.id,
      workflowId: wf.id,
      kind: "moved",
      liveStageKey: deriveStageKey(wf.id, 1),
      draftStageKey: deriveDraftStageKey(visible.id, 2),
      livePhaseIndex: 1,
      draftPhaseIndex: 2,
      label: "Ship",
      description: undefined,
    });
  });

  it("queryWorkflowDraftSessions can filter inventory by workflow", () => {
    const wfA = createWorkflow({ projectId: DOMAIN, name: "A", phases: [{ name: "Build" }], createdBy: "agent:pm" }, db);
    const wfB = createWorkflow({ projectId: DOMAIN, name: "B", phases: [{ name: "Plan" }], createdBy: "agent:pm" }, db);

    createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wfA.id,
      title: "A draft",
      createdBy: "agent:pm",
      draftWorkflow: { phases: [{ name: "Build+", taskIds: [], gateCondition: "all_done" }] },
    }, db);
    createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wfB.id,
      title: "B draft",
      createdBy: "agent:pm",
      draftWorkflow: { phases: [{ name: "Plan+" , taskIds: [], gateCondition: "all_done" }] },
    }, db);

    expect(queryWorkflowDraftSessions(DOMAIN, undefined, db)).toHaveLength(2);
    const filtered = queryWorkflowDraftSessions(DOMAIN, wfA.id, db);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.workflowId).toBe(wfA.id);
  });

  it("queryWorkflowDraftSession returns explicit draft scope and detail payload", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "Build" }, { name: "Ship" }], createdBy: "agent:pm" }, db);
    const session = createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wf.id,
      title: "Reshape workflow",
      createdBy: "agent:pm",
      draftWorkflow: {
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "Verify", taskIds: [], gateCondition: "all_resolved" },
          { name: "Ship", taskIds: [], gateCondition: "all_done" },
        ],
      },
    }, db);

    const detail = queryWorkflowDraftSession(DOMAIN, session.id, db)!;
    expect(detail.scope).toEqual({
      kind: "draft",
      domainId: DOMAIN,
      workflowId: wf.id,
      draftSessionId: session.id,
    });
    expect(detail.baseStageCount).toBe(2);
    expect(detail.draftStageCount).toBe(3);
    expect(detail.draftStages.map((stage) => stage.label)).toEqual(["Build", "Verify", "Ship"]);
    expect(detail.overlays[0]!.draftStageKey).toBe(deriveDraftStageKey(session.id, 1));
  });

  it("visibility toggles change whether overlays are surfaced in workflow topology", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "Build" }, { name: "Ship" }], createdBy: "agent:pm" }, db);
    const session = createWorkflowDraftSession({
      projectId: DOMAIN,
      workflowId: wf.id,
      title: "Hideable draft",
      createdBy: "agent:pm",
      draftWorkflow: {
        phases: [
          { name: "Build", taskIds: [], gateCondition: "all_done" },
          { name: "QA", taskIds: [], gateCondition: "all_resolved" },
          { name: "Ship", taskIds: [], gateCondition: "all_done" },
        ],
      },
      overlayVisibility: "hidden",
    }, db);

    expect(queryWorkflowTopology(DOMAIN, wf.id, db)!.draftOverlays).toEqual([]);

    setWorkflowDraftSessionVisibility(DOMAIN, session.id, "visible", "dashboard", db);

    const topology = queryWorkflowTopology(DOMAIN, wf.id, db)!;
    expect(topology.hasDraftOverlays).toBe(true);
    expect(topology.draftOverlays.map((overlay) => overlay.kind)).toEqual(["added", "moved"]);
  });
});

describe("queryWorkflowStageInspector", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  it("returns null for unknown workflow or stage", () => {
    expect(queryWorkflowStageInspector(DOMAIN, "no-wf", "0", db)).toBeNull();

    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "X",
      phases: [{ name: "A" }],
      createdBy: "agent:pm",
    }, db);
    expect(queryWorkflowStageInspector(DOMAIN, wf.id, "99", db)).toBeNull();
    expect(queryWorkflowStageInspector(DOMAIN, wf.id, "not-a-stage", db)).toBeNull();
  });

  it("returns null when stageKey references a different workflow", () => {
    const wfA = createWorkflow({ projectId: DOMAIN, name: "A", phases: [{ name: "X" }], createdBy: "agent:pm" }, db);
    const wfB = createWorkflow({ projectId: DOMAIN, name: "B", phases: [{ name: "Y" }], createdBy: "agent:pm" }, db);
    const stageKeyForB = deriveStageKey(wfB.id, 0);
    expect(queryWorkflowStageInspector(DOMAIN, wfA.id, stageKeyForB, db)).toBeNull();
  });

  it("returns stage detail with gate status, tasks, and current-position flag", () => {
    const wf = createWorkflow({
      projectId: DOMAIN,
      name: "Pipeline",
      phases: [{ name: "Build", gateCondition: "all_done" }, { name: "Ship" }],
      createdBy: "agent:pm",
    }, db);

    const t1 = createTask({ projectId: DOMAIN, title: "T1", createdBy: "agent:pm", assignedTo: "agent-dev" }, db);
    const t2 = createTask({ projectId: DOMAIN, title: "T2", createdBy: "agent:pm", assignedTo: "agent-dev" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t2.id }, db);
    completeTask(db, t1.id);

    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, deriveStageKey(wf.id, 0), db)!;

    expect(inspector.scope).toEqual({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wf.id,
      stageKey: deriveStageKey(wf.id, 0),
    });
    expect(inspector.workflow.id).toBe(wf.id);
    expect(inspector.workflow.totalPhases).toBe(2);
    expect(inspector.position).toBe("current");
    expect(inspector.gate.condition).toBe("all_done");
    expect(inspector.gate.ready).toBe(false);
    expect(inspector.gate.completed).toBe(1);
    expect(inspector.gate.total).toBe(2);
    expect(inspector.tasks).toHaveLength(2);
    expect(inspector.tasks.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    const done = inspector.tasks.find((t) => t.id === t1.id)!;
    expect(done.state).toBe("DONE");
    expect(done.assignedTo).toBe("agent-dev");
  });

  it("accepts a bare phase-index as stageKey (convenience)", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "A", phases: [{ name: "X" }, { name: "Y" }], createdBy: "agent:pm" }, db);
    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, "1", db)!;
    expect(inspector.stage.phaseIndex).toBe(1);
    expect(inspector.stage.stageKey).toBe(deriveStageKey(wf.id, 1));
    expect(inspector.position).toBe("upcoming");
  });
});

describe("queryScopedWorkspaceFeed", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    buildAttentionSummaryMock.mockClear();
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  function setFeed(items: AttentionItem[], counts = { actionNeeded: 0, watching: items.length, fyi: 0 }) {
    mockSummary = {
      projectId: DOMAIN,
      items,
      counts,
      generatedAt: 2000,
    };
  }

  it("project scope passes summary through unchanged", () => {
    setFeed([freshItem({ id: "p-1", category: "task" })]);

    const feed = queryScopedWorkspaceFeed({ kind: "project", domainId: DOMAIN }, db);
    expect(feed.scope).toEqual({ kind: "project", domainId: DOMAIN });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.crossScope).toBeUndefined();
    expect(feed.crossScopeCount).toBe(0);
    expect(feed.counts).toEqual(mockSummary.counts);

    // never invents a second event source
    expect(buildAttentionSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("workflow scope keeps items whose task belongs to the workflow and drops unrelated items", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const tIn = createTask({ projectId: DOMAIN, title: "In", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: tIn.id }, db);
    const tOut = createTask({ projectId: DOMAIN, title: "Out", createdBy: "agent:pm" }, db);

    setFeed([
      freshItem({ id: "in", category: "task", taskId: tIn.id, urgency: "watching" }),
      freshItem({ id: "out", category: "task", taskId: tOut.id, urgency: "watching" }),
      freshItem({ id: "unrelated", category: "comms", urgency: "fyi" }),
    ]);

    const feed = queryScopedWorkspaceFeed({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id }, db);
    expect(feed.scope).toEqual({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id });
    expect(feed.items.map((i) => i.id)).toEqual(["in"]);
    expect(feed.crossScopeCount).toBe(0);
  });

  it("workflow scope surfaces cross-scope critical items (budget / health / compliance action-needed)", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }], createdBy: "agent:pm" }, db);

    setFeed([
      freshItem({ id: "budget-crit", category: "budget", urgency: "action-needed" }),
      freshItem({ id: "budget-fyi", category: "budget", urgency: "fyi" }),
      freshItem({ id: "health-crit", category: "health", urgency: "action-needed" }),
      freshItem({ id: "noise", category: "task", urgency: "watching" }),
    ]);

    const feed = queryScopedWorkspaceFeed({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id }, db);
    expect(feed.items.map((i) => i.id).sort()).toEqual(["budget-crit", "health-crit"]);
    expect(feed.items.every((i) => i.crossScope === true)).toBe(true);
    expect(feed.crossScopeCount).toBe(2);
  });

  it("stage scope narrows to the selected phase and respects cross-scope escalation", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const tA = createTask({ projectId: DOMAIN, title: "A-task", createdBy: "agent:pm" }, db);
    const tB = createTask({ projectId: DOMAIN, title: "B-task", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: tA.id }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 1, taskId: tB.id }, db);

    setFeed([
      freshItem({ id: "phase-a", category: "task", taskId: tA.id, urgency: "action-needed" }),
      freshItem({ id: "phase-b", category: "task", taskId: tB.id, urgency: "watching" }),
      freshItem({ id: "budget-crit", category: "budget", urgency: "action-needed" }),
    ]);

    const stageKey = deriveStageKey(wf.id, 0);
    const feed = queryScopedWorkspaceFeed({ kind: "stage", domainId: DOMAIN, workflowId: wf.id, stageKey }, db);
    expect(feed.scope).toEqual({ kind: "stage", domainId: DOMAIN, workflowId: wf.id, stageKey });
    expect(feed.items.map((i) => i.id).sort()).toEqual(["budget-crit", "phase-a"]);
    expect(feed.items.find((i) => i.id === "budget-crit")!.crossScope).toBe(true);
    expect(feed.items.find((i) => i.id === "phase-a")!.crossScope).toBeUndefined();
    expect(feed.crossScopeCount).toBe(1);
  });

  it("returns an empty scoped feed when the referenced workflow does not exist", () => {
    setFeed([freshItem({ id: "x", category: "task", taskId: "irrelevant" })]);

    const feed = queryScopedWorkspaceFeed({ kind: "workflow", domainId: DOMAIN, workflowId: "no-such" }, db);
    expect(feed.scope).toEqual({ kind: "workflow", domainId: DOMAIN, workflowId: "no-such" });
    expect(feed.items).toEqual([]);
    expect(feed.counts).toEqual({ actionNeeded: 0, watching: 0, fyi: 0 });
  });

  it("supports workflowId metadata-based matching even when taskId is missing", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }], createdBy: "agent:pm" }, db);
    setFeed([
      freshItem({ id: "via-meta", category: "compliance", urgency: "watching", metadata: { workflowId: wf.id } }),
      freshItem({ id: "other", category: "task", urgency: "watching", metadata: { workflowId: "different" } }),
    ]);

    const feed = queryScopedWorkspaceFeed({ kind: "workflow", domainId: DOMAIN, workflowId: wf.id }, db);
    expect(feed.items.map((i) => i.id)).toEqual(["via-meta"]);
  });

  it("supports stageKey metadata matching under stage scope without a taskId", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const stageKey = deriveStageKey(wf.id, 0);
    setFeed([
      freshItem({ id: "stage-meta", category: "compliance", urgency: "watching", metadata: { stageKey } }),
      freshItem({ id: "other-stage-meta", category: "compliance", urgency: "watching", metadata: { stageKey: deriveStageKey(wf.id, 1) } }),
      freshItem({ id: "different-wf-meta", category: "compliance", urgency: "watching", metadata: { stageKey: deriveStageKey("different-wf", 0) } }),
    ]);

    const feed = queryScopedWorkspaceFeed({ kind: "stage", domainId: DOMAIN, workflowId: wf.id, stageKey }, db);
    expect(feed.items.map((i) => i.id)).toEqual(["stage-meta"]);
  });
});

// ---------------------------------------------------------------------------
// Phase A fix-pass: stage inspector + feed consistency
// ---------------------------------------------------------------------------

describe("queryWorkflowStageInspector recentFeed consistency with queryScopedWorkspaceFeed", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    buildAttentionSummaryMock.mockClear();
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  function setSummary(items: AttentionItem[]) {
    mockSummary = {
      projectId: DOMAIN,
      items,
      counts: { actionNeeded: items.filter((i) => i.urgency === "action-needed").length, watching: items.filter((i) => i.urgency === "watching").length, fyi: items.filter((i) => i.urgency === "fyi").length },
      generatedAt: 3000,
    };
  }

  it("surfaces metadata-linked stageKey items that have no taskId (previous bug: dropped by inspector)", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const stageKey = deriveStageKey(wf.id, 0);
    const metaItem = freshItem({
      id: "stage-meta",
      category: "compliance",
      urgency: "watching",
      metadata: { stageKey },
    });
    setSummary([metaItem]);

    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, stageKey, db)!;
    expect(inspector.recentFeed.map((i) => i.id)).toEqual(["stage-meta"]);
  });

  it("surfaces metadata-linked workflowId items only when they also match this stage", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const stageKey = deriveStageKey(wf.id, 0);
    // Workflow-wide metadata (no stageKey) should not appear in stage scope —
    // only workflow scope is broad enough for it.
    setSummary([freshItem({ id: "wf-meta", category: "compliance", urgency: "watching", metadata: { workflowId: wf.id } })]);

    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, stageKey, db)!;
    expect(inspector.recentFeed.map((i) => i.id)).toEqual([]);
  });

  it("produces the same items (up to the inspector cap) as queryScopedWorkspaceFeed({kind:'stage'})", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const tIn = createTask({ projectId: DOMAIN, title: "T", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: tIn.id }, db);

    const stageKey = deriveStageKey(wf.id, 0);
    setSummary([
      freshItem({ id: "via-task", category: "task", urgency: "watching", taskId: tIn.id }),
      freshItem({ id: "via-meta", category: "compliance", urgency: "watching", metadata: { stageKey } }),
      freshItem({ id: "unrelated", category: "comms", urgency: "fyi" }),
      freshItem({ id: "cross-scope", category: "budget", urgency: "action-needed" }),
    ]);

    const feed = queryScopedWorkspaceFeed({ kind: "stage", domainId: DOMAIN, workflowId: wf.id, stageKey }, db);
    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, stageKey, db)!;

    // Inspector should mirror the scoped feed (bounded by INSPECTOR_FEED_LIMIT=20).
    expect(inspector.recentFeed.map((i) => i.id).sort()).toEqual(feed.items.map((i) => i.id).sort());
    // Cross-scope items propagate identically.
    const crossScopeInspector = inspector.recentFeed.find((i) => i.id === "cross-scope");
    expect(crossScopeInspector?.crossScope).toBe(true);
  });

  it("drops items that belong to a different workflow", () => {
    const wfA = createWorkflow({ projectId: DOMAIN, name: "A", phases: [{ name: "X" }], createdBy: "agent:pm" }, db);
    const wfB = createWorkflow({ projectId: DOMAIN, name: "B", phases: [{ name: "Y" }], createdBy: "agent:pm" }, db);
    const stageA = deriveStageKey(wfA.id, 0);
    const stageB = deriveStageKey(wfB.id, 0);
    setSummary([
      freshItem({ id: "a-meta", category: "compliance", urgency: "watching", metadata: { stageKey: stageA } }),
      freshItem({ id: "b-meta", category: "compliance", urgency: "watching", metadata: { stageKey: stageB } }),
    ]);

    const inspector = queryWorkflowStageInspector(DOMAIN, wfA.id, stageA, db)!;
    expect(inspector.recentFeed.map((i) => i.id)).toEqual(["a-meta"]);
  });
});

// ---------------------------------------------------------------------------
// Phase A fix-pass: no silent 1000-task truncation in truth-bearing summaries
// ---------------------------------------------------------------------------

describe("workspace summaries scale past 1000 tasks without silent truncation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    mockSummary = {
      projectId: DOMAIN,
      items: [],
      counts: { actionNeeded: 0, watching: 0, fyi: 0 },
      generatedAt: 5000,
    };
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  // 1100 is comfortably above the old 1000-row listTasks cap. Keep the per-test
  // corpus small enough that the suite stays fast.
  const LARGE_N = 1100;

  it("queryProjectWorkspace.operator.openTaskCount reflects every open task", () => {
    for (let i = 0; i < LARGE_N; i++) {
      createTask({ projectId: DOMAIN, title: `T${i}`, createdBy: "agent:pm" }, db);
    }
    const result = queryProjectWorkspace(DOMAIN, db);
    expect(result.operator.openTaskCount).toBe(LARGE_N);
  });

  it("queryWorkflowTopology stage taskCount reflects every task attached to a phase", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "Big", phases: [{ name: "Phase 0" }], createdBy: "agent:pm" }, db);
    for (let i = 0; i < LARGE_N; i++) {
      const t = createTask({ projectId: DOMAIN, title: `T${i}`, createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t.id }, db);
    }
    const topology = queryWorkflowTopology(DOMAIN, wf.id, db)!;
    expect(topology.stages[0]!.taskCount).toBe(LARGE_N);
    // Also reflected in the project grid.
    const workspace = queryProjectWorkspace(DOMAIN, db);
    expect(workspace.workflows[0]!.stages[0]!.taskCount).toBe(LARGE_N);
  });

  it("queryWorkflowStageInspector exposes the full count plus the honest truncation flag", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "Big", phases: [{ name: "Phase 0" }], createdBy: "agent:pm" }, db);
    for (let i = 0; i < LARGE_N; i++) {
      const t = createTask({ projectId: DOMAIN, title: `T${i}`, createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t.id }, db);
    }
    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, deriveStageKey(wf.id, 0), db)!;
    expect(inspector.totalTaskCount).toBe(LARGE_N);
    expect(inspector.tasks.length).toBeLessThanOrEqual(100); // hard cap on displayed rows
    expect(inspector.tasksTruncated).toBe(true);
    expect(inspector.stage.taskCount).toBe(LARGE_N);
  });

  it("small stages do not report truncation", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "Small", phases: [{ name: "Phase 0" }], createdBy: "agent:pm" }, db);
    for (let i = 0; i < 5; i++) {
      const t = createTask({ projectId: DOMAIN, title: `T${i}`, createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: DOMAIN, workflowId: wf.id, phase: 0, taskId: t.id }, db);
    }
    const inspector = queryWorkflowStageInspector(DOMAIN, wf.id, deriveStageKey(wf.id, 0), db)!;
    expect(inspector.totalTaskCount).toBe(5);
    expect(inspector.tasks).toHaveLength(5);
    expect(inspector.tasksTruncated).toBe(false);
  });

  it("open task count excludes terminal states", () => {
    // 5 open, 3 terminal — openTaskCount must equal 5 regardless of size.
    for (let i = 0; i < 5; i++) {
      createTask({ projectId: DOMAIN, title: `Open${i}`, createdBy: "agent:pm" }, db);
    }
    const done = createTask({ projectId: DOMAIN, title: "Done", createdBy: "agent:pm" }, db);
    completeTask(db, done.id);
    const failed = createTask({ projectId: DOMAIN, title: "Failed", createdBy: "agent:pm" }, db);
    transitionTask({ projectId: DOMAIN, taskId: failed.id, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: DOMAIN, taskId: failed.id, toState: "FAILED", actor: "agent:a" }, db);
    const cancelled = createTask({ projectId: DOMAIN, title: "Cancelled", createdBy: "agent:pm" }, db);
    transitionTask({ projectId: DOMAIN, taskId: cancelled.id, toState: "CANCELLED", actor: "agent:a" }, db);

    const workspace = queryProjectWorkspace(DOMAIN, db);
    expect(workspace.operator.openTaskCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Phase A fix-pass: invalid stage scope must not leak cross-scope items
// ---------------------------------------------------------------------------
//
// `queryWorkflowStageInspector()` returns null (and the router 404s) when a
// stageKey is malformed, references a different workflow, or points past the
// end of `workflow.phases`. The scoped feed must mirror that — an invalid
// stage scope is not a real scope, so it must not still emit
// budget/health/compliance `crossScope: true` items as though it were.
// See `resolveStagePhaseIndex` in src/workspace/queries.ts.

describe("queryScopedWorkspaceFeed — invalid stage scope", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    buildAttentionSummaryMock.mockClear();
    // Seed the attention summary with items that would qualify as
    // cross-scope-critical (budget/health/compliance action-needed). Under
    // a valid-but-unmatched stage they surface as crossScope; under an
    // invalid scope they must not appear at all.
    mockSummary = {
      projectId: DOMAIN,
      items: [
        {
          id: "budget-crit",
          projectId: DOMAIN,
          urgency: "action-needed",
          actionability: "action-needed",
          kind: "alert",
          severity: "critical",
          automationState: "needs_human",
          category: "budget",
          title: "Budget critical",
          summary: "",
          destination: "/",
          detectedAt: 7000,
          updatedAt: 7000,
        },
        {
          id: "health-crit",
          projectId: DOMAIN,
          urgency: "action-needed",
          actionability: "action-needed",
          kind: "alert",
          severity: "critical",
          automationState: "needs_human",
          category: "health",
          title: "Health critical",
          summary: "",
          destination: "/",
          detectedAt: 7000,
          updatedAt: 7000,
        },
      ],
      counts: { actionNeeded: 2, watching: 0, fyi: 0 },
      generatedAt: 7000,
    };
  });
  afterEach(() => { try { db.close(); } catch { /* already closed */ } });

  function assertEmptyInvalidFeed(feed: ReturnType<typeof queryScopedWorkspaceFeed>) {
    expect(feed.items).toEqual([]);
    expect(feed.counts).toEqual({ actionNeeded: 0, watching: 0, fyi: 0 });
    expect(feed.crossScopeCount).toBe(0);
  }

  it("returns an empty feed when the stageKey has a malformed format", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    const feed = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wf.id,
      stageKey: "not-a-stage",
    }, db);
    expect(feed.scope).toEqual({ kind: "stage", domainId: DOMAIN, workflowId: wf.id, stageKey: "not-a-stage" });
    assertEmptyInvalidFeed(feed);
    // Parallel with the inspector contract.
    expect(queryWorkflowStageInspector(DOMAIN, wf.id, "not-a-stage", db)).toBeNull();
  });

  it("returns an empty feed when the stageKey belongs to a different workflow", () => {
    const wfA = createWorkflow({ projectId: DOMAIN, name: "A", phases: [{ name: "X" }], createdBy: "agent:pm" }, db);
    const wfB = createWorkflow({ projectId: DOMAIN, name: "B", phases: [{ name: "Y" }], createdBy: "agent:pm" }, db);
    const stageKeyForB = deriveStageKey(wfB.id, 0);
    const feed = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wfA.id,
      stageKey: stageKeyForB,
    }, db);
    expect(feed.scope).toEqual({ kind: "stage", domainId: DOMAIN, workflowId: wfA.id, stageKey: stageKeyForB });
    assertEmptyInvalidFeed(feed);
    expect(queryWorkflowStageInspector(DOMAIN, wfA.id, stageKeyForB, db)).toBeNull();
  });

  it("returns an empty feed when the phase index is past the end of the workflow", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }, { name: "B" }], createdBy: "agent:pm" }, db);
    // Numeric, out-of-range.
    const outOfRangeBare = "99";
    const feedBare = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wf.id,
      stageKey: outOfRangeBare,
    }, db);
    assertEmptyInvalidFeed(feedBare);
    expect(queryWorkflowStageInspector(DOMAIN, wf.id, outOfRangeBare, db)).toBeNull();

    // Structured `workflowId:phase:N` form, out-of-range.
    const outOfRangeStructured = deriveStageKey(wf.id, 99);
    const feedStructured = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wf.id,
      stageKey: outOfRangeStructured,
    }, db);
    assertEmptyInvalidFeed(feedStructured);
    expect(queryWorkflowStageInspector(DOMAIN, wf.id, outOfRangeStructured, db)).toBeNull();
  });

  it("a valid-but-unmatched stage still surfaces cross-scope critical items (sanity: the short-circuit only triggers for invalid scopes)", () => {
    const wf = createWorkflow({ projectId: DOMAIN, name: "WF", phases: [{ name: "A" }], createdBy: "agent:pm" }, db);
    const stageKey = deriveStageKey(wf.id, 0);
    const feed = queryScopedWorkspaceFeed({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: wf.id,
      stageKey,
    }, db);
    expect(feed.items.map((i) => i.id).sort()).toEqual(["budget-crit", "health-crit"]);
    expect(feed.items.every((i) => i.crossScope === true)).toBe(true);
    expect(feed.crossScopeCount).toBe(2);
  });
});
