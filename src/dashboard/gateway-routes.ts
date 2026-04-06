/**
 * Clawforce — Gateway route handler
 *
 * Single HTTP handler registered via api.registerHttpRoute({ path: "/clawforce", match: "prefix" })
 * that dispatches all /clawforce/* requests to:
 *   - SSE endpoint:  GET /clawforce/api/sse?domain=<id>
 *   - REST reads:    GET /clawforce/api/:domain/:resource
 *   - REST actions:  POST /clawforce/api/:domain/:resource/:action
 *   - Static files:  GET /clawforce/* -> clawforce-dashboard/dist/
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listDashboardExtensions } from "./extensions.js";
import {
  handleAction,
  handleDemoCreate,
  handleStarterDomainCreate,
  handleAgentKillAction,
  handleDomainKillAction,
} from "./actions.js";
import { getSSEManager } from "./sse.js";
import { checkAuth, setCorsHeaders, setSecurityHeaders, checkRateLimit } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig, getRegisteredAgentIds, getAgentConfig } from "../project.js";
import {
  queryAgents,
  queryAgentDetail,
  queryTasks,
  queryTaskDetail,
  queryCosts,
  queryGoals,
  queryGoalDetail,
  queryOrgChart,
  queryMessages,
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryTrustHistory,
  queryConfig,
  queryMeetings,
  queryMeetingDetail,
  queryThreadMessages,
  queryHealth,
  querySlos,
  queryAlerts,
  queryEvents,
  querySessions,
  querySessionDetail,
  queryMetricsDashboard,
  queryPolicies,
  queryProtocols,
  queryAuditLog,
  queryAuditRuns,
  queryEnforcementRetries,
  queryOnboardingState,
  queryTrackedSessions,
  queryWorkerAssignments,
  queryQueueStatus,
  queryKnowledge,
  queryKnowledgeFlags,
  queryPromotionCandidates,
  queryInterventions,
  queryWorkStreams,
  queryUserInbox,
  queryOperationalMetrics,
  queryConfigVersions,
  readContextFile,
  writeContextFile,
  ContextFileError,
} from "./queries.js";
import type { RouteResult } from "./routes.js";
import type { TaskState, TaskPriority, EventStatus, MessageType, MessageStatus, ProtocolStatus, GoalStatus } from "../types.js";
import { TASK_STATES, TASK_PRIORITIES, EVENT_STATUSES, MESSAGE_TYPES } from "../types.js";
import type { CapabilityResponse, DashboardRuntimeResponse } from "../api/contract.js";
import { getDomainContextDir, readDomainConfig as readDomainConfigViaService } from "../config/api-service.js";

/** Parse an integer from a string, returning a default if NaN. */
function safeParseInt(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function resolveProjectDir(projectId: string): string | null {
  const agentIds = getRegisteredAgentIds();
  for (const agentId of agentIds) {
    const entry = getAgentConfig(agentId);
    if (entry?.projectId === projectId && entry.projectDir) {
      return entry.projectDir;
    }
  }
  return null;
}

function resolveContextRoots(projectId: string): string[] {
  const roots = [
    resolveProjectDir(projectId),
    getDomainContextDir(projectId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return Array.from(new Set(roots));
}

function readContextFileFromRoots(projectId: string, relativePath: string): RouteResult {
  const roots = resolveContextRoots(projectId);
  if (roots.length === 0) return notFound("Project directory not found");

  for (const root of roots) {
    try {
      return ok(readContextFile(root, relativePath));
    } catch (error) {
      if (error instanceof ContextFileError && error.status === 404) continue;
      if (error instanceof ContextFileError) {
        return { status: error.status, body: { error: error.message } };
      }
      return { status: 500, body: { error: "Failed to read context file" } };
    }
  }

  return { status: 404, body: { error: "File not found" } };
}

function resolveContextWriteRoot(projectId: string, relativePath: string): string | null {
  const roots = resolveContextRoots(projectId);
  if (roots.length === 0) return null;

  for (const root of roots) {
    try {
      readContextFile(root, relativePath);
      return root;
    } catch (error) {
      if (error instanceof ContextFileError && error.status === 404) continue;
      return root;
    }
  }

  return roots[0] ?? null;
}

function writeContextFileToRoot(projectId: string, relativePath: string, content: string): RouteResult {
  const root = resolveContextWriteRoot(projectId, relativePath);
  if (!root) return notFound("Project directory not found");

  try {
    return ok(writeContextFile(root, relativePath, content));
  } catch (error) {
    if (error instanceof ContextFileError) {
      return { status: error.status, body: { error: error.message } };
    }
    return { status: 500, body: { error: "Failed to write context file" } };
  }
}

const VALID_MESSAGE_STATUSES: readonly string[] = ["queued", "delivered", "read", "failed"];
const VALID_PROTOCOL_STATUSES: readonly string[] = [
  "awaiting_response", "resolved", "pending_acceptance", "in_progress",
  "completed", "rejected", "awaiting_review", "reviewed", "approved",
  "revision_requested", "expired", "escalated", "cancelled",
];
const VALID_GOAL_STATUSES: readonly string[] = ["active", "achieved", "abandoned"];

export type DashboardHandlerOptions = {
  /** Absolute path to dashboard dist directory for static files */
  staticDir?: string;
  /** Function to inject a message into an agent session */
  injectAgentMessage?: (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
  /** Authentication options. When used inside a gateway plugin, set skipAuth=true to let the gateway handle auth. */
  auth?: AuthOptions & { skipAuth?: boolean };
  /** Allowed CORS origins. Defaults to localhost-only. */
  allowedOrigins?: string[];
  /**
   * Runtime mode — who owns the process and auth lifecycle.
   *   "embedded"   — running inside an OpenClaw gateway plugin; OpenClaw owns auth.
   *   "standalone" — running as a dedicated HTTP server; ClawForce owns auth.
   * Defaults to "embedded" when skipAuth=true, "standalone" otherwise.
   */
  runtimeMode?: "embedded" | "standalone";
  /** Runtime metadata so the dashboard can explain whether OpenClaw or standalone auth is in effect. */
  runtime?: DashboardRuntimeResponse;
};

function respondTextEventStream(
  res: ServerResponse,
  content: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ content })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

type AssistantFallbackTarget = {
  agentId: string;
  title?: string;
  explicit: boolean;
  source: "explicit" | "configured" | "lead";
};

type DashboardAssistantSettings = {
  enabled: boolean;
  agentId?: string;
};

function isLeadLikeAgent(projectId: string, agentId: string): boolean {
  const entry = getAgentConfig(agentId);
  if (!entry || entry.projectId !== projectId) return false;
  return !!entry.config.coordination?.enabled || !!entry.config.extends?.includes("lead");
}

function getDashboardAssistantSettings(projectId: string): DashboardAssistantSettings {
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

function parseAssistantDirective(content: string): { requestedAgentId?: string; content: string } {
  const trimmed = content.trim();
  const mentionMatch = trimmed.match(/^@([\w-]+)\s+(.+)$/s);
  if (!mentionMatch) return { content: trimmed };
  return {
    requestedAgentId: mentionMatch[1],
    content: mentionMatch[2]?.trim() ?? "",
  };
}

function resolveAssistantFallbackTarget(
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

function persistDirectAgentMessage(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
  content: string,
): RouteResult {
  return handleAction(projectId, "messages/send", {
    ...body,
    to: agentId,
    content,
  });
}

function persistAssistantFallbackMessage(
  projectId: string,
  target: AssistantFallbackTarget | null,
  body: Record<string, unknown>,
  content: string,
): { target: AssistantFallbackTarget | null; result: RouteResult | null } {
  if (!target) return { target: null, result: null };

  return {
    target,
    result: persistDirectAgentMessage(projectId, target.agentId, body, content),
  };
}

function renderAssistantStoredMessage(target: AssistantFallbackTarget): string {
  if (target.source === "explicit") {
    return `Stored your operator request for "${target.agentId}". They will see it in their next briefing.`;
  }
  if (target.source === "configured") {
    return `No live assistant session is wired, so I routed your operator request to the configured assistant target "${target.agentId}". They will see it in their next briefing.`;
  }
  return `No live assistant session is wired, so I routed your operator request to "${target.agentId}". They will see it in their next briefing.`;
}

function renderAssistantLiveDeliveryMessage(requestedAgentId: string, deliveredAgentId: string): string {
  if (requestedAgentId === deliveredAgentId) {
    return `Delivered your message to "${deliveredAgentId}".`;
  }
  return `Delivered your operator request to "${deliveredAgentId}".`;
}

function renderAssistantUnavailableMessage(
  projectId: string,
  settings: DashboardAssistantSettings = getDashboardAssistantSettings(projectId),
): string {
  if (!settings.enabled) {
    return "The dashboard assistant is disabled for this domain. Use @lead-id in chat to message a lead directly, or enable dashboard_assistant in domain config.";
  }
  return "The dashboard assistant does not have a live session wired right now, and no lead target could be resolved. Use @lead-id in chat to message a lead directly, or configure a live assistant session in your runtime.";
}

/**
 * Create the dashboard HTTP handler.
 * Returns a handler compatible with registerHttpRoute handler signature.
 */
export function createDashboardHandler(options: DashboardHandlerOptions) {
  const runtimeMode = options.runtimeMode
    ?? (options.auth?.skipAuth ? "embedded" : "standalone");

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // CORS — origin-validated (localhost by default, configurable)
    setCorsHeaders(req, res, options.allowedOrigins);
    setSecurityHeaders(res);

    // Identify runtime mode on every response so the SPA can adapt
    res.setHeader("X-ClawForce-Runtime", runtimeMode);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Determine if we need to apply auth / rate-limiting.
    // Static file serving (non-API) is exempt from auth.
    const isApiRequest = url.pathname.startsWith("/clawforce/api/");

    if (isApiRequest && !options.auth?.skipAuth) {
      // Rate limit check
      if (!checkRateLimit(req, res)) return;

      // Auth check
      if (!checkAuth(req, res, options.auth ?? {})) return;
    }

    // SSE endpoint: /clawforce/api/sse?domain=<id>
    if (url.pathname === "/clawforce/api/sse" && req.method === "GET") {
      const domain = url.searchParams.get("domain");
      if (!domain) {
        respondJson(res, 400, { error: "domain query parameter required" });
        return;
      }
      getSSEManager().addClient(domain, res);
      return;
    }

    // Runtime metadata endpoint: /clawforce/api/runtime
    if (url.pathname === "/clawforce/api/runtime" && req.method === "GET") {
      respondJson(res, 200, {
        mode: runtimeMode,
        auth: runtimeMode === "embedded" ? "openclaw-delegated" : "clawforce-managed",
        version: "0.2.0",
      });
      return;
    }

    // API routes: /clawforce/api/:domain/...
    if (url.pathname.startsWith("/clawforce/api/")) {
      // Handle non-domain-scoped endpoints first
      if (url.pathname === "/clawforce/api/domains" && req.method === "GET") {
        try {
          const { getActiveProjectIds } = await import("../../src/lifecycle.js");
          const { getRegisteredAgentIds, getAgentConfig } = await import("../../src/project.js");
          const projectIds = getActiveProjectIds();
          const allAgentIds = getRegisteredAgentIds();
          const domains = projectIds.map((id: string) => ({
            id,
            agentCount: allAgentIds.filter((aid: string) => {
              const entry = getAgentConfig(aid);
              return entry?.projectId === id;
            }).length,
          }));
          respondJson(res, 200, domains);
        } catch {
          respondJson(res, 200, []);
        }
        return;
      }
      if (url.pathname === "/clawforce/api/extensions" && req.method === "GET") {
        const extensions = listDashboardExtensions();
        respondJson(res, 200, { extensions, count: extensions.length });
        return;
      }
      if (url.pathname === "/clawforce/api/runtime" && req.method === "GET") {
        respondJson(res, 200, options.runtime ?? {
          mode: "standalone",
          authMode: "localhost-only",
          notes: [
            "Runtime metadata was not explicitly provided by the caller.",
          ],
        } satisfies DashboardRuntimeResponse);
        return;
      }
      if (url.pathname === "/clawforce/api/demo/create" && req.method === "POST") {
        const result = handleDemoCreate();
        respondJson(res, result.status, result.body);
        return;
      }
      if (url.pathname === "/clawforce/api/domains/create" && req.method === "POST") {
        const body = await parseBody(req);
        const result = handleStarterDomainCreate(body);
        respondJson(res, result.status, result.body);
        return;
      }

      const apiPath = url.pathname.slice("/clawforce/api/".length);
      const slashIdx = apiPath.indexOf("/");
      const domain = slashIdx === -1 ? apiPath : apiPath.slice(0, slashIdx);
      const resource = slashIdx === -1 ? "" : apiPath.slice(slashIdx + 1);

      if (!domain) {
        respondJson(res, 400, { error: "domain is required in path" });
        return;
      }

      if (req.method === "POST") {
        const body = await parseBody(req);

        // Assistant/widget messages expect an SSE response body.
        if (resource.match(/^agents\/[^/]+\/message$/)) {
          const agentId = resource.split("/")[1]!;
          const rawContent = typeof body.content === "string"
            ? body.content
            : typeof body.message === "string"
              ? body.message
              : "";
          const directive = agentId === "clawforce-assistant"
            ? parseAssistantDirective(rawContent)
            : { content: rawContent };
          const content = directive.content;
          const requestedTarget = typeof body.to === "string"
            ? body.to
            : typeof body.leadId === "string"
              ? body.leadId
              : directive.requestedAgentId;
          const assistantSettings = agentId === "clawforce-assistant"
            ? getDashboardAssistantSettings(domain)
            : null;
          const assistantTarget = agentId === "clawforce-assistant"
            ? resolveAssistantFallbackTarget(domain, requestedTarget, assistantSettings ?? undefined)
            : null;
          if (!content.trim()) {
            respondJson(res, 400, { error: "content is required" });
            return;
          }

          if (agentId === "clawforce-assistant" && !requestedTarget && assistantSettings && !assistantSettings.enabled) {
            respondTextEventStream(res, renderAssistantUnavailableMessage(domain, assistantSettings));
            return;
          }

          if (options.injectAgentMessage) {
            try {
              const deliveryAgentId = agentId === "clawforce-assistant"
                ? (assistantTarget?.agentId ?? agentId)
                : agentId;
              await options.injectAgentMessage({
                sessionKey: `agent:${deliveryAgentId}:main`,
                message: content,
              });
              respondTextEventStream(
                res,
                renderAssistantLiveDeliveryMessage(agentId, deliveryAgentId),
              );
            } catch (err) {
              if (agentId === "clawforce-assistant") {
                const fallback = persistAssistantFallbackMessage(domain, assistantTarget, body, content);
                if (fallback.target && fallback.result && fallback.result.status < 400) {
                  respondTextEventStream(res, renderAssistantStoredMessage(fallback.target));
                  return;
                }
              } else {
                const fallback = persistDirectAgentMessage(domain, agentId, body, content);
                if (fallback.status < 400) {
                  respondTextEventStream(
                    res,
                    `Live delivery failed, but your message was stored for "${agentId}". They will see it in their next briefing.`,
                  );
                  return;
                }
              }

              respondJson(res, 502, {
                error: err instanceof Error ? err.message : "Failed to deliver live message",
              });
            }
            return;
          }

          if (agentId !== "clawforce-assistant") {
            const result = handleAction(domain, "messages/send", {
              ...body,
              to: agentId,
              content,
            });
            if (result.status >= 400) {
              respondJson(res, result.status, result.body);
              return;
            }
            respondTextEventStream(
              res,
              `Stored your message for "${agentId}". They will see it in their next briefing.`,
            );
            return;
          }

          const fallback = persistAssistantFallbackMessage(domain, assistantTarget, body, content);
          if (fallback.target && fallback.result && fallback.result.status < 400) {
            respondTextEventStream(res, renderAssistantStoredMessage(fallback.target));
            return;
          }

          respondTextEventStream(
            res,
            renderAssistantUnavailableMessage(domain, assistantSettings ?? undefined),
          );
          return;
        }

        if (resource === "context-files") {
          if (typeof body.path !== "string" || typeof body.content !== "string") {
            respondJson(res, 400, { error: "Missing required fields: path, content" });
            return;
          }
          const result = writeContextFileToRoot(domain, body.path, body.content);
          respondJson(res, result.status, result.body);
          return;
        }

        if (resource === "kill") {
          const result = await handleDomainKillAction(domain, body);
          respondJson(res, result.status, result.body);
          return;
        }

        if (resource.match(/^agents\/[^/]+\/kill$/)) {
          const agentId = resource.split("/")[1]!;
          const result = await handleAgentKillAction(domain, agentId, body);
          respondJson(res, result.status, result.body);
          return;
        }

        const result = handleAction(domain, resource, body);
        respondJson(res, result.status, result.body);
        return;
      }

      // GET — route to appropriate query function
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) params[k] = v;

      const result = routeRead(domain, resource, params);
      respondJson(res, result.status, result.body);
      return;
    }

    // Static files: /clawforce/* -> serve from dashboard/dist/
    if (options.staticDir) {
      const served = serveStatic(url.pathname, options.staticDir, res);
      if (served) return;
    }

    // SPA fallback for /clawforce paths — serve index.html if it exists
    if (options.staticDir) {
      const indexPath = path.join(options.staticDir, "index.html");
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": content.byteLength });
        res.end(content);
        return;
      }
    }

    respondJson(res, 404, { error: "Not found" });
  };
}

/**
 * Route GET requests to the appropriate query function.
 */
function routeRead(
  domain: string,
  resource: string,
  params: Record<string, string>,
): RouteResult {
  const segments = resource.split("/").filter(Boolean);
  const topResource = segments[0] ?? "";

  switch (topResource) {
    case "": // GET /clawforce/api/:domain — project overview
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

    case "messages": {
      if (segments[1]) {
        // GET /:domain/messages/:threadId — fetch messages for a specific thread/channel
        const detail = queryThreadMessages(domain, segments[1], {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          since: params.since ? safeParseInt(params.since, 0) : undefined,
        });
        return ok(detail);
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
      if (segments[1] === "forecast") {
        return ok(queryBudgetForecast(domain));
      }
      return ok(queryBudgetStatus(domain));

    case "trust": {
      if (segments[1] === "history") {
        return ok(queryTrustHistory(domain, params));
      }
      return ok(queryTrustScores(domain));
    }

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
      }, {
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
      }));
    }

    case "config":
      if (segments[1] === "versions") {
        return ok(queryConfigVersions(domain, params.limit ? safeParseInt(params.limit, 50) : undefined));
      }
      return ok(queryConfig(domain));

    case "config-versions":
      return ok(queryConfigVersions(domain, params.limit ? safeParseInt(params.limit, 50) : undefined));

    case "context-files": {
      const requestedPath = params.path;
      if (!requestedPath) {
        return { status: 400, body: { error: "Missing required query param: path" } };
      }
      return readContextFileFromRoots(domain, requestedPath);
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
        return detail ? ok(detail) : { status: 404, body: { error: "Session not found" } };
      }
      return ok(querySessions(
        domain,
        { agentId: params.agent },
        {
          limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
          offset: params.offset ? safeParseInt(params.offset, 0) : undefined,
        },
      ));
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

    case "workstreams": {
      // GET /:domain/workstreams or /:domain/workstreams/:leadId
      const leadId = segments[1];
      return ok(queryWorkStreams(domain, leadId));
    }

    case "inbox": {
      // GET /:domain/inbox — user messages (to/from "user" pseudo-agent)
      return ok(queryUserInbox(domain, {
        agentId: params.agent,
        limit: params.limit ? safeParseInt(params.limit, 50) : undefined,
        since: params.since ? safeParseInt(params.since, 0) : undefined,
      }));
    }

    case "operational-metrics":
      return ok(queryOperationalMetrics(domain, {
        windowHours: params.window ? safeParseInt(params.window, 24) : undefined,
      }));

    case "capabilities":
      return ok(buildCapabilities(domain));

    default:
      return notFound("Unknown resource");
  }
}

// --- Capability Discovery ---

function buildCapabilities(domain: string): CapabilityResponse {
  // Detect which features are enabled for this domain by checking
  // whether the domain has relevant config or data.
  let hasApprovals = false;
  let hasBudget = false;
  let hasTrust = false;
  let hasMemory = false;
  let hasComms = false;

  try {
    const extConfig = getExtendedProjectConfig(domain);

    if (extConfig) {
      hasApprovals = !!extConfig.policies; // approval is policy-driven
      hasBudget = !!extConfig.safety; // budget/safety config present
      hasTrust = !!extConfig.trust;
      hasMemory = !!extConfig.memory;
      hasComms = !!(extConfig.channels && (extConfig.channels as unknown[]).length > 0);
    }
  } catch {
    // If config loading fails, report minimal features
  }

  return {
    version: "0.2.0",
    features: {
      tasks: true, // tasks are always available
      approvals: hasApprovals,
      budget: hasBudget,
      trust: hasTrust,
      memory: hasMemory,
      comms: hasComms,
    },
    endpoints: [
      "dashboard", "agents", "tasks", "approvals", "messages",
      "meetings", "budget", "trust", "costs", "goals", "config",
      "org", "health", "slos", "alerts", "events", "sessions",
      "metrics", "policies", "protocols", "audit-log", "audit-runs",
      "enforcement-retries", "onboarding", "tracked-sessions",
      "worker-assignments", "queue", "knowledge",
      "knowledge-flags", "promotion-candidates", "interventions",
      "workstreams", "inbox", "operational-metrics", "capabilities",
      "extensions", "runtime",
    ],
  };
}

// --- Static file serving ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveStatic(
  pathname: string,
  staticDir: string,
  res: ServerResponse,
): boolean {
  // Strip /clawforce/ prefix to get relative path
  const relativePath = pathname.replace(/^\/clawforce\/?/, "") || "index.html";
  const filePath = path.join(staticDir, relativePath);

  // Security: prevent path traversal — use path.resolve + separator boundary
  const resolvedFile = path.resolve(filePath);
  const resolvedBase = path.resolve(staticDir);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    return false;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": content.byteLength,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(content);
  return true;
}

// --- Helpers ---

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: { error: message } };
}
