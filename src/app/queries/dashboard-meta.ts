import { buildAttentionSummary, buildDecisionInboxSummary } from "../../attention/builder.js";
import type { AttentionSummary } from "../../attention/types.js";
import type {
  CapabilityResponse,
  DashboardExtensionListResponse,
  DashboardRuntimeResponse,
} from "../../api/contract.js";
import { listDashboardExtensions } from "../../dashboard/extensions.js";
import { getActiveProjectIds } from "../../lifecycle.js";
import { getAgentConfig, getExtendedProjectConfig, getRegisteredAgentIds } from "../../project.js";
import {
  getDashboardAssistantSettings,
  resolveAssistantFallbackTarget,
} from "./dashboard-assistant.js";

export type ActiveDomainSummary = {
  id: string;
  agentCount: number;
};

const DEFAULT_RUNTIME_METADATA = {
  mode: "standalone",
  authMode: "localhost-only",
  notes: [
    "Runtime metadata was not explicitly provided by the caller.",
  ],
} satisfies DashboardRuntimeResponse;

const CAPABILITY_ENDPOINTS = [
  "dashboard", "agents", "tasks", "approvals", "messages",
  "meetings", "budget", "trust", "costs", "goals", "config",
  "setup",
  "entities",
  "org", "health", "slos", "alerts", "events", "sessions",
  "metrics", "policies", "protocols", "audit-log", "audit-runs",
  "enforcement-retries", "onboarding", "tracked-sessions",
  "worker-assignments", "queue", "knowledge",
  "knowledge-flags", "promotion-candidates", "interventions",
  "workstreams", "inbox", "operational-metrics", "capabilities",
  "assistant", "operator-comms",
  "extensions", "runtime", "actions", "action-records",
  "notifications", "attention", "feed", "decision-inbox", "history",
  "policy-violations", "manager-reviews", "reviews",
];

export function queryActiveDomains(): ActiveDomainSummary[] {
  try {
    const projectIds = getActiveProjectIds();
    const allAgentIds = getRegisteredAgentIds();
    return projectIds.map((id) => ({
      id,
      agentCount: allAgentIds.filter((agentId) => getAgentConfig(agentId)?.projectId === id).length,
    }));
  } catch {
    return [];
  }
}

export function queryDashboardExtensions(): DashboardExtensionListResponse {
  const extensions = listDashboardExtensions();
  return { extensions, count: extensions.length };
}

export function queryDashboardRuntimeMetadata(
  runtime?: DashboardRuntimeResponse,
): DashboardRuntimeResponse {
  return runtime ?? DEFAULT_RUNTIME_METADATA;
}

export function queryActiveAttentionRollup(): {
  businesses: AttentionSummary[];
  totals: { actionNeeded: number; watching: number; fyi: number };
} {
  try {
    const projectIds = getActiveProjectIds();
    const businesses = projectIds.map((id) => buildAttentionSummary(id));
    return {
      businesses,
      totals: {
        actionNeeded: businesses.reduce((sum, business) => sum + business.counts.actionNeeded, 0),
        watching: businesses.reduce((sum, business) => sum + business.counts.watching, 0),
        fyi: businesses.reduce((sum, business) => sum + business.counts.fyi, 0),
      },
    };
  } catch {
    return { businesses: [], totals: { actionNeeded: 0, watching: 0, fyi: 0 } };
  }
}

export function queryActiveDecisionInboxRollup(): {
  businesses: AttentionSummary[];
  totals: { actionNeeded: number; watching: number; fyi: number };
} {
  try {
    const projectIds = getActiveProjectIds();
    const businesses = projectIds.map((id) => buildDecisionInboxSummary(id));
    return {
      businesses,
      totals: {
        actionNeeded: businesses.reduce((sum, business) => sum + business.counts.actionNeeded, 0),
        watching: businesses.reduce((sum, business) => sum + business.counts.watching, 0),
        fyi: businesses.reduce((sum, business) => sum + business.counts.fyi, 0),
      },
    };
  } catch {
    return { businesses: [], totals: { actionNeeded: 0, watching: 0, fyi: 0 } };
  }
}

export function queryDomainCapabilities(domain: string): CapabilityResponse {
  let hasApprovals = false;
  let hasBudget = false;
  let hasTrust = false;
  let hasMemory = false;
  let channelsConfigured = false;

  try {
    const extConfig = getExtendedProjectConfig(domain);
    if (extConfig) {
      hasApprovals = !!extConfig.policies;
      hasBudget = !!extConfig.safety;
      hasTrust = !!extConfig.trust;
      hasMemory = !!extConfig.memory;
      channelsConfigured = !!(extConfig.channels && (extConfig.channels as unknown[]).length > 0);
    }
  } catch {
    // Keep the default feature set when config inspection fails.
  }

  const projectAgentCount = getRegisteredAgentIds()
    .filter((agentId) => getAgentConfig(agentId)?.projectId === domain)
    .length;
  const directAgentMessaging = projectAgentCount > 0;
  const assistantSettings = getDashboardAssistantSettings(domain);
  const assistantTarget = resolveAssistantFallbackTarget(domain, undefined, assistantSettings);
  const assistantRouting = directAgentMessaging || !!assistantTarget;
  const hasComms = directAgentMessaging || channelsConfigured;
  const loadedExtensions = listDashboardExtensions();

  return {
    version: "0.2.0",
    features: {
      tasks: true,
      approvals: hasApprovals,
      budget: hasBudget,
      trust: hasTrust,
      memory: hasMemory,
      comms: hasComms,
    },
    messaging: {
      operatorChat: assistantRouting,
      directAgentMessaging,
      channels: channelsConfigured,
      assistantRouting,
    },
    endpoints: CAPABILITY_ENDPOINTS,
    extensions: {
      count: loadedExtensions.length,
      ids: loadedExtensions.map((extension) => extension.id),
    },
  };
}
