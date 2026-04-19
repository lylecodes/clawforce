const KNOWN_SESSION_TYPES = new Set([
  "main",
  "cron",
  "dispatch",
  "meeting",
  "review",
  "approval",
  "channel",
  "workflow",
  "ghost",
  "memory",
  "manual",
]);

export type ParsedAgentSessionKey = {
  agentId: string;
  sessionType: string;
  suffix: string[];
};

/**
 * Parse a session key shaped like `agent:<agentId>:<type>:...`.
 *
 * Agent IDs may themselves contain colons, so the parser looks for a known
 * session-type marker from the right-hand side instead of splitting on the
 * first two separators.
 */
export function parseAgentSessionKey(key: string): ParsedAgentSessionKey | null {
  if (!key.startsWith("agent:")) {
    return null;
  }

  const payload = key.slice("agent:".length);
  if (!payload) {
    return null;
  }

  const parts = payload.split(":");
  for (let i = parts.length - 1; i >= 1; i--) {
    const sessionType = parts[i]!;
    if (!KNOWN_SESSION_TYPES.has(sessionType)) {
      continue;
    }

    return {
      agentId: parts.slice(0, i).join(":"),
      sessionType,
      suffix: parts.slice(i + 1),
    };
  }

  return null;
}

export function extractAgentIdFromReference(value: string): string {
  const parsed = parseAgentSessionKey(value);
  if (parsed) {
    return parsed.agentId;
  }

  if (value.startsWith("agent:")) {
    return value.slice("agent:".length);
  }

  return value;
}
