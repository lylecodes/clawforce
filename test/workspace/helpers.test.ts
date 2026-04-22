/**
 * Phase D — workflow helper session lifecycle tests.
 *
 * Integration-style against a real in-memory DB so the helper session,
 * workflow creation, and draft-session materialization are all tested
 * through the real framework code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../../src/sqlite-driver.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { getWorkflow } = await import("../../src/workflow.js");
const { getWorkflowDraftSessionRecord } = await import("../../src/workspace/drafts.js");
const {
  acceptWorkflowHelperProposal,
  getWorkflowHelperSessionRecord,
  sendWorkflowHelperMessage,
  startWorkflowHelperSession,
} = await import("../../src/workspace/helpers.js");
const { queryWorkflowHelperSession } = await import("../../src/workspace/queries.js");

const DOMAIN = "ws-helper-test";

describe("workflow helper sessions", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("starts with a goal question and exposes helper scope through the query surface", () => {
    const session = startWorkflowHelperSession({
      projectId: DOMAIN,
      actor: "user",
    }, db);

    expect(session.status).toBe("asking");
    expect(session.currentStep).toBe("goal");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]!.role).toBe("helper");
    expect(session.messages[0]!.content).toContain("goal");

    const detail = queryWorkflowHelperSession(DOMAIN, session.id, db);
    expect(detail?.scope).toEqual({
      kind: "helper",
      domainId: DOMAIN,
      helperSessionId: session.id,
    });
    expect(detail?.messages).toHaveLength(1);
  });

  it("collects goal, trigger, and stages one question at a time before proposing", () => {
    const session = startWorkflowHelperSession({ projectId: DOMAIN, actor: "user" }, db);

    const goal = sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "Ship onboarding reliably",
    }, db);
    expect(goal.ok).toBe(true);
    if (!goal.ok) throw new Error("unreachable");
    expect(goal.session.currentStep).toBe("trigger");
    expect(goal.session.gatheredAnswers.goal).toBe("Ship onboarding reliably");

    const trigger = sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "A new customer signs up",
    }, db);
    expect(trigger.ok).toBe(true);
    if (!trigger.ok) throw new Error("unreachable");
    expect(trigger.session.currentStep).toBe("stages");
    expect(trigger.session.gatheredAnswers.trigger).toBe("A new customer signs up");

    const proposal = sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "intake, configure, verify, launch",
    }, db);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) throw new Error("unreachable");
    expect(proposal.session.status).toBe("proposing");
    expect(proposal.session.currentStep).toBe("review");
    expect(proposal.session.proposal?.workflowName).toBe("Ship onboarding reliably");
    expect(proposal.session.proposal?.stages.map((stage) => stage.label)).toEqual([
      "intake",
      "configure",
      "verify",
      "launch",
    ]);
  });

  it("accepts a helper proposal into a real workflow + draft session", () => {
    const session = startWorkflowHelperSession({ projectId: DOMAIN, actor: "user" }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "Launch a new onboarding workflow",
    }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "When a customer signs up",
    }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "intake, configure, verify, launch",
    }, db);

    const accepted = acceptWorkflowHelperProposal({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
    }, db);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("unreachable");
    expect(accepted.created).toBe(true);

    const workflow = getWorkflow(DOMAIN, accepted.workflowId, db);
    expect(workflow?.name).toBe("Launch a new onboarding workflow");
    expect(workflow?.phases).toEqual([]);

    const draft = getWorkflowDraftSessionRecord(DOMAIN, accepted.draftSessionId, db);
    expect(draft?.workflowId).toBe(accepted.workflowId);
    expect(draft?.draftWorkflow.phases.map((phase) => phase.name)).toEqual([
      "intake",
      "configure",
      "verify",
      "launch",
    ]);

    const helperAfter = getWorkflowHelperSessionRecord(DOMAIN, session.id, db);
    expect(helperAfter?.status).toBe("accepted");
    expect(helperAfter?.linkedWorkflowId).toBe(accepted.workflowId);
    expect(helperAfter?.linkedDraftSessionId).toBe(accepted.draftSessionId);
  });

  it("refuses new helper messages after acceptance", () => {
    const session = startWorkflowHelperSession({ projectId: DOMAIN, actor: "user" }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "Make a workflow",
    }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "When triggered",
    }, db);
    sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "draft, review, launch",
    }, db);
    acceptWorkflowHelperProposal({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
    }, db);

    const afterAccepted = sendWorkflowHelperMessage({
      projectId: DOMAIN,
      helperSessionId: session.id,
      actor: "user",
      content: "add one more stage",
    }, db);
    expect(afterAccepted.ok).toBe(false);
    if (afterAccepted.ok) throw new Error("unreachable");
    expect(afterAccepted.reason).toBe("terminal");
    expect(afterAccepted.currentStatus).toBe("accepted");
  });
});
