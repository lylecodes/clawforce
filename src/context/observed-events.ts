/**
 * Clawforce — Observed Events context source
 *
 * Renders recent events matching an agent's observe patterns
 * as a markdown briefing section.
 */

import type { DatabaseSync } from "node:sqlite";
import { listEvents } from "../events/store.js";

/**
 * Match an event type against a pattern.
 * Supports exact match and wildcard suffix (e.g. "budget.*" matches "budget.exceeded").
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(prefix + ".");
  }
  return eventType === pattern;
}

/**
 * Render observed events matching the given patterns as markdown.
 */
export function renderObservedEvents(
  domain: string,
  patterns: string[],
  since: number,
  db?: DatabaseSync,
): string {
  const allEvents = listEvents(domain, { limit: 200 }, db);

  const matching = allEvents.filter(e =>
    e.createdAt > since &&
    patterns.some(p => matchesPattern(e.type, p))
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
