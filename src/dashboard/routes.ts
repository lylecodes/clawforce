/**
 * Clawforce — Dashboard routes
 *
 * Maps URL paths to query functions.
 * All routes return JSON via handleRequest().
 */

import type { TaskState, TaskPriority, TaskKind, EventStatus } from "../types.js";
import type { MessageType, MessageStatus } from "../types.js";
import type { ProtocolStatus, GoalStatus } from "../types.js";
import { TASK_STATES, TASK_KINDS, TASK_PRIORITIES, EVENT_STATUSES, MESSAGE_TYPES } from "../types.js";

/** Parse an integer from a string, returning a default if NaN. */
function safeParseInt(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const VALID_MESSAGE_STATUSES: readonly string[] = ["queued", "delivered", "read", "failed"];
const VALID_PROTOCOL_STATUSES: readonly string[] = [
  "awaiting_response", "resolved", "pending_acceptance", "in_progress",
  "completed", "rejected", "awaiting_review", "reviewed", "approved",
  "revision_requested", "expired", "escalated", "cancelled",
];
const VALID_GOAL_STATUSES: readonly string[] = ["active", "achieved", "abandoned"];
import {
  queryProjects,
  queryAgents,
  queryAgentDetail,
  queryTasks,
  queryTaskDetail,
  querySessions,
  querySessionDetail,
  queryEvents,
  queryMetricsDashboard,
  queryCosts,
  queryPolicies,
  querySlos,
  queryAlerts,
  queryOrgChart,
  queryHealth,
  queryMessages,
  queryProtocols,
  queryGoals,
  queryGoalDetail,
  queryAuditLog,
  queryAuditRuns,
  queryEnforcementRetries,
  queryOnboardingState,
  queryTrackedSessions,
  queryWorkerAssignments,
  queryExperiments,
  queryKnowledge,
  queryKnowledgeFlags,
  queryPromotionCandidates,
  queryQueueStatus,
} from "./queries.js";
import { ingestEvent } from "../events/store.js";
import { getDb } from "../db.js";
import { getExtendedProjectConfig } from "../project.js";

export type RouteResult = {
  status: number;
  body: unknown;
};

/**
 * Route a request to the appropriate query function.
 * Returns { status, body } for the HTTP response.
 */
export function handleRequest(pathname: string, params: Record<string, string>, method?: string, body?: Record<string, unknown>): RouteResult {
  // Strip trailing slash
  const path = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;

  // Parse path segments
  const segments = path.split("/").filter(Boolean);

  // GET /api/projects
  if (segments.length === 2 && segments[0] === "api" && segments[1] === "projects") {
    return ok(queryProjects());
  }

  // Routes under /api/projects/:id/...
  if (segments.length >= 3 && segments[0] === "api" && segments[1] === "projects") {
    const projectId = segments[2]!;
    const resource = segments[3];

    if (!resource) {
      // GET /api/projects/:id — project detail (agents list)
      return ok({ id: projectId, agents: queryAgents(projectId) });
    }

    switch (resource) {
      case "agents": {
        if (segments[4]) {
          // GET /api/projects/:id/agents/:aid
          const detail = queryAgentDetail(projectId, segments[4]);
          return detail ? ok(detail) : notFound("Agent not found");
        }
        // GET /api/projects/:id/agents
        return ok(queryAgents(projectId));
      }

      case "tasks": {
        if (segments[4]) {
          // GET /api/projects/:id/tasks/:tid
          const detail = queryTaskDetail(projectId, segments[4]);
          return detail ? ok(detail) : notFound("Task not found");
        }
        // GET /api/projects/:id/tasks
        const stateParam = params.state;
        const states = stateParam
          ? stateParam.split(",").filter((s): s is TaskState => (TASK_STATES as readonly string[]).includes(s))
          : undefined;
        const priority = params.priority && (TASK_PRIORITIES as readonly string[]).includes(params.priority)
          ? params.priority as TaskPriority
          : undefined;
        const kindParam = params.kind && (TASK_KINDS as readonly string[]).includes(params.kind)
          ? params.kind as TaskKind
          : undefined;
        const excludeKindsParam = params.excludeKinds
          ? params.excludeKinds.split(",").filter((k): k is TaskKind => (TASK_KINDS as readonly string[]).includes(k))
          : undefined;
        return ok(queryTasks(projectId, {
          state: states && states.length === 1 ? states[0] : states,
          assignedTo: params.assignee,
          priority,
          department: params.department,
          team: params.team,
          kind: kindParam,
          excludeKinds: excludeKindsParam,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "sessions": {
        // GET /api/projects/:id/sessions/:sessionKey
        if (segments[4]) {
          const detail = querySessionDetail(projectId, decodeURIComponent(segments[4]));
          return detail ? ok(detail) : { status: 404, body: { error: "Session not found" } };
        }
        // GET /api/projects/:id/sessions
        return ok(querySessions(projectId, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "events": {
        // POST /api/projects/:id/events/ingest
        if (method === "POST" && segments[4] === "ingest") {
          if (!body?.type || typeof body.type !== "string") {
            return { status: 400, body: { error: "Missing required field: type" } };
          }
          const db = getDb(projectId);
          const result = ingestEvent(
            projectId,
            body.type as string,
            "webhook",
            (body.payload as Record<string, unknown>) ?? {},
            (body.dedup_key as string) ?? undefined,
            db,
          );
          return { status: result.deduplicated ? 200 : 201, body: result };
        }
        // GET /api/projects/:id/events
        const eventStatus = params.status && (EVENT_STATUSES as readonly string[]).includes(params.status)
          ? params.status as EventStatus
          : undefined;
        return ok(queryEvents(projectId, {
          status: eventStatus,
          type: params.type as string | undefined,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        }));
      }

      case "metrics": {
        // GET /api/projects/:id/metrics
        return ok(queryMetricsDashboard(projectId, {
          type: params.type,
          key: params.key,
          window: params.window ? safeParseInt(params.window, 3600) : undefined,
        }));
      }

      case "costs": {
        // GET /api/projects/:id/costs
        return ok(queryCosts(projectId, {
          agentId: params.agent,
          taskId: params.task,
          since: params.since ? safeParseInt(params.since, 0) : undefined,
          until: params.until ? safeParseInt(params.until, Date.now()) : undefined,
          days: params.days,
        }));
      }

      case "policies": {
        // GET /api/projects/:id/policies
        return ok(queryPolicies(projectId));
      }

      case "slos": {
        // GET /api/projects/:id/slos
        return ok(querySlos(projectId));
      }

      case "alerts": {
        // GET /api/projects/:id/alerts
        return ok(queryAlerts(projectId));
      }

      case "org": {
        // GET /api/projects/:id/org
        return ok(queryOrgChart(projectId));
      }

      case "health": {
        // GET /api/projects/:id/health
        return ok(queryHealth(projectId));
      }

      case "messages": {
        // GET /api/projects/:id/messages?agent=foo&type=direct&status=queued&limit=50
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
        // GET /api/projects/:id/goals?status=active&owner=foo&parent=none
        if (segments[4]) {
          const detail = queryGoalDetail(projectId, segments[4]);
          return detail ? ok(detail) : notFound("Goal not found");
        }
        const goalStatus = params.status && VALID_GOAL_STATUSES.includes(params.status)
          ? params.status as GoalStatus
          : undefined;
        return ok(queryGoals(projectId, {
          status: goalStatus,
          ownerAgentId: params.owner,
          parentGoalId: params.parent === "none" ? null : params.parent,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        }));
      }

      case "event-handlers": {
        // GET /api/projects/:id/event-handlers
        const extConfig = getExtendedProjectConfig(projectId);
        return ok(extConfig?.eventHandlers ?? {});
      }

      case "protocols": {
        // GET /api/projects/:id/protocols?agent=foo&type=request&status=awaiting_response
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

      case "audit-log": {
        return ok(queryAuditLog(projectId, {
          actor: params.actor,
          action: params.action,
          targetType: params.targetType,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "audit-runs": {
        return ok(queryAuditRuns(projectId, {
          agentId: params.agent,
          status: params.status,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "enforcement-retries": {
        return ok(queryEnforcementRetries(projectId, {
          agentId: params.agent,
        }, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "onboarding": {
        return ok(queryOnboardingState(projectId));
      }

      case "tracked-sessions": {
        return ok(queryTrackedSessions(projectId, {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "worker-assignments": {
        return ok(queryWorkerAssignments(projectId));
      }

      case "queue": {
        return ok(queryQueueStatus(projectId));
      }

      case "experiments": {
        return ok(queryExperiments(projectId));
      }

      case "knowledge": {
        return ok(queryKnowledge(projectId, {
          limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "knowledge-flags": {
        return ok(queryKnowledgeFlags(projectId, {
          limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      case "promotion-candidates": {
        return ok(queryPromotionCandidates(projectId, {
          limit: params.limit ? safeParseInt(params.limit, 100) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        }));
      }

      default:
        return notFound(`Unknown resource: ${resource}`);
    }
  }

  return notFound("Not found");
}

function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: { error: message } };
}
