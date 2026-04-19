import type { DatabaseSync } from "../sqlite-driver.js";
import { resolveCommandExecutionEffect, getEffectiveExecutionConfig, resolveToolExecutionEffect } from "./policy.js";
import {
  attachProposalToSimulatedAction,
  recordSimulatedAction,
} from "./simulated-actions.js";
import { createProposal, type Proposal } from "../approval/resolve.js";
import { getApprovalNotifier } from "../approval/notify.js";
import { persistToolCallIntent } from "../approval/intent-store.js";
import { ingestEvent } from "../events/store.js";
import { safeLog } from "../diagnostics.js";
import type {
  DomainExecutionEffect,
  SimulatedAction,
} from "../types.js";

export type ToolExecutionInterceptContext = {
  projectId: string;
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  taskId?: string;
};

export type CommandExecutionInterceptContext = {
  projectId: string;
  actor?: string;
  sessionKey?: string;
  taskId?: string;
  entityType?: string;
  entityId?: string;
  sourceType?: string;
  sourceId?: string;
  summary?: string;
};

export type ExecutionInterceptDecision =
  | { effect: "allow" }
  | {
    effect: Exclude<DomainExecutionEffect, "allow">;
    reason: string;
    simulatedAction: SimulatedAction;
    proposal?: Proposal;
  };

function readStringValue(
  params: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function inferToolTarget(
  toolName: string,
  params: Record<string, unknown>,
  projectId: string,
  contextTaskId?: string,
): { targetType?: string; targetId?: string; entityType?: string; entityId?: string; taskId?: string } {
  const taskId = readStringValue(params, "task_id", "depends_on_task_id", "enqueue_task_id") ?? contextTaskId;
  const entityId = readStringValue(params, "entity_id");
  const entityType = readStringValue(params, "entity_type", "kind");
  const domain = readStringValue(params, "domain", "project_id") ?? projectId;

  if (toolName === "clawforce_task") {
    return { targetType: "task", targetId: taskId, taskId, entityType, entityId };
  }
  if (toolName === "clawforce_entity") {
    return { targetType: entityType ?? "entity", targetId: entityId, entityType, entityId, taskId };
  }
  if (toolName === "clawforce_config" || toolName === "clawforce_setup") {
    return { targetType: "domain", targetId: domain, taskId, entityType, entityId };
  }
  return { taskId, entityType, entityId };
}

function buildToolSummary(toolName: string, action: string | undefined): string {
  return action
    ? `Would execute ${toolName}:${action}`
    : `Would execute ${toolName}`;
}

function createSimulatedActionProposal(params: {
  projectId: string;
  simulatedAction: SimulatedAction;
  title: string;
  description: string;
  proposedBy: string;
  sessionKey?: string;
  riskTier: string;
  entityType?: string;
  entityId?: string;
  snapshot: Record<string, unknown>;
  notificationContext?: {
    toolName: string;
    category?: string;
    taskId?: string;
  };
  dbOverride?: DatabaseSync;
}): Proposal {
  const proposal = createProposal({
    projectId: params.projectId,
    title: params.title,
    description: params.description,
    proposedBy: params.proposedBy,
    sessionKey: params.sessionKey,
    approvalPolicySnapshot: JSON.stringify(params.snapshot),
    riskTier: params.riskTier,
    entityType: params.entityType,
    entityId: params.entityId,
    origin: "simulated_action",
    reasoning: `Execution policy intercepted ${params.simulatedAction.sourceType} action ${params.simulatedAction.summary}.`,
  });

  attachProposalToSimulatedAction(params.projectId, params.simulatedAction.id, proposal.id, params.dbOverride);
  params.simulatedAction.proposalId = proposal.id;

  getApprovalNotifier()?.sendProposalNotification({
    proposalId: proposal.id,
    projectId: params.projectId,
    title: proposal.title,
    description: proposal.description ?? undefined,
    proposedBy: params.proposedBy,
    riskTier: proposal.risk_tier ?? undefined,
    ...(params.notificationContext ? { toolContext: params.notificationContext } : {}),
  }).catch((err) => safeLog("execution.intercept.proposalNotify", err));

  try {
    ingestEvent(params.projectId, "proposal_created", "internal", {
      proposalId: proposal.id,
      proposedBy: params.proposedBy,
      riskTier: proposal.risk_tier,
      title: proposal.title,
      entityId: params.entityId,
      entityType: params.entityType,
      simulatedActionId: params.simulatedAction.id,
    }, `proposal-created:${proposal.id}`, params.dbOverride);
  } catch (err) {
    safeLog("execution.intercept.proposalEvent", err);
  }

  return proposal;
}

export function evaluateToolExecution(
  context: ToolExecutionInterceptContext,
  params: Record<string, unknown>,
  dbOverride?: DatabaseSync,
): ExecutionInterceptDecision {
  const config = getEffectiveExecutionConfig(context.projectId);
  const action = readStringValue(params, "action");
  const effect = resolveToolExecutionEffect(config, context.toolName, action);
  if (effect === "allow") {
    return { effect };
  }

  const target = inferToolTarget(context.toolName, params, context.projectId, context.taskId);
  const simulatedAction = recordSimulatedAction({
    projectId: context.projectId,
    domainId: context.projectId,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    taskId: target.taskId,
    entityType: target.entityType,
    entityId: target.entityId,
    sourceType: "tool",
    sourceId: context.toolName,
    actionType: action ?? "execute",
    targetType: target.targetType,
    targetId: target.targetId,
    summary: buildToolSummary(context.toolName, action),
    payload: params,
    policyDecision: effect,
  }, dbOverride);

  let proposal: Proposal | undefined;
  if (effect === "require_approval") {
    proposal = createSimulatedActionProposal({
      projectId: context.projectId,
      simulatedAction,
      title: `Approve dry-run action: ${buildToolSummary(context.toolName, action)}`,
      description: `${buildToolSummary(context.toolName, action)} was intercepted by domain execution policy and needs approval before it can run live.`,
      proposedBy: context.agentId ?? "system:execution",
      sessionKey: context.sessionKey,
      riskTier: context.toolName.startsWith("clawforce_") ? "medium" : "high",
      entityType: target.entityType,
      entityId: target.entityId,
      snapshot: {
        replayType: "tool",
        simulatedActionId: simulatedAction.id,
        toolName: context.toolName,
        toolParams: params,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        taskId: target.taskId,
      },
      notificationContext: {
        toolName: context.toolName,
        category: `execution:${context.toolName}`,
        taskId: target.taskId,
      },
      dbOverride,
    });

    if (target.taskId && context.agentId) {
      persistToolCallIntent({
        proposalId: proposal.id,
        projectId: context.projectId,
        agentId: context.agentId,
        taskId: target.taskId,
        toolName: context.toolName,
        toolParams: params,
        category: `execution:${context.toolName}`,
        riskTier: proposal.risk_tier ?? "high",
      }, dbOverride);
    }
  }

  return {
    effect,
    reason: effect === "simulate"
      ? `Domain is in dry-run mode. ${context.toolName}${action ? `:${action}` : ""} was simulated.`
      : effect === "require_approval"
        ? `Domain execution policy requires approval before ${context.toolName}${action ? `:${action}` : ""} can run live.`
        : `Domain execution policy blocked ${context.toolName}${action ? `:${action}` : ""}.`,
    simulatedAction,
    proposal,
  };
}

export function evaluateCommandExecution(
  context: CommandExecutionInterceptContext,
  command: string,
  payload?: Record<string, unknown>,
  dbOverride?: DatabaseSync,
): ExecutionInterceptDecision {
  const config = getEffectiveExecutionConfig(context.projectId);
  const effect = resolveCommandExecutionEffect(config, command);
  if (effect === "allow") {
    return { effect };
  }

  const simulatedAction = recordSimulatedAction({
    projectId: context.projectId,
    domainId: context.projectId,
    agentId: context.actor,
    sessionKey: context.sessionKey,
    taskId: context.taskId,
    entityType: context.entityType,
    entityId: context.entityId,
    sourceType: context.sourceType ?? "command",
    sourceId: context.sourceId,
    actionType: "exec",
    targetType: "command",
    targetId: command,
    summary: context.summary ?? `Would run command: ${command}`,
    payload: {
      command,
      ...(payload ?? {}),
    },
    policyDecision: effect,
  }, dbOverride);

  let proposal: Proposal | undefined;
  if (effect === "require_approval") {
    proposal = createSimulatedActionProposal({
      projectId: context.projectId,
      simulatedAction,
      title: `Approve dry-run command: ${command}`,
      description: `Command execution was intercepted by domain execution policy and needs approval before it can run live.`,
      proposedBy: context.actor ?? "system:execution",
      sessionKey: context.sessionKey,
      riskTier: "medium",
      entityType: context.entityType,
      entityId: context.entityId,
      snapshot: {
        replayType: "command",
        simulatedActionId: simulatedAction.id,
        command,
        payload: payload ?? {},
        actor: context.actor,
        sessionKey: context.sessionKey,
        taskId: context.taskId,
        entityType: context.entityType,
        entityId: context.entityId,
      },
      dbOverride,
    });
  }

  return {
    effect,
    reason: effect === "simulate"
      ? `Command was simulated by domain execution policy.`
      : effect === "require_approval"
        ? `Command requires approval before it can run live.`
        : `Command was blocked by domain execution policy.`,
    simulatedAction,
    proposal,
  };
}
