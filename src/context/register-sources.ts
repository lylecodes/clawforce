/**
 * Clawforce — Context source registrations
 *
 * Registers all context sources with the registry.
 * Imported as a side-effect to populate the registry before resolution.
 */

import { getDb } from "../db.js";
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
import { buildCostSummary } from "./sources/cost-summary.js";
import { buildClawforceHealthReport } from "./sources/clawforce-health-report.js";
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
import { getTaskCreationStandards, getExecutionStandards, getReviewStandards, getRejectionStandards } from "./standards.js";

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AssemblerContext } from "./assembler.js";
import { registerContextSource } from "./registry.js";

// --- instructions ---
registerContextSource("instructions", (ctx) => {
  return buildInstructions(ctx.config.expectations);
});

// --- custom ---
registerContextSource("custom", (_ctx, source) => {
  return source.content ?? null;
});

// --- project_md ---
registerContextSource("project_md", (ctx) => {
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
});

// --- task_board ---
registerContextSource("task_board", (ctx) => {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

  const countRow = db
    .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?")
    .get(ctx.projectId) as Record<string, unknown> | undefined;
  if (!countRow || (countRow.cnt as number) === 0) return null;

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
});

// --- assigned_task ---
registerContextSource("assigned_task", (ctx) => {
  const assignment = getWorkerAssignment(ctx.agentId);
  if (!assignment) return null;

  let db: DatabaseSync;
  try { db = getDb(assignment.projectId); } catch { return null; }

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
});

// --- knowledge ---
registerContextSource("knowledge", (ctx, source) => {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

  let query = "SELECT title, category, content FROM knowledge WHERE project_id = ?";
  const params: (string | number | null)[] = [ctx.projectId];

  if (source.filter?.category?.length) {
    const placeholders = source.filter.category.map(() => "?").join(", ");
    query += ` AND category IN (${placeholders})`;
    params.push(...source.filter.category);
  }

  if (source.filter?.tags?.length) {
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
});

// --- file ---
registerContextSource("file", (ctx, source) => {
  if (!source.path || !ctx.projectDir) return null;

  if (source.path.includes("*")) {
    return resolveFileGlob(source.path, ctx.projectDir);
  }

  const resolved = path.resolve(ctx.projectDir, source.path);
  if (!resolved.startsWith(ctx.projectDir + path.sep) && resolved !== ctx.projectDir) {
    return null;
  }

  try {
    if (!fs.existsSync(resolved)) return null;
    const content = fs.readFileSync(resolved, "utf-8").trim();
    if (!content) return null;
    const capped = content.length > 10_240 ? content.slice(0, 10_240) + "\n…(truncated)" : content;
    return `## File: ${source.path}\n\n\`\`\`\n${capped}\n\`\`\``;
  } catch {
    return null;
  }
});

// --- escalations ---
registerContextSource("escalations", (ctx) => {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderEscalations(db, ctx.projectId, 25);
});

// --- workflows ---
registerContextSource("workflows", (ctx) => {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderWorkflows(db, ctx.projectId);
});

// --- activity ---
registerContextSource("activity", (ctx) => {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderRecentActivity(db, ctx.projectId, 20);
});

// --- sweep_status ---
registerContextSource("sweep_status", (ctx) => {
  if (!ctx.projectId) return null;
  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }
  return renderSweepStatus(db, ctx.projectId);
});

// --- proposals ---
registerContextSource("proposals", (ctx) => {
  if (!ctx.projectId) return null;

  let proposals: ReturnType<typeof listPendingProposals>;
  try { proposals = listPendingProposals(ctx.projectId); } catch { return null; }
  if (proposals.length === 0) return null;

  const PROPOSAL_TTL_WARNING_MS = 20 * 60 * 60 * 1000;
  const lines = [
    "## Pending Proposals",
    "",
    `${proposals.length} proposal(s) awaiting user decision:`,
    "",
  ];

  for (const p of proposals) {
    const ageMs = Date.now() - p.created_at;
    const ago = formatTimeAgo(ageMs);
    const desc = p.description ? ` — ${p.description.slice(0, 120)}${p.description.length > 120 ? "…" : ""}` : "";
    const ttlWarning = ageMs > PROPOSAL_TTL_WARNING_MS ? " **[EXPIRING SOON]**" : "";
    lines.push(`- \`${p.id.slice(0, 8)}\` **${p.title}** by ${p.proposed_by} (${ago})${desc}${ttlWarning}`);
  }

  return lines.join("\n");
});

// --- agent_status ---
registerContextSource("agent_status", (ctx) => {
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
});

// --- cost_summary ---
registerContextSource("cost_summary", (ctx) => {
  if (!ctx.projectId) return null;
  try { return buildCostSummary(ctx.projectId, ctx.agentId); } catch { return null; }
});

// --- policy_status ---
registerContextSource("policy_status", (ctx) => {
  if (!ctx.projectId) return null;
  try { return buildPolicyStatus(ctx.projectId, ctx.agentId); } catch { return null; }
});

// --- health_status ---
registerContextSource("health_status", (ctx) => {
  if (!ctx.projectId) return null;
  try { return buildHealthStatus(ctx.projectId); } catch { return null; }
});

// --- clawforce_health_report ---
registerContextSource("clawforce_health_report", (ctx) => {
  if (!ctx.projectId) return null;
  try { return buildClawforceHealthReport(ctx.projectId, ctx.projectDir); } catch { return null; }
});

// --- team_status ---
registerContextSource("team_status", (ctx) => {
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
});

// --- team_performance ---
registerContextSource("team_performance", (ctx) => {
  if (!ctx.projectId) return null;

  const reports = getDirectReports(ctx.projectId, ctx.agentId);
  if (reports.length === 0) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

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
});

// --- skill ---
registerContextSource("skill", (ctx) => {
  const hasToolsRef = ctx.config.briefing.some((s) => s.source === "tools_reference");
  return resolveSkillSource(ctx.config.extends ?? "employee", undefined, hasToolsRef ? ["tools"] : undefined, ctx.projectId);
});

// --- memory ---
registerContextSource("memory", () => {
  return "## Shared Memory\n\nUse `memory_search` to find relevant learnings from previous sessions. Use `memory_get` to retrieve specific memories by ID.";
});

// --- memory_instructions ---
registerContextSource("memory_instructions", (ctx) => {
  return resolveMemoryInstructions(ctx.config.memory, ctx.config.extends ?? "employee");
});

// --- memory_review_context ---
registerContextSource("memory_review_context", (ctx) => {
  if (!ctx.projectDir) return null;
  const memoryConfig = ctx.config.memory;
  return buildReviewContext({
    agentId: ctx.agentId,
    scope: memoryConfig?.review?.scope ?? "self",
    aggressiveness: memoryConfig?.review?.aggressiveness ?? "medium",
    projectDir: ctx.projectDir,
  });
});

// --- soul ---
registerContextSource("soul", (ctx) => {
  return resolveSoulDoc(ctx.agentId, ctx.projectDir);
});

// --- tools_reference ---
registerContextSource("tools_reference", (ctx) => {
  return resolveToolsDocs(ctx.agentId, ctx.config, ctx.projectDir, ctx.projectId);
});

// --- pending_messages ---
registerContextSource("pending_messages", (ctx) => {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

  let messages: import("../types.js").Message[];
  try { messages = getPendingMessages(ctx.projectId, ctx.agentId, db); } catch { return null; }
  if (messages.length === 0) return null;

  try { markBulkDelivered(messages.map((m) => m.id), db); } catch { /* best effort */ }

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
          const ago = formatTimeAgo(Date.now() - msg.createdAt);
          lines.push(`### From: ${msg.fromAgent} (${msg.type})${priorityFlag} — ${ago}`);
          lines.push(msg.content);
          lines.push(`*Message ID: \`${shortId}\` — use clawforce_message read/reply to respond*`);
        }
      }
    } else {
      const typeTag = msg.type !== "direct" ? ` (${msg.type})` : "";
      const ago = formatTimeAgo(Date.now() - msg.createdAt);
      lines.push(`### From: ${msg.fromAgent}${typeTag}${priorityFlag} — ${ago}`);
      lines.push(msg.content);
      lines.push(`*Message ID: \`${shortId}\` — use clawforce_message read/reply to respond*`);
    }
    lines.push("");
  }

  return lines.join("\n");
});

// --- user_messages ---
// Shows messages from the dashboard user to this agent, separate from agent-to-agent messaging.
registerContextSource("user_messages", (ctx) => {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

  // Fetch undelivered messages from "user" to this agent
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(
      `SELECT id, content, created_at, metadata FROM messages WHERE project_id = ? AND to_agent = ? AND from_agent = 'user' AND status = 'queued' ORDER BY created_at ASC`,
    ).all(ctx.projectId, ctx.agentId) as Record<string, unknown>[];
  } catch { return null; }

  if (!rows || rows.length === 0) return null;

  // Mark as delivered
  try {
    const stmt = db.prepare("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?");
    const now = Date.now();
    for (const r of rows) {
      stmt.run(now, r.id as string);
    }
  } catch { /* best effort */ }

  const lines = [
    "## Messages from the User",
    "",
    `You have ${rows.length} message(s) from the user (dashboard):`,
    "",
  ];

  for (const row of rows) {
    const ago = formatTimeAgo(Date.now() - (row.created_at as number));
    lines.push(`### User Message — ${ago}`);
    lines.push(String(row.content));

    // Check for linked proposal
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata as string);
        if (meta.proposalId) {
          lines.push(`*Related to proposal: \`${meta.proposalId}\`*`);
        }
      } catch { /* ignore */ }
    }
    lines.push("");
  }

  lines.push("*Respond to the user by creating tasks, proposals, or sending a message to agent \"user\".*");

  return lines.join("\n");
});

// --- goal_hierarchy ---
registerContextSource("goal_hierarchy", (ctx) => {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

  const rows = db.prepare(
    "SELECT * FROM goals WHERE project_id = ? AND status IN ('active', 'achieved') ORDER BY parent_goal_id IS NULL DESC, created_at ASC",
  ).all(ctx.projectId) as Record<string, unknown>[];

  if (rows.length === 0) return null;

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

  const visibleGoals = isManager
    ? goals
    : goals.filter((g) =>
      g.parentGoalId === null ||
      (agentDept && g.department === agentDept) ||
      (agentTeam && g.team === agentTeam) ||
      g.ownerAgentId === ctx.agentId,
    );

  if (visibleGoals.length === 0) return null;

  const lines = ["## Goals", ""];

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
});

// --- channel_messages ---
registerContextSource("channel_messages", (ctx) => {
  if (!ctx.projectId) return null;

  let db: DatabaseSync;
  try { db = getDb(ctx.projectId); } catch { return null; }

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

    const msgs = db.prepare(
      "SELECT from_agent, content, created_at FROM messages WHERE channel_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(channelId, ctx.projectId) as Record<string, unknown>[];

    if (msgs.length === 0) continue;

    const lines = [`### #${channelName} (${channelType})`];
    for (const msg of msgs.reverse()) {
      const line = `**${msg.from_agent}**: ${(msg.content as string).slice(0, 300)}`;
      if (totalChars + line.length > charBudget) break;
      lines.push(line);
      totalChars += line.length;
    }

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
});

// --- planning_delta ---
registerContextSource("planning_delta", (ctx) => {
  if (!ctx.projectId) return null;
  try {
    const report = buildDeltaReport(ctx.projectId, ctx.agentId);
    return renderDeltaReport(report);
  } catch { return null; }
});

// --- velocity ---
registerContextSource("velocity", (ctx) => {
  if (!ctx.projectId) return null;
  try {
    const report = buildVelocityReport(ctx.projectId);
    return renderVelocityReport(report);
  } catch { return null; }
});

// --- preferences ---
registerContextSource("preferences", (ctx) => {
  if (!ctx.projectId) return null;
  try { return renderPreferences(ctx.projectId, ctx.agentId); } catch { return null; }
});

// --- trust_scores ---
registerContextSource("trust_scores", (ctx) => {
  if (!ctx.projectId) return null;
  try { return renderTrustSummary(ctx.projectId); } catch { return null; }
});

// --- resources ---
registerContextSource("resources", (ctx) => {
  if (!ctx.projectId) return null;
  try { return buildResourcesContext(ctx.projectId, ctx.agentId); } catch { return null; }
});

// --- initiative_status ---
registerContextSource("initiative_status", (ctx) => {
  return resolveInitiativeStatusSourceImpl(ctx.projectId ?? "", undefined);
});

// --- cost_forecast ---
registerContextSource("cost_forecast", (ctx) => {
  return resolveCostForecastSourceImpl(ctx.projectId ?? "", undefined);
});

// --- available_capacity ---
registerContextSource("available_capacity", (ctx) => {
  return resolveAvailableCapacitySourceImpl(ctx.projectId ?? "", undefined);
});

// --- knowledge_candidates ---
registerContextSource("knowledge_candidates", (ctx) => {
  return resolveKnowledgeCandidatesSourceImpl(ctx.projectId ?? "", undefined);
});

// --- budget_guidance ---
registerContextSource("budget_guidance", (ctx, source) => {
  return resolveBudgetGuidanceSource(ctx.projectId ?? "", source.params);
});

// --- onboarding_welcome ---
registerContextSource("onboarding_welcome", (ctx) => {
  if (!ctx.projectId) return null;
  try {
    const db = getDb(ctx.projectId);
    const agents = getRegisteredAgentIds();
    return resolveWelcomeSource(ctx.projectId, db, {
      agentCount: agents.length,
      domainName: ctx.projectId,
    });
  } catch { return null; }
});

// --- weekly_digest ---
registerContextSource("weekly_digest", (ctx) => {
  if (!ctx.projectId) return null;
  try {
    const db = getDb(ctx.projectId);
    return resolveWeeklyDigestSource(ctx.projectId, db);
  } catch { return null; }
});

// --- intervention_suggestions ---
registerContextSource("intervention_suggestions", (ctx) => {
  if (!ctx.projectId) return null;
  try {
    const db = getDb(ctx.projectId);
    const agents = getRegisteredAgentIds();
    return resolveInterventionSource(ctx.projectId, db, agents);
  } catch { return null; }
});

// --- custom_stream ---
registerContextSource("custom_stream", (ctx, source) => {
  if (!source.streamName || !ctx.projectId) return null;
  const streamDef = getStream(source.streamName);
  if (!streamDef) return null;
  return `## ${source.streamName}\n\n${streamDef.description}`;
});

// --- observed_events ---
registerContextSource("observed_events", (ctx, source) => {
  if (!ctx.projectId) return null;
  const observe = ctx.config.observe ?? [];
  return renderObservedEvents(ctx.projectId, observe, source.since ?? 0);
});

// --- direction ---
registerContextSource("direction", (ctx) => {
  if (!ctx.projectId) return null;
  return renderDomainContext(getProjectsDir(), ctx.projectId, "direction");
});

// --- policies ---
registerContextSource("policies", (ctx) => {
  if (!ctx.projectId) return null;
  return renderDomainContext(getProjectsDir(), ctx.projectId, "policies");
});

// --- standards ---
registerContextSource("standards", (ctx) => {
  if (!ctx.projectId) return null;
  return renderDomainContext(getProjectsDir(), ctx.projectId, "standards");
});

// --- architecture ---
registerContextSource("architecture", (ctx) => {
  if (!ctx.projectId) return null;
  return renderDomainContext(getProjectsDir(), ctx.projectId, "architecture");
});

// --- task_creation_standards ---
registerContextSource("task_creation_standards", () => {
  return getTaskCreationStandards();
});

// --- execution_standards ---
registerContextSource("execution_standards", () => {
  return getExecutionStandards();
});

// --- review_standards ---
registerContextSource("review_standards", () => {
  return getReviewStandards();
});

// --- rejection_standards ---
registerContextSource("rejection_standards", () => {
  return getRejectionStandards();
});

// ─── Shared implementations for exported source resolvers ───────────────────

/**
 * Resolve initiative status. Used both by the registry and the exported function.
 */
export function resolveInitiativeStatusSourceImpl(
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

/**
 * Resolve cost forecast. Used both by the registry and the exported function.
 */
export function resolveCostForecastSourceImpl(
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

/**
 * Resolve available capacity. Used both by the registry and the exported function.
 */
export function resolveAvailableCapacitySourceImpl(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

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

/**
 * Resolve knowledge candidates. Used both by the registry and the exported function.
 */
export function resolveKnowledgeCandidatesSourceImpl(
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

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolve a glob pattern to concatenated file contents.
 * Uses fs.globSync (Node 22+) with per-file and total caps.
 */
function resolveFileGlob(pattern: string, projectDir: string): string | null {
  const PER_FILE_CAP = 5_120;
  const TOTAL_CAP = 10_240;

  try {
    const resolvedPattern = path.resolve(projectDir, pattern);
    if (!resolvedPattern.startsWith(projectDir + path.sep) && !resolvedPattern.startsWith(projectDir)) {
      return null;
    }

    let matches: string[];
    try {
      matches = fs.globSync(pattern, { cwd: projectDir }) as unknown as string[];
    } catch {
      return null;
    }

    if (matches.length === 0) return null;

    const sections: string[] = [];
    let totalSize = 0;

    for (const match of matches) {
      if (totalSize >= TOTAL_CAP) break;

      const filePath = path.resolve(projectDir, match);
      if (!filePath.startsWith(projectDir + path.sep) && filePath !== projectDir) continue;

      try {
        if (!fs.existsSync(filePath)) continue;
        let content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        if (content.length > PER_FILE_CAP) {
          content = content.slice(0, PER_FILE_CAP) + "\n…(truncated)";
        }

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
