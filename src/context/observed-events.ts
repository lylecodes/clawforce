/**
 * Clawforce — Observed Events context source
 *
 * Renders recent events matching an agent's observe patterns
 * as a markdown briefing section. Supports scoped entries that
 * filter events by team or agent membership.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ClawforceEvent, ObserveEntry } from "../types.js";
import { listEvents } from "../events/store.js";
import { getTeamAgents } from "../org.js";

/**
 * Match an event type against a pattern.
 * Supports exact match and wildcard suffix (e.g. "budget.*" matches "budget.exceeded").
 */
export function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(prefix + ".");
  }
  return eventType === pattern;
}

/**
 * Extract the originating agent ID from an event payload.
 * Events may store the agent in various payload fields depending on type.
 */
function getEventAgentId(event: ClawforceEvent): string | undefined {
  const p = event.payload;
  return (p.agentId ?? p.assignedTo ?? p.actor ?? p.proposedBy ?? p.concludedBy) as string | undefined;
}

/**
 * Check whether an event passes the scope filter for an observe entry.
 * If no scope is defined, all events pass. If scope.team is set, the event's
 * originating agent must belong to that team. If scope.agent is set, the
 * event's originating agent must match exactly.
 */
export function matchesScope(
  event: ClawforceEvent,
  scope: { team?: string; agent?: string } | undefined,
  projectId: string,
): boolean {
  if (!scope) return true;

  const eventAgent = getEventAgentId(event);

  if (scope.agent) {
    if (!eventAgent || eventAgent !== scope.agent) return false;
  }

  if (scope.team) {
    if (!eventAgent) return false;
    const teamMembers = getTeamAgents(projectId, scope.team);
    if (!teamMembers.includes(eventAgent)) return false;
  }

  return true;
}

/**
 * Check whether an event matches an observe entry (pattern + optional scope).
 */
function matchesEntry(event: ClawforceEvent, entry: ObserveEntry, projectId: string): boolean {
  if (typeof entry === "string") {
    return matchesPattern(event.type, entry);
  }

  if (!matchesPattern(event.type, entry.pattern)) return false;
  return matchesScope(event, entry.scope, projectId);
}

/**
 * Render observed events matching the given observe entries as markdown.
 */
export function renderObservedEvents(
  domain: string,
  entries: ObserveEntry[],
  since: number,
  db?: DatabaseSync,
): string {
  const allEvents = listEvents(domain, { limit: 200 }, db);

  const matching = allEvents.filter(e =>
    e.createdAt > since &&
    entries.some(entry => matchesEntry(e, entry, domain))
  );

  if (matching.length === 0) {
    return "## Observed Events\n\nNo observed events since last check.";
  }

  const lines = matching.map(e => {
    const time = new Date(e.createdAt).toISOString();
    const payload = JSON.stringify(e.payload);
    return `- **${e.type}** (${time}): ${payload}`;
  });

  return `## Observed Events\n\n${lines.join("\n")}`;
}
