import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createClawforceTaskTool } = await import("../../src/tools/task-tool.js");
const {
  approveProposal,
  rejectProposal,
  listPendingProposals,
  getProposal,
} = await import("../../src/approval/resolve.js");
const { registerEnforcementConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

describe("approval flow", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();

    // Register a project with approval policy
    registerEnforcementConfig(PROJECT, {
      name: "test",
      approval: {
        policy: "You may auto-approve routine maintenance. Everything else needs approval.",
      },
      agents: {
        leon: {
          extends: "manager",
          context_in: [{ source: "instructions" }],
          required_outputs: [{ tool: "clawforce_task", action: ["propose"], min_calls: 1 }],
          on_failure: { action: "alert" },
        },
      },
    });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
    resetEnforcementConfigForTest();
  });

  function createTool() {
    return createClawforceTaskTool({ agentSessionKey: "leon-session" });
  }

  async function execute(params: Record<string, unknown>) {
    const tool = createTool();
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  describe("get_approval_context action", () => {
    it("returns approval policy and pending proposals", async () => {
      const result = await execute({
        action: "get_approval_context",
        project_id: PROJECT,
        title: "Add new feature X",
        description: "Build a new widget system",
      });

      expect(result.ok).toBe(true);
      expect(result.proposal_context.approval_policy).toContain("routine maintenance");
      expect(result.proposal_context.pending_proposals).toEqual([]);
      expect(result.proposal_context.proposed_task.title).toBe("Add new feature X");
      expect(result.instructions).toContain("auto-approved");
    });

    it("includes existing pending proposals in context", async () => {
      // First submit a proposal
      await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Existing proposal",
      });

      // Now call get_approval_context — should see the pending one
      const result = await execute({
        action: "get_approval_context",
        project_id: PROJECT,
        title: "New proposal",
      });

      expect(result.proposal_context.pending_proposals).toHaveLength(1);
      expect(result.proposal_context.pending_proposals[0].title).toBe("Existing proposal");
    });
  });

  describe("submit_proposal action", () => {
    it("creates a pending proposal", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Build feature Y",
        description: "Detailed description of feature Y",
      });

      expect(result.ok).toBe(true);
      expect(result.proposal.id).toBeDefined();
      expect(result.proposal.status).toBe("pending");
      expect(result.proposal.title).toBe("Build feature Y");
    });

    it("stores approval policy snapshot", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Some proposal",
      });

      const proposal = getProposal(PROJECT, result.proposal.id);
      expect(proposal).not.toBeNull();
      expect(proposal!.approval_policy_snapshot).toContain("routine maintenance");
    });
  });

  describe("resolve proposals", () => {
    it("approves a proposal", async () => {
      const submitResult = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Feature Z",
      });

      const approved = approveProposal(PROJECT, submitResult.proposal.id, "Looks good");
      expect(approved).not.toBeNull();
      expect(approved!.status).toBe("approved");
      expect(approved!.user_feedback).toBe("Looks good");
      expect(approved!.resolved_at).toBeGreaterThan(0);
    });

    it("rejects a proposal with feedback", async () => {
      const submitResult = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Bad idea",
      });

      const rejected = rejectProposal(PROJECT, submitResult.proposal.id, "Not now");
      expect(rejected).not.toBeNull();
      expect(rejected!.status).toBe("rejected");
      expect(rejected!.user_feedback).toBe("Not now");
    });

    it("lists pending proposals", async () => {
      await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Proposal 1",
      });
      await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Proposal 2",
      });

      const pending = listPendingProposals(PROJECT);
      expect(pending).toHaveLength(2);
    });

    it("approved proposals don't appear in pending list", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "To approve",
      });

      approveProposal(PROJECT, result.proposal.id);

      const pending = listPendingProposals(PROJECT);
      expect(pending).toHaveLength(0);
    });

    it("double-approve returns null on second call", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Race test",
      });

      const first = approveProposal(PROJECT, result.proposal.id, "ok");
      expect(first).not.toBeNull();
      expect(first!.status).toBe("approved");

      const second = approveProposal(PROJECT, result.proposal.id, "duplicate");
      expect(second).toBeNull();
    });

    it("double-reject returns null on second call", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Race reject test",
      });

      const first = rejectProposal(PROJECT, result.proposal.id, "no");
      expect(first).not.toBeNull();
      expect(first!.status).toBe("rejected");

      const second = rejectProposal(PROJECT, result.proposal.id, "still no");
      expect(second).toBeNull();
    });

    it("approve after reject returns null", async () => {
      const result = await execute({
        action: "submit_proposal",
        project_id: PROJECT,
        title: "Cross resolve test",
      });

      rejectProposal(PROJECT, result.proposal.id, "rejected");
      const approved = approveProposal(PROJECT, result.proposal.id, "try approve");
      expect(approved).toBeNull();
    });
  });
});
