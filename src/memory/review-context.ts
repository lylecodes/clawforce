/**
 * Clawforce — Memory Review Context Source
 *
 * Assembles session transcripts and agent identity context
 * for the memory review job. Reads JSONL transcript files
 * from the agent's session directory.
 */

import fs from "node:fs";
import path from "node:path";

export type ReviewContextOpts = {
  agentId: string;
  scope: "self" | "reports" | "all";
  aggressiveness: "low" | "medium" | "high";
  projectDir: string;
  /** Target agent IDs when scope is "reports" or "all". */
  targetAgentIds?: string[];
  /** Max total characters for transcript content. Default 50_000. */
  maxTranscriptChars?: number;
};

const AGGRESSIVENESS_GUIDANCE: Record<string, string> = {
  low: "Extract only explicit decisions, error resolutions, and task outcomes. Skip opinions, hunches, and partial insights.",
  medium: "Extract learnings, patterns, reusable context, observations, and notable decisions. Skip trivial chatter.",
  high: "Extract Everything potentially useful including hunches, partial insights, patterns, preferences, and context that might help in future sessions.",
};

/**
 * Build the full review context for the memory review job.
 */
export function buildReviewContext(opts: ReviewContextOpts & { projectId?: string }): string {
  // Read memory config for review transcript budget
  let defaultMaxChars = 50_000;
  if (opts.projectId) {
    try {
      const { getExtendedProjectConfig } = require("../project.js") as typeof import("../project.js");
      const extConfig = getExtendedProjectConfig(opts.projectId);
      if (extConfig?.memory?.reviewTranscriptMaxChars != null) {
        defaultMaxChars = extConfig.memory.reviewTranscriptMaxChars;
      }
    } catch { /* project module may not be available */ }
  }
  const maxChars = opts.maxTranscriptChars ?? defaultMaxChars;
  const sections: string[] = [];

  // Header
  sections.push("## Memory Review Session");
  sections.push("");
  sections.push(`**Scope:** ${opts.scope} | **Aggressiveness:** ${opts.aggressiveness}`);
  sections.push("");

  // Aggressiveness guidance
  sections.push("### Extraction Guidance");
  sections.push("");
  sections.push(AGGRESSIVENESS_GUIDANCE[opts.aggressiveness] ?? AGGRESSIVENESS_GUIDANCE.medium);
  sections.push("");

  // SOUL.md for identity context
  const soulContent = readSoulDoc(opts.agentId, opts.projectDir);
  if (soulContent) {
    sections.push("### Agent Identity");
    sections.push("");
    sections.push(soulContent);
    sections.push("");
  }

  // Resolve which agent IDs to review
  const agentIds = resolveTargetAgents(opts);

  // Session transcripts
  let totalTranscriptChars = 0;
  let hasAnyTranscripts = false;

  for (const agentId of agentIds) {
    const transcripts = readSessionTranscripts(agentId, opts.projectDir);
    if (transcripts.length === 0) continue;

    hasAnyTranscripts = true;

    for (const transcript of transcripts) {
      if (totalTranscriptChars >= maxChars) {
        sections.push("...(remaining transcripts truncated for context budget)");
        break;
      }

      const remaining = maxChars - totalTranscriptChars;
      let content = transcript.content;
      if (content.length > remaining) {
        content = content.slice(0, remaining) + "\n...(truncated)";
      }

      sections.push(`### Session: ${transcript.filename} (agent: ${agentId})`);
      sections.push("");
      sections.push(content);
      sections.push("");
      totalTranscriptChars += content.length;
    }

    if (totalTranscriptChars >= maxChars) break;
  }

  if (!hasAnyTranscripts) {
    sections.push("### Session Transcripts");
    sections.push("");
    sections.push("No session transcripts found for the review period.");
  }

  return sections.join("\n");
}

type TranscriptFile = {
  filename: string;
  content: string;
  modifiedAt: number;
};

/**
 * Resolve which agent IDs to include based on scope.
 */
function resolveTargetAgents(opts: ReviewContextOpts): string[] {
  switch (opts.scope) {
    case "self":
      return [opts.agentId];
    case "reports":
    case "all":
      return opts.targetAgentIds && opts.targetAgentIds.length > 0
        ? [opts.agentId, ...opts.targetAgentIds]
        : [opts.agentId];
    default:
      return [opts.agentId];
  }
}

/**
 * Read session transcript JSONL files from an agent's sessions directory.
 * Only includes files modified today (since midnight).
 */
function readSessionTranscripts(agentId: string, projectDir: string): TranscriptFile[] {
  const sessionsDir = path.join(projectDir, "agents", agentId, "sessions");

  try {
    if (!fs.existsSync(sessionsDir)) return [];
  } catch {
    return [];
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const results: TranscriptFile[] = [];

  try {
    const files = fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"));

    for (const filename of files) {
      const filePath = path.join(sessionsDir, filename);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < todayMs) continue; // Skip old files

        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) continue;

        const content = parseTranscriptJsonl(raw);
        if (content) {
          results.push({
            filename,
            content,
            modifiedAt: stat.mtimeMs,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Sessions dir unreadable
  }

  // Sort by most recent first (priority for context budget)
  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results;
}

/**
 * Parse a JSONL transcript file into readable text.
 */
function parseTranscriptJsonl(raw: string): string | null {
  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { role?: string; content?: string };
      if (parsed.role && parsed.content) {
        // Truncate individual messages to 500 chars
        const content = parsed.content.length > 500
          ? parsed.content.slice(0, 500) + "..."
          : parsed.content;
        messages.push(`**${parsed.role}**: ${content}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages.length > 0 ? messages.join("\n") : null;
}

/**
 * Read SOUL.md for an agent.
 */
function readSoulDoc(agentId: string, projectDir: string): string | null {
  const soulPath = path.join(projectDir, "agents", agentId, "SOUL.md");
  try {
    if (!fs.existsSync(soulPath)) return null;
    const content = fs.readFileSync(soulPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
