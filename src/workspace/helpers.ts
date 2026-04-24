/**
 * Clawforce — Workspace helper sessions (Phase D)
 *
 * Framework-backed workflow-authoring conversations. The helper gathers
 * structured intake one prompt at a time, holds a proposed workflow topology,
 * and can materialize that proposal into a real draft session when accepted.
 *
 * The helper is not a hidden config system and not decorative chat state:
 * its conversation and proposal live in core truth.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { createWorkflowDraftSession } from "./drafts.js";
import type {
  WorkflowHelperConversationStep,
  WorkflowHelperGatheredAnswers,
  WorkflowHelperMessage,
  WorkflowHelperProposal,
  WorkflowHelperProposalStage,
  WorkflowHelperSession,
  WorkflowHelperSessionMode,
  WorkflowHelperSessionStatus,
} from "./types.js";
import { createWorkflow } from "../workflow.js";

type WorkflowHelperSessionRow = {
  id: string;
  project_id: string;
  mode: WorkflowHelperSessionMode;
  status: WorkflowHelperSessionStatus;
  current_step: WorkflowHelperConversationStep;
  created_by: string;
  messages_json: string;
  gathered_answers_json: string;
  proposal_json: string | null;
  linked_workflow_id: string | null;
  linked_draft_session_id: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
};

export type WorkflowHelperSessionRecord = {
  id: string;
  projectId: string;
  mode: WorkflowHelperSessionMode;
  status: WorkflowHelperSessionStatus;
  currentStep: WorkflowHelperConversationStep;
  createdBy: string;
  messages: WorkflowHelperMessage[];
  gatheredAnswers: WorkflowHelperGatheredAnswers;
  proposal?: WorkflowHelperProposal;
  linkedWorkflowId?: string;
  linkedDraftSessionId?: string;
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
};

export type StartWorkflowHelperSessionParams = {
  projectId: string;
  actor: string;
};

export type SendWorkflowHelperMessageParams = {
  projectId: string;
  helperSessionId: string;
  actor: string;
  content: string;
};

export type SendWorkflowHelperMessageResult =
  | { ok: true; session: WorkflowHelperSessionRecord }
  | { ok: false; reason: "not_found" | "terminal"; currentStatus?: WorkflowHelperSessionStatus };

export type AcceptWorkflowHelperProposalParams = {
  projectId: string;
  helperSessionId: string;
  actor: string;
};

export type AcceptWorkflowHelperProposalResult =
  | {
      ok: true;
      created: boolean;
      session: WorkflowHelperSessionRecord;
      workflowId: string;
      draftSessionId: string;
    }
  | {
      ok: false;
      reason: "not_found" | "proposal_missing";
      currentStatus?: WorkflowHelperSessionStatus;
    };

const INITIAL_HELPER_PROMPT = "What is the goal of this workflow?";
const TRIGGER_PROMPT = "What kicks this workflow off?";
const STAGES_PROMPT = "List the main stages in order. A comma-separated list is fine.";
const REFINE_PROMPT = "I proposed a starter workflow on the canvas. Accept it to turn it into a governed draft session, or send a revised stage list.";
const REFINE_EMPTY_PROMPT = "I need at least one stage name. Send the stages in order, comma-separated or one per line.";

export function startWorkflowHelperSession(
  params: StartWorkflowHelperSessionParams,
  dbOverride?: DatabaseSync,
): WorkflowHelperSessionRecord {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const messages = [helperMessage(INITIAL_HELPER_PROMPT, now)];

  db.prepare(`
    INSERT INTO workflow_helper_sessions (
      id, project_id, mode, status, current_step, created_by,
      messages_json, gathered_answers_json, proposal_json,
      linked_workflow_id, linked_draft_session_id,
      created_at, updated_at, accepted_at
    )
    VALUES (?, ?, 'create_workflow', 'asking', 'goal', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).run(
    id,
    params.projectId,
    params.actor,
    JSON.stringify(messages),
    JSON.stringify({}),
    now,
    now,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.actor,
    action: "workflow_helper.start",
    targetType: "workflow_helper_session",
    targetId: id,
    detail: "create_workflow",
  }, db);

  return getWorkflowHelperSessionRecord(params.projectId, id, db)!;
}

export function sendWorkflowHelperMessage(
  params: SendWorkflowHelperMessageParams,
  dbOverride?: DatabaseSync,
): SendWorkflowHelperMessageResult {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getWorkflowHelperSessionRecord(params.projectId, params.helperSessionId, db);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status === "accepted") {
    return { ok: false, reason: "terminal", currentStatus: current.status };
  }

  const content = params.content.trim();
  const operatorMessage = operatorMessageRecord(content);
  const messages = [...current.messages, operatorMessage];
  const gathered = { ...current.gatheredAnswers };
  let proposal = current.proposal;
  let status: WorkflowHelperSessionStatus = current.status;
  let currentStep: WorkflowHelperConversationStep = current.currentStep;
  let helperReply = "";

  switch (current.currentStep) {
    case "goal":
      gathered.goal = content;
      status = "asking";
      currentStep = "trigger";
      helperReply = TRIGGER_PROMPT;
      break;
    case "trigger":
      gathered.trigger = content;
      status = "asking";
      currentStep = "stages";
      helperReply = STAGES_PROMPT;
      break;
    case "stages":
    case "review": {
      const parsedStages = parseStageLabels(content);
      if (parsedStages.length === 0) {
        status = proposal ? "proposing" : "asking";
        currentStep = proposal ? "review" : "stages";
        helperReply = REFINE_EMPTY_PROMPT;
        break;
      }
      gathered.stagesText = content;
      proposal = buildProposal(params.helperSessionId, gathered, parsedStages);
      status = "proposing";
      currentStep = "review";
      helperReply = REFINE_PROMPT;
      break;
    }
    case "accepted":
      return { ok: false, reason: "terminal", currentStatus: current.status };
  }

  messages.push(helperMessage(helperReply));

  persistSession(
    {
      ...current,
      status,
      currentStep,
      messages,
      gatheredAnswers: gathered,
      proposal,
      updatedAt: Date.now(),
    },
    db,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.actor,
    action: "workflow_helper.message",
    targetType: "workflow_helper_session",
    targetId: params.helperSessionId,
    detail: content,
  }, db);

  return {
    ok: true,
    session: getWorkflowHelperSessionRecord(params.projectId, params.helperSessionId, db)!,
  };
}

export function acceptWorkflowHelperProposal(
  params: AcceptWorkflowHelperProposalParams,
  dbOverride?: DatabaseSync,
): AcceptWorkflowHelperProposalResult {
  const db = dbOverride ?? getDb(params.projectId);
  const current = getWorkflowHelperSessionRecord(params.projectId, params.helperSessionId, db);
  if (!current) return { ok: false, reason: "not_found" };

  if (current.status === "accepted" && current.linkedWorkflowId && current.linkedDraftSessionId) {
    return {
      ok: true,
      created: false,
      session: current,
      workflowId: current.linkedWorkflowId,
      draftSessionId: current.linkedDraftSessionId,
    };
  }

  if (!current.proposal) {
    return { ok: false, reason: "proposal_missing", currentStatus: current.status };
  }

  const workflow = createWorkflow({
    projectId: params.projectId,
    name: current.proposal.workflowName,
    phases: [],
    createdBy: params.actor,
  }, db);

  const draftSession = createWorkflowDraftSession({
    projectId: params.projectId,
    workflowId: workflow.id,
    title: `Create workflow: ${current.proposal.workflowName}`,
    description: current.proposal.summary,
    createdBy: params.actor,
    draftWorkflow: {
      name: current.proposal.workflowName,
      phases: current.proposal.stages.map((stage) => ({
        name: stage.label,
        description: stage.description,
        taskIds: [],
        gateCondition: stage.gateCondition,
      })),
    },
  }, db);

  const acceptedAt = Date.now();
  const acceptanceNote = helperMessage(
    "Accepted. I turned the proposal into a real draft session linked to the new workflow.",
    acceptedAt,
  );
  persistSession(
    {
      ...current,
      status: "accepted",
      currentStep: "accepted",
      linkedWorkflowId: workflow.id,
      linkedDraftSessionId: draftSession.id,
      acceptedAt,
      updatedAt: acceptedAt,
      messages: [...current.messages, acceptanceNote],
    },
    db,
  );

  writeAuditEntry({
    projectId: params.projectId,
    actor: params.actor,
    action: "workflow_helper.accept",
    targetType: "workflow_helper_session",
    targetId: params.helperSessionId,
    detail: current.proposal.workflowName,
  }, db);

  const updated = getWorkflowHelperSessionRecord(params.projectId, params.helperSessionId, db)!;
  return {
    ok: true,
    created: true,
    session: updated,
    workflowId: workflow.id,
    draftSessionId: draftSession.id,
  };
}

export function getWorkflowHelperSessionRecord(
  projectId: string,
  helperSessionId: string,
  dbOverride?: DatabaseSync,
): WorkflowHelperSessionRecord | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(`
    SELECT * FROM workflow_helper_sessions
     WHERE id = ? AND project_id = ?
  `).get(helperSessionId, projectId) as WorkflowHelperSessionRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function toWorkflowHelperSessionDetail(
  projectId: string,
  record: WorkflowHelperSessionRecord,
): WorkflowHelperSession {
  return {
    scope: {
      kind: "helper",
      domainId: projectId,
      helperSessionId: record.id,
    },
    id: record.id,
    mode: record.mode,
    status: record.status,
    currentStep: record.currentStep,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messages: record.messages,
    gatheredAnswers: record.gatheredAnswers,
    proposal: record.proposal,
    linkedWorkflowId: record.linkedWorkflowId,
    linkedDraftSessionId: record.linkedDraftSessionId,
    acceptedAt: record.acceptedAt,
  };
}

function persistSession(
  record: WorkflowHelperSessionRecord,
  db: DatabaseSync,
): void {
  db.prepare(`
    UPDATE workflow_helper_sessions
       SET status = ?,
           current_step = ?,
           messages_json = ?,
           gathered_answers_json = ?,
           proposal_json = ?,
           linked_workflow_id = ?,
           linked_draft_session_id = ?,
           updated_at = ?,
           accepted_at = ?
     WHERE id = ? AND project_id = ?
  `).run(
    record.status,
    record.currentStep,
    JSON.stringify(record.messages),
    JSON.stringify(record.gatheredAnswers),
    record.proposal ? JSON.stringify(record.proposal) : null,
    record.linkedWorkflowId ?? null,
    record.linkedDraftSessionId ?? null,
    record.updatedAt,
    record.acceptedAt ?? null,
    record.id,
    record.projectId,
  );
}

function rowToRecord(row: WorkflowHelperSessionRow): WorkflowHelperSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    status: row.status,
    currentStep: row.current_step,
    createdBy: row.created_by,
    messages: JSON.parse(row.messages_json) as WorkflowHelperMessage[],
    gatheredAnswers: JSON.parse(row.gathered_answers_json) as WorkflowHelperGatheredAnswers,
    proposal: row.proposal_json
      ? JSON.parse(row.proposal_json) as WorkflowHelperProposal
      : undefined,
    linkedWorkflowId: row.linked_workflow_id ?? undefined,
    linkedDraftSessionId: row.linked_draft_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at ?? undefined,
  };
}

function buildProposal(
  helperSessionId: string,
  gathered: WorkflowHelperGatheredAnswers,
  stages: string[],
): WorkflowHelperProposal {
  const workflowName = deriveWorkflowName(gathered.goal);
  const proposalStages: WorkflowHelperProposalStage[] = stages.map((label, phaseIndex) => ({
    helperStageKey: `${helperSessionId}:helper-phase:${phaseIndex}`,
    phaseIndex,
    label,
    gateCondition: "all_done",
  }));

  const summaryParts: string[] = [];
  if (gathered.goal) summaryParts.push(`Goal: ${normalizeSentence(gathered.goal)}.`);
  if (gathered.trigger) summaryParts.push(`Trigger: ${normalizeSentence(gathered.trigger)}.`);
  summaryParts.push(`Stages: ${proposalStages.map((stage) => stage.label).join(" → ")}.`);

  return {
    workflowName,
    summary: summaryParts.join(" "),
    stages: proposalStages,
  };
}

function deriveWorkflowName(goal: string | undefined): string {
  const trimmed = goal?.trim();
  if (!trimmed) return "New workflow";
  return normalizeSentence(trimmed);
}

function normalizeSentence(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

function parseStageLabels(input: string): string[] {
  const normalized = input
    .replace(/\bthen\b/gi, ",")
    .replace(/->|→/g, ",")
    .split(/[\n,;]+/)
    .map((part) => part.replace(/^\s*[-*0-9.)]+\s*/, "").trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of normalized) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function helperMessage(content: string, createdAt = Date.now()): WorkflowHelperMessage {
  return {
    id: crypto.randomUUID(),
    role: "helper",
    content,
    createdAt,
  };
}

function operatorMessageRecord(content: string, createdAt = Date.now()): WorkflowHelperMessage {
  return {
    id: crypto.randomUUID(),
    role: "operator",
    content,
    createdAt,
  };
}
