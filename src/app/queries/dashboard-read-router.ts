import type {
  EventStatus,
  GoalStatus,
  MessageStatus,
  MessageType,
  ProtocolStatus,
  TaskPriority,
  TaskState,
} from "../../types.js";
import {
  EVENT_STATUSES,
  MESSAGE_TYPES,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_PRIORITIES,
  TASK_STATES,
} from "../../types.js";
import type { ActionStatusQuery } from "../../api/contract.js";
import {
  queryActionStatus,
  queryAgentDetail,
  queryAgents,
  queryAlerts,
  queryApprovals,
  queryAuditLog,
  queryAuditRuns,
  queryBudgetForecast,
  queryBudgetStatus,
  queryConfig,
  queryConfigVersions,
  queryCosts,
  queryDashboardSummary,
  queryDecisionInbox,
  queryEntities,
  queryEntityDetail,
  queryEnforcementRetries,
  queryEvents,
  queryGoals,
  queryGoalDetail,
  queryHealth,
  queryInterventions,
  queryKnowledge,
  queryKnowledgeFlags,
  queryManagerReviews,
  queryMeetingDetail,
  queryMeetings,
  queryMessages,
  queryMetricsDashboard,
  queryNotifications,
  queryOperatorComms,
  queryOnboardingState,
  queryOperationalMetrics,
  queryOrgChart,
  queryPolicies,
  queryPolicyViolations,
  queryProjects,
  queryPromotionCandidates,
  queryProtocols,
  queryQueueStatus,
  queryRecentChanges,
  queryResourceHistory,
  querySessions,
  querySessionDetail,
  querySetupExperience,
  querySlos,
  queryTasks,
  queryTaskDetail,
  queryThreadMessages,
  queryTrackedSessions,
  queryTrustDecisions,
  queryTrustHistory,
  queryTrustScores,
  queryUnreadCount,
  queryUserInbox,
  queryWorkerAssignments,
  queryWorkStreams,
  queryAttentionSummary,
  queryToolCalls,
} from "../../dashboard/queries.js";
import {
  ContextFileError,
  readDomainContextFile,
} from "./context-files.js";
import { queryDashboardAssistantStatus } from "./dashboard-assistant.js";
import { queryDomainCapabilities } from "./dashboard-meta.js";
import {
  queryProjectWorkspace,
  queryWorkflowDraftSession,
  queryWorkflowDraftSessions,
  queryScopedWorkspaceFeed,
  queryWorkflowReview,
  queryWorkflowReviews,
  queryWorkflowStageInspector,
  queryWorkflowTopology,
  type ScopedFeedParams,
} from "../../workspace/queries.js";
import { WORKFLOW_REVIEW_STATUSES, type WorkflowReviewStatus } from "../../workspace/types.js";
import { getDb } from "../../db.js";
import { getActionRecord } from "../../dashboard/action-status.js";
import { getExtendedProjectConfig } from "../../project.js";

export type DashboardReadRouteResult = {
  status: number;
  body: unknown;
};

const VALID_MESSAGE_STATUSES: readonly string[] = ["queued", "delivered", "read", "failed"];
const VALID_PROTOCOL_STATUSES: readonly string[] = [
  "awaiting_response", "resolved", "pending_acceptance", "in_progress",
  "completed", "rejected", "awaiting_review", "reviewed", "approved",
  "revision_requested", "expired", "escalated", "cancelled",
];
const VALID_GOAL_STATUSES: readonly string[] = ["active", "achieved", "abandoned"];
const VALID_NOTIFICATION_CATEGORIES = ["approval", "task", "budget", "health", "comms", "compliance", "system"];
const VALID_NOTIFICATION_SEVERITIES = ["critical", "warning", "info"];

function safeParseInt(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function ok(body: unknown): DashboardReadRouteResult {
  return { status: 200, body };
}

function notFound(message: string): DashboardReadRouteResult {
  return { status: 404, body: { error: message } };
}

export function mapContextFileErrorToRouteResult(
  error: unknown,
  fallbackMessage: string,
): DashboardReadRouteResult {
  if (error instanceof ContextFileError) {
    return { status: error.status, body: { error: error.message } };
  }
  return { status: 500, body: { error: fallbackMessage } };
}

export function queryProjectsIndex(): DashboardReadRouteResult {
  return ok(queryProjects());
}

export function queryLegacyProjectOverview(projectId: string): DashboardReadRouteResult {
  return ok({ id: projectId, agents: queryAgents(projectId) });
}

export function routeLegacyProjectRead(
  projectId: string,
  resource: string,
  params: Record<string, string>,
): DashboardReadRouteResult {
  const segments = resource.split("/").filter(Boolean);

  switch (segments[0] ?? "") {
    case "agents": {
      if (segments[1]) {
        const detail = queryAgentDetail(projectId, segments[1]);
        return detail ? ok(detail) : notFound("Agent not found");
      }
      return ok(queryAgents(projectId));
    }

    case "tasks": {
      if (segments[1]) {
        const detail = queryTaskDetail(projectId, segments[1]);
        return detail ? ok(detail) : notFound("Task not found");
      }
      const stateParam = params.state;
      const states = stateParam
        ? stateParam.split(",").filter((s): s is TaskState => (TASK_STATES as readonly string[]).includes(s))
        : undefined;
      const priority = params.priority && (TASK_PRIORITIES as readonly string[]).includes(params.priority)
        ? params.priority as TaskPriority
        : undefined;
      const kind = params.kind && (TASK_KINDS as readonly string[]).includes(params.kind)
        ? params.kind as import("../../types.js").TaskKind
        : undefined;
      const excludeKinds = params.excludeKinds
        ? params.excludeKinds
          .split(",")
          .filter((value): value is import("../../types.js").TaskKind => (TASK_KINDS as readonly string[]).includes(value))
        : undefined;
      const origin = params.origin && (TASK_ORIGINS as readonly string[]).includes(params.origin)
        ? params.origin as import("../../types.js").TaskOrigin
        : undefined;
      return ok(queryTasks(projectId, {
        state: states && states.length === 1 ? states[0] : states,
        assignedTo: params.assignee,
        priority,
        department: params.department,
        team: params.team,
        entityType: params.entityType,
        entityId: params.entityId,
        kind,
        excludeKinds,
        origin,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));
    }

    case "sessions": {
      if (segments[1]) {
        const detail = querySessionDetail(projectId, decodeURIComponent(segments[1]));
        return detail ? ok(detail) : notFound("Session not found");
      }
      return ok(querySessions(
        projectId,
        { agentId: params.agent },
        {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        },
      ));
    }

    case "events": {
      const eventStatus = params.status && (EVENT_STATUSES as readonly string[]).includes(params.status)
        ? params.status as EventStatus
        : undefined;
      return ok(queryEvents(projectId, {
        status: eventStatus,
        type: params.type,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "metrics":
      return ok(queryMetricsDashboard(projectId, {
        type: params.type,
        key: params.key,
        window: params.window ? safeParseInt(params.window, 3600) : undefined,
      }));

    case "costs":
      return ok(queryCosts(projectId, {
        agentId: params.agent,
        taskId: params.task,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
        until: params.until ? safeParseInt(params.until, Date.now()) : undefined,
        days: params.days,
      }));

    case "policies":
      return ok(queryPolicies(projectId));

    case "slos":
      return ok(querySlos(projectId));

    case "alerts":
      return ok(queryAlerts(projectId));

    case "org":
      return ok(queryOrgChart(projectId));

    case "health":
      return ok(queryHealth(projectId));

    case "messages": {
      const msgType = params.type && (MESSAGE_TYPES as readonly string[]).includes(params.type)
        ? params.type as MessageType
        : undefined;
      const msgStatus = params.status && VALID_MESSAGE_STATUSES.includes(params.status)
        ? params.status as MessageStatus
        : undefined;
      return ok(queryMessages(projectId, {
        agentId: params.agent,
        type: msgType,
        status: msgStatus,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "goals": {
      if (segments[1]) {
        const detail = queryGoalDetail(projectId, segments[1]);
        return detail ? ok(detail) : notFound("Goal not found");
      }
      const goalStatus = params.status && VALID_GOAL_STATUSES.includes(params.status)
        ? params.status as GoalStatus
        : undefined;
      return ok(queryGoals(projectId, {
        status: goalStatus,
        ownerAgentId: params.owner,
        parentGoalId: params.parent === "none" ? null : params.parent,
        entityType: params.entityType,
        entityId: params.entityId,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "event-handlers": {
      const extConfig = getExtendedProjectConfig(projectId);
      return ok(extConfig?.eventHandlers ?? {});
    }

    case "protocols": {
      const protoType = params.type && (MESSAGE_TYPES as readonly string[]).includes(params.type)
        ? params.type as MessageType
        : undefined;
      const protoStatus = params.status && VALID_PROTOCOL_STATUSES.includes(params.status)
        ? params.status as ProtocolStatus
        : undefined;
      return ok(queryProtocols(projectId, {
        agentId: params.agent,
        type: protoType,
        protocolStatus: protoStatus,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "audit-log":
      return ok(queryAuditLog(projectId, {
        actor: params.actor,
        action: params.action,
        targetType: params.targetType,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "audit-runs":
      return ok(queryAuditRuns(projectId, {
        agentId: params.agent,
        status: params.status,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "enforcement-retries":
      return ok(queryEnforcementRetries(projectId, {
        agentId: params.agent,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "onboarding":
      return ok(queryOnboardingState(projectId));

    case "tracked-sessions":
      return ok(queryTrackedSessions(projectId, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "worker-assignments":
      return ok(queryWorkerAssignments(projectId));

    case "queue":
      return ok(queryQueueStatus(projectId));

    case "knowledge":
      return ok(queryKnowledge(projectId, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "knowledge-flags":
      return ok(queryKnowledgeFlags(projectId, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "promotion-candidates":
      return ok(queryPromotionCandidates(projectId, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "tool-calls":
      return ok(queryToolCalls(projectId, {
        agentId: params.agent,
        sessionKey: params.session,
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
      }));

    case "config-versions":
      return ok(queryConfigVersions(projectId, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "manager-reviews":
      return ok(queryManagerReviews(projectId, params.task, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "trust-decisions":
      return ok(queryTrustDecisions(projectId, params.agent, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "policy-violations":
      return ok(queryPolicyViolations(projectId, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "workstreams":
      return ok(queryWorkStreams(projectId, segments[1]));

    case "inbox":
      return ok(queryUserInbox(projectId, {
        agentId: params.agent,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
      }));

    case "assistant":
      return ok(queryDashboardAssistantStatus(projectId));

    case "operator-comms":
      return ok(queryOperatorComms(projectId, {
        agentId: params.agent,
        limit: params.limit ? safeParseInt(params.limit, 25) : undefined,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
      }));

    case "context-files": {
      const requestedPath = params.path;
      if (!requestedPath) {
        return { status: 400, body: { error: "Missing required query param: path" } };
      }
      try {
        return ok(readDomainContextFile(projectId, requestedPath));
      } catch (error) {
        return mapContextFileErrorToRouteResult(error, "Failed to read context file");
      }
    }

    default:
      return notFound(`Unknown resource: ${resource}`);
  }
}

export function routeGatewayDomainRead(
  domain: string,
  resource: string,
  params: Record<string, string>,
): DashboardReadRouteResult {
  const segments = resource.split("/").filter(Boolean);
  const topResource = segments[0] ?? "";

  switch (topResource) {
    case "":
    case "dashboard":
      return ok(queryDashboardSummary(domain));

    case "agents": {
      if (segments[1]) {
        const detail = queryAgentDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Agent not found");
      }
      return ok(queryAgents(domain));
    }

    case "tasks": {
      if (segments[1]) {
        const detail = queryTaskDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Task not found");
      }
      const stateParam = params.state;
      const states = stateParam
        ? stateParam.split(",").filter((s): s is TaskState => (TASK_STATES as readonly string[]).includes(s))
        : undefined;
      const priority = params.priority && (TASK_PRIORITIES as readonly string[]).includes(params.priority)
        ? params.priority as TaskPriority
        : undefined;
      return ok(queryTasks(domain, {
        state: states && states.length === 1 ? states[0] : states,
        assignedTo: params.assignee,
        priority,
        department: params.department,
        team: params.team,
        entityType: params.entityType,
        entityId: params.entityId,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "approvals": {
      const approvalStatus = params.status && ["pending", "approved", "rejected"].includes(params.status)
        ? params.status as "pending" | "approved" | "rejected"
        : undefined;
      return ok(queryApprovals(domain, {
        status: approvalStatus,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "entities": {
      if (segments[1]) {
        const detail = queryEntityDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Entity not found");
      }
      return ok(queryEntities(domain, {
        kind: params.kind,
        state: params.state,
        health: params.health,
        ownerAgentId: params.owner,
        parentEntityId: params.parent === "none" ? null : params.parent,
        department: params.department,
        team: params.team,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "messages": {
      if (segments[1]) {
        return ok(queryThreadMessages(domain, segments[1], {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          since: params.since ? safeParseInt(params.since, 0) : undefined,
        }));
      }
      const msgType = params.type && (MESSAGE_TYPES as readonly string[]).includes(params.type)
        ? params.type as MessageType
        : undefined;
      const msgStatus = params.status && VALID_MESSAGE_STATUSES.includes(params.status)
        ? params.status as MessageStatus
        : undefined;
      return ok(queryMessages(domain, {
        agentId: params.agent,
        type: msgType,
        status: msgStatus,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "meetings": {
      if (segments[1]) {
        const detail = queryMeetingDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Meeting not found");
      }
      return ok(queryMeetings(domain, {
        status: params.status,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "budget":
      return segments[1] === "forecast"
        ? ok(queryBudgetForecast(domain))
        : ok(queryBudgetStatus(domain));

    case "trust":
      return segments[1] === "history"
        ? ok(queryTrustHistory(domain, params))
        : ok(queryTrustScores(domain));

    case "costs":
      return ok(queryCosts(domain, {
        agentId: params.agent,
        taskId: params.task,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
        until: params.until ? safeParseInt(params.until, Date.now()) : undefined,
        days: params.days,
      }));

    case "goals": {
      if (segments[1]) {
        const detail = queryGoalDetail(domain, segments[1]);
        return detail ? ok(detail) : notFound("Goal not found");
      }
      const goalStatus = params.status && VALID_GOAL_STATUSES.includes(params.status)
        ? params.status as GoalStatus
        : undefined;
      return ok(queryGoals(domain, {
        status: goalStatus,
        ownerAgentId: params.owner,
        parentGoalId: params.parent === "none" ? null : params.parent,
        entityType: params.entityType,
        entityId: params.entityId,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "config":
      return segments[1] === "versions"
        ? ok(queryConfigVersions(domain, params.limit ? safeParseInt(params.limit, 50) : undefined))
        : ok(queryConfig(domain));

    case "setup":
      return ok(querySetupExperience(domain));

    case "config-versions":
      return ok(queryConfigVersions(domain, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "context-files": {
      const requestedPath = params.path;
      if (!requestedPath) {
        return { status: 400, body: { error: "Missing required query param: path" } };
      }
      try {
        return ok(readDomainContextFile(domain, requestedPath, { includeDomainContext: true }));
      } catch (error) {
        return mapContextFileErrorToRouteResult(error, "Failed to read context file");
      }
    }

    case "org":
      return ok(queryOrgChart(domain));

    case "health":
      return ok(queryHealth(domain));

    case "slos":
      return ok(querySlos(domain));

    case "alerts":
      return ok(queryAlerts(domain));

    case "events": {
      const evtStatus = params.status && (EVENT_STATUSES as readonly string[]).includes(params.status)
        ? params.status as EventStatus
        : undefined;
      return ok(queryEvents(domain, {
        status: evtStatus,
        type: params.type,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "sessions": {
      if (segments[1]) {
        const detail = querySessionDetail(domain, decodeURIComponent(segments[1]));
        return detail ? ok(detail) : notFound("Session not found");
      }
      return ok(querySessions(domain, { agentId: params.agent }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));
    }

    case "metrics":
      return ok(queryMetricsDashboard(domain, {
        type: params.type,
        key: params.key,
        window: params.window ? safeParseInt(params.window, 3600) : undefined,
      }));

    case "policies":
      return ok(queryPolicies(domain));

    case "protocols": {
      const protoType = params.type && (MESSAGE_TYPES as readonly string[]).includes(params.type)
        ? params.type as MessageType
        : undefined;
      const protoStatus = params.status && VALID_PROTOCOL_STATUSES.includes(params.status)
        ? params.status as ProtocolStatus
        : undefined;
      return ok(queryProtocols(domain, {
        agentId: params.agent,
        type: protoType,
        protocolStatus: protoStatus,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "audit-log":
      return ok(queryAuditLog(domain, {
        actor: params.actor,
        action: params.action,
        targetType: params.targetType,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "audit-runs":
      return ok(queryAuditRuns(domain, {
        agentId: params.agent,
        status: params.status,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "enforcement-retries":
      return ok(queryEnforcementRetries(domain, {
        agentId: params.agent,
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "onboarding":
      return ok(queryOnboardingState(domain));

    case "tracked-sessions":
      return ok(queryTrackedSessions(domain, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "worker-assignments":
      return ok(queryWorkerAssignments(domain));

    case "queue":
      return ok(queryQueueStatus(domain));

    case "knowledge":
      return ok(queryKnowledge(domain, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "knowledge-flags":
      return ok(queryKnowledgeFlags(domain, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "promotion-candidates":
      return ok(queryPromotionCandidates(domain, {
        limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "interventions":
      return ok(queryInterventions(domain));

    case "workstreams":
      return ok(queryWorkStreams(domain, segments[1]));

    case "inbox":
      return ok(queryUserInbox(domain, {
        agentId: params.agent,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
      }));

    case "assistant":
      return ok(queryDashboardAssistantStatus(domain));

    case "operator-comms":
      return ok(queryOperatorComms(domain, {
        agentId: params.agent,
        limit: params.limit ? safeParseInt(params.limit, 25) : undefined,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
      }));

    case "operational-metrics":
      return ok(queryOperationalMetrics(domain, {
        windowHours: params.window ? safeParseInt(params.window, 24) : undefined,
      }));

    case "capabilities":
      return ok(queryDomainCapabilities(domain));

    case "action-records": {
      const query: ActionStatusQuery = {
        status: params.status as ActionStatusQuery["status"] | undefined,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      };
      return ok(queryActionStatus(domain, query));
    }

    case "actions": {
      const actionId = segments[1];
      if (actionId) {
        try {
          const db = getDb(domain);
          const record = getActionRecord(actionId, db);
          if (!record) return notFound(`Action record "${actionId}" not found`);
          return ok(record);
        } catch {
          return notFound(`Action record "${actionId}" not found`);
        }
      }
      const query: ActionStatusQuery = {
        status: params.status as ActionStatusQuery["status"] | undefined,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      };
      return ok(queryActionStatus(domain, query));
    }

    case "history": {
      const resourceType = segments[1];
      const resourceId = segments[2];

      if (resourceType && resourceId) {
        return ok(queryResourceHistory(domain, resourceType, decodeURIComponent(resourceId), {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
          provenance: params.provenance as import("../../history/store.js").ChangeProvenance | undefined,
        }));
      }

      return ok(queryRecentChanges(domain, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        resourceType: params.resourceType,
        provenance: params.provenance as import("../../history/store.js").ChangeProvenance | undefined,
      }));
    }

    case "attention":
    case "feed":
      return ok(queryAttentionSummary(domain));

    case "decision-inbox":
    case "decisions":
      return ok(queryDecisionInbox(domain));

    case "notifications":
      if (segments[1] === "unread-count") {
        return ok(queryUnreadCount(domain));
      }
      return ok(queryNotifications(domain, {
        category: params.category && VALID_NOTIFICATION_CATEGORIES.includes(params.category)
          ? params.category as import("../../notifications/types.js").NotificationCategory
          : undefined,
        severity: params.severity && VALID_NOTIFICATION_SEVERITIES.includes(params.severity)
          ? params.severity as import("../../notifications/types.js").NotificationSeverity
          : undefined,
        read: params.read === "true" ? true : params.read === "false" ? false : undefined,
        dismissed: params.dismissed === "true" ? true : params.dismissed === "false" ? false : undefined,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
      }));

    case "policy-violations":
    case "policy_violations":
      return ok(queryPolicyViolations(domain, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "manager-reviews":
    case "reviews":
      return ok(queryManagerReviews(domain, params.task, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "workspace": {
      const sub = segments[1] ?? "";
      if (sub === "" || sub === "overview") {
        return ok(queryProjectWorkspace(domain));
      }
      if (sub === "drafts") {
        const draftSessionId = segments[2];
        if (draftSessionId) {
          const detail = queryWorkflowDraftSession(domain, decodeURIComponent(draftSessionId));
          return detail ? ok(detail) : notFound("Workflow draft session not found");
        }
        return ok(queryWorkflowDraftSessions(domain, params.workflowId));
      }
      if (sub === "feed") {
        const feedParams = parseScopedFeedParams(domain, params);
        if (!feedParams) {
          return { status: 400, body: { error: "Invalid scope — workflow and stage scope require workflowId" } };
        }
        return ok(queryScopedWorkspaceFeed(feedParams));
      }
      return notFound(`Unknown workspace resource: ${sub}`);
    }

    case "workflows": {
      const workflowId = segments[1];
      if (!workflowId) {
        return notFound("workflowId required");
      }
      const kind = segments[2];
      if (!kind || kind === "topology") {
        const topology = queryWorkflowTopology(domain, workflowId);
        return topology ? ok(topology) : notFound("Workflow not found");
      }
      if (kind === "stages") {
        const stageKey = segments[3];
        if (!stageKey) {
          return notFound("stageKey required");
        }
        const inspector = queryWorkflowStageInspector(domain, workflowId, decodeURIComponent(stageKey));
        return inspector ? ok(inspector) : notFound("Workflow stage not found");
      }
      return notFound(`Unknown workflow resource: ${kind}`);
    }

    case "workflow-reviews": {
      const reviewId = segments[1];
      if (reviewId) {
        const detail = queryWorkflowReview(domain, decodeURIComponent(reviewId));
        return detail ? ok(detail) : notFound("Workflow review not found");
      }
      const statusParam = params.status;
      const includeStatuses = statusParam
        ? statusParam
          .split(",")
          .filter((s): s is WorkflowReviewStatus =>
            (WORKFLOW_REVIEW_STATUSES as readonly string[]).includes(s),
          )
        : undefined;
      return ok(queryWorkflowReviews(domain, {
        workflowId: params.workflowId,
        includeStatuses,
      }));
    }

    default:
      return notFound("Unknown resource");
  }
}

/**
 * Parse query-string inputs for `workspace/feed` into a `ScopedFeedParams`.
 *
 * Accepts:
 * - `?scope=project` (or no params)                   → project scope
 * - `?scope=workflow&workflowId=X`                    → workflow scope
 * - `?scope=stage&workflowId=X&stageKey=Y`            → stage scope
 * - bare `?workflowId=X&stageKey=Y` (scope inferred)  → stage scope
 * - bare `?workflowId=X`                              → workflow scope
 *
 * Returns `null` on inconsistent inputs (e.g. stage scope without workflowId).
 */
function parseScopedFeedParams(
  domain: string,
  params: Record<string, string>,
): ScopedFeedParams | null {
  const scope = params.scope;
  const workflowId = params.workflowId;
  const stageKey = params.stageKey;

  if (scope === "stage" || (scope == null && workflowId && stageKey)) {
    if (!workflowId || !stageKey) return null;
    return { kind: "stage", domainId: domain, workflowId, stageKey };
  }
  if (scope === "workflow" || (scope == null && workflowId)) {
    if (!workflowId) return null;
    return { kind: "workflow", domainId: domain, workflowId };
  }
  if (scope == null || scope === "project") {
    return { kind: "project", domainId: domain };
  }
  return null;
}
