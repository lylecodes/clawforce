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
import { buildCompactionInstructions, isCompactionEnabled } from "./sources/compaction.js";
import { buildCostSummary } from "./sources/cost-summary.js";
import { buildHealthStatus } from "./sources/health-status.js";
import { buildInstructions } from "./sources/instructions.js";
import { buildPolicyStatus } from "./sources/policy-status.js";
import { buildMemoryContext } from "./sources/memory.js";
import { resolveSkillSource } from "../skills/registry.js";
import { ROLE_DEFAULTS } from "../profiles.js";
import { getDirectReports } from "../org.js";
import { getAgentConfig } from "../project.js";

export type AssemblerContext = {
  agentId: string;
  config: AgentConfig;
  projectId?: string;
  projectDir?: string;
};

/**
 * Assemble the session-start context for an agent.
 * Returns a markdown string to inject via before_prompt_build.
 */
export function assembleContext(
  agentId: string,
  config: AgentConfig,
  opts?: { projectId?: string; projectDir?: string; budgetChars?: number },
): string {
  const ctx: AssemblerContext = { agentId, config, projectId: opts?.projectId, projectDir: opts?.projectDir };
  const budgetChars = opts?.budgetChars ?? 15_000;
  const sections: string[] = [];

  // Inject title and persona at the top of the context
  const profileHeader = buildProfileHeader(agentId, config);
  if (profileHeader) {
    sections.push(profileHeader);
  }

  for (const source of config.briefing) {
    const content = resolveSource(source, ctx);
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
 */
function resolveSource(source: ContextSource, ctx: AssemblerContext): string | null {
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

    case "skill":
      return resolveSkillSource(ctx.config.role);

    case "memory":
      if (!ctx.projectId) return null;
      return buildMemoryContext(ctx.projectId, ctx.agentId, ctx.config);

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
  if (ctx.config.role === "manager") {
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
 * Build a profile header with title and persona for the agent.
 * Uses role defaults if the agent doesn't specify its own.
 */
function buildProfileHeader(agentId: string, config: AgentConfig): string | null {
  const title = config.title ?? ROLE_DEFAULTS[config.role]?.title;
  const persona = config.persona;

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
