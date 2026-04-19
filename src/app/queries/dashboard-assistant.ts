import { readDomainConfig as readDomainConfigViaService } from "../../config/api-service.js";
import type { DashboardAssistantStatusResponse } from "../../api/contract.js";
import { getAgentConfig, getRegisteredAgentIds } from "../../project.js";

export type AssistantFallbackTarget = {
  agentId: string;
  title?: string;
  explicit: boolean;
  source: "explicit" | "configured" | "lead";
};

export type DashboardAssistantSettings = {
  enabled: boolean;
  agentId?: string;
};

function isLeadLikeAgent(projectId: string, agentId: string): boolean {
  const entry = getAgentConfig(agentId);
  if (!entry || entry.projectId !== projectId) return false;
  return !!entry.config.coordination?.enabled || !!entry.config.extends?.includes("lead");
}

export function getDashboardAssistantSettings(projectId: string): DashboardAssistantSettings {
  try {
    const raw = readDomainConfigViaService(projectId)?.dashboard_assistant;
    if (!raw || typeof raw !== "object") return { enabled: true };
    const config = raw as Record<string, unknown>;
    return {
      enabled: config.enabled !== false,
      agentId: typeof config.agentId === "string" && config.agentId.trim()
        ? config.agentId.trim()
        : undefined,
    };
  } catch {
    return { enabled: true };
  }
}

export function parseAssistantDirective(content: string): { requestedAgentId?: string; content: string } {
  const trimmed = content.trim();
  const mentionMatch = trimmed.match(/^@([\w-]+)\s+(.+)$/s);
  if (!mentionMatch) return { content: trimmed };
  return {
    requestedAgentId: mentionMatch[1],
    content: mentionMatch[2]?.trim() ?? "",
  };
}

export function resolveAssistantFallbackTarget(
  projectId: string,
  requestedAgentId?: string,
  assistantSettings: DashboardAssistantSettings = getDashboardAssistantSettings(projectId),
): AssistantFallbackTarget | null {
  if (requestedAgentId) {
    const requested = getAgentConfig(requestedAgentId);
    if (requested?.projectId === projectId) {
      return {
        agentId: requestedAgentId,
        title: requested.config.title,
        explicit: true,
        source: "explicit",
      };
    }
  }

  if (!assistantSettings.enabled) return null;

  if (assistantSettings.agentId) {
    const configured = getAgentConfig(assistantSettings.agentId);
    if (configured?.projectId === projectId) {
      return {
        agentId: assistantSettings.agentId,
        title: configured.config.title,
        explicit: false,
        source: "configured",
      };
    }
  }

  const allAgentIds = getRegisteredAgentIds();
  const projectAgentIds = new Set(
    allAgentIds.filter((agentId) => getAgentConfig(agentId)?.projectId === projectId),
  );

  const leads = allAgentIds
    .filter((agentId) => isLeadLikeAgent(projectId, agentId))
    .map((agentId) => {
      const entry = getAgentConfig(agentId)!;
      const reportsTo = entry.config.reports_to;
      const isRootLead = !reportsTo || reportsTo === "parent" || !projectAgentIds.has(reportsTo);
      return {
        agentId,
        title: entry.config.title,
        explicit: false,
        isRootLead,
      };
    })
    .sort((a, b) => {
      if (a.isRootLead !== b.isRootLead) return a.isRootLead ? -1 : 1;
      return a.agentId.localeCompare(b.agentId);
    });

  if (leads.length === 0) return null;
  const lead = leads[0]!;
  return {
    agentId: lead.agentId,
    title: lead.title,
    explicit: false,
    source: "lead",
  };
}

export function renderAssistantStoredMessage(target: AssistantFallbackTarget): string {
  if (target.source === "explicit") {
    return `Stored your operator request for "${target.agentId}". They will see it in their next briefing.`;
  }
  if (target.source === "configured") {
    return `No live assistant session is wired, so I routed your operator request to the configured assistant target "${target.agentId}". They will see it in their next briefing.`;
  }
  return `No live assistant session is wired, so I routed your operator request to "${target.agentId}". They will see it in their next briefing.`;
}

export function renderAssistantLiveDeliveryMessage(requestedAgentId: string, deliveredAgentId: string): string {
  if (requestedAgentId === deliveredAgentId) {
    return `Delivered your message to "${deliveredAgentId}".`;
  }
  return `Delivered your operator request to "${deliveredAgentId}".`;
}

export function renderAssistantUnavailableMessage(
  projectId: string,
  settings: DashboardAssistantSettings = getDashboardAssistantSettings(projectId),
): string {
  if (!settings.enabled) {
    return "The dashboard assistant is disabled for this domain. Use @lead-id in chat to message a lead directly, or enable dashboard_assistant in domain config.";
  }
  return "The dashboard assistant does not have a live session wired right now, and no lead target could be resolved. Use @lead-id in chat to message a lead directly, or configure a live assistant session in your runtime.";
}

export function queryDashboardAssistantStatus(projectId: string): DashboardAssistantStatusResponse {
  const settings = getDashboardAssistantSettings(projectId);
  const fallbackTarget = resolveAssistantFallbackTarget(projectId, undefined, settings);

  if (!settings.enabled) {
    return {
      enabled: false,
      configuredAgentId: settings.agentId,
      resolvedAgentId: fallbackTarget?.source !== "explicit" ? fallbackTarget?.agentId : undefined,
      resolvedTitle: fallbackTarget?.source !== "explicit" ? fallbackTarget?.title : undefined,
      resolutionSource: fallbackTarget?.source === "configured" || fallbackTarget?.source === "lead"
        ? fallbackTarget.source
        : undefined,
      deliveryPolicy: "unavailable",
      directMentionsSupported: true,
      note: renderAssistantUnavailableMessage(projectId, settings),
    };
  }

  if (!fallbackTarget || fallbackTarget.source === "explicit") {
    return {
      enabled: true,
      configuredAgentId: settings.agentId,
      deliveryPolicy: "unavailable",
      directMentionsSupported: true,
      note: renderAssistantUnavailableMessage(projectId, settings),
    };
  }

  const note = fallbackTarget.source === "configured"
    ? `Operator chat routes to configured assistant target "${fallbackTarget.agentId}" and falls back to stored delivery when no live session is available.`
    : `Operator chat routes to lead "${fallbackTarget.agentId}" by default and falls back to stored delivery when no live session is available.`;

  return {
    enabled: true,
    configuredAgentId: settings.agentId,
    resolvedAgentId: fallbackTarget.agentId,
    resolvedTitle: fallbackTarget.title,
    resolutionSource: fallbackTarget.source,
    deliveryPolicy: "live-if-session-available-else-store",
    directMentionsSupported: true,
    note,
  };
}
