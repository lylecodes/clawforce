import { writeAuditEntry } from "../../audit.js";
import { killStuckAgent } from "../../audit/auto-kill.js";
import {
  disableAgent,
  enableAgent,
} from "../../enforcement/disabled-store.js";
import { ingestEvent } from "../../events/store.js";
import { recordChange } from "../../history/store.js";
import { getAgentConfig, getRegisteredAgentIds } from "../../project.js";

export type AgentCommandResult = {
  status: number;
  body: unknown;
  sse?: {
    event: "agent:status";
    payload: Record<string, unknown>;
  };
};

export type KillAgentCommandResult = {
  ok: true;
  agentId: string;
  killedSessions: number;
  reason: string;
};

export function listProjectAgentIds(projectId: string): string[] {
  try {
    return getRegisteredAgentIds().filter((agentId) => {
      const entry = getAgentConfig(agentId);
      return entry?.projectId === projectId;
    });
  } catch {
    return [];
  }
}

export function isKnownProjectAgent(projectId: string, agentId: string): boolean {
  const projectAgentIds = listProjectAgentIds(projectId);
  return projectAgentIds.length === 0 || projectAgentIds.includes(agentId);
}

export function runDisableAgentCommand(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
): AgentCommandResult {
  if (!isKnownProjectAgent(projectId, agentId)) {
    return {
      status: 404,
      body: { error: `Agent "${agentId}" is not registered in project "${projectId}".` },
    };
  }

  const reason = (body.reason as string) ?? "Disabled via dashboard";
  const actor = (body.actor as string) ?? "dashboard";

  disableAgent(projectId, agentId, reason);

  try {
    ingestEvent(projectId, "agent_disabled", "internal", {
      agentId,
      reason,
      actor,
    }, `agent-disabled:${agentId}:${Date.now()}`);
  } catch {
    // non-fatal
  }

  try {
    recordChange(projectId, {
      resourceType: "agent",
      resourceId: agentId,
      action: "update",
      provenance: "human",
      actor,
      before: { agentId, enabled: true },
      after: { agentId, enabled: false, reason },
      reversible: true,
    });
  } catch {
    // non-fatal
  }

  return {
    status: 200,
    body: { agentId, status: "disabled" },
    sse: {
      event: "agent:status",
      payload: { agentId, status: "disabled", reason },
    },
  };
}

export function runEnableAgentCommand(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
): AgentCommandResult {
  if (!isKnownProjectAgent(projectId, agentId)) {
    return {
      status: 404,
      body: { error: `Agent "${agentId}" is not registered in project "${projectId}".` },
    };
  }

  const actor = (body.actor as string) ?? "dashboard";

  enableAgent(projectId, agentId);

  try {
    ingestEvent(projectId, "agent_enabled", "internal", {
      agentId,
      actor,
    }, `agent-enabled:${agentId}:${Date.now()}`);
  } catch {
    // non-fatal
  }

  try {
    recordChange(projectId, {
      resourceType: "agent",
      resourceId: agentId,
      action: "update",
      provenance: "human",
      actor,
      before: { agentId, enabled: false },
      after: { agentId, enabled: true },
      reversible: true,
    });
  } catch {
    // non-fatal
  }

  return {
    status: 200,
    body: { agentId, status: "enabled" },
    sse: {
      event: "agent:status",
      payload: { agentId, status: "idle" },
    },
  };
}

export async function runKillAgentCommand(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<KillAgentCommandResult> {
  const actor = (body.actor as string) ?? "dashboard";
  const reason = (body.reason as string) ?? "Killed via dashboard";

  let killedSessions = 0;
  for (const kind of ["main", "cron"] as const) {
    const killed = await killStuckAgent({
      projectId,
      agentId,
      sessionKey: `agent:${agentId}:${kind}`,
      reason,
    });
    if (killed) {
      killedSessions++;
    }
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "kill_agent",
      targetType: "agent",
      targetId: agentId,
      detail: JSON.stringify({ reason, killedSessions }),
    });
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    agentId,
    killedSessions,
    reason,
  };
}
