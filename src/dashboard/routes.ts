/**
 * Clawforce — Dashboard routes
 *
 * Maps URL paths to query functions.
 * All routes return JSON via handleRequest().
 */

import type { TaskState, TaskPriority, EventStatus } from "../types.js";
import type { MessageType, MessageStatus } from "../types.js";
import type { ProtocolStatus, GoalStatus } from "../types.js";
import {
  queryProjects,
  queryAgents,
  queryAgentDetail,
  queryTasks,
  queryTaskDetail,
  querySessions,
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
        const states = stateParam ? stateParam.split(",") as TaskState[] : undefined;
        return ok(queryTasks(projectId, {
          state: states && states.length === 1 ? states[0] : states as any,
          assignedTo: params.assignee,
          priority: params.priority as TaskPriority | undefined,
          department: params.department,
          team: params.team,
        }, {
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
          offset: params.offset ? parseInt(params.offset, 10) : undefined,
        }));
      }

      case "sessions": {
        // GET /api/projects/:id/sessions
        return ok(querySessions(projectId, {
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
          offset: params.offset ? parseInt(params.offset, 10) : undefined,
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
        return ok(queryEvents(projectId, {
          status: params.status as EventStatus | undefined,
          type: params.type as string | undefined,
        }, {
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
        }));
      }

      case "metrics": {
        // GET /api/projects/:id/metrics
        return ok(queryMetricsDashboard(projectId, {
          type: params.type,
          key: params.key,
          window: params.window ? parseInt(params.window, 10) : undefined,
        }));
      }

      case "costs": {
        // GET /api/projects/:id/costs
        return ok(queryCosts(projectId, {
          agentId: params.agent,
          taskId: params.task,
          since: params.since ? parseInt(params.since, 10) : undefined,
          until: params.until ? parseInt(params.until, 10) : undefined,
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
        return ok(queryMessages(projectId, {
          agentId: params.agent,
          type: params.type as MessageType | undefined,
          status: params.status as MessageStatus | undefined,
          since: params.since ? parseInt(params.since, 10) : undefined,
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
        }));
      }

      case "goals": {
        // GET /api/projects/:id/goals?status=active&owner=foo&parent=none
        if (segments[4]) {
          const detail = queryGoalDetail(projectId, segments[4]);
          return detail ? ok(detail) : notFound("Goal not found");
        }
        return ok(queryGoals(projectId, {
          status: params.status as GoalStatus | undefined,
          ownerAgentId: params.owner,
          parentGoalId: params.parent === "none" ? null : params.parent,
        }, {
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
        }));
      }

      case "event-handlers": {
        // GET /api/projects/:id/event-handlers
        const extConfig = getExtendedProjectConfig(projectId);
        return ok(extConfig?.eventHandlers ?? {});
      }

      case "protocols": {
        // GET /api/projects/:id/protocols?agent=foo&type=request&status=awaiting_response
        return ok(queryProtocols(projectId, {
          agentId: params.agent,
          type: params.type as MessageType | undefined,
          protocolStatus: params.status as ProtocolStatus | undefined,
          limit: params.limit ? parseInt(params.limit, 10) : undefined,
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
