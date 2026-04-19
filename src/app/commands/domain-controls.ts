import { writeAuditEntry } from "../../audit.js";
import { killStuckAgent } from "../../audit/auto-kill.js";
import { getDb } from "../../db.js";
import {
  disableDomain as disableDomainState,
  enableDomain as enableDomainState,
  isDomainDisabled,
} from "../../enforcement/disabled-store.js";
import { recordChange } from "../../history/store.js";
import { getAgentConfig, getRegisteredAgentIds } from "../../project.js";
import {
  activateEmergencyStop,
  deactivateEmergencyStop,
  isEmergencyStopActive,
} from "../../safety.js";

export type DisableDomainCommandInput = {
  actor?: string;
  reason?: string;
};

export type DisableDomainCommandResult = {
  ok: true;
  domainEnabled: false;
  emergencyStop: boolean;
  reason: string;
};

export type EnableDomainCommandInput = {
  actor?: string;
};

export type EnableDomainCommandResult = {
  ok: true;
  domainEnabled: true;
  emergencyStop: false;
  clearedEmergencyStop: boolean;
  resumed: boolean;
};

export type KillDomainCommandInput = {
  actor?: string;
  reason?: string;
};

export type KillDomainCommandResult = {
  ok: true;
  domainEnabled: false;
  emergencyStop: true;
  reason: string;
  cancelledDispatches: number;
  killedSessions: number;
};

export function runDisableDomainCommand(
  projectId: string,
  input: DisableDomainCommandInput = {},
): DisableDomainCommandResult {
  const actor = input.actor ?? "dashboard";
  const reason = input.reason ?? "Disabled via dashboard";

  disableDomainState(projectId, reason, actor);
  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "disable_domain",
      targetType: "domain",
      targetId: projectId,
      detail: reason,
    });
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    domainEnabled: false,
    emergencyStop: isEmergencyStopActive(projectId),
    reason,
  };
}

export function runEnableDomainCommand(
  projectId: string,
  input: EnableDomainCommandInput = {},
): EnableDomainCommandResult {
  const actor = input.actor ?? "dashboard";
  const hadEmergencyStop = isEmergencyStopActive(projectId);
  const wasDisabled = isDomainDisabled(projectId);

  if (hadEmergencyStop) {
    deactivateEmergencyStop(projectId);
    try {
      writeAuditEntry({
        projectId,
        actor,
        action: "emergency_resume",
        targetType: "domain",
        targetId: projectId,
      });
    } catch {
      // non-fatal
    }
  }

  if (wasDisabled) {
    enableDomainState(projectId);
    try {
      writeAuditEntry({
        projectId,
        actor,
        action: "enable_domain",
        targetType: "domain",
        targetId: projectId,
      });
    } catch {
      // non-fatal
    }
  }

  return {
    ok: true,
    domainEnabled: true,
    emergencyStop: false,
    clearedEmergencyStop: hadEmergencyStop,
    resumed: wasDisabled || hadEmergencyStop,
  };
}

export async function runDomainKillCommand(
  projectId: string,
  input: KillDomainCommandInput = {},
): Promise<KillDomainCommandResult> {
  const actor = input.actor ?? "dashboard";
  const rawReason = input.reason ?? "Emergency stop via dashboard";
  const reason = rawReason.startsWith("EMERGENCY:") ? rawReason : `EMERGENCY: ${rawReason}`;

  disableDomainState(projectId, reason, actor);
  activateEmergencyStop(projectId);
  const cancelledDispatches = cancelQueuedDispatches(projectId, reason);

  let killedSessions = 0;
  for (const agentId of getProjectAgentIds(projectId)) {
    killedSessions += await killAgentSessions(projectId, agentId, reason);
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "disable_domain",
      targetType: "domain",
      targetId: projectId,
      detail: reason,
    });
    writeAuditEntry({
      projectId,
      actor,
      action: "emergency_stop",
      targetType: "domain",
      targetId: projectId,
      detail: JSON.stringify({ reason, cancelledDispatches, killedSessions }),
    });
    writeAuditEntry({
      projectId,
      actor,
      action: "lock_bypassed",
      targetType: "domain",
      targetId: projectId,
      detail: JSON.stringify({ bypassClass: "emergency_kill", reason }),
    });
  } catch {
    // non-fatal
  }

  try {
    recordChange(projectId, {
      resourceType: "org",
      resourceId: projectId,
      action: "domain_kill",
      provenance: "human",
      actor,
      after: { reason, cancelledDispatches, killedSessions },
      reversible: false,
    });
  } catch {
    // non-fatal
  }

  try {
    const { notifyKillSwitchActivated } = await import("../../notifications/integrations.js");
    notifyKillSwitchActivated(projectId, reason, actor);
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    domainEnabled: false,
    emergencyStop: true,
    reason,
    cancelledDispatches,
    killedSessions,
  };
}

function getProjectAgentIds(projectId: string): string[] {
  try {
    return getRegisteredAgentIds().filter((agentId) => {
      const entry = getAgentConfig(agentId);
      return entry?.projectId === projectId;
    });
  } catch {
    return [];
  }
}

function cancelQueuedDispatches(projectId: string, reason: string): number {
  try {
    const db = getDb(projectId);
    const result = db.prepare(
      "UPDATE dispatch_queue SET status = 'cancelled', last_error = ?, completed_at = ? WHERE project_id = ? AND status IN ('queued', 'leased')",
    ).run(reason, Date.now(), projectId) as { changes?: number };
    return result.changes ?? 0;
  } catch {
    return 0;
  }
}

async function killAgentSessions(projectId: string, agentId: string, reason: string): Promise<number> {
  let killedSessions = 0;
  for (const kind of ["main", "cron"] as const) {
    const killed = await killStuckAgent({
      projectId,
      agentId,
      sessionKey: `agent:${agentId}:${kind}`,
      reason,
    });
    if (killed) killedSessions++;
  }
  return killedSessions;
}
