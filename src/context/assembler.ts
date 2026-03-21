/**
 * Clawforce — Context assembler
 *
 * Builds the session-start context for an agent from its config.
 * Kept minimal: role description + enforcement instructions + any custom sources.
 * Heavy context comes from tool responses at point of decision.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent } from "../diagnostics.js";
import type { AgentConfig, ContextSource } from "../types.js";
import { getActiveSessions } from "../enforcement/tracker.js";
import { listDisabledAgents } from "../enforcement/disabled-store.js";
import { detectStuckAgents } from "../audit/stuck-detector.js";
import { getWorkerAssignment } from "../worker-registry.js";
import {
  formatTimeAgo,
  renderEscalations,
  renderRecentActivity,
  renderScopedTaskBoard,
  renderSweepStatus,
  renderTaskBoard,
  renderWorkflows,
} from "./builder.js";
import { listPendingProposals } from "../approval/resolve.js";
import { getPendingMessages, markBulkDelivered } from "../messaging/store.js";
import { buildCompactionInstructions, isCompactionEnabled } from "./sources/compaction.js";
import { buildCostSummary } from "./sources/cost-summary.js";
import { buildHealthStatus } from "./sources/health-status.js";
import { buildInstructions } from "./sources/instructions.js";
import { buildPolicyStatus } from "./sources/policy-status.js";
import { buildResourcesContext } from "./sources/resources.js";
import { resolveToolsDocs, resolveSoulDoc } from "./sources/agent-docs.js";

import { renderObservedEvents } from "./observed-events.js";
import { computeAvailableSlots } from "../scheduling/slots.js";
import { getInitiativeSpend } from "../goals/ops.js";
import { resolveSkillSource } from "../skills/registry.js";
import { buildDeltaReport, renderDeltaReport } from "../planning/ooda.js";
import { buildVelocityReport, renderVelocityReport } from "../planning/velocity.js";
import { renderPreferences } from "../trust/preferences.js";
import { renderTrustSummary } from "../trust/tracker.js";
import { getDirectReports } from "../org.js";
import { getAgentConfig, getRegisteredAgentIds } from "../project.js";
import { getStream } from "../streams/catalog.js";
import { resolveBudgetGuidanceSource } from "./sources/budget-guidance.js";
import { resolveWelcomeSource, resolveWeeklyDigestSource, resolveInterventionSource } from "./sources/onboarding-sources.js";
import { resolveMemoryInstructions } from "./sources/memory-instructions.js";
import { buildReviewContext } from "../memory/review-context.js";
import { renderDomainContext } from "./domain-context.js";
import { getProjectsDir } from "../db.js";

export type AssemblerContext = {
  agentId: string;
  config: AgentConfig;
  projectId?: string;
  projectDir?: string;
};

/**
 * Sources that are static within a session — their content does not change between turns.
 * These are cached per session key to avoid redundant re-resolution on every turn.
 */
const STATIC_SOURCES = new Set<string>([
  "soul",
  "project_md",
  "skill",
  "tools_reference",
  "memory_instructions",
  "instructions",
]);

/** Session-scoped cache: `${sessionKey}:${sourceName}` → content */
const assemblerCache = new Map<string, string | null>();

/**
 * Clear the assembler cache for a given session at session end.
 */
export function clearAssemblerCache(sessionKey: string): void {
  for (const key of assemblerCache.keys()) {
    if (key.startsWith(`${sessionKey}:`)) {
      assemblerCache.delete(key);
    }
  }
}

/**
 * Assemble the session-start context for an agent.
 * Returns a markdown string to inject via before_prompt_build.
 */
export function assembleContext(
  agentId: string,
  config: AgentConfig,
  opts?: { projectId?: string; projectDir?: string; budgetChars?: number; sessionKey?: string },
): string {
  const ctx: AssemblerContext = { agentId, config, projectId: opts?.projectId, projectDir: opts?.projectDir };
  const budgetChars = opts?.budgetChars ?? 15_000;
  const sessionKey = opts?.sessionKey;
  const sections: string[] = [];

  // Inject title and persona at the top of the context
  const profileHeader = buildProfileHeader(agentId, config, opts?.projectDir);
  if (profileHeader) {
    sections.push(profileHeader);
  }

  for (const source of config.briefing) {
    const content = resolveSource(source, ctx, sessionKey);
    if (content) {
      sections.push(content);
    }
  }

  // Auto-inject compaction instructions at the end for eligible agents
  if (isCompactionEnabled(config)) {
    const compactionInstructions = buildCompactionInstructions(config, ctx.projectDir);
    if (compactionInstructions) {
      sections.push(compactionInstructions);
    }
  }

  if (sections.length === 0) return "";

  let result = sections.join("\n\n");

  if (result.length > budgetChars) {
    result = result.slice(0, budgetChars - 20) + "\n\n[...truncated]";
  }

  return result;
}

/**
 * Resolve a single context source to its content.
 * Static sources (soul, project_md, skill, tools_reference, memory_instructions, instructions)
 * are cached per session key to avoid redundant re-resolution on every turn.
 */
function resolveSource(source: ContextSource, ctx: AssemblerContext, sessionKey?: string): string | null {
  // Cache lookup for static sources
  if (sessionKey && STATIC_SOURCES.has(source.source)) {
    const cacheKey = `${sessionKey}:${source.source}`;
    if (assemblerCache.has(cacheKey)) {
      return assemblerCache.get(cacheKey) ?? null;
    }
    const result = resolveSourceRaw(source, ctx);
    assemblerCache.set(cacheKey, result);
    return result;
  }
  return resolveSourceRaw(source, ctx);
}

/**
 * Internal: resolve a source without caching.
 */
function resolveSourceRaw(source: ContextSource, ctx: AssemblerContext): string | null {
  switch (source.source) {
    case "instructions":
      return buildInstructions(ctx.config.expectations);

    case "custom":
      return source.content ?? null;

    case "project_md":
      return resolveProjectMd(ctx);

    case "task_board":
      return resolveTaskBoard(ctx);

    case "assigned_task":
      return resolveAssignedTask(ctx);

    case "knowledge":
      return resolveKnowledge(source, ctx);

    case "file":
      return resolveFile(source, ctx);

    case "escalations":
      return resolveEscalationsSource(ctx);

    case "workflows":
      return resolveWorkflowsSource(ctx);

    case "activity":
      return resolveActivitySource(ctx);

    case "sweep_status":
      return resolveSweepStatusSource(ctx);

    case "proposals":
      return resolveProposalsSource(ctx);

    case "agent_status":
      return resolveAgentStatusSource(ctx);

    case "cost_summary":
      return resolveCostSummarySource(ctx);

    case "policy_status":
      return resolvePolicyStatusSource(ctx);

    case "health_status":
      return resolveHealthStatusSource(ctx);

    case "team_status":
      return resolveTeamStatusSource(ctx);

    case "team_performance":
      return resolveTeamPerformanceSource(ctx);

    case "skill": {
      // If tools_reference is also in the briefing, exclude "tools" from the skill TOC
      // to avoid duplicating the tools reference content.
      const hasToolsRef = ctx.config.briefing.some((s) => s.source === "tools_reference");
      return resolveSkillSource(ctx.config.extends ?? "employee", undefined, hasToolsRef ? ["tools"] : undefined, ctx.projectId);
    }

    case "memory":
      return "## Shared Memory\n\nUse `memory_search` to find relevant learnings from previous sessions. Use `memory_get` to retrieve specific memories by ID.";

    case "memory_instructions":
      return resolveMemoryInstructions(ctx.config.memory, ctx.config.extends ?? "employee");

    case "memory_review_context": {
      if (!ctx.projectDir) return null;
      const memoryConfig = ctx.config.memory;
      return buildReviewContext({
        agentId: ctx.agentId,
        scope: memoryConfig?.review?.scope ?? "self",
        aggressiveness: memoryConfig?.review?.aggressiveness ?? "medium",
        projectDir: ctx.projectDir,
      });
    }

    case "soul":
      return resolveSoulDoc(ctx.agentId, ctx.projectDir);

    case "tools_reference":
      return resolveToolsDocs(ctx.agentId, ctx.config, ctx.projectDir, ctx.projectId);

    case "pending_messages":
      return resolvePendingMessagesSource(ctx);

    case "goal_hierarchy":
      return resolveGoalHierarchySource(ctx);

    case "channel_messages":
      return resolveChannelMessagesSource(ctx);

    case "planning_delta":
      return resolvePlanningDeltaSource(ctx);

    case "velocity":
      return resolveVelocitySource(ctx);

    case "preferences":
      return resolvePreferencesSource(ctx);

    case "trust_scores":
      return resolveTrustScoresSource(ctx);

    case "resources":
      return resolveResourcesSource(ctx);

    case "initiative_status":
      return resolveInitiativeStatusSource(ctx.projectId ?? "", undefined);

    case "cost_forecast":
      return resolveCostForecastSource(ctx.projectId ?? "", undefined);

    case "available_capacity":
      return resolveAvailableCapacitySource(ctx.projectId ?? "", undefined);

    case "knowledge_candidates":
      return resolveKnowledgeCandidatesSource(ctx.projectId ?? "", undefined);

    case "budget_guidance":
      return resolveBudgetGuidanceSource(ctx.projectId ?? "", source.params);

    case "onboarding_welcome": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        const agents = getRegisteredAgentIds();
        return resolveWelcomeSource(ctx.projectId, db, {
          agentCount: agents.length,
          domainName: ctx.projectId,
        });
      } catch { return null; }
    }

    case "weekly_digest": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        return resolveWeeklyDigestSource(ctx.projectId, db);
      } catch { return null; }
    }

    case "intervention_suggestions": {
      if (!ctx.projectId) return null;
      try {
        const db = getDb(ctx.projectId);
        const agents = getRegisteredAgentIds();
        return resolveInterventionSource(ctx.projectId, db, agents);
      } catch { return null; }
    }

    case "custom_stream": {
      if (!source.streamName || !ctx.projectId) return null;
      const streamDef = getStream(source.streamName);
      if (!streamDef) return null;
      // Custom streams with queries are resolved through the router.
      // In briefing context, show the stream description as a reference.
      return `## ${source.streamName}\n\n${streamDef.description}`;
    }

    case "observed_events": {
      if (!ctx.projectId) return null;
      const observe = ctx.config.observe ?? [];
      return renderObservedEvents(ctx.projectId, observe, source.since ?? 0);
    }

    case "direction":
    case "policies":
    case "standards":
    case "architecture": {
      if (!ctx.projectId) return null;
      return renderDomainContext(getProjectsDir(), ctx.projectId, source.source);
    }

    default:
      return null;
  }
}

// --- Source resolvers ---

function resolveProjectMd(ctx: AssemblerContext): string | null {
  if (!ctx.projectDir) return null;

  const mdPath = path.join(ctx.projectDir, "PROJECT.md");
  try {
    if (!fs.existsSync(mdPath)) return null;
    const content = fs.readFileSync(mdPath, "utf-8").trim();
    if (!content) return null;
    return `## Project Charter\n\n${content}`;
  } catch {
    return null;
  }
}

function resolveTaskBoard(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  // Check if there are any tasks at all before rendering the full board
  const countRow = db
    .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?")
    .get(ctx.projectId) as Record<string, unknown> | undefined;
  if (!countRow || (countRow.cnt as number) === 0) return null;

  // For managers, scope the board by department/team/direct reports
  if (ctx.config.coordination?.enabled) {
    const directReports = getDirectReports(ctx.projectId, ctx.agentId);
    const hasScope = ctx.config.department || ctx.config.team || directReports.length > 0;

    if (hasScope) {
      return renderScopedTaskBoard(db, ctx.projectId, 50, {
        department: ctx.config.department,
        team: ctx.config.team,
        directReports: directReports.length > 0 ? directReports : undefined,
      });
    }
  }

  return renderTaskBoard(db, ctx.projectId, 50);
}

function resolveAssignedTask(ctx: AssemblerContext): string | null {
  const assignment = getWorkerAssignment(ctx.agentId);
  if (!assignment) return null;

  let db: DatabaseSync;
  try {
    db = getDb(assignment.projectId);
  } catch {
    return null;
  }

  const row = db
    .prepare("SELECT id, title, description, state, priority FROM tasks WHERE id = ? AND project_id = ?")
    .get(assignment.taskId, assignment.projectId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const lines = [
    `## Your Assignment\n`,
    `**${row.title}** (\`${row.id}\`)`,
    `Priority: ${row.priority} | State: ${row.state}`,
  ];

  if (row.description) {
    lines.push("", String(row.description));
  }

  // Include recent evidence summary
  const evidence = db
    .prepare("SELECT type, content FROM evidence WHERE task_id = ? ORDER BY attached_at DESC LIMIT 5")
    .all(assignment.taskId) as Record<string, unknown>[];

  if (evidence.length > 0) {
    lines.push("", "### Recent Evidence");
    for (const e of evidence) {
      const preview = String(e.content).slice(0, 200);
      lines.push(`- **${e.type}**: ${preview}${String(e.content).length > 200 ? "…" : ""}`);
    }
  }

  return lines.join("\n");
}

function resolveEscalationsSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderEscalations(db, ctx.projectId, 25);
}

function resolveWorkflowsSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderWorkflows(db, ctx.projectId);
}

function resolveActivitySource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderRecentActivity(db, ctx.projectId, 20);
}

function resolveSweepStatusSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderSweepStatus(db, ctx.projectId);
}

function resolveProposalsSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let proposals: ReturnType<typeof listPendingProposals>;
  try {
    proposals = listPendingProposals(ctx.projectId);
  } catch {
    return null;
  }

  if (proposals.length === 0) return null;

  const lines = [
    "## Pending Proposals",
    "",
    `${proposals.length} proposal(s) awaiting user decision:`,
    "",
  ];

  const PROPOSAL_TTL_WARNING_MS = 20 * 60 * 60 * 1000; // warn when >20h old (80% of 24h TTL)
  for (const p of proposals) {
    const ageMs = Date.now() - p.created_at;
    const ago = formatTimeAgo(ageMs);
    const desc = p.description ? ` — ${p.description.slice(0, 120)}${p.description.length > 120 ? "…" : ""}` : "";
    const ttlWarning = ageMs > PROPOSAL_TTL_WARNING_MS ? " **[EXPIRING SOON]**" : "";
    lines.push(`- \`${p.id.slice(0, 8)}\` **${p.title}** by ${p.proposed_by} (${ago})${desc}${ttlWarning}`);
  }

  return lines.join("\n");
}

function resolveAgentStatusSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  const allSessions = getActiveSessions();
  const sessions = allSessions.filter((s) => s.projectId === ctx.projectId);
  const disabled = listDisabledAgents(ctx.projectId);
  const stuck = detectStuckAgents();
  const projectStuck = stuck.filter((s) => s.projectId === ctx.projectId);

  if (sessions.length === 0 && disabled.length === 0 && projectStuck.length === 0) return null;

  const lines = ["## Workforce Status\n"];

  if (sessions.length > 0) {
    lines.push(`**Currently working:** ${sessions.length}`);
    for (const s of sessions.slice(0, 10)) {
      const runtimeSec = Math.round((Date.now() - s.metrics.startedAt) / 1000);
      lines.push(`- \`${s.agentId}\` (${s.sessionKey.slice(0, 8)}…) — ${runtimeSec}s, ${s.metrics.toolCalls.length} tool calls`);
    }
    if (sessions.length > 10) {
      lines.push(`- …and ${sessions.length - 10} more`);
    }
    lines.push("");
  }

  if (projectStuck.length > 0) {
    lines.push(`**Unresponsive employees:** ${projectStuck.length}`);
    for (const s of projectStuck) {
      lines.push(`- \`${s.agentId}\` (${s.sessionKey.slice(0, 8)}…) — ${s.reason}`);
    }
    lines.push("");
  }

  if (disabled.length > 0) {
    lines.push(`**Terminated employees:** ${disabled.length}`);
    for (const d of disabled) {
      const ago = formatTimeAgo(Date.now() - d.disabledAt);
      lines.push(`- \`${d.agentId}\` — ${d.reason} (${ago})`);
    }
  }

  return lines.join("\n");
}

function resolveCostSummarySource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  try {
    return buildCostSummary(ctx.projectId, ctx.agentId);
  } catch {
    return null;
  }
}

function resolvePolicyStatusSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  try {
    return buildPolicyStatus(ctx.projectId, ctx.agentId);
  } catch {
    return null;
  }
}

function resolveHealthStatusSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  try {
    return buildHealthStatus(ctx.projectId);
  } catch {
    return null;
  }
}

function resolveKnowledge(source: ContextSource, ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  let query = "SELECT title, category, content FROM knowledge WHERE project_id = ?";
  const params: (string | number | null)[] = [ctx.projectId];

  if (source.filter?.category?.length) {
    const placeholders = source.filter.category.map(() => "?").join(", ");
    query += ` AND category IN (${placeholders})`;
    params.push(...source.filter.category);
  }

  if (source.filter?.tags?.length) {
    // Tags stored as JSON array; use json_each for exact matching
    for (const tag of source.filter.tags) {
      query += " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)";
      params.push(tag);
    }
  }

  query += " ORDER BY created_at DESC LIMIT 20";

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  if (rows.length === 0) return null;

  const lines = ["## Knowledge Base\n"];
  for (const row of rows) {
    lines.push(`### ${row.title} (${row.category})`);
    lines.push(String(row.content));
    lines.push("");
  }

  return lines.join("\n");
}

function resolveFile(source: ContextSource, ctx: AssemblerContext): string | null {
  if (!source.path || !ctx.projectDir) return null;

  // Detect glob pattern
  if (source.path.includes("*")) {
    return resolveFileGlob(source.path, ctx.projectDir);
  }

  // Path traversal check: resolved path must be under projectDir
  const resolved = path.resolve(ctx.projectDir, source.path);
  if (!resolved.startsWith(ctx.projectDir + path.sep) && resolved !== ctx.projectDir) {
    return null;
  }

  try {
    if (!fs.existsSync(resolved)) return null;
    const content = fs.readFileSync(resolved, "utf-8").trim();
    if (!content) return null;
    // Cap at 10KB to keep context lightweight
    const capped = content.length > 10_240 ? content.slice(0, 10_240) + "\n…(truncated)" : content;
    return `## File: ${source.path}\n\n\`\`\`\n${capped}\n\`\`\``;
  } catch {
    return null;
  }
}

/**
 * Resolve a glob pattern to concatenated file contents.
 * Uses fs.globSync (Node 22+) with per-file and total caps.
 */
function resolveFileGlob(pattern: string, projectDir: string): string | null {
  const PER_FILE_CAP = 5_120; // 5KB per file
  const TOTAL_CAP = 10_240; // 10KB total

  try {
    const resolvedPattern = path.resolve(projectDir, pattern);
    // Ensure the resolved pattern starts with projectDir (path traversal guard)
    if (!resolvedPattern.startsWith(projectDir + path.sep) && !resolvedPattern.startsWith(projectDir)) {
      return null;
    }

    let matches: string[];
    try {
      matches = fs.globSync(pattern, { cwd: projectDir }) as unknown as string[];
    } catch {
      // globSync may not be available — fall back gracefully
      return null;
    }

    if (matches.length === 0) return null;

    const sections: string[] = [];
    let totalSize = 0;

    for (const match of matches) {
      if (totalSize >= TOTAL_CAP) break;

      const filePath = path.resolve(projectDir, match);
      // Path traversal guard per match
      if (!filePath.startsWith(projectDir + path.sep) && filePath !== projectDir) continue;

      try {
        if (!fs.existsSync(filePath)) continue;
        let content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        // Per-file cap
        if (content.length > PER_FILE_CAP) {
          content = content.slice(0, PER_FILE_CAP) + "\n…(truncated)";
        }

        // Total cap check
        if (totalSize + content.length > TOTAL_CAP) {
          content = content.slice(0, TOTAL_CAP - totalSize) + "\n…(truncated)";
        }

        sections.push(`### ${match}\n\n\`\`\`\n${content}\n\`\`\``);
        totalSize += content.length;
      } catch {
        continue;
      }
    }

    if (sections.length === 0) return null;
    return `## Files: ${pattern}\n\n${sections.join("\n\n")}`;
  } catch {
    return null;
  }
}

/**
 * Build a profile header with title and persona for the agent.
 * If SOUL.md exists, uses its content as persona instead of config.persona.
 */
function buildProfileHeader(agentId: string, config: AgentConfig, projectDir?: string): string | null {
  const title = config.title;

  // SOUL.md overrides config.persona when present
  const soulContent = resolveSoulDoc(agentId, projectDir);
  const persona = soulContent ?? config.persona;

  if (!title && !persona) return null;

  const lines: string[] = [];
  if (title) {
    lines.push(`## Role: ${title}`);
  }
  if (persona) {
    lines.push("", persona);
  }

  return lines.join("\n");
}

/**
 * Build team status: shows direct reports' current activity.
 */
function resolveTeamStatusSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  const reports = getDirectReports(ctx.projectId, ctx.agentId);
  if (reports.length === 0) return null;

  const allSessions = getActiveSessions();
  const lines = ["## Direct Reports\n"];

  lines.push(`**Reports:** ${reports.join(", ")}\n`);

  for (const reportId of reports) {
    const session = allSessions.find((s) => s.agentId === reportId && s.projectId === ctx.projectId);
    const reportEntry = getAgentConfig(reportId);
    const title = reportEntry?.config.title ?? reportId;

    if (session) {
      const runtimeSec = Math.round((Date.now() - session.metrics.startedAt) / 1000);
      lines.push(`- **${title}** (\`${reportId}\`) — working (${runtimeSec}s, ${session.metrics.toolCalls.length} tool calls)`);
    } else {
      lines.push(`- **${title}** (\`${reportId}\`) — idle`);
    }
  }

  return lines.join("\n");
}

/**
 * Build team performance: shows recent review outcomes for direct reports.
 */
function resolvePendingMessagesSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  let messages: import("../types.js").Message[];
  try {
    messages = getPendingMessages(ctx.projectId, ctx.agentId, db);
  } catch {
    return null;
  }

  if (messages.length === 0) return null;

  // Mark as delivered (they are now in the context)
  try {
    markBulkDelivered(messages.map((m) => m.id), db);
  } catch { /* best effort */ }

  const lines = [
    "## Pending Messages",
    "",
    `You have ${messages.length} unread message(s):`,
    "",
  ];

  for (const msg of messages) {
    const priorityFlag = msg.priority === "urgent" ? " **[URGENT]**" : msg.priority === "high" ? " [HIGH]" : "";
    const shortId = msg.id.slice(0, 8);

    if (msg.protocolStatus) {
      // Protocol message — render with type-specific context
      const deadlineInfo = msg.responseDeadline
        ? ` (deadline: ${formatTimeAgo(msg.responseDeadline - Date.now())} remaining)`
        : "";

      switch (msg.type) {
        case "request":
          lines.push(`### REQUEST from ${msg.fromAgent}${priorityFlag}${deadlineInfo}`);
          lines.push(msg.content);
          lines.push(`*Use \`clawforce_message respond message_id=${shortId}\` to respond*`);
          break;

        case "delegation":
          lines.push(`### DELEGATION from ${msg.fromAgent}${priorityFlag}${deadlineInfo}`);
          lines.push(msg.content);
          if (msg.protocolStatus === "pending_acceptance") {
            lines.push(`*Use \`clawforce_message accept message_id=${shortId}\` or \`reject\` to respond*`);
          }
          break;

        case "feedback": {
          lines.push(`### REVIEW REQUEST from ${msg.fromAgent}${priorityFlag}${deadlineInfo}`);
          lines.push(msg.content);
          const meta = msg.metadata;
          if (meta?.artifact) lines.push(`**Artifact:** ${meta.artifact}`);
          if (meta?.reviewCriteria) lines.push(`**Criteria:** ${meta.reviewCriteria}`);
          lines.push(`*Use \`clawforce_message submit_review message_id=${shortId} verdict=approve|revise|reject\`*`);
          break;
        }

        default: {
          // Other protocol types — generic rendering
          const ago = formatTimeAgo(Date.now() - msg.createdAt);
          lines.push(`### From: ${msg.fromAgent} (${msg.type})${priorityFlag} — ${ago}`);
          lines.push(msg.content);
          lines.push(`*Message ID: \`${shortId}\` — use clawforce_message read/reply to respond*`);
        }
      }
    } else {
      // Standard message — existing rendering
      const typeTag = msg.type !== "direct" ? ` (${msg.type})` : "";
      const ago = formatTimeAgo(Date.now() - msg.createdAt);
      lines.push(`### From: ${msg.fromAgent}${typeTag}${priorityFlag} — ${ago}`);
      lines.push(msg.content);
      lines.push(`*Message ID: \`${shortId}\` — use clawforce_message read/reply to respond*`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function resolveGoalHierarchySource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  // Query active goals (and recently achieved for context)
  const rows = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND status IN ('active', 'achieved') ORDER BY parent_goal_id IS NULL DESC, created_at ASC",
  ).all(ctx.projectId) as Record<string, unknown>[];

  if (rows.length === 0) return null;

  // For non-managers, filter to relevant goals (by department/team)
  const agentDept = ctx.config.department;
  const agentTeam = ctx.config.team;
  const isManager = ctx.config.coordination?.enabled === true;

  type GoalRow = { id: string; title: string; status: string; parentGoalId: string | null; ownerAgentId: string | null; department: string | null; team: string | null };
  const goals: GoalRow[] = rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    parentGoalId: (r.parent_goal_id as string) ?? null,
    ownerAgentId: (r.owner_agent_id as string) ?? null,
    department: (r.department as string) ?? null,
    team: (r.team as string) ?? null,
  }));

  // Filter for non-managers: show goals in their department/team or top-level goals
  const visibleGoals = isManager
    ? goals
    : goals.filter((g) =>
      g.parentGoalId === null || // always show top-level
      (agentDept && g.department === agentDept) ||
      (agentTeam && g.team === agentTeam) ||
      g.ownerAgentId === ctx.agentId,
    );

  if (visibleGoals.length === 0) return null;

  // Build tree rendering
  const lines = ["## Goals", ""];

  // Top-level goals first
  const topLevel = visibleGoals.filter((g) => g.parentGoalId === null);
  const childMap = new Map<string, GoalRow[]>();
  for (const g of visibleGoals) {
    if (g.parentGoalId) {
      const siblings = childMap.get(g.parentGoalId) ?? [];
      siblings.push(g);
      childMap.set(g.parentGoalId, siblings);
    }
  }

  function renderGoal(g: GoalRow, depth: number): void {
    const prefix = depth === 0 ? "###" : depth === 1 ? "####" : "-";
    const statusTag = g.status === "achieved" ? " ✓ ACHIEVED" : "";
    const ownerTag = g.ownerAgentId ? ` (${g.ownerAgentId})` : "";
    const deptTag = g.department ? ` [${g.department}]` : "";

    // Count children for progress hint
    const children = childMap.get(g.id) ?? [];
    const achievedCount = children.filter((c) => c.status === "achieved").length;
    const progressHint = children.length > 0 ? ` — ${achievedCount}/${children.length} sub-goals` : "";

    lines.push(`${prefix} ${g.title}${deptTag}${ownerTag}${statusTag}${progressHint}`);

    for (const child of children) {
      renderGoal(child, depth + 1);
    }
  }

  for (const goal of topLevel) {
    renderGoal(goal, 0);
  }

  return lines.join("\n");
}

function resolveChannelMessagesSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  // Find channels where the agent is a member
  const channelRows = db.prepare(
    "SELECT * FROM channels WHERE project_id = ? AND status = 'active'",
  ).all(ctx.projectId) as Record<string, unknown>[];

  if (channelRows.length === 0) return null;

  const sections: string[] = [];
  let totalChars = 0;
  const charBudget = 5000;

  for (const row of channelRows) {
    let members: string[] = [];
    try { members = JSON.parse((row.members as string) ?? "[]"); } catch { /* */ }
    if (!members.includes(ctx.agentId)) continue;

    const channelId = row.id as string;
    const channelName = row.name as string;
    const channelType = row.type as string;

    // Get recent messages (last 20 per channel)
    const msgs = db.prepare(
      "SELECT from_agent, content, created_at FROM messages WHERE channel_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(channelId, ctx.projectId) as Record<string, unknown>[];

    if (msgs.length === 0) continue;

    const lines = [`### #${channelName} (${channelType})`];
    // Reverse to chronological order
    for (const msg of msgs.reverse()) {
      const line = `**${msg.from_agent}**: ${(msg.content as string).slice(0, 300)}`;
      if (totalChars + line.length > charBudget) break;
      lines.push(line);
      totalChars += line.length;
    }

    // Check if it's an active meeting and it's this agent's turn
    if (channelType === "meeting" && row.metadata) {
      try {
        const metadata = JSON.parse(row.metadata as string);
        const mc = metadata?.meetingConfig;
        if (mc?.participants && mc.currentTurn < mc.participants.length) {
          const currentAgent = mc.participants[mc.currentTurn];
          if (currentAgent === ctx.agentId) {
            lines.push("");
            lines.push("**It is your turn in this meeting.** Use `clawforce_channel send` to respond.");
          }
        }
      } catch { /* */ }
    }

    sections.push(lines.join("\n"));
    if (totalChars > charBudget) break;
  }

  if (sections.length === 0) return null;
  return ["## Channel Messages", "", ...sections].join("\n");
}

function resolvePlanningDeltaSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  try {
    const report = buildDeltaReport(ctx.projectId, ctx.agentId);
    return renderDeltaReport(report);
  } catch {
    return null;
  }
}

function resolveVelocitySource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  try {
    const report = buildVelocityReport(ctx.projectId);
    return renderVelocityReport(report);
  } catch {
    return null;
  }
}

function resolvePreferencesSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  try {
    return renderPreferences(ctx.projectId, ctx.agentId);
  } catch {
    return null;
  }
}

function resolveTrustScoresSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  try {
    return renderTrustSummary(ctx.projectId);
  } catch {
    return null;
  }
}

function resolveTeamPerformanceSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;

  const reports = getDirectReports(ctx.projectId, ctx.agentId);
  if (reports.length === 0) return null;

  let db: DatabaseSync;
  try {
    db = getDb(ctx.projectId);
  } catch {
    return null;
  }

  const lines = ["## Team Performance\n"];
  let hasData = false;

  for (const reportId of reports) {
    const rows = db.prepare(
      `SELECT status, COUNT(*) as cnt FROM audit_runs
       WHERE project_id = ? AND agent_id = ?
       AND ended_at > ?
       GROUP BY status`,
    ).all(ctx.projectId, reportId, Date.now() - 24 * 60 * 60 * 1000) as Record<string, unknown>[];

    if (rows.length === 0) continue;
    hasData = true;

    const reportEntry = getAgentConfig(reportId);
    const title = reportEntry?.config.title ?? reportId;
    const stats = rows.map((r) => `${r.status}: ${r.cnt}`).join(", ");
    lines.push(`- **${title}** (\`${reportId}\`) — last 24h: ${stats}`);
  }

  if (!hasData) return null;

  return lines.join("\n");
}

function resolveResourcesSource(ctx: AssemblerContext): string | null {
  if (!ctx.projectId) return null;
  try {
    return buildResourcesContext(ctx.projectId, ctx.agentId);
  } catch {
    return null;
  }
}

export function resolveInitiativeStatusSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  // Get initiatives (goals with allocation)
  const initiatives = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND allocation IS NOT NULL AND status = 'active' ORDER BY allocation DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (initiatives.length === 0) return "No initiatives configured.";

  // Get project daily budget
  const budgetRow = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;
  const dailyBudget = budgetRow?.daily_limit_cents ?? 0;

  const lines: string[] = ["## Initiative Budget Status", ""];
  lines.push(`Daily budget: ${dailyBudget}c`, "");
  lines.push("| Initiative | Allocation | Budget | Spent | Remaining |");
  lines.push("|------------|-----------|--------|-------|-----------|");

  let totalAllocation = 0;
  let totalSpent = 0;

  for (const row of initiatives) {
    const title = row.title as string;
    const id = row.id as string;
    const allocationPct = row.allocation as number;
    const allocationCents = Math.floor((allocationPct / 100) * dailyBudget);
    const spent = getInitiativeSpend(projectId, id, db);
    const remaining = allocationCents - spent;
    totalAllocation += allocationPct;
    totalSpent += spent;

    const status = remaining <= 0 ? " ⛔" : remaining < allocationCents * 0.25 ? " ⚠️" : "";
    lines.push(`| ${title} | ${allocationPct}% | ${allocationCents}c | ${spent}c | ${remaining}c${status} |`);
  }

  const reservePct = 100 - totalAllocation;
  const reserveCents = dailyBudget - Math.floor((totalAllocation / 100) * dailyBudget);
  lines.push("");
  lines.push(`Reserve: ${reservePct}% (${reserveCents}c)`);
  lines.push(`Total spent: ${totalSpent}c of ${dailyBudget}c`);

  return lines.join("\n");
}

export function resolveCostForecastSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  const initiatives = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND allocation IS NOT NULL AND status = 'active' ORDER BY allocation DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (initiatives.length === 0) return "No initiatives configured.";

  const budgetRow = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;
  const dailyBudget = budgetRow?.daily_limit_cents ?? 0;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hoursElapsed = Math.max(0.5, (now.getTime() - todayStart) / (1000 * 60 * 60));

  const lines: string[] = ["## Cost Forecast", ""];
  lines.push(`Daily budget: ${dailyBudget}c | Hours elapsed: ${hoursElapsed.toFixed(1)}h`, "");
  lines.push("| Initiative | Allocation | Budget | Spent | Remaining | Burn Rate | Exhausts At |");
  lines.push("|------------|-----------|--------|-------|-----------|-----------|-------------|");

  let totalAllocation = 0;
  let totalSpent = 0;

  for (const row of initiatives) {
    const title = row.title as string;
    const id = row.id as string;
    const allocationPct = row.allocation as number;
    const allocationCents = Math.floor((allocationPct / 100) * dailyBudget);
    const spent = getInitiativeSpend(projectId, id, db);
    const remaining = allocationCents - spent;
    totalAllocation += allocationPct;
    totalSpent += spent;

    const burnRate = spent > 0 ? spent / hoursElapsed : 0;
    let exhaustsAt = "—";
    if (burnRate > 0 && remaining > 0) {
      const hoursUntilExhausted = remaining / burnRate;
      const exhaustTime = new Date(now.getTime() + hoursUntilExhausted * 60 * 60 * 1000);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      if (exhaustTime.getTime() < midnight) {
        exhaustsAt = `~${exhaustTime.getHours()}:${String(exhaustTime.getMinutes()).padStart(2, "0")}`;
      }
    }

    const status = remaining <= 0 ? " ⛔" : remaining < allocationCents * 0.25 ? " ⚠️" : "";
    lines.push(`| ${title} | ${allocationPct}% | ${allocationCents}c | ${spent}c | ${remaining}c${status} | ${burnRate.toFixed(1)}c/hr | ${exhaustsAt} |`);
  }

  const reservePct = 100 - totalAllocation;
  const reserveCents = dailyBudget - Math.floor((totalAllocation / 100) * dailyBudget);
  lines.push("");
  lines.push(`Reserve: ${reservePct}% (${reserveCents}c) | Total spent: ${totalSpent}c of ${dailyBudget}c`);

  return lines.join("\n");
}

export function resolveAvailableCapacitySource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  // Try to load resource config from project_metadata
  let modelConfigs: Record<string, { rpm: number; tpm: number; cost_per_1k_input: number; cost_per_1k_output: number }> | undefined;
  try {
    const metaRow = db.prepare(
      "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'resources_models'",
    ).get(projectId) as { value: string } | undefined;
    if (metaRow?.value) {
      modelConfigs = JSON.parse(metaRow.value);
    }
  } catch { /* ignore */ }

  if (!modelConfigs || Object.keys(modelConfigs).length === 0) {
    return "## Available Capacity\n\nNo resource/model configuration found. Configure `resources.models` in project.yaml to enable capacity planning.";
  }

  // Count active sessions per model from dispatch queue
  const activeRows = db.prepare(`
    SELECT payload, COUNT(*) as count
    FROM dispatch_queue
    WHERE project_id = ? AND status = 'leased'
    GROUP BY payload
  `).all(projectId) as Record<string, unknown>[];

  const activeSessions: Record<string, number> = {};
  for (const row of activeRows) {
    try {
      const payload = JSON.parse(row.payload as string);
      const model = payload.model ?? "unknown";
      activeSessions[model] = (activeSessions[model] ?? 0) + (row.count as number);
    } catch { /* ignore */ }
  }

  // Get average tokens per session from cost_records
  const tokenRows = db.prepare(`
    SELECT model, AVG(input_tokens + output_tokens) as avg_tokens
    FROM cost_records
    WHERE project_id = ?
    GROUP BY model
  `).all(projectId) as Record<string, unknown>[];

  const avgTokens: Record<string, number> = {};
  for (const row of tokenRows) {
    if (row.model) avgTokens[row.model as string] = Math.round(row.avg_tokens as number);
  }

  // Build slot calc input
  const models: Record<string, { rpm: number; tpm: number; costPer1kInput: number; costPer1kOutput: number }> = {};
  for (const [name, config] of Object.entries(modelConfigs)) {
    models[name] = {
      rpm: config.rpm ?? 60,
      tpm: config.tpm ?? 200000,
      costPer1kInput: config.cost_per_1k_input ?? 0,
      costPer1kOutput: config.cost_per_1k_output ?? 0,
    };
  }

  const slots = computeAvailableSlots({ models, activeSessions, avgTokensPerSession: avgTokens });

  const lines: string[] = ["## Available Capacity", ""];
  lines.push("| Model | Available Slots | Active | RPM (used/limit) | Avg Tokens/Session |");
  lines.push("|-------|----------------|--------|-------------------|-------------------|");

  for (const slot of slots) {
    lines.push(`| ${slot.model} | ${slot.availableSlots} | ${slot.currentActive} | ${slot.rpmUsed}/${slot.rpmLimit} | ${slot.avgTokensPerSession.toLocaleString()} |`);
  }

  return lines.join("\n");
}

export function resolveKnowledgeCandidatesSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  const candidates = db.prepare(
    "SELECT * FROM promotion_candidates WHERE project_id = ? AND status = 'pending' ORDER BY retrieval_count DESC",
  ).all(projectId) as Record<string, unknown>[];

  const flags = db.prepare(
    "SELECT * FROM knowledge_flags WHERE project_id = ? AND status = 'pending' ORDER BY severity DESC, created_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (candidates.length === 0 && flags.length === 0) {
    return "No pending knowledge promotions or corrections.";
  }

  const lines: string[] = ["## Knowledge Review", ""];

  if (candidates.length > 0) {
    lines.push("### Promotion Candidates", "");
    lines.push("| Content | Retrieved | Sessions | Suggested Target | Action |");
    lines.push("|---------|-----------|----------|-----------------|--------|");
    for (const row of candidates) {
      const snippet = (row.content_snippet as string).slice(0, 80);
      lines.push(`| ${snippet} | ${row.retrieval_count}x | ${row.session_count} | ${row.suggested_target} | \`approve_promotion\` / \`dismiss_promotion\` candidate_id="${row.id}" |`);
    }
    lines.push("");
  }

  if (flags.length > 0) {
    lines.push("### Knowledge Corrections", "");
    lines.push("| Source | Wrong | Correct | Severity | Action |");
    lines.push("|--------|-------|---------|----------|--------|");
    for (const row of flags) {
      const flagged = (row.flagged_content as string).slice(0, 50);
      const correction = (row.correction as string).slice(0, 50);
      lines.push(`| ${row.source_type}:${row.source_ref} | ${flagged} | ${correction} | ${row.severity} | \`resolve_flag\` / \`dismiss_flag\` flag_id="${row.id}" |`);
    }
  }

  return lines.join("\n");
}
