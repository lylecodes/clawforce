/**
 * Clawforce — Dashboard routes
 *
 * Maps URL paths to query functions.
 * All routes return JSON via handleRequest().
 */

import {
  runIngestProjectEventCommand,
  runUpdateProjectBudgetLimitCommand,
  runWriteProjectContextFileCommand,
} from "../app/commands/project-controls.js";
import {
  queryLegacyProjectOverview,
  queryProjectsIndex,
  routeLegacyProjectRead,
} from "../app/queries/dashboard-read-router.js";

export type RouteResult = {
  status: number;
  body: unknown;
};

/**
 * Route a request to the appropriate query function.
 * Returns { status, body } for the HTTP response.
 */
export function handleRequest(
  pathname: string,
  params: Record<string, string>,
  method?: string,
  body?: Record<string, unknown>,
): RouteResult {
  const path = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "projects") {
    return queryProjectsIndex();
  }

  if (segments.length >= 3 && segments[0] === "api" && segments[1] === "projects") {
    const projectId = segments[2]!;
    const resource = segments[3];

    if (!resource) {
      return queryLegacyProjectOverview(projectId);
    }

    if (resource === "events" && method === "POST" && segments[4] === "ingest") {
      return runIngestProjectEventCommand(projectId, body ?? {});
    }

    if (resource === "budget" && method === "POST") {
      return runUpdateProjectBudgetLimitCommand(projectId, body ?? {});
    }

    if (resource === "context-files" && method === "POST") {
      return runWriteProjectContextFileCommand(projectId, body ?? {});
    }

    return routeLegacyProjectRead(projectId, segments.slice(3).join("/"), params);
  }

  return notFound("Not found");
}

function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: { error: message } };
}
