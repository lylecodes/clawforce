import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock core functions
vi.mock("../../src/approval/resolve.js", () => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

vi.mock("../../src/tasks/ops.js", () => ({
  createTask: vi.fn(),
  reassignTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("../../src/workspace/drafts.js", () => ({
  setWorkflowDraftSessionVisibility: vi.fn(),
}));

vi.mock("../../src/workspace/helpers.js", () => ({
  startWorkflowHelperSession: vi.fn(),
  sendWorkflowHelperMessage: vi.fn(),
  acceptWorkflowHelperProposal: vi.fn(),
}));

vi.mock("../../src/workspace/reviews.js", () => ({
  createWorkflowReviewFromDraft: vi.fn(),
  approveWorkflowReview: vi.fn(),
  rejectWorkflowReview: vi.fn(),
}));

vi.mock("../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
  enableAgent: vi.fn(),
  disableDomain: vi.fn(),
  enableDomain: vi.fn(),
  isDomainDisabled: vi.fn(() => false),
}));

vi.mock("../../src/channels/meeting.js", () => ({
  startMeeting: vi.fn(),
  concludeMeeting: vi.fn(),
}));

vi.mock("../../src/channels/messages.js", () => ({
  sendChannelMessage: vi.fn(),
}));

vi.mock("../../src/app/commands/operator-messages.js", () => ({
  runSendDirectMessageCommand: vi.fn((_projectId: string, input: Record<string, unknown>) => ({
    ok: true,
    status: 201,
    message: {
      id: "msg-1",
      projectId: "test-project",
      fromAgent: "user",
      toAgent: input.toAgent,
      content: input.content,
      type: "direct",
      priority: input.priority ?? "normal",
      status: "queued",
      channelId: null,
      parentMessageId: null,
      createdAt: 123,
      deliveredAt: null,
      readAt: null,
      protocolStatus: null,
      responseDeadline: null,
      metadata: input.proposalId ? { proposalId: input.proposalId } : null,
    },
  })),
}));

vi.mock("../../src/app/commands/setup-controls.js", () => ({
  runRequestControllerHandoffCommand: vi.fn((_projectId: string) => ({
    status: 200,
    body: { ok: true, actionId: "setup-handoff-1", mode: "handoff_requested" },
  })),
  runRecoverRecurringRunCommand: vi.fn((_projectId: string, taskId: string) => ({
    status: 200,
    body: { ok: true, actionId: "setup-recovery-1", taskId, mode: "replayed" },
  })),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  emitSSE: vi.fn(),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

vi.mock("../../src/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../src/safety.js", () => ({
  activateEmergencyStop: vi.fn(),
  deactivateEmergencyStop: vi.fn(),
  isEmergencyStopActive: vi.fn(() => false),
}));

vi.mock("../../src/audit/auto-kill.js", () => ({
  killStuckAgent: vi.fn(async () => false),
}));

vi.mock("../../src/budget-cascade.js", () => ({
  allocateBudget: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../src/budget/normalize.js", () => ({
  normalizeBudgetConfig: vi.fn((config: unknown) => config ?? {}),
}));

vi.mock("../../src/config/api-service.js", () => {
  const saveDomainConfigSection = vi.fn(() => ({ ok: true }));
  const previewDomainConfigSectionChange = vi.fn((_projectId: string, section: string) => ({
    ok: true,
    preview: {
      before: {},
      after: {},
      valid: true,
      changedPaths: [section],
      changedKeys: [section],
    },
  }));
  const readDomainConfig = vi.fn(() => ({
    domain: "test-project",
    agents: ["a1", "a2"],
    goals: {
      existing: { allocation: 25, description: "Existing goal" },
    },
  }));
  const readGlobalConfig = vi.fn(() => ({
    agents: {
      a1: {
        briefing: [
          { source: "file", path: "context/ops.md" },
          { source: "direction" },
        ],
        expectations: [
          { tool: "clawforce_task", action: ["transition", "comment"], min_calls: 2 },
        ],
        jobs: {
          standup: { cron: "0 9 * * *", description: "Daily sync", enabled: true, nudge: "existing" },
        },
      },
      a2: {
        jobs: {
          cleanup: { cron: "0 18 * * *", enabled: false },
        },
      },
    },
  }));
  const reloadDomainRuntime = vi.fn(() => ({ domains: ["test-project"], errors: [] }));
  const reloadDomainRuntimes = vi.fn(() => ({ domains: ["test-project"], errors: [] }));
  const updateGlobalAgentConfig = vi.fn(() => ({ ok: true }));
  const upsertGlobalAgents = vi.fn(() => ({ ok: true }));
  const writeDomainConfig = vi.fn(() => ({ ok: true }));
  return {
    createConfigService: vi.fn(() => ({
      readDomainConfig,
      readGlobalConfig,
      reloadDomainRuntime,
      reloadDomainRuntimes,
      updateGlobalAgentConfig,
      upsertGlobalAgents,
      writeDomainConfig,
    })),
    saveDomainConfigSection,
    previewDomainConfigSectionChange,
    updateDomainConfig: saveDomainConfigSection,
    reloadDomainRuntime,
    reloadDomainRuntimes,
    updateGlobalAgentConfig,
    upsertGlobalAgents,
    writeDomainConfig,
    readDomainConfig,
    readGlobalConfig,
  };
});

vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0 })),
    })),
  })),
}));

vi.mock("../../src/project.js", () => {
  const configs = new Map<string, any>([
    ["a1", { projectId: "test-project", config: { extends: "worker" } }],
    ["a2", { projectId: "test-project", config: { extends: "worker" } }],
    ["agent-a", { projectId: "test-project", config: { extends: "worker" } }],
    ["agent-b", { projectId: "test-project", config: { extends: "worker" } }],
    ["other", { projectId: "other-project", config: { extends: "worker" } }],
  ]);
  return {
    getRegisteredAgentIds: vi.fn(() => [...configs.keys()]),
    getAgentConfig: vi.fn((id: string) => configs.get(id) ?? null),
    getExtendedProjectConfig: vi.fn(() => null),
  };
});

const {
  handleAction,
  handleStarterDomainCreate,
  handleAgentKillAction,
  handleDomainKillAction,
} = await import("../../src/dashboard/actions.js");
const { approveProposal, rejectProposal } = await import("../../src/approval/resolve.js");
const { createTask, reassignTask, transitionTask } = await import("../../src/tasks/ops.js");
const { setWorkflowDraftSessionVisibility } = await import("../../src/workspace/drafts.js");
const {
  acceptWorkflowHelperProposal,
  sendWorkflowHelperMessage,
  startWorkflowHelperSession,
} = await import("../../src/workspace/helpers.js");
const { approveWorkflowReview, createWorkflowReviewFromDraft, rejectWorkflowReview } = await import("../../src/workspace/reviews.js");
const {
  disableAgent,
  enableAgent,
  disableDomain,
  enableDomain,
  isDomainDisabled,
} = await import("../../src/enforcement/disabled-store.js");
const { startMeeting, concludeMeeting } = await import("../../src/channels/meeting.js");
const { sendChannelMessage } = await import("../../src/channels/messages.js");
const { runSendDirectMessageCommand } = await import("../../src/app/commands/operator-messages.js");
const { emitSSE } = await import("../../src/dashboard/sse.js");
const { writeAuditEntry } = await import("../../src/audit.js");
const {
  activateEmergencyStop,
  deactivateEmergencyStop,
  isEmergencyStopActive,
} = await import("../../src/safety.js");
const { killStuckAgent } = await import("../../src/audit/auto-kill.js");
const { allocateBudget } = await import("../../src/budget-cascade.js");
const { normalizeBudgetConfig } = await import("../../src/budget/normalize.js");
const { getDb } = await import("../../src/db.js");
const {
  updateDomainConfig,
  reloadDomainRuntime,
  reloadDomainRuntimes,
  readDomainConfig,
  updateGlobalAgentConfig,
  readGlobalConfig,
  upsertGlobalAgents,
  writeDomainConfig,
} = await import("../../src/config/api-service.js");
const {
  runRequestControllerHandoffCommand,
  runRecoverRecurringRunCommand,
} = await import("../../src/app/commands/setup-controls.js");

describe("handleStarterDomainCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (readDomainConfig as any).mockReturnValue(null);
    (readGlobalConfig as any).mockReturnValue({ agents: {} });
    (upsertGlobalAgents as any).mockReturnValue({ ok: true });
    (writeDomainConfig as any).mockReturnValue({ ok: true });
    (reloadDomainRuntime as any).mockReturnValue({ domains: ["starter-co"], errors: [] });
  });

  it("creates a starter domain for a new business", () => {
    const result = handleStarterDomainCreate({
      domainId: "Starter Co",
      mode: "new",
      mission: "Ship internal tools",
      operationalProfile: "high",
      paths: ["~/work/starter"],
    });

    expect(result.status).toBe(201);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      "starter-co-lead": expect.objectContaining({
        extends: "manager",
        title: "Business Lead",
      }),
      "starter-co-builder": expect.objectContaining({
        extends: "employee",
        reports_to: "starter-co-lead",
      }),
    }, "dashboard");
    expect(writeDomainConfig).toHaveBeenCalledWith("starter-co", expect.objectContaining({
      domain: "starter-co",
      agents: ["starter-co-lead", "starter-co-builder"],
      manager: { enabled: true, agentId: "starter-co-lead" },
      paths: ["~/work/starter"],
      operational_profile: "high",
      template: "startup",
      execution: {
        mode: "dry_run",
        default_mutation_policy: "simulate",
      },
    }));
    expect(reloadDomainRuntime).toHaveBeenCalledWith("starter-co");
  });

  it("rejects starter creation when the domain already exists", () => {
    (readDomainConfig as any).mockReturnValue({ domain: "starter-co", agents: [] });

    const result = handleStarterDomainCreate({
      domainId: "starter-co",
      mode: "new",
    });

    expect(result.status).toBe(409);
    expect(upsertGlobalAgents).not.toHaveBeenCalled();
    expect(writeDomainConfig).not.toHaveBeenCalled();
  });

  it("creates a governance starter around existing agents and only upserts missing defs", () => {
    (readGlobalConfig as any).mockReturnValue({
      agents: {
        lead: { extends: "manager", title: "Existing Lead" },
      },
    });
    (reloadDomainRuntime as any).mockReturnValue({ domains: ["governed"], errors: [] });

    const result = handleStarterDomainCreate({
      domainId: "governed",
      mode: "governance",
      existingAgents: ["lead", "worker-a", "worker-b"],
      leadAgentId: "lead",
    });

    expect(result.status).toBe(201);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      "worker-a": expect.objectContaining({
        extends: "employee",
        reports_to: "lead",
      }),
      "worker-b": expect.objectContaining({
        extends: "employee",
        reports_to: "lead",
      }),
    }, "dashboard");
    expect(writeDomainConfig).toHaveBeenCalledWith("governed", expect.objectContaining({
      domain: "governed",
      agents: ["lead", "worker-a", "worker-b"],
      manager: { enabled: true, agentId: "lead" },
      execution: {
        mode: "dry_run",
        default_mutation_policy: "simulate",
      },
    }));
    expect(reloadDomainRuntime).toHaveBeenCalledWith("governed");
  });

  it("rejects governance starter creation without existing agents", () => {
    const result = handleStarterDomainCreate({
      domainId: "governed",
      mode: "governance",
      existingAgents: [],
    });

    expect(result.status).toBe(400);
    expect(upsertGlobalAgents).not.toHaveBeenCalled();
    expect(writeDomainConfig).not.toHaveBeenCalled();
  });
});

describe("handleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (readDomainConfig as any).mockReturnValue({
      domain: "test-project",
      agents: ["a1", "a2"],
      goals: {
        existing: { allocation: 25, description: "Existing goal" },
      },
    });
    (readGlobalConfig as any).mockReturnValue({
      agents: {
        a1: {
          briefing: [
            { source: "file", path: "context/ops.md" },
            { source: "direction" },
          ],
          expectations: [
            { tool: "clawforce_task", action: ["transition", "comment"], min_calls: 2 },
          ],
          jobs: {
            standup: { cron: "0 9 * * *", description: "Daily sync", enabled: true, nudge: "existing" },
          },
        },
        a2: {
          jobs: {
            cleanup: { cron: "0 18 * * *", enabled: false },
          },
        },
      },
    });
    (updateDomainConfig as any).mockReturnValue({ ok: true });
    (updateGlobalAgentConfig as any).mockReturnValue({ ok: true });
    (upsertGlobalAgents as any).mockReturnValue({ ok: true });
    (isDomainDisabled as any).mockReturnValue(false);
    (isEmergencyStopActive as any).mockReturnValue(false);
    (killStuckAgent as any).mockResolvedValue(false);
    (getDb as any).mockReturnValue({
      prepare: vi.fn(() => ({
        run: vi.fn(() => ({ changes: 0 })),
      })),
    });
  });

  // --- Approvals ---

  it("approves a proposal", () => {
    (approveProposal as any).mockReturnValue({ id: "p1", status: "approved" });

    const result = handleAction("test-project", "approvals/p1/approve", {});
    expect(result.status).toBe(200);
    expect(approveProposal).toHaveBeenCalledWith("test-project", "p1", undefined);
    expect(emitSSE).toHaveBeenCalledWith("test-project", "approval:resolved", {
      proposalId: "p1",
      status: "approved",
    });
  });

  it("rejects a proposal with feedback", () => {
    (rejectProposal as any).mockReturnValue({ id: "p1", status: "rejected" });

    const result = handleAction("test-project", "approvals/p1/reject", { feedback: "nope" });
    expect(result.status).toBe(200);
    expect(rejectProposal).toHaveBeenCalledWith("test-project", "p1", "nope");
  });

  it("returns 404 for missing proposal on approve", () => {
    (approveProposal as any).mockReturnValue(null);

    const result = handleAction("test-project", "approvals/p1/approve", {});
    expect(result.status).toBe(404);
  });

  // --- Tasks ---

  it("creates a task", () => {
    (createTask as any).mockReturnValue({ id: "t1", title: "Test task" });

    const result = handleAction("test-project", "tasks/create", {
      title: "Test task",
      priority: "medium",
      assignedTo: "agent-a",
    });
    expect(result.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        title: "Test task",
        priority: "medium",
        assignedTo: "agent-a",
        createdBy: "dashboard",
      }),
    );
    expect(emitSSE).toHaveBeenCalledWith("test-project", "task:update", {
      taskId: "t1",
      action: "created",
    });
  });

  it("returns 400 for task create without title", () => {
    const result = handleAction("test-project", "tasks/create", {});
    expect(result.status).toBe(400);
  });

  it("reassigns a task", () => {
    (reassignTask as any).mockReturnValue({ ok: true, task: { id: "t1" } });

    const result = handleAction("test-project", "tasks/t1/reassign", { newAssignee: "agent-b" });
    expect(result.status).toBe(200);
    expect(reassignTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        taskId: "t1",
        newAssignee: "agent-b",
      }),
    );
  });

  it("returns 400 for reassign without newAssignee", () => {
    const result = handleAction("test-project", "tasks/t1/reassign", {});
    expect(result.status).toBe(400);
  });

  it("returns 400 for failed reassign", () => {
    (reassignTask as any).mockReturnValue({ ok: false, reason: "Task not found" });

    const result = handleAction("test-project", "tasks/t1/reassign", { newAssignee: "agent-b" });
    expect(result.status).toBe(400);
  });

  it("transitions a task", () => {
    (transitionTask as any).mockReturnValue({ ok: true, task: { id: "t1" } });

    const result = handleAction("test-project", "tasks/t1/transition", { toState: "IN_PROGRESS" });
    expect(result.status).toBe(200);
  });

  it("updates workflow draft visibility", () => {
    (setWorkflowDraftSessionVisibility as any).mockReturnValue({
      id: "draft-1",
      workflowId: "wf-1",
      overlayVisibility: "hidden",
    });

    const result = handleAction("test-project", "workspace/drafts/draft-1/visibility", {
      overlayVisibility: "hidden",
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(setWorkflowDraftSessionVisibility).toHaveBeenCalledWith(
      "test-project",
      "draft-1",
      "hidden",
      "user",
    );
    expect(emitSSE).toHaveBeenCalledWith("test-project", "workspace:draft", {
      draftSessionId: "draft-1",
      workflowId: "wf-1",
      overlayVisibility: "hidden",
    });
  });

  it("returns 400 for invalid workflow draft visibility values", () => {
    const result = handleAction("test-project", "workspace/drafts/draft-1/visibility", {
      overlayVisibility: "nope",
    });
    expect(result.status).toBe(400);
    expect(setWorkflowDraftSessionVisibility).not.toHaveBeenCalled();
  });

  it("returns 404 when the workflow draft session does not exist", () => {
    (setWorkflowDraftSessionVisibility as any).mockReturnValue(null);
    const result = handleAction("test-project", "workspace/drafts/missing/visibility", {
      overlayVisibility: "visible",
    });
    expect(result.status).toBe(404);
  });

  // --- Phase D: helper sessions ---

  it("starts a workflow helper session and emits workspace:helper SSE", () => {
    (startWorkflowHelperSession as any).mockReturnValue({
      id: "helper-1",
      status: "asking",
      currentStep: "goal",
    });

    const result = handleAction("test-project", "workspace/helpers/start", {
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(startWorkflowHelperSession).toHaveBeenCalledWith({
      projectId: "test-project",
      actor: "user",
    });
    expect(emitSSE).toHaveBeenCalledWith("test-project", "workspace:helper", {
      helperSessionId: "helper-1",
      status: "asking",
      currentStep: "goal",
      created: true,
    });
  });

  it("sends a helper message and emits workspace:helper SSE", () => {
    (sendWorkflowHelperMessage as any).mockReturnValue({
      ok: true,
      session: {
        id: "helper-1",
        status: "proposing",
        currentStep: "review",
        proposal: { workflowName: "Pipeline" },
      },
    });

    const result = handleAction("test-project", "workspace/helpers/helper-1/messages", {
      actor: "user",
      content: "intake, execute, review",
    });
    expect(result.status).toBe(200);
    expect(sendWorkflowHelperMessage).toHaveBeenCalledWith({
      projectId: "test-project",
      helperSessionId: "helper-1",
      actor: "user",
      content: "intake, execute, review",
    });
    expect(emitSSE).toHaveBeenCalledWith("test-project", "workspace:helper", {
      helperSessionId: "helper-1",
      status: "proposing",
      currentStep: "review",
      proposalReady: true,
    });
  });

  it("returns 400 when sending an empty helper message", () => {
    const result = handleAction("test-project", "workspace/helpers/helper-1/messages", {
      content: "   ",
    });
    expect(result.status).toBe(400);
    expect(sendWorkflowHelperMessage).not.toHaveBeenCalled();
  });

  it("returns 409 when sending to a terminal helper session", () => {
    (sendWorkflowHelperMessage as any).mockReturnValue({
      ok: false,
      reason: "terminal",
      currentStatus: "accepted",
    });
    const result = handleAction("test-project", "workspace/helpers/helper-1/messages", {
      actor: "user",
      content: "anything",
    });
    expect(result.status).toBe(409);
    expect((result.body as { currentStatus: string }).currentStatus).toBe("accepted");
  });

  it("accepts a helper proposal, creates a draft-backed workflow, and emits helper + draft SSE", () => {
    (acceptWorkflowHelperProposal as any).mockReturnValue({
      ok: true,
      created: true,
      workflowId: "wf-new",
      draftSessionId: "draft-new",
      session: {
        id: "helper-1",
        status: "accepted",
        currentStep: "accepted",
      },
    });

    const result = handleAction("test-project", "workspace/helpers/helper-1/accept", {
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(acceptWorkflowHelperProposal).toHaveBeenCalledWith({
      projectId: "test-project",
      helperSessionId: "helper-1",
      actor: "user",
    });
    expect(emitSSE).toHaveBeenNthCalledWith(1, "test-project", "workspace:helper", {
      helperSessionId: "helper-1",
      status: "accepted",
      currentStep: "accepted",
      workflowId: "wf-new",
      draftSessionId: "draft-new",
      created: true,
    });
    expect(emitSSE).toHaveBeenNthCalledWith(2, "test-project", "workspace:draft", {
      draftSessionId: "draft-new",
      workflowId: "wf-new",
      overlayVisibility: "visible",
    });
  });

  it("returns 409 when accepting a helper session without a ready proposal", () => {
    (acceptWorkflowHelperProposal as any).mockReturnValue({
      ok: false,
      reason: "proposal_missing",
      currentStatus: "asking",
    });
    const result = handleAction("test-project", "workspace/helpers/helper-1/accept", { actor: "user" });
    expect(result.status).toBe(409);
    expect((result.body as { currentStatus: string }).currentStatus).toBe("asking");
  });

  // --- Phase C: draft confirm + workflow review approve/reject ---

  it("confirms a draft into a pending review", () => {
    (createWorkflowReviewFromDraft as any).mockReturnValue({
      ok: true,
      created: true,
      record: {
        id: "rev-1",
        workflowId: "wf-1",
        draftSessionId: "draft-1",
        status: "pending",
      },
    });

    const result = handleAction("test-project", "workspace/drafts/draft-1/confirm", {
      actor: "user",
      title: "Insert verify",
    });
    expect(result.status).toBe(200);
    expect(createWorkflowReviewFromDraft).toHaveBeenCalledWith({
      projectId: "test-project",
      draftSessionId: "draft-1",
      confirmedBy: "user",
      title: "Insert verify",
      summary: undefined,
    });
    expect(emitSSE).toHaveBeenCalledWith("test-project", "workspace:review", {
      reviewId: "rev-1",
      workflowId: "wf-1",
      draftSessionId: "draft-1",
      status: "pending",
      created: true,
    });
  });

  it("returns 404 when confirming a missing draft", () => {
    (createWorkflowReviewFromDraft as any).mockReturnValue({
      ok: false,
      reason: "draft_not_found",
    });
    const result = handleAction("test-project", "workspace/drafts/missing/confirm", { actor: "user" });
    expect(result.status).toBe(404);
  });

  it("returns 409 when confirming a terminal (applied) draft", () => {
    (createWorkflowReviewFromDraft as any).mockReturnValue({
      ok: false,
      reason: "draft_terminal",
      currentStatus: "applied",
    });
    const result = handleAction("test-project", "workspace/drafts/applied-draft/confirm", { actor: "user" });
    expect(result.status).toBe(409);
    expect((result.body as { currentStatus: string }).currentStatus).toBe("applied");
    // Must not broadcast a workspace:review event for a rejected confirm.
    expect(emitSSE).not.toHaveBeenCalledWith(
      "test-project",
      "workspace:review",
      expect.anything(),
    );
  });

  it("approves a workflow review and emits workspace:review SSE", () => {
    (approveWorkflowReview as any).mockReturnValue({
      ok: true,
      record: {
        id: "rev-1",
        workflowId: "wf-1",
        draftSessionId: "draft-1",
        status: "approved",
        resolvedBy: "reviewer",
        decisionNotes: "LGTM",
        resolvedAt: 2000,
      },
    });

    const result = handleAction("test-project", "workflow-reviews/rev-1/approve", {
      actor: "reviewer",
      decisionNotes: "LGTM",
    });
    expect(result.status).toBe(200);
    expect(approveWorkflowReview).toHaveBeenCalledWith({
      projectId: "test-project",
      reviewId: "rev-1",
      actor: "reviewer",
      decisionNotes: "LGTM",
    });
    expect(emitSSE).toHaveBeenCalledWith("test-project", "workspace:review", expect.objectContaining({
      reviewId: "rev-1",
      workflowId: "wf-1",
      status: "approved",
    }));
  });

  it("rejects a workflow review with feedback (fallback body key)", () => {
    (rejectWorkflowReview as any).mockReturnValue({
      ok: true,
      record: {
        id: "rev-1",
        workflowId: "wf-1",
        draftSessionId: "draft-1",
        status: "rejected",
        resolvedBy: "reviewer",
        decisionNotes: "too risky",
        resolvedAt: 2000,
      },
    });

    const result = handleAction("test-project", "workflow-reviews/rev-1/reject", {
      actor: "reviewer",
      feedback: "too risky",
    });
    expect(result.status).toBe(200);
    expect(rejectWorkflowReview).toHaveBeenCalledWith({
      projectId: "test-project",
      reviewId: "rev-1",
      actor: "reviewer",
      decisionNotes: "too risky",
    });
  });

  it("returns 404 when approving a missing review", () => {
    (approveWorkflowReview as any).mockReturnValue({ ok: false, reason: "not_found" });
    const result = handleAction("test-project", "workflow-reviews/missing/approve", { actor: "x" });
    expect(result.status).toBe(404);
  });

  it("returns 409 when approving an already-resolved review", () => {
    (approveWorkflowReview as any).mockReturnValue({
      ok: false,
      reason: "not_pending",
      currentStatus: "approved",
    });
    const result = handleAction("test-project", "workflow-reviews/rev-1/approve", { actor: "x" });
    expect(result.status).toBe(409);
    expect((result.body as { currentStatus: string }).currentStatus).toBe("approved");
  });

  it("404s an unknown workflow-review action", () => {
    const result = handleAction("test-project", "workflow-reviews/rev-1/bogus", {});
    expect(result.status).toBe(404);
  });

  // --- Agents ---

  it("disables an agent", () => {
    const result = handleAction("test-project", "agents/a1/disable", { reason: "testing" });
    expect(result.status).toBe(200);
    expect(disableAgent).toHaveBeenCalledWith("test-project", "a1", "testing");
    expect(emitSSE).toHaveBeenCalledWith("test-project", "agent:status", {
      agentId: "a1",
      status: "disabled",
      reason: "testing",
    });
  });

  it("enables an agent", () => {
    const result = handleAction("test-project", "agents/a1/enable", {});
    expect(result.status).toBe(200);
    expect(enableAgent).toHaveBeenCalledWith("test-project", "a1");
  });

  it("disables a domain", () => {
    const result = handleAction("test-project", "disable", { reason: "maintenance", actor: "user" });
    expect(result.status).toBe(200);
    expect(disableDomain).toHaveBeenCalledWith("test-project", "maintenance", "user");
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "test-project",
      actor: "user",
      action: "disable_domain",
    }));
  });

  it("enables a domain and clears emergency stop when needed", () => {
    (isDomainDisabled as any).mockReturnValue(true);
    (isEmergencyStopActive as any).mockReturnValue(true);

    const result = handleAction("test-project", "enable", { actor: "user" });
    expect(result.status).toBe(200);
    expect(deactivateEmergencyStop).toHaveBeenCalledWith("test-project");
    expect(enableDomain).toHaveBeenCalledWith("test-project");
    expect(writeAuditEntry).toHaveBeenCalledTimes(2);
  });

  it("persists a direct agent message through the sync action path", () => {
    const result = handleAction("test-project", "agents/a1/message", { message: "hello" });
    expect(result.status).toBe(201);
    expect(runSendDirectMessageCommand).toHaveBeenCalledWith("test-project", {
      toAgent: "a1",
      content: "hello",
      priority: undefined,
      proposalId: undefined,
    });
    expect(result.body).toEqual(expect.objectContaining({
      projectId: "test-project",
      toAgent: "a1",
      content: "hello",
    }));
  });

  it("queues an agent kill through the sync action path", () => {
    const result = handleAction("test-project", "agents/a1/kill", {});
    expect(result.status).toBe(202);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.agentId).toBe("a1");
    // 202 response must include action envelope with actionType
    const action = body.action as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(action.actionType).toBe("agent_kill");
    expect(action.state).toBe("accepted");
    // statusUrl is included when actionId is available (may be undefined if DB unavailable)
    expect("actionId" in action).toBe(true);
    expect("statusUrl" in action).toBe(true);
  });

  it("queues a domain kill through the sync action path", () => {
    const result = handleAction("test-project", "kill", { reason: "panic" });
    expect(result.status).toBe(202);
    const body = result.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.domainEnabled).toBe(false);
    expect(body.emergencyStop).toBe(true);
    // 202 response must include action envelope with actionType
    const action = body.action as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(action.actionType).toBe("domain_kill");
    expect(action.state).toBe("accepted");
    expect("actionId" in action).toBe(true);
    expect("statusUrl" in action).toBe(true);
  });

  // --- Meetings ---

  it("creates a meeting", () => {
    (startMeeting as any).mockReturnValue({
      channel: { id: "ch1", name: "meeting-1" },
      dispatched: true,
    });

    const result = handleAction("test-project", "meetings/create", {
      participants: ["agent-a", "agent-b"],
      prompt: "Discuss Q3 goals",
    });
    expect(result.status).toBe(201);
    expect(startMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        participants: ["agent-a", "agent-b"],
        prompt: "Discuss Q3 goals",
      }),
    );
    expect(emitSSE).toHaveBeenCalledWith("test-project", "meeting:started", {
      channelId: "ch1",
      participants: ["agent-a", "agent-b"],
    });
  });

  it("returns 400 for meeting create without participants", () => {
    const result = handleAction("test-project", "meetings/create", {});
    expect(result.status).toBe(400);
  });

  it("sends a meeting message", () => {
    (sendChannelMessage as any).mockReturnValue({ id: "m1", content: "hello" });

    const result = handleAction("test-project", "meetings/ch1/message", {
      content: "hello",
      fromAgent: "agent-a",
    });
    expect(result.status).toBe(200);
    expect(sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "ch1",
        projectId: "test-project",
        content: "hello",
        fromAgent: "agent-a",
      }),
    );
  });

  it("ends a meeting", () => {
    (concludeMeeting as any).mockReturnValue({ id: "ch1", status: "concluded" });

    const result = handleAction("test-project", "meetings/ch1/end", {});
    expect(result.status).toBe(200);
    expect(concludeMeeting).toHaveBeenCalledWith("test-project", "ch1", "dashboard");
    expect(emitSSE).toHaveBeenCalledWith("test-project", "meeting:ended", { channelId: "ch1" });
  });

  // --- Config / Budget (deferred) ---

  it("returns 400 for config save without section", () => {
    const result = handleAction("test-project", "config/save", {});
    expect(result.status).toBe(400);
  });

  it("saves safety config using canonical core keys", () => {
    const result = handleAction("test-project", "config/save", {
      section: "safety",
      data: {
        circuit_breaker_multiplier: 2.5,
        spawn_depth_limit: 6,
        loop_detection_threshold: 8,
      },
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(updateDomainConfig).toHaveBeenCalledWith(
      "test-project",
      "safety",
      {
        costCircuitBreaker: 2.5,
        maxSpawnDepth: 6,
        loopDetectionThreshold: 8,
      },
      "user",
    );
  });

  it("saves budget limits while splitting profile and initiatives to canonical sections", () => {
    const result = handleAction("test-project", "config/save", {
      section: "budget",
      data: {
        daily: { cents: 2000, tokens: 50000, requests: 25 },
        hourly: { cents: 200, tokens: 5000, requests: 5 },
        operational_profile: "high",
        initiatives: { existing: 55, new_one: 20 },
      },
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(updateDomainConfig).toHaveBeenNthCalledWith(
      1,
      "test-project",
      "budget",
      {
        daily: { cents: 2000, tokens: 50000, requests: 25 },
        hourly: { cents: 200, tokens: 5000, requests: 5 },
      },
      "user",
      { reload: "none" },
    );
    expect(updateDomainConfig).toHaveBeenNthCalledWith(
      2,
      "test-project",
      "operational_profile",
      "high",
      "user",
      { reload: "none" },
    );
    expect(updateDomainConfig).toHaveBeenNthCalledWith(
      3,
      "test-project",
      "goals",
      {
        existing: { allocation: 55, description: "Existing goal" },
        new_one: { allocation: 20 },
      },
      "user",
      { reload: "none" },
    );
    expect(reloadDomainRuntimes).toHaveBeenCalledWith(["test-project"]);
  });

  it("saves agents by upserting global config and updating the domain agent list", () => {
    const result = handleAction("test-project", "config/save", {
      section: "agents",
      data: [
        {
          id: "a1",
          title: "Ops Lead",
          persona: "Runs the operation",
          reports_to: "",
          department: "ops",
          team: "alpha",
          channel: "ops-alpha",
          briefing: ["file: context/ops.md", "direction"],
          expectations: ["clawforce_task: transition, comment (min: 2)"],
          performance_policy: { action: "alert", max_retries: 2, then: "terminate_and_alert" },
        },
      ],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      a1: {
        jobs: {
          standup: { cron: "0 9 * * *", description: "Daily sync", enabled: true, nudge: "existing" },
        },
        title: "Ops Lead",
        persona: "Runs the operation",
        department: "ops",
        team: "alpha",
        channel: "ops-alpha",
        briefing: [
          { source: "file", path: "context/ops.md" },
          { source: "direction" },
        ],
        expectations: [
          { tool: "clawforce_task", action: ["transition", "comment"], min_calls: 2 },
        ],
        performance_policy: { action: "alert", max_retries: 2, then: "terminate_and_alert" },
      },
    }, "user");
    expect(updateDomainConfig).toHaveBeenCalledWith(
      "test-project",
      "agents",
      ["a1"],
      "user",
      { reload: "none" },
    );
    expect(reloadDomainRuntimes).toHaveBeenCalledWith(["test-project"]);
  });

  it("parses new file briefing labels into structured context sources", () => {
    const result = handleAction("test-project", "config/save", {
      section: "agents",
      data: [
        {
          id: "a1",
          briefing: ["file: docs/architecture.md", "direction"],
        },
      ],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      a1: expect.objectContaining({
        briefing: [
          { source: "file", path: "docs/architecture.md" },
          { source: "direction" },
        ],
      }),
    }, "user");
  });

  it("parses new expectation strings into structured core expectations", () => {
    const result = handleAction("test-project", "config/save", {
      section: "agents",
      data: [
        {
          id: "a1",
          expectations: ["clawforce_log: write, outcome (min: 3)"],
        },
      ],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      a1: expect.objectContaining({
        expectations: [
          { tool: "clawforce_log", action: ["write", "outcome"], min_calls: 3 },
        ],
      }),
    }, "user");
  });

  it("saves runtime envelope and binding through the agents config surface", () => {
    const result = handleAction("test-project", "config/save", {
      section: "agents",
      data: [
        {
          id: "a1",
          runtimeRef: "existing-openclaw-a1",
          runtime: {
            allowedTools: ["Read", "Edit"],
            workspacePaths: ["packages/core"],
          },
        },
      ],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(upsertGlobalAgents).toHaveBeenCalledWith({
      a1: expect.objectContaining({
        runtime_ref: "existing-openclaw-a1",
        runtime: {
          allowedTools: ["Read", "Edit"],
          workspacePaths: ["packages/core"],
        },
      }),
    }, "user");
  });

  it("saves profile config through operational_profile alias", () => {
    const result = handleAction("test-project", "config/save", {
      section: "profile",
      data: { operational_profile: "high" },
    });
    expect(result.status).toBe(200);
    expect(updateDomainConfig).toHaveBeenCalledWith(
      "test-project",
      "operational_profile",
      "high",
      "dashboard",
    );
  });

  it("saves dashboard assistant config with canonical fields", () => {
    const result = handleAction("test-project", "config/save", {
      section: "dashboard_assistant",
      data: {
        enabled: false,
        agentId: " a1 ",
        model: " gpt-5.4-mini ",
      },
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(updateDomainConfig).toHaveBeenCalledWith(
      "test-project",
      "dashboard_assistant",
      {
        enabled: false,
        agentId: "a1",
        model: "gpt-5.4-mini",
      },
      "user",
    );
  });

  it("rejects dashboard assistant targets outside the domain", () => {
    const result = handleAction("test-project", "config/save", {
      section: "dashboard_assistant",
      data: {
        agentId: "other",
      },
      actor: "user",
    });
    expect(result.status).toBe(400);
    expect(updateDomainConfig).not.toHaveBeenCalledWith(
      "test-project",
      "dashboard_assistant",
      expect.anything(),
      expect.anything(),
    );
  });

  it("saves initiatives by merging into goals", () => {
    const result = handleAction("test-project", "config/save", {
      section: "initiatives",
      data: {
        existing: { allocation_pct: 40 },
        new_one: { allocation_pct: 15 },
      },
    });
    expect(result.status).toBe(200);
    expect(readDomainConfig).toHaveBeenCalledWith("test-project");
    expect(updateDomainConfig).toHaveBeenCalledWith(
      "test-project",
      "goals",
      {
        existing: { allocation: 40, description: "Existing goal" },
        new_one: { allocation: 15 },
      },
      "dashboard",
    );
  });

  it("saves jobs by merging into global agent config", () => {
    const result = handleAction("test-project", "config/save", {
      section: "jobs",
      data: [
        {
          id: "a1:standup",
          agent: "a1",
          cron: "0 10 * * *",
          enabled: false,
          description: "Updated daily sync",
        },
        {
          id: "a2:cleanup",
          agent: "a2",
          cron: "0 19 * * *",
          enabled: true,
        },
      ],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(readGlobalConfig).toHaveBeenCalled();
    expect(updateGlobalAgentConfig).toHaveBeenNthCalledWith(1, "a1", {
      jobs: {
        standup: {
          cron: "0 10 * * *",
          description: "Updated daily sync",
          enabled: false,
          nudge: "existing",
        },
      },
    }, "user");
    expect(updateGlobalAgentConfig).toHaveBeenNthCalledWith(2, "a2", {
      jobs: {
        cleanup: {
          cron: "0 19 * * *",
          enabled: true,
        },
      },
    }, "user");
    expect(reloadDomainRuntimes).toHaveBeenCalledWith(["test-project"]);
  });

  it("clears omitted jobs for project agents when saving the jobs section", () => {
    const result = handleAction("test-project", "config/save", {
      section: "jobs",
      data: [],
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(updateGlobalAgentConfig).toHaveBeenNthCalledWith(1, "a1", {
      jobs: {},
    }, "user");
    expect(updateGlobalAgentConfig).toHaveBeenNthCalledWith(2, "a2", {
      jobs: {},
    }, "user");
    expect(reloadDomainRuntimes).toHaveBeenCalledWith(["test-project"]);
  });

  it("validates defaults as a partial agent config object", () => {
    const result = handleAction("test-project", "config/validate", {
      section: "defaults",
      data: {
        briefing: "direction",
        performance_policy: [],
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      valid: false,
      section: "defaults",
      errors: expect.arrayContaining([
        "defaults.briefing: must be an array",
        "defaults.performance_policy: must be an object",
      ]),
    }));
  });

  it("validates role_defaults and team_templates as maps of partial agent config objects", () => {
    const roleDefaults = handleAction("test-project", "config/validate", {
      section: "role_defaults",
      data: {
        manager: {
          title: 42,
        },
      },
    });
    expect(roleDefaults.status).toBe(200);
    expect(roleDefaults.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "role_defaults.manager.title: must be a string",
      ]),
    }));

    const teamTemplates = handleAction("test-project", "config/validate", {
      section: "team_templates",
      data: {
        eng: "bad",
      },
    });
    expect(teamTemplates.status).toBe(200);
    expect(teamTemplates.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "team_templates.eng: must be an object",
      ]),
    }));
  });

  it("validates workflows and knowledge section shapes", () => {
    const workflows = handleAction("test-project", "config/validate", {
      section: "workflows",
      data: ["daily_review", ""],
    });
    expect(workflows.status).toBe(200);
    expect(workflows.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "workflows[1]: must be a non-empty string",
      ]),
    }));

    const knowledge = handleAction("test-project", "config/validate", {
      section: "knowledge",
      data: ["filesystem"],
    });
    expect(knowledge.status).toBe(200);
    expect(knowledge.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "knowledge: must be an object",
      ]),
    }));
  });

  it("validates rules and warns on unknown rule agents", () => {
    const malformed = handleAction("test-project", "config/validate", {
      section: "rules",
      data: [
        {
          name: "",
          trigger: "ci_failed",
          action: { agent: 42, prompt_template: 7 },
        },
      ],
    });
    expect(malformed.status).toBe(200);
    expect(malformed.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "rules[0].name: name must be a non-empty string",
        "rules[0].trigger: trigger must be an object",
        "rules[0].action.agent: action.agent must be a string",
        "rules[0].action.prompt_template: action.prompt_template must be a string",
      ]),
    }));

    const unknownAgent = handleAction("test-project", "config/validate", {
      section: "rules",
      data: [
        {
          name: "route-ci",
          trigger: { event: "ci_failed" },
          action: { agent: "ghost", prompt_template: "Fix {{payload.error}}" },
        },
      ],
    });
    expect(unknownAgent.status).toBe(200);
    expect(unknownAgent.body).toEqual(expect.objectContaining({
      valid: true,
      warnings: expect.arrayContaining([
        'rules[0].action.agent: references unknown agent "ghost"',
      ]),
    }));
  });

  it("validates event_handlers action shapes", () => {
    const result = handleAction("test-project", "config/validate", {
      section: "event_handlers",
      data: {
        ci_failed: [
          { action: "create_task", template: "" },
          { action: "notify", message: 42 },
          { action: "escalate", to: "ghost" },
          { action: "emit_event", event_type: "", event_payload: { branch: 1 } },
          { action: "dispatch_agent", session_type: "bad" },
        ],
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining([
        "event_handlers.ci_failed[0].template: must be a non-empty string",
        "event_handlers.ci_failed[1].message: must be a non-empty string",
        "event_handlers.ci_failed[3].event_type: must be a non-empty string",
        "event_handlers.ci_failed[3].event_payload.branch: must be a string",
        "event_handlers.ci_failed[4].agent_role: must be a non-empty string",
        "event_handlers.ci_failed[4].session_type: must be one of reactive, active, planning",
      ]),
      warnings: expect.arrayContaining([
        'event_handlers.ci_failed[2].to: references unknown agent "ghost"',
      ]),
    }));
  });

  it("returns 400 when budget allocation is missing required fields", () => {
    const result = handleAction("test-project", "budget/allocate", {});
    expect(result.status).toBe(400);
  });

  it("allocates budget with camelCase fields", () => {
    const result = handleAction("test-project", "budget/allocate", {
      parentAgentId: "a1",
      childAgentId: "a2",
      dailyLimitCents: 500,
      actor: "user",
    });
    expect(result.status).toBe(200);
    expect(allocateBudget).toHaveBeenCalledWith({
      projectId: "test-project",
      parentAgentId: "a1",
      childAgentId: "a2",
      dailyLimitCents: 500,
      allocationConfig: undefined,
    });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: "allocate_budget",
      actor: "user",
      targetId: "a2",
    }));
    expect(emitSSE).toHaveBeenCalledWith("test-project", "budget:update", expect.objectContaining({
      parentAgentId: "a1",
      childAgentId: "a2",
    }));
  });

  it("allocates budget with allocationConfig object", () => {
    const result = handleAction("test-project", "budget/allocate", {
      parent_agent_id: "a1",
      child_agent_id: "a2",
      allocation_config: {
        daily: { cents: 600, tokens: 1000 },
      },
    });
    expect(result.status).toBe(200);
    expect(normalizeBudgetConfig).toHaveBeenCalledWith({
      daily: { cents: 600, tokens: 1000 },
    });
    expect(allocateBudget).toHaveBeenCalledWith({
      projectId: "test-project",
      parentAgentId: "a1",
      childAgentId: "a2",
      dailyLimitCents: undefined,
      allocationConfig: {
        hourly: undefined,
        daily: { cents: 600, tokens: 1000 },
        monthly: undefined,
      },
    });
  });

  it("returns 400 when budget allocation fails", () => {
    (allocateBudget as any).mockReturnValueOnce({ ok: false, reason: "Parent has no budget" });
    const result = handleAction("test-project", "budget/allocate", {
      parentAgentId: "a1",
      childAgentId: "a2",
      dailyLimitCents: 500,
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "Parent has no budget" });
  });

  it("kills an agent session through the async helper", async () => {
    (killStuckAgent as any)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await handleAgentKillAction("test-project", "a1", { reason: "stop now", actor: "user" });
    expect(result.status).toBe(200);
    expect(killStuckAgent).toHaveBeenCalledTimes(2);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: "kill_agent",
      targetId: "a1",
    }));
  });

  it("returns 404 when killing an unknown agent", async () => {
    const result = await handleAgentKillAction("test-project", "missing", {});
    expect(result.status).toBe(404);
  });

  it("kills a domain through the async helper", async () => {
    (killStuckAgent as any)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    (getDb as any).mockReturnValue({
      prepare: vi.fn(() => ({
        run: vi.fn(() => ({ changes: 3 })),
      })),
    });

    const result = await handleDomainKillAction("test-project", { actor: "user", reason: "bad rollout" });
    expect(result.status).toBe(200);
    expect(disableDomain).toHaveBeenCalledWith("test-project", "EMERGENCY: bad rollout", "user");
    expect(activateEmergencyStop).toHaveBeenCalledWith("test-project");
    expect(killStuckAgent).toHaveBeenCalledTimes(8);
    // 3 audit entries: disable_domain, emergency_stop, lock_bypassed
    expect(writeAuditEntry).toHaveBeenCalledTimes(3);
  });

  it("routes setup controller handoff actions", () => {
    const result = handleAction("test-project", "setup/controller/handoff", { actor: "user" });
    expect(result.status).toBe(200);
    expect(runRequestControllerHandoffCommand).toHaveBeenCalledWith("test-project", { actor: "user" });
  });

  it("routes setup recurring recovery actions", () => {
    const result = handleAction("test-project", "setup/recurring/task-123/recover", { actor: "user" });
    expect(result.status).toBe(200);
    expect(runRecoverRecurringRunCommand).toHaveBeenCalledWith("test-project", "task-123", { actor: "user" });
  });

  // --- Unknown ---

  it("returns 404 for unknown action", () => {
    const result = handleAction("test-project", "unknown/action", {});
    expect(result.status).toBe(404);
  });

  it("returns 404 for too-short action path", () => {
    const result = handleAction("test-project", "approvals", {});
    expect(result.status).toBe(404);
  });
});
