#!/usr/bin/env npx tsx
/**
 * clawforce CLI — operational diagnostics + runtime control
 *
 * Usage: npx tsx src/cli.ts <command> [options]
 *
 * Diagnostics:
 *   status          System vitals — gateway, budget, task counts, queue
 *   tasks           Active tasks with states and assignees
 *   costs           Cost breakdown by agent, task, or time window
 *   queue           Dispatch queue health and failure reasons
 *   transitions     Recent state transitions (catches silent failures)
 *   errors          Recent errors, failed dispatches, swallowed exceptions
 *   agents          Agent session status and activity
 *   streams         List available data streams
 *   query           Raw SQL query against the project DB
 *
 * Visibility Suite:
 *   dashboard       Single-command overview with anomaly detection
 *   sessions        List recent sessions with cost/output summary
 *   session <key>   Drill into one session — tool calls, transitions, cost
 *   proposals       List proposals with status and reasoning preview
 *   flows           Per-session action timeline
 *   metrics         Per-agent efficiency metrics
 *   budget          Budget pacing status and projections
 *   trust           Per-agent trust overview
 *   inbox           User messages from/to agents
 *   approve <id>    Approve a pending proposal
 *   reject <id>     Reject a pending proposal with optional feedback
 *   message <agent> Send a message to an agent
 *   replay <key>    Replay session tool calls with full input/output
 *   watch           Curated feed — only what changed since last check
 *
 * Runtime Control:
 *   disable         Disable domain via DB (blocks new dispatches)
 *   enable          Enable domain via DB (resume dispatches)
 *   kill            Emergency stop: disable + cancel queue + block ALL tool calls
 *   kill --resume   Clear emergency stop and re-enable domain
 *
 * Config:
 *   config get      Read a config value using dot-notation
 *   config set      Write a config value (auto-detects type)
 *   config show     Show full config or a section
 *
 * Verification:
 *   running         Show what's actually running right now
 *   health          Comprehensive health check
 */

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import { cmdOrg, cmdOrgSet, cmdOrgCheck } from "./cli/org.js";
import { getAgentSaturation, getQueueWaitTime, getAgentThroughput, getCostEfficiency, getSessionEfficiency, getTaskCycleTime, getFailureRate, getRetryRate } from "./metrics/operational.js";

const HOME = process.env.HOME ?? "/tmp";
const DEFAULT_PROJECT = "clawforce-dev";
const DB_DIR = path.join(HOME, ".clawforce");

function getDb(projectId: string): DatabaseSync {
  const dbPath = path.join(DB_DIR, projectId, "clawforce.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(2);
  }
  return new DatabaseSync(dbPath, { open: true });
}

function fmt$(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

function fmtAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-US", { hour12: false });
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 1) + "\u2026";
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

/**
 * Extract a display name from a session key like "agent:cf-lead:cron:uuid".
 * Returns e.g. "cf-lead" (agent name) and "cron" (session type).
 */
function parseSessionKey(key: string): { agent: string; type: string } {
  // Format: agent:<agentName>:<sessionType>:<uuid>
  const parts = key.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return { agent: parts[1]!, type: parts[2]! };
  }
  // Fallback: just return the whole thing
  return { agent: key, type: "?" };
}

/**
 * Extract just the agent name from a session key or agent reference.
 * "agent:cf-lead:cron:uuid" -> "cf-lead"
 * "cf-lead" -> "cf-lead"
 */
function extractAgentName(key: string): string {
  if (key.startsWith("agent:")) {
    const parts = key.split(":");
    return parts[1] ?? key;
  }
  return key;
}

/**
 * Load agent list from domain YAML config.
 */
function loadDomainAgents(domainId: string): string[] {
  const yamlPath = path.join(DB_DIR, "domains", `${domainId}.yaml`);
  if (!fs.existsSync(yamlPath)) return [];
  try {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.agents)) {
      return parsed.agents as string[];
    }
  } catch { /* ignore */ }
  return [];
}

// ─── Commands ────────────────────────────────────────────────────────

export function cmdStatus(db: DatabaseSync, json = false) {
  // Gateway
  let gatewayPid = "down";
  try {
    const ps = execSync("ps aux | grep openclaw-gateway | grep -v grep", { encoding: "utf8" }).trim();
    const match = ps.match(/\S+\s+(\d+)/);
    if (match) gatewayPid = match[1]!;
  } catch { /* not running */ }

  // Budget
  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents, monthly_spent_cents FROM budgets WHERE agent_id IS NULL"
  ).get() as Record<string, number> | undefined;

  // Tasks
  const taskCounts = db.prepare(
    "SELECT state, COUNT(*) as cnt FROM tasks GROUP BY state"
  ).all() as Array<{ state: string; cnt: number }>;

  // Queue
  const queueCounts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM dispatch_queue GROUP BY status"
  ).all() as Array<{ status: string; cnt: number }>;

  // Recent cost (last hour)
  const recentCost = db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost, COUNT(*) as calls FROM cost_records WHERE created_at > ?"
  ).get(Date.now() - 3600_000) as { cost: number; calls: number };

  if (json) {
    console.log(JSON.stringify({
      gateway: gatewayPid === "down" ? null : { pid: Number(gatewayPid) },
      budget: budget ? { daily_limit_cents: budget.daily_limit_cents, daily_spent_cents: budget.daily_spent_cents, monthly_spent_cents: budget.monthly_spent_cents } : null,
      burn_rate: { cost_cents: recentCost.cost, calls: recentCost.calls, window: "1h" },
      tasks: Object.fromEntries(taskCounts.map(r => [r.state, r.cnt])),
      queue: Object.fromEntries(queueCounts.map(r => [r.status, r.cnt])),
    }, null, 2));
    return;
  }

  console.log("## ClawForce Status\n");
  console.log(`Gateway:     ${gatewayPid === "down" ? "DOWN" : `running (PID ${gatewayPid})`}`);

  if (budget) {
    const pct = Math.round((budget.daily_spent_cents / budget.daily_limit_cents) * 100);
    console.log(`Budget:      ${fmt$(budget.daily_spent_cents)} / ${fmt$(budget.daily_limit_cents)} daily (${pct}%)`);
    if (budget.monthly_spent_cents > 0) {
      console.log(`             ${fmt$(budget.monthly_spent_cents)} monthly total`);
    }
  } else {
    console.log("Budget:      no budget configured");
  }

  console.log(`Burn rate:   ${fmt$(recentCost.cost)} / ${recentCost.calls} calls in last hour`);

  console.log("\nTasks:");
  const taskMap = Object.fromEntries(taskCounts.map(r => [r.state, r.cnt]));
  for (const state of ["ASSIGNED", "IN_PROGRESS", "REVIEW", "OPEN", "BLOCKED", "FAILED", "DONE", "CANCELLED"]) {
    if (taskMap[state]) console.log(`  ${state.padEnd(14)} ${taskMap[state]}`);
  }

  console.log("\nQueue:");
  const queueMap = Object.fromEntries(queueCounts.map(r => [r.status, r.cnt]));
  for (const status of ["queued", "leased", "dispatched", "completed", "failed", "cancelled"]) {
    if (queueMap[status]) console.log(`  ${status.padEnd(14)} ${queueMap[status]}`);
  }
}

export function cmdTasks(db: DatabaseSync, filter?: string, json = false) {
  const where = filter
    ? `WHERE state = '${filter.toUpperCase()}'`
    : "WHERE state NOT IN ('DONE', 'CANCELLED')";

  const tasks = db.prepare(`
    SELECT id, title, state, assigned_to, priority,
           datetime(created_at/1000, 'unixepoch') as created,
           datetime(updated_at/1000, 'unixepoch') as updated
    FROM tasks ${where} ORDER BY state, created_at
  `).all() as Array<Record<string, unknown>>;

  if (json) {
    console.log(JSON.stringify({ filter: filter?.toUpperCase() ?? "active", tasks }, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  for (const t of tasks) {
    const assignee = t.assigned_to ? ` → ${t.assigned_to}` : "";
    console.log(`[${t.state}] ${t.title}${assignee}`);
    console.log(`  id: ${(t.id as string).slice(0, 8)}  priority: ${t.priority ?? "—"}  updated: ${t.updated}`);
  }
}

export function cmdCosts(db: DatabaseSync, groupBy?: string, hours?: number, json = false) {
  const since = Date.now() - (hours ?? 24) * 3600_000;
  const sinceStr = fmtDate(since);

  if (groupBy === "task") {
    const rows = db.prepare(`
      SELECT c.agent_id, c.task_id, t.title as task_title,
             SUM(c.cost_cents) as cost, COUNT(*) as calls,
             SUM(c.input_tokens) as input_tok, SUM(c.output_tokens) as output_tok,
             SUM(c.cache_read_tokens) as cache_read
      FROM cost_records c LEFT JOIN tasks t ON c.task_id = t.id
      WHERE c.created_at > ?
      GROUP BY c.agent_id, c.task_id ORDER BY cost DESC
    `).all(since) as Array<Record<string, unknown>>;

    if (json) {
      console.log(JSON.stringify({ group_by: "task", since: sinceStr, rows }, null, 2));
      return;
    }

    console.log(`## Costs by Task (since ${sinceStr})\n`);
    for (const r of rows) {
      const task = r.task_title ? ` "${(r.task_title as string).slice(0, 50)}"` : " (no task)";
      console.log(`${fmt$((r.cost as number)).padStart(8)}  ${r.agent_id}${task}  (${r.calls} calls, ${r.output_tok} output tok)`);
    }
    return;
  }

  if (groupBy === "day") {
    const rows = db.prepare(`
      SELECT date(created_at/1000, 'unixepoch') as day,
             SUM(cost_cents) as cost, COUNT(*) as calls,
             SUM(output_tokens) as output_tok
      FROM cost_records GROUP BY day ORDER BY day DESC LIMIT 14
    `).all() as Array<Record<string, unknown>>;

    if (json) {
      console.log(JSON.stringify({ group_by: "day", rows }, null, 2));
      return;
    }

    console.log("## Costs by Day\n");
    for (const r of rows) {
      console.log(`${r.day}  ${fmt$((r.cost as number)).padStart(8)}  ${(r.calls as number).toString().padStart(4)} calls  ${r.output_tok} output tok`);
    }
    return;
  }

  // Default: by agent
  const rows = db.prepare(`
    SELECT agent_id, model,
           SUM(cost_cents) as cost, COUNT(*) as calls,
           SUM(input_tokens) as input_tok, SUM(output_tokens) as output_tok,
           SUM(cache_read_tokens) as cache_read, SUM(cache_write_tokens) as cache_write
    FROM cost_records WHERE created_at > ?
    GROUP BY agent_id, model ORDER BY cost DESC
  `).all(since) as Array<Record<string, unknown>>;

  const total = rows.reduce((s, r) => s + (r.cost as number), 0);

  if (json) {
    console.log(JSON.stringify({ group_by: "agent", since: sinceStr, total_cents: total, rows }, null, 2));
    return;
  }

  console.log(`## Costs by Agent (since ${sinceStr})\n`);
  for (const r of rows) {
    const pct = Math.round(((r.cost as number) / total) * 100);
    console.log(`${fmt$((r.cost as number)).padStart(8)} (${pct.toString().padStart(2)}%)  ${r.agent_id}  ${r.model}`);
    console.log(`           ${r.calls} calls | out: ${r.output_tok} | cache_read: ${r.cache_read} | cache_write: ${r.cache_write}`);
  }
  console.log(`\n   Total: ${fmt$(total)}`);
}

export function cmdQueue(db: DatabaseSync, json = false) {
  // Status counts
  const counts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM dispatch_queue GROUP BY status"
  ).all() as Array<{ status: string; cnt: number }>;

  // Failure reasons
  const failures = db.prepare(`
    SELECT last_error, COUNT(*) as cnt
    FROM dispatch_queue WHERE status = 'failed'
    GROUP BY last_error ORDER BY cnt DESC LIMIT 10
  `).all() as Array<{ last_error: string | null; cnt: number }>;

  // Recent dispatches
  const recent = db.prepare(`
    SELECT dq.task_id, t.title, dq.status, dq.last_error,
           datetime(dq.created_at/1000, 'unixepoch') as created
    FROM dispatch_queue dq LEFT JOIN tasks t ON dq.task_id = t.id
    WHERE dq.created_at > ?
    ORDER BY dq.created_at DESC LIMIT 10
  `).all(Date.now() - 3600_000) as Array<Record<string, unknown>>;

  if (json) {
    console.log(JSON.stringify({
      counts: Object.fromEntries(counts.map(r => [r.status, r.cnt])),
      failures,
      recent,
    }, null, 2));
    return;
  }

  console.log("## Dispatch Queue\n");
  for (const r of counts) {
    console.log(`  ${r.status.padEnd(14)} ${r.cnt}`);
  }

  if (failures.length > 0) {
    console.log("\nFailure reasons:");
    for (const f of failures) {
      console.log(`  ${f.cnt.toString().padStart(4)}x  ${f.last_error ?? "(no error message)"}`);
    }
  }

  if (recent.length > 0) {
    console.log("\nRecent (last hour):");
    for (const r of recent) {
      const title = r.title ? ` "${(r.title as string).slice(0, 40)}"` : "";
      const err = r.last_error ? ` — ${(r.last_error as string).slice(0, 60)}` : "";
      console.log(`  [${r.status}] ${r.created}${title}${err}`);
    }
  }
}

export function cmdTransitions(db: DatabaseSync, hours?: number) {
  const since = Date.now() - (hours ?? 2) * 3600_000;

  const rows = db.prepare(`
    SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor,
           datetime(t.created_at/1000, 'unixepoch') as ts
    FROM transitions t LEFT JOIN tasks tk ON t.task_id = tk.id
    WHERE t.created_at > ?
    ORDER BY t.created_at DESC LIMIT 30
  `).all(since) as Array<Record<string, unknown>>;

  console.log(`## Transitions (last ${hours ?? 2}h)\n`);
  if (rows.length === 0) {
    console.log("No transitions.");
    return;
  }
  for (const r of rows) {
    const title = r.title ? ` "${(r.title as string).slice(0, 45)}"` : "";
    console.log(`${r.ts}  ${r.from_state} → ${r.to_state}  by ${r.actor}${title}`);
  }
}

export function cmdErrors(db: DatabaseSync, hours?: number) {
  const since = Date.now() - (hours ?? 2) * 3600_000;

  // Failed dispatches
  const failed = db.prepare(`
    SELECT dq.task_id, t.title, dq.last_error, dq.dispatch_attempts,
           datetime(dq.created_at/1000, 'unixepoch') as created
    FROM dispatch_queue dq LEFT JOIN tasks t ON dq.task_id = t.id
    WHERE dq.status = 'failed' AND dq.created_at > ?
    ORDER BY dq.created_at DESC LIMIT 15
  `).all(since) as Array<Record<string, unknown>>;

  console.log(`## Errors (last ${hours ?? 2}h)\n`);

  if (failed.length > 0) {
    console.log("Dispatch failures:");
    for (const f of failed) {
      const title = f.title ? ` "${(f.title as string).slice(0, 40)}"` : "";
      console.log(`  ${f.created}${title}`);
      console.log(`    ${f.last_error ?? "no error"} (attempts: ${f.dispatch_attempts})`);
    }
  }

  // Failed tasks
  const failedTasks = db.prepare(`
    SELECT id, title, assigned_to, datetime(updated_at/1000, 'unixepoch') as updated
    FROM tasks WHERE state = 'FAILED' AND updated_at > ?
    ORDER BY updated_at DESC
  `).all(since) as Array<Record<string, unknown>>;

  if (failedTasks.length > 0) {
    console.log("\nFailed tasks:");
    for (const t of failedTasks) {
      console.log(`  ${t.updated}  "${t.title}" (${t.assigned_to})`);
    }
  }

  // Transition failures (tasks that went ASSIGNED→ASSIGNED, indicating failed transition attempts)
  const stuckTransitions = db.prepare(`
    SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor,
           datetime(t.created_at/1000, 'unixepoch') as ts
    FROM transitions t LEFT JOIN tasks tk ON t.task_id = tk.id
    WHERE t.from_state = t.to_state AND t.created_at > ?
    ORDER BY t.created_at DESC LIMIT 10
  `).all(since) as Array<Record<string, unknown>>;

  if (stuckTransitions.length > 0) {
    console.log("\nStuck transitions (same state → same state):");
    for (const r of stuckTransitions) {
      console.log(`  ${r.ts}  ${r.from_state} → ${r.to_state}  "${r.title}" by ${r.actor}`);
    }
  }

  if (failed.length === 0 && failedTasks.length === 0 && stuckTransitions.length === 0) {
    console.log("No errors found.");
  }
}

export function cmdAgents(db: DatabaseSync, json = false) {
  const agents = db.prepare(`
    SELECT agent_id,
           COUNT(*) as total_sessions,
           SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) as recent_sessions,
           SUM(cost_cents) as total_cost,
           SUM(CASE WHEN created_at > ? THEN cost_cents ELSE 0 END) as recent_cost,
           MAX(created_at) as last_active
    FROM cost_records GROUP BY agent_id ORDER BY last_active DESC
  `).all(Date.now() - 3600_000, Date.now() - 3600_000) as Array<Record<string, unknown>>;

  // Tasks per agent
  const assignments = db.prepare(`
    SELECT assigned_to, state, COUNT(*) as cnt
    FROM tasks WHERE state NOT IN ('DONE', 'CANCELLED') AND assigned_to IS NOT NULL
    GROUP BY assigned_to, state ORDER BY assigned_to, state
  `).all() as Array<Record<string, unknown>>;

  if (json) {
    console.log(JSON.stringify({ agents, assignments }, null, 2));
    return;
  }

  console.log("## Agents\n");
  for (const a of agents) {
    const age = Date.now() - (a.last_active as number);
    console.log(`${a.agent_id}`);
    console.log(`  Last active: ${fmtAge(age)} ago | Today: ${fmt$((a.recent_cost as number))} (${a.recent_sessions} sessions) | Total: ${fmt$((a.total_cost as number))} (${a.total_sessions} sessions)`);
  }

  if (assignments.length > 0) {
    console.log("\nActive assignments:");
    for (const a of assignments) {
      console.log(`  ${a.assigned_to}: ${a.cnt} ${a.state}`);
    }
  }
}

export function cmdStreams(db: DatabaseSync, domainId: string) {
  console.log("## Available Data Streams\n");
  console.log("Use context sources in agent briefings or export via webhook.\n");

  // Read stream definitions from the builtin manifest source file
  let catalogStreams: Array<{ name: string; description: string }> = [];
  try {
    const scriptDir = path.dirname(process.argv[1] ?? "");
    const manifestPath = path.resolve(scriptDir, "streams", "builtin-manifest.ts");
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const re = /registerStream\(\{\s*name:\s*"([^"]+)",\s*description:\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        catalogStreams.push({ name: m[1]!, description: m[2]! });
      }
    }
  } catch { /* fall through to hardcoded fallback */ }

  // Fallback: hardcoded list (in case manifest file can't be parsed)
  if (catalogStreams.length === 0) {
    catalogStreams = [
      { name: "cost_summary", description: "Cost tracking summary for the project" },
      { name: "cost_forecast", description: "Budget exhaustion projection" },
      { name: "budget_guidance", description: "Budget utilization, remaining sessions, forecast" },
      { name: "task_board", description: "Current task board with status, priority, assignee" },
      { name: "velocity", description: "Task completion velocity and trends" },
      { name: "team_performance", description: "Performance metrics per team member" },
      { name: "trust_scores", description: "Trust evolution scores per action category" },
      { name: "agent_status", description: "Status of all agents in the team" },
      { name: "health_status", description: "System health indicators" },
      { name: "sweep_status", description: "Automated sweep findings" },
      { name: "initiative_status", description: "Initiative allocation vs spend" },
      { name: "weekly_digest", description: "Weekly performance summary" },
      { name: "intervention_suggestions", description: "Pattern-detected recommendations" },
    ];
    console.log("  (using fallback list -- builtin manifest not found)\n");
  }

  // Load domain YAML to check which streams are configured in default briefings
  const activeSources = new Set<string>();
  const yamlPath = path.join(DB_DIR, "domains", `${domainId}.yaml`);
  try {
    if (fs.existsSync(yamlPath)) {
      const raw = fs.readFileSync(yamlPath, "utf-8");
      const parsed = YAML.parse(raw) as Record<string, unknown>;
      const defaults = parsed.defaults as Record<string, unknown> | undefined;
      if (defaults && Array.isArray(defaults.briefing)) {
        for (const entry of defaults.briefing) {
          if (typeof entry === "string") activeSources.add(entry);
          else if (entry && typeof entry === "object" && "source" in entry) {
            activeSources.add((entry as Record<string, string>).source);
          }
        }
      }
    }
  } catch { /* ignore */ }

  for (const s of catalogStreams) {
    const active = activeSources.has(s.name) ? " [active]" : "";
    console.log(`  ${s.name.padEnd(28)} ${s.description}${active}`);
  }

  if (activeSources.size > 0) {
    console.log(`\n  ${activeSources.size} stream(s) active in domain "${domainId}" defaults.`);
    console.log("  Agents may have additional streams via presets.");
  }
}

export function cmdQuery(db: DatabaseSync, sql: string) {
  try {
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      console.log("(no rows)");
      return;
    }
    // Print as simple table
    const keys = Object.keys(rows[0]!);
    console.log(keys.join("\t"));
    for (const row of rows) {
      console.log(keys.map(k => String(row[k] ?? "")).join("\t"));
    }
  } catch (err) {
    console.error(`SQL error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Visibility Suite ────────────────────────────────────────────────

export function detectAnomalies(db: DatabaseSync, projectId: string, hours: number): string[] {
  const anomalies: string[] = [];
  const since = Date.now() - hours * 3600_000;

  // 1. Agent ran sessions but produced 0 output (low efficiency)
  try {
    const sessions = db.prepare(`
      SELECT sa.agent_id, COUNT(*) as session_count,
             (SELECT COUNT(*) FROM transitions t WHERE t.actor LIKE 'agent:' || sa.agent_id || ':%' AND t.created_at > ?) as transition_count,
             (SELECT COUNT(*) FROM proposals p WHERE p.proposed_by LIKE 'agent:' || sa.agent_id || ':%' AND p.created_at > ?) as proposal_count
      FROM session_archives sa
      WHERE sa.project_id = ? AND sa.started_at > ?
      GROUP BY sa.agent_id
    `).all(since, since, projectId, since) as Array<Record<string, unknown>>;

    for (const s of sessions) {
      const tc = (s.transition_count as number) ?? 0;
      const pc = (s.proposal_count as number) ?? 0;
      const sc = s.session_count as number;
      if (sc >= 2 && tc === 0 && pc === 0) {
        anomalies.push(`${s.agent_id} ran ${sc} sessions but produced 0 transitions and 0 proposals`);
      }
    }
  } catch { /* table may not exist */ }

  // 2. Items stuck in queue for >30min
  try {
    const stuck = db.prepare(`
      SELECT COUNT(*) as cnt FROM dispatch_queue
      WHERE project_id = ? AND status = 'queued' AND created_at < ?
    `).get(projectId, Date.now() - 30 * 60_000) as { cnt: number };

    if (stuck.cnt > 0) {
      anomalies.push(`${stuck.cnt} item(s) stuck in queue for >30min (dispatch may be broken)`);
    }
  } catch { /* ignore */ }

  // 3. Workers haven't run despite assigned tasks
  try {
    const assignedWorkerTasks = db.prepare(`
      SELECT t.assigned_to, COUNT(*) as cnt
      FROM tasks t
      WHERE t.project_id = ? AND t.state IN ('ASSIGNED', 'IN_PROGRESS')
        AND t.assigned_to LIKE '%worker%'
        AND t.updated_at < ?
      GROUP BY t.assigned_to
    `).all(projectId, Date.now() - 60 * 60_000) as Array<Record<string, unknown>>;

    for (const wt of assignedWorkerTasks) {
      anomalies.push(`${wt.assigned_to} has ${wt.cnt} assigned task(s) but hasn't run in >1h`);
    }
  } catch { /* ignore */ }

  // 4. Budget burn rate will exhaust before end of day
  try {
    const budget = db.prepare(
      "SELECT daily_limit_cents, daily_spent_cents, daily_reset_at FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(projectId) as Record<string, number> | undefined;

    if (budget && budget.daily_limit_cents > 0) {
      const remaining = budget.daily_limit_cents - budget.daily_spent_cents;
      const hourCost = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?",
      ).get(projectId, Date.now() - 3600_000) as { cost: number };

      if (hourCost.cost > 0) {
        const hoursLeft = remaining / hourCost.cost;
        const now = new Date();
        const hoursUntilMidnight = 24 - now.getHours() - (now.getMinutes() / 60);
        if (hoursLeft < hoursUntilMidnight && hoursLeft < 4) {
          anomalies.push(`Budget burn rate (${fmt$(hourCost.cost)}/hr) will exhaust in ~${hoursLeft.toFixed(1)}h — before end of day`);
        }
      }
    }
  } catch { /* ignore */ }

  // 5. Lead spawned subagents instead of using workers
  try {
    const leadSubagents = db.prepare(`
      SELECT sa.agent_id, COUNT(*) as cnt
      FROM session_archives sa
      WHERE sa.project_id = ? AND sa.started_at > ?
        AND sa.agent_id LIKE '%lead%'
        AND EXISTS (
          SELECT 1 FROM tool_call_details tc
          WHERE tc.session_key = sa.session_key
            AND tc.tool_name IN ('spawn_subagent', 'Bash')
            AND tc.input LIKE '%agent%'
        )
      GROUP BY sa.agent_id
    `).all(projectId, since) as Array<Record<string, unknown>>;

    for (const ls of leadSubagents) {
      if ((ls.cnt as number) >= 1) {
        anomalies.push(`${ls.agent_id} may be spawning subagents instead of using workers (${ls.cnt} instance(s))`);
      }
    }
  } catch { /* ignore */ }

  // 6. Same task re-assigned multiple times
  try {
    const reassigned = db.prepare(`
      SELECT t.task_id, tk.title, COUNT(*) as cnt
      FROM transitions t
      LEFT JOIN tasks tk ON t.task_id = tk.id
      WHERE t.created_at > ?
        AND t.to_state = 'ASSIGNED'
      GROUP BY t.task_id HAVING cnt >= 3
    `).all(since) as Array<Record<string, unknown>>;

    for (const r of reassigned) {
      const title = r.title ? ` "${truncate(r.title as string, 40)}"` : "";
      anomalies.push(`Task${title} re-assigned ${r.cnt} times — may be bouncing`);
    }
  } catch { /* ignore */ }

  // 7. Agent workload saturation > 3 (overloaded)
  try {
    const saturated = getAgentSaturation(projectId, hours, db);
    for (const s of saturated) {
      if (s.saturation > 3) {
        anomalies.push(`${s.agentId} overloaded: saturation ${s.saturation.toFixed(1)} (assigned: ${s.assignedTasks}, queued: ${s.queuedDispatches}, throughput: ${s.avgCompletedPerHour}/hr)`);
      }
    }
  } catch { /* ignore */ }

  // 8. High failure rate (>30%) for agents with enough data
  try {
    const failures = getFailureRate(projectId, hours * 7, db);
    for (const f of failures) {
      const total = f.doneTasks + f.failedTasks;
      if (total >= 3 && f.failureRatePct > 30) {
        anomalies.push(`${f.agentId} high failure rate: ${f.failureRatePct}% (${f.failedTasks}/${total} tasks failed)`);
      }
    }
  } catch { /* ignore */ }

  // 9. Low session efficiency (<50%) for agents with enough sessions
  try {
    const sessEff = getSessionEfficiency(projectId, hours, db);
    for (const s of sessEff) {
      if (s.totalSessions >= 3 && s.efficiencyPct < 50) {
        anomalies.push(`${s.agentId} low session efficiency: ${s.efficiencyPct}% (${s.productiveSessions}/${s.totalSessions} sessions produced output)`);
      }
    }
  } catch { /* ignore */ }

  return anomalies;
}

export function cmdDashboard(db: DatabaseSync, projectId: string, hours: number, json = false): void {
  const since = Date.now() - hours * 3600_000;

  // Anomaly detection
  const anomalies = detectAnomalies(db, projectId, hours);

  // --- Summary ---
  let totalSessions = 0;
  let totalCostCents = 0;
  try {
    const sessionCount = db.prepare(
      "SELECT COUNT(*) as sessions FROM session_archives WHERE project_id = ? AND started_at > ?"
    ).get(projectId, since) as { sessions: number };
    const costSum = db.prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?"
    ).get(projectId, since) as { cost: number };
    totalSessions = sessionCount.sessions;
    totalCostCents = costSum.cost;
  } catch { /* ignore */ }

  if (json) {
    // Gather all dashboard data for JSON
    let activeAgents: Array<Record<string, unknown>> = [];
    try {
      activeAgents = db.prepare(`
        SELECT sa.agent_id,
               COUNT(*) as sessions,
               COALESCE(MAX(ac.cost), 0) as cost,
               MAX(sa.started_at) as last_active,
               SUM(sa.tool_call_count) as tool_calls
        FROM session_archives sa
        LEFT JOIN (SELECT agent_id, SUM(cost_cents) as cost FROM cost_records WHERE project_id = ? AND created_at > ? GROUP BY agent_id) ac ON ac.agent_id = sa.agent_id
        WHERE sa.project_id = ? AND sa.started_at > ?
        GROUP BY sa.agent_id ORDER BY last_active DESC
      `).all(projectId, since, projectId, since) as Array<Record<string, unknown>>;
    } catch { /* ignore */ }

    let pendingProposals: Array<Record<string, unknown>> = [];
    try {
      pendingProposals = db.prepare(
        "SELECT id, title, proposed_by, created_at, origin FROM proposals WHERE project_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 10",
      ).all(projectId, since) as Array<Record<string, unknown>>;
    } catch { /* ignore */ }

    let queueCounts: Array<{ status: string; cnt: number }> = [];
    try {
      queueCounts = db.prepare(
        "SELECT status, COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? GROUP BY status",
      ).all(projectId) as Array<{ status: string; cnt: number }>;
    } catch { /* ignore */ }

    let budget: Record<string, number> | undefined;
    try {
      budget = db.prepare(
        "SELECT daily_limit_cents, daily_spent_cents, monthly_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
      ).get(projectId) as Record<string, number> | undefined;
    } catch { /* ignore */ }

    const taskCounts = db.prepare(
      "SELECT state, COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED') GROUP BY state",
    ).all(projectId) as Array<{ state: string; cnt: number }>;

    console.log(JSON.stringify({
      hours,
      total_sessions: totalSessions,
      total_cost_cents: totalCostCents,
      anomalies,
      agents: activeAgents,
      pending_proposals: pendingProposals,
      queue: Object.fromEntries(queueCounts.map(r => [r.status, r.cnt])),
      budget: budget ?? null,
      active_tasks: Object.fromEntries(taskCounts.map(r => [r.state, r.cnt])),
    }, null, 2));
    return;
  }

  // Formatted output
  if (anomalies.length > 0) {
    console.log("## Anomalies\n");
    for (const a of anomalies) {
      console.log(`  \u26A0\uFE0F  ${a}`);
    }
    console.log("");
  }

  console.log(`## Dashboard (last ${hours}h)  |  ${totalSessions} sessions  |  ${fmt$(totalCostCents)} total cost\n`);

  // --- Agent Status ---
  console.log("## Agent Status\n");
  try {
    // Get agents with sessions in the window; costs from cost_records directly by agent_id to avoid session_key duplication
    const activeAgents = db.prepare(`
      SELECT sa.agent_id,
             COUNT(*) as sessions,
             COALESCE(MAX(ac.cost), 0) as cost,
             MAX(sa.started_at) as last_active,
             SUM(sa.tool_call_count) as tool_calls
      FROM session_archives sa
      LEFT JOIN (SELECT agent_id, SUM(cost_cents) as cost FROM cost_records WHERE project_id = ? AND created_at > ? GROUP BY agent_id) ac ON ac.agent_id = sa.agent_id
      WHERE sa.project_id = ? AND sa.started_at > ?
      GROUP BY sa.agent_id ORDER BY last_active DESC
    `).all(projectId, since, projectId, since) as Array<Record<string, unknown>>;

    const activeAgentIds = new Set(activeAgents.map(a => a.agent_id as string));

    // Show active agents
    for (const a of activeAgents) {
      const lastAge = fmtAgo(a.last_active as number);
      console.log(`  ${pad(a.agent_id as string, 20)} ${(a.sessions as number).toString().padStart(3)} sessions  ${fmt$(a.cost as number).padStart(8)}  ${(a.tool_calls as number).toString().padStart(4)} tools  last: ${lastAge}`);
    }

    // Show configured agents that had no sessions (idle)
    const configuredAgents = loadDomainAgents(projectId);
    const idleAgents = configuredAgents.filter(a => !activeAgentIds.has(a));
    for (const agent of idleAgents) {
      console.log(`  ${pad(agent, 20)}   — idle (no sessions in window)`);
    }

    if (activeAgents.length === 0 && idleAgents.length === 0) {
      console.log("  No agent activity.\n");
    } else {
      console.log("");
    }
  } catch {
    console.log("  (session_archives table not available)\n");
  }

  // --- Pending Proposals ---
  console.log("## Pending Proposals\n");
  try {
    const proposals = db.prepare(
      "SELECT id, title, proposed_by, created_at, origin FROM proposals WHERE project_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 10",
    ).all(projectId, since) as Array<Record<string, unknown>>;

    if (proposals.length === 0) {
      console.log("  None.\n");
    } else {
      for (const p of proposals) {
        const age = fmtAgo(p.created_at as number);
        const origin = p.origin ? ` [${p.origin}]` : "";
        const proposer = extractAgentName(p.proposed_by as string);
        console.log(`  ${(p.id as string).slice(0, 8)}  ${truncate(p.title as string, 50).padEnd(52)} by ${proposer}${origin}  ${age}`);
      }
      console.log("");
    }
  } catch {
    console.log("  (proposals table not available)\n");
  }

  // --- Queue Health ---
  console.log("## Queue Health\n");
  try {
    const queueCounts = db.prepare(
      "SELECT status, COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? GROUP BY status",
    ).all(projectId) as Array<{ status: string; cnt: number }>;

    if (queueCounts.length === 0) {
      console.log("  Empty.\n");
    } else {
      const parts = queueCounts.map(r => `${r.status}: ${r.cnt}`);
      console.log(`  ${parts.join("  |  ")}\n`);
    }
  } catch {
    console.log("  (dispatch_queue not available)\n");
  }

  // --- Recent Transitions ---
  console.log("## Recent Transitions\n");
  try {
    const transitions = db.prepare(`
      SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor,
             t.created_at as ts
      FROM transitions t LEFT JOIN tasks tk ON t.task_id = tk.id
      WHERE t.created_at > ?
      ORDER BY t.created_at DESC LIMIT 8
    `).all(since) as Array<Record<string, unknown>>;

    if (transitions.length === 0) {
      console.log("  None.\n");
    } else {
      for (const r of transitions) {
        const title = r.title ? ` "${truncate(r.title as string, 35)}"` : "";
        const actorName = extractAgentName(r.actor as string);
        console.log(`  ${fmtTime(r.ts as number)}  ${r.from_state} \u2192 ${r.to_state}  by ${actorName}${title}`);
      }
      console.log("");
    }
  } catch {
    console.log("  (transitions not available)\n");
  }

  // --- Budget Pacing ---
  console.log("## Budget\n");
  try {
    const budget = db.prepare(
      "SELECT daily_limit_cents, daily_spent_cents, monthly_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(projectId) as Record<string, number> | undefined;

    if (!budget) {
      console.log("  Not configured.\n");
    } else {
      const pct = budget.daily_limit_cents > 0 ? Math.round((budget.daily_spent_cents / budget.daily_limit_cents) * 100) : 0;
      const remaining = Math.max(0, budget.daily_limit_cents - budget.daily_spent_cents);

      const hourCost = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?",
      ).get(projectId, Date.now() - 3600_000) as { cost: number };

      const burnRate = hourCost.cost;
      const hoursLeft = burnRate > 0 ? (remaining / burnRate).toFixed(1) : "\u221E";

      // Compute pacing status
      const now = new Date();
      const hoursUntilMidnight = 24 - now.getHours() - (now.getMinutes() / 60);
      const reserve = Math.round(remaining * 0.2);
      const allocatable = remaining - reserve;
      const hourlyTarget = hoursUntilMidnight > 0 ? Math.round(allocatable / hoursUntilMidnight) : 0;
      const pctRemaining = budget.daily_limit_cents > 0 ? (remaining / budget.daily_limit_cents) * 100 : 0;

      let pacingStatus: string;
      if (pctRemaining <= 5) {
        pacingStatus = `CRITICAL (${pctRemaining.toFixed(1)}% remaining)`;
      } else if (pctRemaining <= 10) {
        pacingStatus = `LOW (${pctRemaining.toFixed(1)}% remaining)`;
      } else if (burnRate > hourlyTarget && hourlyTarget > 0) {
        pacingStatus = `THROTTLED (${fmt$(burnRate)}/hr vs ${fmt$(hourlyTarget)}/hr target)`;
      } else {
        pacingStatus = `Normal (${pctRemaining.toFixed(1)}% remaining)`;
      }

      console.log(`  Daily:  ${fmt$(budget.daily_spent_cents)} / ${fmt$(budget.daily_limit_cents)} (${pct}%)  |  Remaining: ${fmt$(remaining)}`);
      console.log(`  Burn:   ${fmt$(burnRate)}/hr  |  Hours left: ${hoursLeft}  |  Pacing: ${pacingStatus}`);
      if (budget.monthly_spent_cents > 0) {
        console.log(`  Monthly: ${fmt$(budget.monthly_spent_cents)}`);
      }
      console.log("");
    }
  } catch {
    console.log("  (budget data not available)\n");
  }

  // Summary line — active tasks + throughput
  const taskCounts = db.prepare(
    "SELECT state, COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED') GROUP BY state",
  ).all(projectId) as Array<{ state: string; cnt: number }>;
  const taskSummary = taskCounts.map(r => `${r.state}: ${r.cnt}`).join(", ");

  // Count tasks completed within the window (via transitions to DONE)
  let doneCount = 0;
  try {
    const done = db.prepare(
      "SELECT COUNT(DISTINCT task_id) as cnt FROM transitions WHERE to_state = 'DONE' AND created_at > ?",
    ).get(since) as { cnt: number };
    doneCount = done.cnt;
  } catch { /* ignore */ }

  const throughput = doneCount > 0 ? `  |  DONE (last ${hours}h): ${doneCount}` : "";
  if (taskSummary || doneCount > 0) {
    console.log(`Active tasks: ${taskSummary || "none"}${throughput}`);
  }
}

export function cmdSessions(db: DatabaseSync, projectId: string, hours: number, agentFilter?: string, json = false): void {
  const since = Date.now() - hours * 3600_000;

  let sql = `
    SELECT sa.session_key, sa.agent_id, sa.started_at, sa.duration_ms,
           sa.tool_call_count, sa.outcome, sa.task_id,
           (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_records WHERE session_key = sa.session_key AND project_id = ? AND created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as session_cost,
           (SELECT COUNT(*) FROM transitions t WHERE t.actor = sa.session_key AND t.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as transitions,
           (SELECT COUNT(*) FROM proposals p WHERE p.proposed_by = sa.session_key AND p.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as proposals
    FROM session_archives sa
    WHERE sa.project_id = ? AND sa.started_at > ?
  `;
  const params: (string | number)[] = [projectId, Date.now(), Date.now(), Date.now(), projectId, since];

  if (agentFilter) {
    sql += " AND sa.agent_id = ?";
    params.push(agentFilter);
  }
  sql += " ORDER BY sa.started_at DESC LIMIT 50";

  const sessions = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  if (json) {
    console.log(JSON.stringify({ hours, agent_filter: agentFilter ?? null, sessions }, null, 2));
    return;
  }

  console.log(`## Sessions (last ${hours}h${agentFilter ? `, agent: ${agentFilter}` : ""})\n`);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const s of sessions) {
    const parsed = parseSessionKey(s.session_key as string);
    const displayName = `${parsed.agent} (${parsed.type})`;
    const duration = s.duration_ms ? fmtAge(s.duration_ms as number) : "?";
    const tools = s.tool_call_count ?? 0;
    const cost = fmt$(s.session_cost as number);
    const trans = s.transitions as number;
    const props = s.proposals as number;
    const started = fmtTime(s.started_at as number);
    const produced: string[] = [];
    if (trans > 0) produced.push(`${trans} transitions`);
    if (props > 0) produced.push(`${props} proposals`);
    const output = produced.length > 0 ? produced.join(", ") : "no output";

    console.log(`  ${pad(displayName, 22)} ${started}  ${duration.padStart(6)}  ${(tools as number).toString().padStart(3)} tools  ${cost.padStart(7)}  ${output}`);
  }
}

export function cmdSessionDetail(db: DatabaseSync, projectId: string, sessionKey: string): void {
  // Find matching session
  const session = db.prepare(`
    SELECT * FROM session_archives WHERE project_id = ? AND session_key LIKE ?
    ORDER BY started_at DESC LIMIT 1
  `).get(projectId, `${sessionKey}%`) as Record<string, unknown> | undefined;

  if (!session) {
    console.error(`No session found matching "${sessionKey}"`);
    process.exit(2);
  }

  const fullKey = session.session_key as string;
  const parsedKey = parseSessionKey(fullKey);
  console.log(`## Session: ${parsedKey.agent} (${parsedKey.type})\n`);
  console.log(`  Agent:      ${session.agent_id}`);
  console.log(`  Outcome:    ${session.outcome}`);
  console.log(`  Started:    ${fmtDate(session.started_at as number)}`);
  if (session.ended_at) console.log(`  Ended:      ${fmtDate(session.ended_at as number)}`);
  if (session.duration_ms) console.log(`  Duration:   ${fmtAge(session.duration_ms as number)}`);
  console.log(`  Cost:       ${fmt$(session.total_cost_cents as number)}`);
  console.log(`  Tool calls: ${session.tool_call_count}`);
  if (session.model) console.log(`  Model:      ${session.model}`);
  if (session.task_id) console.log(`  Task:       ${(session.task_id as string).slice(0, 8)}`);
  console.log("");

  // Tool call sequence
  const toolCalls = db.prepare(`
    SELECT tool_name, action, sequence_number, duration_ms, success, error_message, created_at
    FROM tool_call_details
    WHERE session_key = ? AND project_id = ?
    ORDER BY sequence_number
  `).all(fullKey, projectId) as Array<Record<string, unknown>>;

  if (toolCalls.length > 0) {
    console.log("  Tool Call Sequence:");
    for (const tc of toolCalls) {
      const actionStr = tc.action ? `:${tc.action}` : "";
      const durStr = tc.duration_ms ? `${tc.duration_ms}ms` : "";
      const status = (tc.success as number) ? "\u2713" : `\u2717 ${tc.error_message ?? ""}`;
      console.log(`    ${(tc.sequence_number as number).toString().padStart(3)}. ${fmtTime(tc.created_at as number)}  ${tc.tool_name}${actionStr}  ${durStr.padStart(6)}  ${status}`);
    }
    console.log("");
  }

  // Transitions during session
  const startedAt = session.started_at as number;
  const endedAt = (session.ended_at as number) ?? Date.now();
  const transitions = db.prepare(`
    SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor, t.created_at
    FROM transitions t LEFT JOIN tasks tk ON t.task_id = tk.id
    WHERE t.actor = ? AND t.created_at BETWEEN ? AND ?
    ORDER BY t.created_at
  `).all(fullKey, startedAt, endedAt) as Array<Record<string, unknown>>;

  if (transitions.length > 0) {
    console.log("  Transitions:");
    for (const tr of transitions) {
      const title = tr.title ? ` "${truncate(tr.title as string, 35)}"` : "";
      console.log(`    ${fmtTime(tr.created_at as number)}  ${tr.from_state} \u2192 ${tr.to_state}${title}`);
    }
    console.log("");
  }

  // Proposals during session
  const proposals = db.prepare(`
    SELECT id, title, status, risk_tier, created_at
    FROM proposals
    WHERE proposed_by = ? AND project_id = ? AND created_at BETWEEN ? AND ?
    ORDER BY created_at
  `).all(fullKey, projectId, startedAt, endedAt) as Array<Record<string, unknown>>;

  if (proposals.length > 0) {
    console.log("  Proposals Created:");
    for (const p of proposals) {
      const risk = p.risk_tier ? ` [${p.risk_tier}]` : "";
      console.log(`    ${(p.id as string).slice(0, 8)}  ${p.status}  "${truncate(p.title as string, 40)}"${risk}`);
    }
    console.log("");
  }

  // Cost breakdown — scoped to session time window to avoid counting costs from other runs of the same session_key
  const costRecords = db.prepare(`
    SELECT model, SUM(cost_cents) as cost, SUM(input_tokens) as input_tok,
           SUM(output_tokens) as output_tok, SUM(cache_read_tokens) as cache_read,
           COUNT(*) as calls
    FROM cost_records
    WHERE session_key = ? AND project_id = ? AND created_at BETWEEN ? AND ?
    GROUP BY model
  `).all(fullKey, projectId, startedAt, endedAt) as Array<Record<string, unknown>>;

  if (costRecords.length > 0) {
    console.log("  Cost Breakdown:");
    for (const c of costRecords) {
      console.log(`    ${c.model}: ${fmt$(c.cost as number)}  (${c.calls} calls, ${c.output_tok} output tok, ${c.cache_read} cache read)`);
    }
    console.log("");
  }

  // Subagent spawns (sessions with matching parent pattern)
  try {
    const subagents = db.prepare(`
      SELECT session_key, agent_id, started_at, total_cost_cents, outcome
      FROM session_archives
      WHERE project_id = ? AND session_key LIKE ? AND session_key != ?
      ORDER BY started_at
    `).all(projectId, `${fullKey.split("-").slice(0, 3).join("-")}%`, fullKey) as Array<Record<string, unknown>>;

    if (subagents.length > 0) {
      console.log("  Subagent Sessions:");
      for (const sa of subagents) {
        const subParsed = parseSessionKey(sa.session_key as string);
        console.log(`    ${subParsed.agent} (${subParsed.type})  ${fmt$(sa.total_cost_cents as number)}  ${sa.outcome}`);
      }
    }
  } catch { /* ignore */ }
}

export function cmdProposals(db: DatabaseSync, projectId: string, statusFilter: string, hours?: number, json = false): void {
  let where = "WHERE project_id = ?";
  const params: (string | number)[] = [projectId];

  if (statusFilter && statusFilter !== "all") {
    where += " AND status = ?";
    params.push(statusFilter);
  }

  if (hours) {
    const since = Date.now() - hours * 3600_000;
    where += " AND created_at > ?";
    params.push(since);
  }

  const proposals = db.prepare(`
    SELECT id, title, proposed_by, status, origin, reasoning, created_at, resolved_at
    FROM proposals ${where}
    ORDER BY created_at DESC LIMIT 50
  `).all(...params) as Array<Record<string, unknown>>;

  if (json) {
    console.log(JSON.stringify({ status_filter: statusFilter, hours: hours ?? null, proposals }, null, 2));
    return;
  }

  console.log(`## Proposals (${statusFilter || "all"}${hours ? `, last ${hours}h` : ""})\n`);

  if (proposals.length === 0) {
    console.log("No proposals found.");
    return;
  }

  for (const p of proposals) {
    const id = (p.id as string).slice(0, 8);
    const title = truncate(p.title as string, 45);
    const origin = p.origin ? `[${p.origin}]` : "";
    const age = fmtAgo(p.created_at as number);
    const reasoning = p.reasoning ? `  ${truncate(p.reasoning as string, 80)}` : "";
    const proposer = extractAgentName(p.proposed_by as string);
    console.log(`  ${id}  ${p.status?.toString().padEnd(10)}  ${title.padEnd(47)} by ${proposer}  ${origin.padEnd(12)} ${age}`);
    if (reasoning) {
      console.log(`           ${reasoning}`);
    }
  }
}

export function cmdFlows(db: DatabaseSync, projectId: string, hours: number, agentFilter?: string, expand?: boolean): void {
  const since = Date.now() - hours * 3600_000;

  let sql = `
    SELECT sa.session_key, sa.agent_id, sa.started_at, sa.ended_at, sa.duration_ms,
           (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_records WHERE session_key = sa.session_key AND project_id = ? AND created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as session_cost,
           sa.outcome, sa.tool_call_count,
           (SELECT COUNT(*) FROM transitions t WHERE t.actor = sa.session_key AND t.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as transitions,
           (SELECT COUNT(*) FROM proposals p WHERE p.proposed_by = sa.session_key AND p.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as proposals
    FROM session_archives sa
    WHERE sa.project_id = ? AND sa.started_at > ?
  `;
  const params: (string | number)[] = [projectId, Date.now(), Date.now(), Date.now(), projectId, since];

  if (agentFilter) {
    sql += " AND sa.agent_id = ?";
    params.push(agentFilter);
  }
  sql += " ORDER BY sa.started_at DESC LIMIT 30";

  const sessions = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  console.log(`## Flows (last ${hours}h${agentFilter ? `, agent: ${agentFilter}` : ""})\n`);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const s of sessions) {
    const flowParsed = parseSessionKey(s.session_key as string);
    const displayKey = `${flowParsed.agent} (${flowParsed.type})`;
    const duration = s.duration_ms ? fmtAge(s.duration_ms as number) : "?";
    const startTime = fmtTime(s.started_at as number);
    const cost = fmt$(s.session_cost as number);
    const trans = s.transitions as number;
    const props = s.proposals as number;
    const outputSummary = (trans > 0 || props > 0)
      ? `${trans} transitions, ${props} proposals`
      : "no output";

    console.log(`--- ${displayKey} | ${startTime} | ${duration} | ${cost} | ${outputSummary} ---`);

    if (expand) {
      // Full tool call list
      const toolCalls = db.prepare(`
        SELECT tool_name, action, sequence_number, created_at, duration_ms, success
        FROM tool_call_details
        WHERE session_key = ? AND project_id = ?
        ORDER BY created_at, sequence_number
      `).all(s.session_key as string, projectId) as Array<Record<string, unknown>>;

      for (const tc of toolCalls) {
        const actionStr = tc.action ? `:${tc.action}` : "";
        const status = (tc.success as number) ? "\u2713" : "\u2717";
        console.log(`    ${fmtTime(tc.created_at as number)}  ${status} ${tc.tool_name}${actionStr}`);
      }
    } else {
      // Collapsed: group tool calls by type
      const toolGroups = db.prepare(`
        SELECT tool_name, COUNT(*) as cnt
        FROM tool_call_details
        WHERE session_key = ? AND project_id = ?
        GROUP BY tool_name ORDER BY cnt DESC
      `).all(s.session_key as string, projectId) as Array<{ tool_name: string; cnt: number }>;

      const transitions = db.prepare(`
        SELECT COUNT(*) as cnt FROM transitions
        WHERE actor = ? AND created_at BETWEEN ? AND ?
      `).get(s.session_key as string, s.started_at as number, (s.ended_at as number) ?? Date.now()) as { cnt: number };

      const toolSummary = toolGroups.map(g => `${g.tool_name}(${g.cnt})`).join(" ");
      const transSummary = transitions.cnt > 0 ? ` \u2192 ${transitions.cnt} transitions` : "";
      if (toolSummary || transSummary) {
        console.log(`    ${toolSummary}${transSummary}`);
      }
    }
    console.log("");
  }
}

export function cmdMetrics(db: DatabaseSync, projectId: string, hours: number, json = false): void {
  const since = Date.now() - hours * 3600_000;

  const agents = db.prepare(`
    SELECT sa.agent_id,
           COUNT(*) as sessions,
           COALESCE(MAX(ac.cost), 0) as total_cost,
           AVG(COALESCE(sa.duration_ms, sa.ended_at - sa.started_at)) as avg_duration_ms,
           AVG(sa.tool_call_count) as avg_tool_calls,
           SUM(sa.tool_call_count) as total_tool_calls
    FROM session_archives sa
    LEFT JOIN (SELECT agent_id, SUM(cost_cents) as cost FROM cost_records WHERE project_id = ? AND created_at > ? GROUP BY agent_id) ac ON ac.agent_id = sa.agent_id
    WHERE sa.project_id = ? AND sa.started_at > ?
    GROUP BY sa.agent_id ORDER BY total_cost DESC
  `).all(projectId, since, projectId, since) as Array<Record<string, unknown>>;

  if (json) {
    const metricsData = agents.map(a => {
      const agent = a.agent_id as string;
      const proposalCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM proposals WHERE proposed_by LIKE 'agent:' || ? || ':%' AND project_id = ? AND created_at > ?",
      ).get(agent, projectId, since) as { cnt: number }).cnt;
      const completedTasks = (db.prepare(`
        SELECT COUNT(DISTINCT task_id) as cnt FROM transitions
        WHERE actor LIKE 'agent:' || ? || ':%' AND to_state = 'DONE' AND created_at > ?
      `).get(agent, since) as { cnt: number }).cnt;
      return { ...a, proposals: proposalCount, completed_tasks: completedTasks };
    });
    const operational = {
      saturation: getAgentSaturation(projectId, hours, db),
      queueWaitTime: getQueueWaitTime(projectId, hours, db),
      throughput: getAgentThroughput(projectId, db),
      costEfficiency: getCostEfficiency(projectId, hours, db),
      sessionEfficiency: getSessionEfficiency(projectId, hours, db),
      cycleTime: getTaskCycleTime(projectId, hours * 7, db),
      failureRate: getFailureRate(projectId, hours * 7, db),
      retryRate: getRetryRate(projectId, hours * 7, db),
    };
    console.log(JSON.stringify({ hours, agents: metricsData, operational }, null, 2));
    return;
  }

  console.log(`## Per-Agent Metrics (last ${hours}h)\n`);

  if (agents.length === 0) {
    console.log("No session data available.");
    return;
  }

  for (const a of agents) {
    const agent = a.agent_id as string;
    const sessions = a.sessions as number;
    const totalCost = a.total_cost as number;
    const avgDur = a.avg_duration_ms ? fmtAge(a.avg_duration_ms as number) : "?";
    const avgTools = Math.round(a.avg_tool_calls as number);

    // Proposals created by this agent (actor in proposals is session_key: agent:<name>:<type>:<uuid>)
    const proposalCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM proposals WHERE proposed_by LIKE 'agent:' || ? || ':%' AND project_id = ? AND created_at > ?",
    ).get(agent, projectId, since) as { cnt: number }).cnt;

    // Completed tasks by this agent (actor in transitions is session_key)
    const completedTasks = (db.prepare(`
      SELECT COUNT(DISTINCT task_id) as cnt FROM transitions
      WHERE actor LIKE 'agent:' || ? || ':%' AND to_state = 'DONE' AND created_at > ?
    `).get(agent, since) as { cnt: number }).cnt;

    const costPerProposal = proposalCount > 0 ? fmt$(Math.round(totalCost / proposalCount)) : "n/a";
    const costPerTask = completedTasks > 0 ? fmt$(Math.round(totalCost / completedTasks)) : "n/a";

    console.log(`  ${agent}`);
    console.log(`    Sessions: ${sessions}  |  Total cost: ${fmt$(totalCost)}  |  Avg duration: ${avgDur}`);
    console.log(`    Tools/session: ${avgTools}  |  Cost/proposal: ${costPerProposal} (${proposalCount})  |  Cost/completed task: ${costPerTask} (${completedTasks})`);
    console.log("");
  }

  // --- Operational Metrics ---
  try {
    const saturation = getAgentSaturation(projectId, hours, db);
    if (saturation.length > 0) {
      console.log("## Workload Saturation\n");
      for (const s of saturation) {
        const flag = s.saturation > 3 ? " [OVERLOADED]" : s.saturation > 1.5 ? " [HIGH]" : "";
        console.log(`  ${pad(s.agentId, 20)} saturation: ${s.saturation.toFixed(1)}  (assigned: ${s.assignedTasks}, queued: ${s.queuedDispatches}, avg/hr: ${s.avgCompletedPerHour})${flag}`);
      }
      console.log("");
    }

    const throughput = getAgentThroughput(projectId, db);
    if (throughput.length > 0) {
      console.log("## Throughput (tasks completed)\n");
      for (const t of throughput) {
        console.log(`  ${pad(t.agentId, 20)} 1h: ${t.completedLastHour}  |  4h: ${t.completedLast4Hours}  |  24h: ${t.completedLast24Hours}  |  avg: ${t.avgPerHour}/hr`);
      }
      console.log("");
    }

    const waitTime = getQueueWaitTime(projectId, hours, db);
    if (waitTime.length > 0) {
      console.log("## Queue Wait Time (ASSIGNED -> IN_PROGRESS)\n");
      for (const w of waitTime) {
        console.log(`  ${pad(w.agentId, 20)} avg: ${fmtAge(w.avgWaitMs)}  |  median: ${fmtAge(w.medianWaitMs)}  |  max: ${fmtAge(w.maxWaitMs)}  (${w.sampleCount} samples)`);
      }
      console.log("");
    }

    const sessionEff = getSessionEfficiency(projectId, hours, db);
    if (sessionEff.length > 0) {
      console.log("## Session Efficiency\n");
      for (const s of sessionEff) {
        const flag = s.efficiencyPct < 50 ? " [LOW]" : "";
        console.log(`  ${pad(s.agentId, 20)} ${s.productiveSessions}/${s.totalSessions} productive (${s.efficiencyPct}%)${flag}`);
      }
      console.log("");
    }

    const failureRate = getFailureRate(projectId, hours * 7, db);
    if (failureRate.length > 0) {
      const withFailures = failureRate.filter((f) => f.failedTasks > 0);
      if (withFailures.length > 0) {
        console.log("## Failure Rate\n");
        for (const f of withFailures) {
          const flag = f.failureRatePct > 30 ? " [HIGH]" : "";
          console.log(`  ${pad(f.agentId, 20)} ${f.failedTasks} failed / ${f.doneTasks + f.failedTasks} total (${f.failureRatePct}%)${flag}`);
        }
        console.log("");
      }
    }

    const retryRate = getRetryRate(projectId, hours * 7, db);
    if (retryRate.length > 0) {
      console.log("## Retry Rate\n");
      for (const r of retryRate) {
        console.log(`  ${pad(r.agentId, 20)} ${r.retryCycles} retry cycles across ${r.tasksWithRetries} task(s)`);
      }
      console.log("");
    }

    const cycleTime = getTaskCycleTime(projectId, hours * 7, db);
    if (cycleTime.length > 0) {
      console.log("## Task Cycle Time\n");
      for (const c of cycleTime) {
        const pri = c.priority ?? "?";
        console.log(`  ${pad(c.agentId, 20)} [${pri}]  avg: ${fmtAge(c.avgCycleMs)}  |  min: ${fmtAge(c.minCycleMs)}  |  max: ${fmtAge(c.maxCycleMs)}  (${c.sampleCount} tasks)`);
      }
      console.log("");
    }
  } catch { /* operational metrics are best-effort */ }
}

export function cmdBudget(db: DatabaseSync, projectId: string, json = false): void {
  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents, monthly_spent_cents, daily_reset_at FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as Record<string, number> | undefined;

  if (json) {
    const hourCost = budget ? (db.prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?",
    ).get(projectId, Date.now() - 3600_000) as { cost: number }).cost : 0;
    const agentBudgets = db.prepare(
      "SELECT agent_id, daily_limit_cents, daily_spent_cents, session_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NOT NULL",
    ).all(projectId) as Array<Record<string, unknown>>;
    console.log(JSON.stringify({
      budget: budget ?? null,
      burn_rate_cents_per_hour: hourCost,
      agent_budgets: agentBudgets,
    }, null, 2));
    return;
  }

  console.log("## Budget Pacing\n");

  if (!budget) {
    console.log("No budget configured.");
    return;
  }

  const dailyRemaining = Math.max(0, budget.daily_limit_cents - budget.daily_spent_cents);
  const dailyPct = budget.daily_limit_cents > 0 ? Math.round((budget.daily_spent_cents / budget.daily_limit_cents) * 100) : 0;

  console.log(`  Daily:     ${fmt$(budget.daily_spent_cents)} / ${fmt$(budget.daily_limit_cents)} (${dailyPct}%)`);

  // Hourly burn rate (last hour)
  const hourCost = db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?",
  ).get(projectId, Date.now() - 3600_000) as { cost: number };

  const burnRate = hourCost.cost;
  console.log(`  Burn rate: ${fmt$(burnRate)}/hr`);

  // Hours remaining
  const hoursRemaining = burnRate > 0 ? dailyRemaining / burnRate : Infinity;
  console.log(`  Hours remaining at current rate: ${hoursRemaining === Infinity ? "\u221E" : hoursRemaining.toFixed(1)}`);

  // Monthly
  if (budget.monthly_spent_cents > 0) {
    console.log(`  Monthly:   ${fmt$(budget.monthly_spent_cents)}`);
  }

  // Compute pacing recommendation
  const now = new Date();
  const hoursUntilMidnight = 24 - now.getHours() - (now.getMinutes() / 60);

  try {
    // Use computeBudgetPacing inline (same logic, avoid import issues in CLI context)
    const remaining = dailyRemaining;
    const reserve = Math.round(remaining * 0.2);
    const allocatable = remaining - reserve;
    const hourlyRate = hoursUntilMidnight > 0 ? Math.round(allocatable / hoursUntilMidnight) : 0;
    const pctRemaining = budget.daily_limit_cents > 0 ? (remaining / budget.daily_limit_cents) * 100 : 0;

    console.log("");
    console.log(`  Pacing:`);
    console.log(`    Allocatable: ${fmt$(allocatable)}  |  Reserve: ${fmt$(reserve)}`);
    console.log(`    Target rate: ${fmt$(hourlyRate)}/hr`);

    if (pctRemaining <= 5) {
      console.log(`    Status: CRITICAL (${pctRemaining.toFixed(1)}% remaining) — all dispatch blocked`);
    } else if (pctRemaining <= 10) {
      console.log(`    Status: LOW (${pctRemaining.toFixed(1)}% remaining) — workers blocked, leads allowed`);
    } else if (burnRate > hourlyRate && hourlyRate > 0) {
      console.log(`    Status: THROTTLED (burning ${fmt$(burnRate)}/hr vs ${fmt$(hourlyRate)}/hr target)`);
    } else {
      console.log(`    Status: Normal (${pctRemaining.toFixed(1)}% remaining)`);
    }
  } catch { /* ignore */ }

  // Per-agent budget overrides
  const agentBudgets = db.prepare(
    "SELECT agent_id, daily_limit_cents, daily_spent_cents, session_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NOT NULL",
  ).all(projectId) as Array<Record<string, unknown>>;

  if (agentBudgets.length > 0) {
    console.log("\n  Per-Agent:");
    for (const ab of agentBudgets) {
      const agentPct = (ab.daily_limit_cents as number) > 0
        ? Math.round(((ab.daily_spent_cents as number) / (ab.daily_limit_cents as number)) * 100)
        : 0;
      console.log(`    ${pad(ab.agent_id as string, 20)} ${fmt$(ab.daily_spent_cents as number)} / ${fmt$(ab.daily_limit_cents as number)} (${agentPct}%)  session limit: ${ab.session_limit_cents ? fmt$(ab.session_limit_cents as number) : "none"}`);
    }
  }
}

export function cmdTrust(db: DatabaseSync, projectId: string, json = false): void {
  const LOW_TRUST_THRESHOLD = 0.5;

  // Get all trust scores, then deduplicate by extracted agent name (latest per name)
  const allScores = db.prepare(`
    SELECT agent_id, score, tier, trigger_type, created_at
    FROM trust_score_history
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).all(projectId) as Array<Record<string, unknown>>;

  // Deduplicate: keep latest score per extracted agent name
  const latestByName = new Map<string, Record<string, unknown>>();
  for (const row of allScores) {
    const name = extractAgentName(row.agent_id as string);
    if (!latestByName.has(name)) {
      latestByName.set(name, row);
    }
  }

  // Helper: get recent trust events for an agent
  function getRecentEvents(rawAgentId: string, limit: number): Array<Record<string, unknown>> {
    try {
      return db.prepare(`
        SELECT score, tier, trigger_type, created_at
        FROM trust_score_history
        WHERE project_id = ? AND agent_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(projectId, rawAgentId, limit) as Array<Record<string, unknown>>;
    } catch { return []; }
  }

  if (json) {
    const trustData: Array<Record<string, unknown>> = [];
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const [name, a] of latestByName) {
      const rawAgent = a.agent_id as string;
      const oldScore = db.prepare(`
        SELECT score FROM trust_score_history
        WHERE project_id = ? AND agent_id = ? AND created_at <= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId, rawAgent, dayAgo) as { score: number } | undefined;
      const diff = oldScore ? (a.score as number) - oldScore.score : 0;
      const recentEvents = getRecentEvents(rawAgent, 5);
      const warning = (a.score as number) < LOW_TRUST_THRESHOLD;
      trustData.push({
        agent: name, score: a.score, tier: a.tier, trigger_type: a.trigger_type,
        created_at: a.created_at, trend_24h: diff, warning,
        recent_events: recentEvents.map(e => ({
          score: e.score, trigger_type: e.trigger_type, at: fmtAgo(e.created_at as number),
        })),
      });
    }
    console.log(JSON.stringify({ agents: trustData }, null, 2));
    return;
  }

  console.log("## Trust Overview\n");

  if (allScores.length === 0) {
    console.log("  No trust history recorded.");
    return;
  }

  const dayAgo = Date.now() - 24 * 3600_000;

  for (const [name, a] of latestByName) {
    const rawAgent = a.agent_id as string;
    const scoreNum = a.score as number;
    const score = scoreNum.toFixed(2);
    const tier = a.tier as string;
    const lastChange = fmtAgo(a.created_at as number);
    const trigger = a.trigger_type as string;

    // Trend: compare to 24h ago (match any agent_id that maps to this name)
    const oldScore = db.prepare(`
      SELECT score FROM trust_score_history
      WHERE project_id = ? AND agent_id = ? AND created_at <= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, rawAgent, dayAgo) as { score: number } | undefined;

    let trend = "stable";
    if (oldScore) {
      const diff = scoreNum - oldScore.score;
      if (diff > 0.05) trend = `\u2191 up (+${diff.toFixed(2)})`;
      else if (diff < -0.05) trend = `\u2193 down (${diff.toFixed(2)})`;
    }

    const warning = scoreNum < LOW_TRUST_THRESHOLD ? "  !! LOW TRUST" : "";
    console.log(`  ${pad(name, 20)} score: ${score}  tier: ${pad(tier, 12)} last change: ${lastChange} (${trigger})  trend: ${trend}${warning}`);

    // Show recent trust-affecting events (last 5)
    const recentEvents = getRecentEvents(rawAgent, 5);
    if (recentEvents.length > 1) { // skip if only the current score entry
      // Show events after the first (current) one
      const past = recentEvents.slice(1);
      for (const ev of past) {
        const evScore = (ev.score as number).toFixed(2);
        const evTrigger = ev.trigger_type as string;
        const evAge = fmtAgo(ev.created_at as number);
        console.log(`    ${evAge.padEnd(14)} ${evTrigger.padEnd(24)} score: ${evScore}`);
      }
    }
  }
}

export function cmdInbox(db: DatabaseSync, projectId: string, opts?: { agent?: string; unread?: boolean; expand?: boolean }): void {
  console.log("## Inbox\n");

  // Build query with optional filters
  let where = "project_id = ? AND (to_agent = 'user' OR from_agent = 'user')";
  const params: (string | number)[] = [projectId];

  if (opts?.agent) {
    where += " AND (from_agent = ? OR to_agent = ?)";
    params.push(opts.agent, opts.agent);
  }

  if (opts?.unread) {
    where += " AND read_at IS NULL";
  }

  const messages = db.prepare(`
    SELECT id, from_agent, to_agent, content, status, created_at, read_at, type
    FROM messages
    WHERE ${where}
    ORDER BY created_at DESC LIMIT 30
  `).all(...params) as Array<Record<string, unknown>>;

  if (messages.length === 0) {
    const filterDesc = opts?.agent ? ` for ${opts.agent}` : "";
    const unreadDesc = opts?.unread ? " (unread only)" : "";
    console.log(`  No messages${filterDesc}${unreadDesc}.`);
    return;
  }

  for (const m of messages) {
    const direction = (m.from_agent as string) === "user" ? "\u2192" : "\u2190";
    const other = (m.from_agent as string) === "user" ? m.to_agent : m.from_agent;
    const age = fmtAgo(m.created_at as number);
    const readStatus = m.read_at ? "" : " [unread]";

    if (opts?.expand) {
      console.log(`  ${direction} ${other as string} (${age})${readStatus}`);
      console.log(`    ${m.content as string}`);
      console.log("");
    } else {
      const preview = truncate(m.content as string, 60);
      console.log(`  ${direction} ${pad(other as string, 18)} ${preview.padEnd(62)} ${age}${readStatus}`);
    }
  }
}

export function cmdApprove(db: DatabaseSync, projectId: string, proposalId: string): void {
  // Find proposal by prefix
  const proposal = db.prepare(
    "SELECT id, title, status FROM proposals WHERE project_id = ? AND id LIKE ?",
  ).get(projectId, `${proposalId}%`) as Record<string, unknown> | undefined;

  if (!proposal) {
    console.error(`No proposal found matching "${proposalId}"`);
    process.exit(2);
  }

  if (proposal.status !== "pending") {
    console.error(`Proposal "${(proposal.id as string).slice(0, 8)}" is already ${proposal.status}`);
    process.exit(2);
  }

  const now = Date.now();
  db.prepare(
    "UPDATE proposals SET status = 'approved', user_feedback = ?, resolved_at = ? WHERE id = ?",
  ).run("Approved via CLI", now, proposal.id as string);

  // Emit approval event
  try {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
      VALUES (?, ?, 'proposal_approved', 'cli', ?, ?, 'pending', ?)
    `).run(id, projectId, JSON.stringify({ proposalId: proposal.id }), `proposal-approved:${proposal.id as string}`, now);
  } catch { /* ignore */ }

  console.log(`Approved: "${truncate(proposal.title as string, 60)}" (${(proposal.id as string).slice(0, 8)})`);
}

export function cmdReject(db: DatabaseSync, projectId: string, proposalId: string, feedback?: string): void {
  const proposal = db.prepare(
    "SELECT id, title, status FROM proposals WHERE project_id = ? AND id LIKE ?",
  ).get(projectId, `${proposalId}%`) as Record<string, unknown> | undefined;

  if (!proposal) {
    console.error(`No proposal found matching "${proposalId}"`);
    process.exit(2);
  }

  if (proposal.status !== "pending") {
    console.error(`Proposal "${(proposal.id as string).slice(0, 8)}" is already ${proposal.status}`);
    process.exit(2);
  }

  const now = Date.now();
  db.prepare(
    "UPDATE proposals SET status = 'rejected', user_feedback = ?, resolved_at = ? WHERE id = ?",
  ).run(feedback ?? "Rejected via CLI", now, proposal.id as string);

  // Emit rejection event
  try {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
      VALUES (?, ?, 'proposal_rejected', 'cli', ?, ?, 'pending', ?)
    `).run(id, projectId, JSON.stringify({ proposalId: proposal.id as string, feedback }), `proposal-rejected:${proposal.id as string}`, now);
  } catch { /* ignore */ }

  console.log(`Rejected: "${truncate(proposal.title as string, 60)}" (${(proposal.id as string).slice(0, 8)})`);
  if (feedback) console.log(`Feedback: ${feedback}`);
}

export function cmdMessage(db: DatabaseSync, projectId: string, toAgent: string, content: string): void {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO messages (id, from_agent, to_agent, project_id, type, priority, content, status, created_at)
    VALUES (?, 'user', ?, ?, 'direct', 'normal', ?, 'queued', ?)
  `).run(id, toAgent, projectId, content, now);

  // Emit user_message event
  try {
    const eventId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
      VALUES (?, ?, 'user_message', 'cli', ?, ?, 'pending', ?)
    `).run(eventId, projectId, JSON.stringify({ messageId: id, toAgent, content }), `user-msg:${id}`, now);
  } catch { /* ignore */ }

  console.log(`Message sent to ${toAgent}: "${truncate(content, 60)}"`);
}

export function cmdReplay(db: DatabaseSync, projectId: string, sessionKey: string): void {
  // Find matching session
  const session = db.prepare(`
    SELECT session_key, agent_id, started_at, ended_at, outcome
    FROM session_archives WHERE project_id = ? AND session_key LIKE ?
    ORDER BY started_at DESC LIMIT 1
  `).get(projectId, `${sessionKey}%`) as Record<string, unknown> | undefined;

  if (!session) {
    console.error(`No session found matching "${sessionKey}"`);
    process.exit(2);
  }

  const fullKey = session.session_key as string;
  const replayParsed = parseSessionKey(fullKey);
  console.log(`## Replay: ${replayParsed.agent} (${replayParsed.type})\n`);
  console.log(`  Started: ${fmtDate(session.started_at as number)}  Outcome: ${session.outcome}\n`);

  const toolCalls = db.prepare(`
    SELECT tool_name, action, input, output, sequence_number, duration_ms,
           success, error_message, created_at
    FROM tool_call_details
    WHERE session_key = ? AND project_id = ?
    ORDER BY sequence_number
  `).all(fullKey, projectId) as Array<Record<string, unknown>>;

  if (toolCalls.length === 0) {
    console.log("  No tool call details recorded for this session.");
    return;
  }

  for (const tc of toolCalls) {
    const seq = (tc.sequence_number as number).toString().padStart(3);
    const time = fmtTime(tc.created_at as number);
    const actionStr = tc.action ? `.${tc.action}` : "";
    const durStr = tc.duration_ms ? `(${tc.duration_ms}ms)` : "";
    const status = (tc.success as number) ? "\u2713" : "\u2717";

    console.log(`  ${seq}. [${time}] ${status} ${tc.tool_name}${actionStr} ${durStr}`);

    // Input (truncated)
    if (tc.input) {
      const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
      console.log(`       Input:  ${truncate(inputStr, 120)}`);
    }

    // Output (truncated)
    if (tc.output) {
      const outputStr = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output);
      console.log(`       Output: ${truncate(outputStr, 120)}`);
    }

    // Error
    if (tc.error_message) {
      console.log(`       Error:  ${truncate(tc.error_message as string, 120)}`);
    }

    console.log("");
  }
}

// ─── Lifecycle commands (DB-backed) ──────────────────────────────────

export function cmdDisable(db: DatabaseSync, projectId: string, args: string[], dryRun = false): void {
  // Check if already disabled
  const existing = db.prepare(
    "SELECT reason, disabled_at, disabled_by FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;

  if (existing) {
    console.log(`Domain "${projectId}" is already disabled.`);
    console.log(`  Reason: ${existing.reason}`);
    console.log(`  Since:  ${fmtDate(existing.disabled_at as number)}`);
    console.log(`  By:     ${existing.disabled_by ?? "unknown"}`);
    return;
  }

  const reason = args.find(a => a.startsWith("--reason="))?.split("=").slice(1).join("=") ?? "Disabled via CLI";

  if (dryRun) {
    console.log(`## Domain Disable [DRY RUN]: ${projectId}\n`);
    console.log(`Would disable with reason: ${reason}`);
    console.log("Effect: New dispatches would be blocked immediately.");
    console.log("Running sessions would finish naturally.");
    return;
  }

  // Insert domain disable via DB
  // crypto imported at top level
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO disabled_scopes (id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by)
    VALUES (?, ?, 'domain', ?, ?, ?, ?)
  `).run(id, projectId, projectId, reason, now, "cli");

  console.log(`## Domain Disabled: ${projectId}\n`);
  console.log(`Reason: ${reason}`);
  console.log("Effect: New dispatches will be blocked immediately.");
  console.log("Running sessions will finish naturally.");
  console.log(`\nTo re-enable: pnpm cf enable`);
}

export function cmdEnable(db: DatabaseSync, projectId: string): void {
  const existing = db.prepare(
    "SELECT reason, disabled_at FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;

  if (!existing) {
    console.log(`Domain "${projectId}" is already enabled.`);

    // Also check emergency stop
    const estop = db.prepare(
      "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
    ).get(projectId) as Record<string, unknown> | undefined;
    if (estop?.value === "true") {
      console.log("\nWARNING: Emergency stop is active. Use 'pnpm cf kill --resume' to clear it.");
    }
    return;
  }

  db.prepare(
    "DELETE FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).run(projectId, projectId);

  const disabledForMs = Date.now() - (existing.disabled_at as number);
  console.log(`## Domain Enabled: ${projectId}\n`);
  console.log(`Was disabled for: ${fmtAge(disabledForMs)}`);
  console.log("Effect: Dispatches will resume on next dispatch loop pass.");
}

export function cmdKill(db: DatabaseSync, projectId: string, args: string[], dryRun = false): void {
  console.log(`## Emergency Stop${dryRun ? " [DRY RUN]" : ""}\n`);

  const reason = args.find(a => a.startsWith("--reason="))?.split("=").slice(1).join("=") ?? "Emergency stop via CLI";

  // 1. Disable domain via DB
  // crypto imported at top level
  const id = crypto.randomUUID();
  const now = Date.now();
  if (dryRun) {
    console.log(`  [DRY RUN] Would disable domain "${projectId}" with reason: EMERGENCY: ${reason}`);
  } else {
    db.prepare(`
      INSERT OR REPLACE INTO disabled_scopes (id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by)
      VALUES (?, ?, 'domain', ?, ?, ?, ?)
    `).run(id, projectId, projectId, `EMERGENCY: ${reason}`, now, "cli:kill");
    console.log("  Domain disabled (DB)");
  }

  // 2. Activate emergency stop flag
  if (dryRun) {
    console.log("  [DRY RUN] Would activate emergency stop flag");
  } else {
    db.prepare(
      "INSERT OR REPLACE INTO project_metadata (project_id, key, value) VALUES (?, 'emergency_stop', 'true')",
    ).run(projectId);
    console.log("  Emergency stop activated");
  }

  // 3. Cancel all queued/leased dispatch items
  if (dryRun) {
    const queuedCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status IN ('queued', 'leased')",
    ).get(projectId) as { cnt: number };
    console.log(`  [DRY RUN] Would cancel ${queuedCount.cnt} queued dispatch item(s)`);
  } else {
    const cancelled = db.prepare(
      "UPDATE dispatch_queue SET status = 'cancelled', last_error = ?, completed_at = ? WHERE project_id = ? AND status IN ('queued', 'leased')",
    ).run(`EMERGENCY: ${reason}`, now, projectId);
    if (cancelled.changes > 0) {
      console.log(`  Cancelled ${cancelled.changes} queued dispatch item(s)`);
    } else {
      console.log("  No queued dispatch items to cancel");
    }
  }

  // 4. Kill active agent sessions via gateway RPC
  // This aborts Claude API streams in-process — no child processes to kill.
  try {
    if (dryRun) {
      let activeCount = 0;
      try {
        const activeSessions = db.prepare(
          "SELECT COUNT(*) as cnt FROM tracked_sessions WHERE project_id = ?",
        ).get(projectId) as { cnt: number };
        activeCount = activeSessions.cnt;
      } catch { /* table may not exist */ }
      console.log(`  [DRY RUN] Would abort ${activeCount} tracked session(s) via gateway`);
    } else {
      const result = execSync(
        `openclaw gateway call clawforce.kill --json --params '${JSON.stringify({ projectId, reason, agents: loadDomainAgents(projectId) })}'`,
        { encoding: "utf-8", timeout: 10_000 },
      ).trim();
      try {
        const parsed = JSON.parse(result);
        if (parsed.killed > 0) {
          console.log(`  Aborted ${parsed.killed} active session(s) via gateway`);
        } else {
          console.log("  No active sessions to abort");
        }
      } catch {
        console.log("  Gateway kill response:", result);
      }
    }
  } catch (err) {
    // Gateway might not be running or method might not be registered
    console.log(`  Gateway kill failed (gateway may not be running): ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: try to kill agent processes by PID
    try {
      const domainAgents = loadDomainAgents(projectId);
      const grepPattern = domainAgents.length > 0
        ? `agent.*(${domainAgents.join("|")})`
        : `agent.*(${projectId.replace(/-dev$/, "")}-)`;
      const pids = execSync(
        `ps aux | grep -E "${grepPattern}" | grep -v grep | awk '{print $2}'`,
        { encoding: "utf-8" },
      ).trim();
      if (pids) {
        for (const pid of pids.split("\n")) {
          try { process.kill(Number(pid), "SIGTERM"); } catch {}
        }
        console.log(`  Fallback: killed ${pids.split("\n").length} process(es) via SIGTERM`);
      }
    } catch { /* no processes found */ }
  }

  console.log(`\n## Emergency Stop Complete\n`);
  console.log("To resume:");
  console.log("  1. pnpm cf enable       (re-enable domain)");
  console.log("  2. pnpm cf kill --resume (clear emergency stop flag)");
}

export function cmdKillResume(db: DatabaseSync, projectId: string): void {
  // Clear emergency stop flag
  const estop = db.prepare(
    "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
  ).get(projectId) as Record<string, unknown> | undefined;

  if (!estop || estop.value !== "true") {
    console.log("Emergency stop is not active.");
    return;
  }

  db.prepare(
    "DELETE FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
  ).run(projectId);

  // Also clear domain disable if it was set by kill
  const domainDisable = db.prepare(
    "SELECT disabled_by FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;
  if (domainDisable?.disabled_by === "cli:kill") {
    db.prepare(
      "DELETE FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
    ).run(projectId, projectId);
    console.log("Emergency stop cleared + domain re-enabled.");
  } else {
    console.log("Emergency stop cleared.");
    if (domainDisable) {
      console.log("NOTE: Domain is still disabled (was disabled separately). Use 'pnpm cf enable' to re-enable.");
    }
  }
  console.log("Dispatches will resume on next dispatch loop pass.");
}

// ─── Running command ─────────────────────────────────────────────────

export function cmdRunning(db: DatabaseSync, projectId: string): void {
  console.log("## Running State\n");

  // 1. Domain disabled?
  const domainDisabled = db.prepare(
    "SELECT reason, disabled_at, disabled_by FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;

  // 2. Emergency stop?
  const estop = db.prepare(
    "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
  ).get(projectId) as Record<string, unknown> | undefined;
  const emergencyStopActive = estop?.value === "true";

  if (emergencyStopActive) {
    console.log("EMERGENCY STOP: ACTIVE");
  }
  if (domainDisabled) {
    console.log(`Domain: DISABLED (${domainDisabled.reason}) since ${fmtDate(domainDisabled.disabled_at as number)}`);
  } else {
    console.log("Domain: enabled");
  }
  console.log("");

  // 3. Active sessions (tracked_sessions where ended_at IS NULL)
  let activeSessions: Array<Record<string, unknown>> = [];
  try {
    activeSessions = db.prepare(`
      SELECT session_key, agent_id, started_at
      FROM tracked_sessions
      WHERE project_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC
    `).all(projectId) as Array<Record<string, unknown>>;
  } catch { /* table may not exist */ }

  console.log(`Active Sessions: ${activeSessions.length}`);
  for (const s of activeSessions.slice(0, 15)) {
    const age = Date.now() - (s.started_at as number);
    console.log(`  ${s.agent_id} (${fmtAge(age)}) key=${(s.session_key as string).slice(0, 20)}...`);
  }
  if (activeSessions.length > 15) {
    console.log(`  ... and ${activeSessions.length - 15} more`);
  }
  console.log("");

  // 4. Disabled agents
  const disabledAgents = db.prepare(
    "SELECT agent_id, reason FROM disabled_agents WHERE project_id = ?",
  ).all(projectId) as Array<Record<string, unknown>>;

  const disabledScopes = db.prepare(
    "SELECT scope_type, scope_value, reason FROM disabled_scopes WHERE project_id = ? AND scope_type != 'domain'",
  ).all(projectId) as Array<Record<string, unknown>>;

  if (disabledAgents.length > 0 || disabledScopes.length > 0) {
    console.log("Disabled:");
    for (const a of disabledAgents) {
      console.log(`  agent: ${a.agent_id} — ${a.reason}`);
    }
    for (const s of disabledScopes) {
      console.log(`  ${s.scope_type}: ${s.scope_value} — ${s.reason}`);
    }
    console.log("");
  }

  // 5. Queue status
  const queueCounts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? GROUP BY status",
  ).all(projectId) as Array<{ status: string; cnt: number }>;
  const queueMap = Object.fromEntries(queueCounts.map(r => [r.status, r.cnt]));

  console.log("Queue:");
  for (const status of ["queued", "leased", "dispatched", "completed", "failed", "cancelled"]) {
    if (queueMap[status]) console.log(`  ${status.padEnd(14)} ${queueMap[status]}`);
  }
  if (queueCounts.length === 0) console.log("  (empty)");
  console.log("");

  // 6. Recent transitions (last 5 minutes)
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const recentTransitions = db.prepare(`
    SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor,
           datetime(t.created_at/1000, 'unixepoch') as ts
    FROM transitions t LEFT JOIN tasks tk ON t.task_id = tk.id
    WHERE t.created_at > ?
    ORDER BY t.created_at DESC LIMIT 10
  `).all(fiveMinAgo) as Array<Record<string, unknown>>;

  if (recentTransitions.length > 0) {
    console.log("Recent transitions (5min):");
    for (const r of recentTransitions) {
      const title = r.title ? ` "${(r.title as string).slice(0, 35)}"` : "";
      console.log(`  ${r.ts} ${r.from_state} -> ${r.to_state}${title}`);
    }
    console.log("");
  }

  // 7. Active dispatches (dispatched items)
  const activeDispatches = db.prepare(`
    SELECT dq.task_id, t.title, dq.status, datetime(dq.created_at/1000, 'unixepoch') as created
    FROM dispatch_queue dq LEFT JOIN tasks t ON dq.task_id = t.id
    WHERE dq.project_id = ? AND dq.status IN ('leased', 'dispatched')
    ORDER BY dq.created_at DESC LIMIT 10
  `).all(projectId) as Array<Record<string, unknown>>;

  if (activeDispatches.length > 0) {
    console.log("Active dispatches:");
    for (const d of activeDispatches) {
      const title = d.title ? ` "${(d.title as string).slice(0, 40)}"` : "";
      console.log(`  [${d.status}] ${d.created}${title}`);
    }
    console.log("");
  }

  // 8. Cron metadata
  try {
    const cronRows = db.prepare(
      "SELECT key, value FROM project_metadata WHERE project_id = ? AND key LIKE 'cron_%'",
    ).all(projectId) as Array<Record<string, unknown>>;
    if (cronRows.length > 0) {
      console.log("Cron metadata:");
      for (const r of cronRows) {
        console.log(`  ${r.key}: ${(r.value as string).slice(0, 60)}`);
      }
    }
  } catch { /* ignore */ }
}

// ─── Health command ──────────────────────────────────────────────────

export function cmdHealth(db: DatabaseSync, projectId: string): void {
  console.log("## Health Check\n");

  let issues = 0;

  // 1. Gateway running?
  let gatewayPid = "down";
  try {
    const ps = execSync("ps aux | grep openclaw-gateway | grep -v grep", { encoding: "utf8" }).trim();
    const match = ps.match(/\S+\s+(\d+)/);
    if (match) gatewayPid = match[1]!;
  } catch { /* not running */ }
  const gwStatus = gatewayPid === "down" ? "DOWN" : `running (PID ${gatewayPid})`;
  console.log(`Gateway:          ${gwStatus}`);
  if (gatewayPid === "down") issues++;

  // 2. Domain enabled/disabled?
  const domainDisabled = db.prepare(
    "SELECT reason FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?",
  ).get(projectId, projectId) as Record<string, unknown> | undefined;
  console.log(`Domain:           ${domainDisabled ? `DISABLED (${domainDisabled.reason})` : "enabled"}`);
  if (domainDisabled) issues++;

  // 3. Emergency stop?
  const estop = db.prepare(
    "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
  ).get(projectId) as Record<string, unknown> | undefined;
  const emergencyStop = estop?.value === "true";
  console.log(`Emergency stop:   ${emergencyStop ? "ACTIVE" : "off"}`);
  if (emergencyStop) issues++;

  // 4. Disabled agents/teams/departments
  const disabledCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM disabled_agents WHERE project_id = ?",
  ).get(projectId) as { cnt: number };
  const disabledScopeCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM disabled_scopes WHERE project_id = ? AND scope_type != 'domain'",
  ).get(projectId) as { cnt: number };
  const totalDisabled = disabledCount.cnt + disabledScopeCount.cnt;
  console.log(`Disabled scopes:  ${totalDisabled > 0 ? `${totalDisabled} (agents/teams/departments)` : "none"}`);

  // 5. Queue health
  const queueCounts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? GROUP BY status",
  ).all(projectId) as Array<{ status: string; cnt: number }>;
  const queueMap = Object.fromEntries(queueCounts.map(r => [r.status, r.cnt]));
  const queued = queueMap["queued"] ?? 0;
  const failed = queueMap["failed"] ?? 0;
  const completed = queueMap["completed"] ?? 0;
  const total = queued + failed + completed + (queueMap["leased"] ?? 0) + (queueMap["dispatched"] ?? 0) + (queueMap["cancelled"] ?? 0);
  const failRate = total > 0 ? Math.round((failed / total) * 100) : 0;
  console.log(`Queue:            ${queued} queued, ${failed} failed (${failRate}% fail rate)`);
  if (failRate > 50) issues++;

  // Stuck items (queued for more than 30 minutes)
  const stuckItems = db.prepare(
    "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'queued' AND created_at < ?",
  ).get(projectId, Date.now() - 30 * 60_000) as { cnt: number };
  if (stuckItems.cnt > 0) {
    console.log(`Stuck items:      ${stuckItems.cnt} (queued > 30min)`);
    issues++;
  }

  // 6. Budget status
  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents, monthly_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as Record<string, number> | undefined;
  if (budget) {
    const pct = Math.round((budget.daily_spent_cents / budget.daily_limit_cents) * 100);
    console.log(`Budget:           ${fmt$(budget.daily_spent_cents)} / ${fmt$(budget.daily_limit_cents)} daily (${pct}%)`);
    if (pct >= 90) {
      console.log(`                  WARNING: Budget at ${pct}%`);
      issues++;
    }
  } else {
    console.log("Budget:           not configured");
  }

  // 7. Last activity timestamp
  let lastActivity = "unknown";
  try {
    const lastCost = db.prepare(
      "SELECT MAX(created_at) as ts FROM cost_records WHERE project_id = ?",
    ).get(projectId) as { ts: number | null } | undefined;
    if (lastCost?.ts) {
      const age = Date.now() - lastCost.ts;
      lastActivity = `${fmtDate(lastCost.ts)} (${fmtAge(age)} ago)`;
    }
  } catch { /* ignore */ }
  console.log(`Last activity:    ${lastActivity}`);

  // 8. TypeScript compile status
  let tscStatus = "unknown";
  try {
    execSync("npx tsc --noEmit 2>&1", { encoding: "utf8", cwd: process.cwd() });
    tscStatus = "OK";
  } catch (err) {
    const output = err instanceof Error && "stdout" in err ? (err as { stdout: string }).stdout : "";
    const errorCount = (output.match(/error TS/g) ?? []).length;
    tscStatus = `${errorCount} error(s)`;
    issues++;
  }
  console.log(`TypeScript:       ${tscStatus}`);

  // 9. Test status (count only)
  let testStatus = "unknown";
  try {
    const testFiles = fs.readdirSync(path.join(process.cwd(), "test"), { recursive: true })
      .filter(f => String(f).endsWith(".test.ts"));
    testStatus = `${testFiles.length} test files`;
  } catch {
    testStatus = "no test directory found";
  }
  console.log(`Tests:            ${testStatus}`);

  console.log(`\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found.`}`);
}

// ─── Config commands ─────────────────────────────────────────────────

const DOMAINS_DIR = path.join(DB_DIR, "domains");

function getDomainYamlPath(domainId: string): string {
  return path.join(DOMAINS_DIR, `${domainId}.yaml`);
}

function getGlobalConfigPath(): string {
  return path.join(DB_DIR, "config.yaml");
}

function loadYamlDocument(filePath: string): YAML.Document {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return YAML.parseDocument(raw);
}

function getByDotPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  // Check for numeric (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (!isNaN(num)) return num;
  }
  return raw;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function cmdConfigGet(domainId: string, dotPath: string, useGlobal: boolean): void {
  const filePath = useGlobal ? getGlobalConfigPath() : getDomainYamlPath(domainId);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw);
  const value = getByDotPath(parsed, dotPath);
  if (value === undefined) {
    const target = useGlobal ? "config.yaml" : domainId;
    console.error(`Path "${dotPath}" not found in ${target}`);
    process.exit(2);
  }
  console.log(formatValue(value));
}

function cmdConfigSet(domainId: string, dotPath: string, rawValue: string, useGlobal: boolean, dryRun = false): void {
  const filePath = useGlobal ? getGlobalConfigPath() : getDomainYamlPath(domainId);
  const doc = loadYamlDocument(filePath);
  const target = useGlobal ? "config.yaml" : domainId;

  const value = parseValue(rawValue);
  const parts = dotPath.split(".");

  // Show current value for comparison
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw);
  const currentValue = getByDotPath(parsed, dotPath);

  if (dryRun) {
    console.log(`[DRY RUN] Would set ${dotPath} in ${target}:`);
    console.log(`  Current: ${formatValue(currentValue)}`);
    console.log(`  New:     ${JSON.stringify(value)}`);
    return;
  }

  // setIn creates intermediate objects and preserves document structure
  doc.setIn(parts, value);

  fs.writeFileSync(filePath, String(doc), "utf-8");
  console.log(`Set ${dotPath} = ${JSON.stringify(value)} in ${target}`);
}

function cmdConfigShow(domainId: string, section: string | undefined, useGlobal: boolean): void {
  const filePath = useGlobal ? getGlobalConfigPath() : getDomainYamlPath(domainId);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw);

  if (section) {
    const value = getByDotPath(parsed, section);
    if (value === undefined) {
      const target = useGlobal ? "config.yaml" : domainId;
      console.error(`Section "${section}" not found in ${target}`);
      process.exit(2);
    }
    if (typeof value === "object" && value !== null) {
      console.log(YAML.stringify(value).trimEnd());
    } else {
      console.log(formatValue(value));
    }
  } else {
    console.log(raw.trimEnd());
  }
}

function cmdConfig(domainId: string, args: string[], configDryRun = false): void {
  const subcommand = args[1]; // args[0] is "config"
  const useGlobal = args.includes("--global");

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(`
config — Read and write ClawForce configuration

Usage:
  cf config get <dotpath>              Read a config value
  cf config set <dotpath> <value>      Write a config value
  cf config show [section]             Show full config or a section

Options:
  --domain=ID    Target domain (default: clawforce-dev)
  --global       Modify config.yaml instead of domain yaml
  --dry-run, -n  (set only) Show what would change without writing

Examples:
  cf config get dispatch.mode
  cf config set budget.project.daily.cents 40000
  cf config set dispatch.budget_pacing.enabled true
  cf config show dispatch
  cf config get agents --global
`);
    return;
  }

  switch (subcommand) {
    case "get": {
      const dotPath = args.slice(2).find(a => !a.startsWith("--"));
      if (!dotPath) {
        console.error("Usage: cf config get <dotpath>");
        process.exit(1);
      }
      cmdConfigGet(domainId, dotPath, useGlobal);
      break;
    }
    case "set": {
      const setArgs = args.slice(2).filter(a => !a.startsWith("--"));
      if (setArgs.length < 2) {
        console.error("Usage: cf config set <dotpath> <value>");
        process.exit(1);
      }
      const [dotPath, ...valueParts] = setArgs;
      const rawValue = valueParts.join(" ");
      cmdConfigSet(domainId, dotPath!, rawValue, useGlobal, configDryRun);
      break;
    }
    case "show": {
      const section = args.slice(2).find(a => !a.startsWith("--"));
      cmdConfigShow(domainId, section, useGlobal);
      break;
    }
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error("Valid subcommands: get, set, show");
      process.exit(1);
  }
}

// ─── Watch command ──────────────────────────────────────────────────

const WATCH_STATE_FILE = path.join(DB_DIR, ".watch_state");

interface WatchState {
  lastCheckAt: number;
}

function readWatchState(): WatchState | null {
  try {
    if (!fs.existsSync(WATCH_STATE_FILE)) return null;
    const raw = fs.readFileSync(WATCH_STATE_FILE, "utf-8");
    return JSON.parse(raw) as WatchState;
  } catch {
    return null;
  }
}

function writeWatchState(state: WatchState): void {
  fs.writeFileSync(WATCH_STATE_FILE, JSON.stringify(state), "utf-8");
}

export function cmdWatch(db: DatabaseSync, projectId: string, reset: boolean, json = false): void {
  const now = Date.now();

  if (reset) {
    writeWatchState({ lastCheckAt: 0 });
    console.log("Watch state reset. Next run will show everything.");
    return;
  }

  const state = readWatchState();
  const since = state?.lastCheckAt ?? 0;
  const isFirstRun = since === 0;

  // For display — how long ago was the last check?
  const sinceLabel = isFirstRun ? "the beginning" : fmtAgo(since);
  const sinceTime = isFirstRun ? "" : ` (${fmtTime(since)})`;

  // ── Gather deltas ──

  // 1. New sessions since last check
  let newSessions: Array<Record<string, unknown>> = [];
  try {
    newSessions = db.prepare(`
      SELECT sa.session_key, sa.agent_id, sa.started_at, sa.duration_ms,
             sa.outcome, sa.task_id,
             (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_records WHERE session_key = sa.session_key AND project_id = ? AND created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as session_cost,
             (SELECT COUNT(*) FROM transitions t WHERE t.actor = sa.session_key AND t.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as transitions,
             (SELECT COUNT(*) FROM proposals p WHERE p.proposed_by = sa.session_key AND p.created_at BETWEEN sa.started_at AND COALESCE(sa.ended_at, ?)) as proposals
      FROM session_archives sa
      WHERE sa.project_id = ? AND sa.started_at > ?
      ORDER BY sa.started_at DESC LIMIT 20
    `).all(projectId, now, now, now, projectId, since) as Array<Record<string, unknown>>;
  } catch { /* table may not exist */ }

  // 2. Tasks completed (transitioned to DONE)
  let completedTasks: Array<Record<string, unknown>> = [];
  try {
    completedTasks = db.prepare(`
      SELECT DISTINCT t.task_id, tk.title, t.actor, t.created_at,
             (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_records WHERE task_id = t.task_id AND project_id = ?) as task_cost,
             tk.updated_at
      FROM transitions t
      LEFT JOIN tasks tk ON t.task_id = tk.id
      WHERE t.to_state = 'DONE' AND t.created_at > ?
      ORDER BY t.created_at DESC LIMIT 20
    `).all(projectId, since) as Array<Record<string, unknown>>;
  } catch { /* ignore */ }

  // 3. Tasks failed
  let failedTasks: Array<Record<string, unknown>> = [];
  try {
    failedTasks = db.prepare(`
      SELECT DISTINCT t.task_id, tk.title, t.actor, t.created_at,
             dq.last_error
      FROM transitions t
      LEFT JOIN tasks tk ON t.task_id = tk.id
      LEFT JOIN dispatch_queue dq ON dq.task_id = t.task_id AND dq.project_id = ?
      WHERE t.to_state = 'FAILED' AND t.created_at > ?
      ORDER BY t.created_at DESC LIMIT 20
    `).all(projectId, since) as Array<Record<string, unknown>>;
  } catch { /* ignore */ }

  // 4. New proposals
  let newProposals: Array<Record<string, unknown>> = [];
  try {
    newProposals = db.prepare(`
      SELECT id, title, proposed_by, reasoning, status, created_at
      FROM proposals
      WHERE project_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 20
    `).all(projectId, since) as Array<Record<string, unknown>>;
  } catch { /* ignore */ }

  // 5. State changes (transitions, excluding DONE/FAILED which are shown separately)
  let stateChanges: Array<Record<string, unknown>> = [];
  try {
    stateChanges = db.prepare(`
      SELECT t.task_id, tk.title, t.from_state, t.to_state, t.actor, t.created_at
      FROM transitions t
      LEFT JOIN tasks tk ON t.task_id = tk.id
      WHERE t.created_at > ? AND t.to_state NOT IN ('DONE', 'FAILED')
      ORDER BY t.created_at DESC LIMIT 20
    `).all(since) as Array<Record<string, unknown>>;
  } catch { /* ignore */ }

  // 6. Anomalies (only new ones — run detection on the since-window)
  const windowHours = Math.max(1, (now - since) / 3600_000);
  const anomalies = isFirstRun ? detectAnomalies(db, projectId, 4) : detectAnomalies(db, projectId, windowHours);

  // 7. New messages
  let newMessages: Array<Record<string, unknown>> = [];
  try {
    newMessages = db.prepare(`
      SELECT id, from_agent, to_agent, content, created_at, type
      FROM messages
      WHERE project_id = ? AND created_at > ? AND to_agent = 'user'
      ORDER BY created_at DESC LIMIT 20
    `).all(projectId, since) as Array<Record<string, unknown>>;
  } catch { /* ignore */ }

  // 8. Budget change check (only show if >5% change)
  let budgetLine: string | null = null;
  try {
    const budget = db.prepare(
      "SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(projectId) as Record<string, number> | undefined;

    if (budget && budget.daily_limit_cents > 0) {
      const costSinceLastCheck = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE project_id = ? AND created_at > ?",
      ).get(projectId, since) as { cost: number };

      const changePercent = (costSinceLastCheck.cost / budget.daily_limit_cents) * 100;
      if (changePercent > 5) {
        const pct = Math.round((budget.daily_spent_cents / budget.daily_limit_cents) * 100);
        budgetLine = `Budget: ${fmt$(budget.daily_spent_cents)} / ${fmt$(budget.daily_limit_cents)} (${pct}%) — ${fmt$(costSinceLastCheck.cost)} spent since last check`;
      }
    }
  } catch { /* ignore */ }

  // 9. Currently active sessions (for "Active" section)
  let activeSessions: Array<Record<string, unknown>> = [];
  try {
    activeSessions = db.prepare(`
      SELECT session_key, agent_id, started_at
      FROM tracked_sessions
      WHERE project_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC
    `).all(projectId) as Array<Record<string, unknown>>;
  } catch { /* table may not exist */ }

  // ── Check if anything changed ──

  const hasChanges = newSessions.length > 0
    || completedTasks.length > 0
    || failedTasks.length > 0
    || newProposals.length > 0
    || stateChanges.length > 0
    || anomalies.length > 0
    || newMessages.length > 0
    || budgetLine !== null
    || activeSessions.length > 0;

  if (json) {
    console.log(JSON.stringify({
      since: since > 0 ? since : null,
      has_changes: hasChanges,
      anomalies,
      completed_tasks: completedTasks,
      failed_tasks: failedTasks,
      new_sessions: newSessions,
      state_changes: stateChanges,
      new_proposals: newProposals,
      new_messages: newMessages,
      active_sessions: activeSessions,
      budget_change: budgetLine,
    }, null, 2));
    writeWatchState({ lastCheckAt: now });
    return;
  }

  if (!hasChanges) {
    console.log(`## Since ${sinceLabel}${sinceTime} \u2014 No changes.`);
    writeWatchState({ lastCheckAt: now });
    return;
  }

  console.log(`## Since ${sinceLabel}${sinceTime}\n`);

  // ── Render sections ──

  // Anomalies first (most important)
  if (anomalies.length > 0) {
    console.log("Anomalies:");
    for (const a of anomalies) {
      console.log(`  \u26A0  ${a}`);
    }
    console.log("");
  }

  // New section: completed, failed, state changes, new sessions
  const newLines: string[] = [];

  for (const t of completedTasks) {
    const who = extractAgentName(t.actor as string);
    const cost = fmt$(t.task_cost as number);
    newLines.push(`  \u2713 ${who} completed "${truncate(t.title as string, 45)}" (${cost})`);
  }

  for (const t of failedTasks) {
    const reason = t.last_error ? ` \u2014 ${truncate(t.last_error as string, 50)}` : "";
    newLines.push(`  \u2717 ${extractAgentName(t.actor as string)} failed "${truncate(t.title as string, 40)}"${reason}`);
  }

  for (const t of stateChanges) {
    const title = t.title ? ` "${truncate(t.title as string, 40)}"` : "";
    const actor = extractAgentName(t.actor as string);
    newLines.push(`  \u2192 ${t.from_state} \u2192 ${t.to_state}${title} by ${actor}`);
  }

  // New sessions that didn't produce transitions/completions — show as one-liners
  const sessionOnlyLines: string[] = [];
  for (const s of newSessions) {
    const parsed = parseSessionKey(s.session_key as string);
    const duration = s.duration_ms ? fmtAge(s.duration_ms as number) : "?";
    const cost = fmt$(s.session_cost as number);
    const trans = s.transitions as number;
    const props = s.proposals as number;
    const output: string[] = [];
    if (trans > 0) output.push(`${trans} transition${trans > 1 ? "s" : ""}`);
    if (props > 0) output.push(`${props} proposal${props > 1 ? "s" : ""}`);
    const outputStr = output.length > 0 ? output.join(", ") : "no output";
    sessionOnlyLines.push(`  ${parsed.agent} (${parsed.type}) ${duration}, ${cost}, ${outputStr}`);
  }

  if (newLines.length > 0) {
    console.log("New:");
    for (const line of newLines) {
      console.log(line);
    }
    console.log("");
  }

  if (sessionOnlyLines.length > 0 && newLines.length === 0) {
    // Only show session lines when there are no transitions/completions to avoid redundancy
    console.log("Sessions:");
    for (const line of sessionOnlyLines) {
      console.log(line);
    }
    console.log("");
  } else if (sessionOnlyLines.length > 0) {
    console.log(`Sessions: ${newSessions.length} new`);
    for (const line of sessionOnlyLines) {
      console.log(line);
    }
    console.log("");
  }

  // Proposals
  const pendingProposals = newProposals.filter(p => p.status === "pending");
  if (pendingProposals.length > 0) {
    console.log("Proposals:");
    for (const p of pendingProposals) {
      const proposer = extractAgentName(p.proposed_by as string);
      const reasoning = p.reasoning ? ` \u2014 ${truncate(p.reasoning as string, 60)}` : "";
      console.log(`  [NEW] "${truncate(p.title as string, 45)}" by ${proposer}${reasoning}`);
      console.log(`        approve? (cf approve ${(p.id as string).slice(0, 8)})`);
    }
    console.log("");
  }

  // Messages
  if (newMessages.length > 0) {
    console.log("Messages:");
    for (const m of newMessages) {
      const from = m.from_agent as string;
      const preview = truncate(m.content as string, 60);
      const age = fmtAgo(m.created_at as number);
      console.log(`  \u2190 ${pad(from, 18)} ${preview}  ${age}`);
    }
    console.log("");
  }

  // Active sessions
  if (activeSessions.length > 0) {
    console.log("Active:");
    for (const s of activeSessions) {
      const age = fmtAge(now - (s.started_at as number));
      // Get running cost
      let runningCost = 0;
      try {
        const costRow = db.prepare(
          "SELECT COALESCE(SUM(cost_cents), 0) as cost FROM cost_records WHERE session_key = ? AND project_id = ? AND created_at >= ?",
        ).get(s.session_key as string, projectId, s.started_at as number) as { cost: number };
        runningCost = costRow.cost;
      } catch { /* ignore */ }
      // Get task name if available
      let taskInfo = "";
      try {
        const taskRow = db.prepare(`
          SELECT tk.title FROM tracked_sessions ts
          LEFT JOIN tasks tk ON ts.task_id = tk.id
          WHERE ts.session_key = ? AND ts.project_id = ?
        `).get(s.session_key as string, projectId) as { title: string | null } | undefined;
        if (taskRow?.title) taskInfo = ` working on "${truncate(taskRow.title, 35)}"`;
      } catch { /* ignore */ }
      console.log(`  ${s.agent_id}${taskInfo} (${age}, ${fmt$(runningCost)} so far)`);
    }
    console.log("");
  }

  // Budget
  if (budgetLine) {
    console.log(budgetLine);
    console.log("");
  }

  // Footer when some sections were empty
  const shownSections = [
    newLines.length > 0,
    sessionOnlyLines.length > 0,
    pendingProposals.length > 0,
    newMessages.length > 0,
    activeSessions.length > 0,
    anomalies.length > 0,
    budgetLine !== null,
  ].filter(Boolean).length;

  if (shownSections > 0 && shownSections < 3) {
    console.log("Nothing else changed.");
  }

  // Update state
  writeWatchState({ lastCheckAt: now });
}

// ─── Per-command help ────────────────────────────────────────────────

const COMMAND_HELP: Record<string, string> = {
  costs: `
costs — Cost breakdown by agent, task, or time window

Usage: cf costs [--by=agent|task|day] [--hours=N] [--json]

Options:
  --by=agent     Group by agent + model (default)
  --by=task      Group by task
  --by=day       Group by day (last 14 days)
  --hours=N      Lookback window in hours (default: 24)

Examples:
  cf costs
  cf costs --by=task --hours=8
  cf costs --by=day
`,
  tasks: `
tasks — Active tasks with states and assignees

Usage: cf tasks [STATE] [--json]

Arguments:
  STATE    Filter by state: ASSIGNED, IN_PROGRESS, REVIEW, OPEN, BLOCKED, FAILED, DONE, CANCELLED
           If omitted, shows all non-terminal tasks.

Examples:
  cf tasks
  cf tasks REVIEW
  cf tasks DONE
`,
  sessions: `
sessions — List recent sessions with cost/output summary

Usage: cf sessions [--hours=N] [--agent=X] [--json]

Options:
  --hours=N      Lookback window in hours (default: 4)
  --agent=X      Filter to a specific agent

Examples:
  cf sessions
  cf sessions --hours=12 --agent=cf-lead
`,
  flows: `
flows — Per-session action timeline

Usage: cf flows [--hours=N] [--agent=X] [--expand] [--json]

Options:
  --hours=N      Lookback window in hours (default: 4)
  --agent=X      Filter to a specific agent
  --expand       Show full tool call list instead of grouped summary

Examples:
  cf flows --expand
  cf flows --agent=cf-worker-1 --hours=2
`,
  proposals: `
proposals — List proposals with status and reasoning preview

Usage: cf proposals [--status=pending|approved|rejected|all] [--hours=N] [--json]

Options:
  --status=X     Filter by status (default: pending)
  --hours=N      Lookback window in hours

Examples:
  cf proposals
  cf proposals --status=all --hours=48
`,
  org: `
org — Live org tree and management

Usage:
  cf org [--team=X] [--agent=X] [--json]    Live org tree with runtime status
  cf org set <agent> --reports-to <mgr>      Rewire reporting chain
  cf org check [--json]                      Structural + operational audit

Options:
  --team=X        Filter tree to a specific team
  --agent=X       Filter to an agent's chain (up + down)
  --dry-run, -n   (org set) Preview change without applying

Examples:
  cf org
  cf org --team=core
  cf org set cf-worker-1 --reports-to cf-lead
  cf org set cf-worker-1 --reports-to cf-lead --dry-run
  cf org check
`,
  "org set": `
org set — Rewire an agent's reporting chain

Usage: cf org set <agent> --reports-to <manager|none> [--dry-run|-n] [--yes]

Options:
  --reports-to=X   New manager (or "none" to clear)
  --dry-run, -n    Preview change without writing config
  --yes            Skip confirmation

Examples:
  cf org set cf-worker-1 --reports-to cf-lead
  cf org set cf-worker-1 --reports-to none
  cf org set cf-worker-1 --reports-to cf-lead --dry-run
`,
  watch: `
watch — Curated feed showing only what changed since last check

Usage: cf watch [--reset] [--json]

Options:
  --reset    Clear watch state; next run shows everything

Examples:
  cf watch
  cf watch --reset
`,
  disable: `
disable — Disable domain via DB (blocks new dispatches)

Usage: cf disable [--reason=MSG] [--dry-run|-n]

Options:
  --reason=MSG    Reason for disabling
  --dry-run, -n   Show what would happen without doing it

Examples:
  cf disable
  cf disable --reason="maintenance window"
  cf disable --dry-run
`,
  kill: `
kill — Emergency stop: disable + cancel queue + block ALL tool calls

Usage: cf kill [--reason=MSG] [--dry-run|-n]
       cf kill --resume

Options:
  --reason=MSG    Reason for the emergency stop
  --resume        Clear emergency stop and re-enable domain
  --dry-run, -n   Show what would happen without doing it

Examples:
  cf kill
  cf kill --reason="runaway costs"
  cf kill --dry-run
  cf kill --resume
`,
  config: `
config — Read and write ClawForce configuration

Usage:
  cf config get <dotpath>              Read a config value
  cf config set <dotpath> <value>      Write a config value
  cf config show [section]             Show full config or a section

Options:
  --domain=ID    Target domain (default: clawforce-dev)
  --global       Modify config.yaml instead of domain yaml
  --dry-run, -n  (config set) Show what would change without writing

Examples:
  cf config get dispatch.mode
  cf config set budget.project.daily.cents 40000 --dry-run
  cf config show dispatch
`,
  dashboard: `
dashboard — Single-command overview with anomaly detection

Usage: cf dashboard [--hours=N] [--json]

Options:
  --hours=N      Lookback window in hours (default: 4)

Examples:
  cf dashboard
  cf dashboard --hours=12
`,
  status: `
status — System vitals: gateway, budget, task counts, queue

Usage: cf status [--json]
`,
  agents: `
agents — Agent session status and activity

Usage: cf agents [--json]
`,
  metrics: `
metrics — Per-agent efficiency metrics

Usage: cf metrics [--hours=N] [--json]

Options:
  --hours=N      Lookback window in hours (default: 24)
`,
  budget: `
budget — Budget pacing status and projections

Usage: cf budget [--json]
`,
  trust: `
trust — Per-agent trust overview with recent events

Usage: cf trust [--json]

Shows current trust score, tier, 24h trend, and recent trust-affecting
events (last 4) for each agent. Agents with score below 0.5 are flagged.
`,
  inbox: `
inbox — User messages from/to agents

Usage: cf inbox [--agent=X] [--unread] [--expand]

Options:
  --agent=X      Filter messages to/from a specific agent
  --unread       Show only unread messages
  --expand       Show full message text instead of truncated preview

Examples:
  cf inbox
  cf inbox --agent=cf-lead
  cf inbox --unread --expand
`,
  queue: `
queue — Dispatch queue health and failure reasons

Usage: cf queue [--json]
`,
};

function showCommandHelp(cmd: string): boolean {
  const helpText = COMMAND_HELP[cmd];
  if (helpText) {
    console.log(helpText.trimEnd());
    return true;
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────

// Guard: only run main logic when executed directly (not when imported as a module)
const __isMain = process.argv[1] && (
  import.meta.url.endsWith(process.argv[1]) ||
  import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, ".js")) ||
  import.meta.url === `file://${process.argv[1]}`
);
if (__isMain) {

const args = process.argv.slice(2);
const command = args[0];
const projectId =
  (args.find(a => a.startsWith("--domain="))?.split("=")[1]) ??
  (args.find(a => a.startsWith("--project="))?.split("=")[1]) ??
  DEFAULT_PROJECT;
const jsonMode = args.includes("--json");
const dryRun = args.includes("--dry-run") || args.includes("-n");

if (!command || command === "help" || command === "--help") {
  console.log(`
clawforce CLI — operational diagnostics + runtime control

Usage: npx tsx src/cli.ts <command> [options]

Diagnostics:
  status                    System vitals — gateway, budget, task counts, queue
  tasks [STATE]             Active tasks (or filter by state: ASSIGNED, REVIEW, etc)
  costs [--by=agent|task|day] [--hours=N]  Cost breakdown (default: by agent, last 24h)
  queue                     Dispatch queue health and failure reasons
  transitions [--hours=N]   Recent state transitions
  errors [--hours=N]        Recent errors, failed dispatches, stuck transitions
  agents                    Agent activity and assignments
  streams                   List available data streams
  query "SQL"               Raw SQL query against the project DB

Visibility Suite:
  dashboard [--hours=N]     THE single-command answer — anomalies, status, budget
  sessions [--hours=N] [--agent=X]  List recent sessions with cost/output summary
  session <key>             Drill into one session — tool calls, transitions, cost
  proposals [--status=pending|approved|rejected|all]  List proposals
  flows [--hours=N] [--agent=X] [--expand]  Per-session action timeline
  metrics [--hours=N]       Per-agent efficiency metrics
  budget                    Budget pacing status and projections
  trust                     Per-agent trust overview with recent events
  inbox [--agent=X] [--unread] [--expand]  User messages from/to agents
  approve <id>              Approve a pending proposal
  reject <id> [--feedback="reason"]  Reject a pending proposal
  message <agent> "text"    Send a user message to an agent
  replay <key>              Replay session tool calls with full I/O
  watch [--reset]           Curated feed — only what changed since last check

Runtime Control:
  disable [--reason=MSG]    Disable domain via DB (blocks new dispatches)
  enable                    Enable domain via DB (resume dispatches)
  kill [--reason=MSG]       Emergency stop: disable + cancel queue + block ALL tool calls
  kill --resume             Clear emergency stop and re-enable domain

Config:
  config get <dotpath>      Read a config value using dot-notation
  config set <dotpath> <v>  Write a config value (auto-detects type)
  config show [section]     Show full config or a section

Org:
  org [--team=X] [--agent=X]  Live org tree with runtime status
  org set <agent> --reports-to <mgr>  Rewire reporting chain
  org check                 Structural + operational audit

Verification:
  running                   Show what's actually running right now
  health                    Comprehensive health check

Options:
  --project=ID, --domain=ID Project/domain ID (default: clawforce-dev)
  --global                  (config only) Target config.yaml instead of domain yaml
  --json                    Output as JSON instead of formatted text
  --dry-run, -n             Preview mutating commands without applying changes
                            Works with: config set, disable, kill, org set

Use <command> --help for per-command usage and examples.
`);
  process.exit(0);
}

// Config commands don't need the database
if (command === "config") {
  if (args.includes("--help")) {
    showCommandHelp("config");
    process.exit(0);
  }
  cmdConfig(projectId, args, dryRun);
  process.exit(0);
}

// Org commands — DB is optional for tree/check, not needed for set
if (command === "org") {
  const sub = args[1];

  // --help handling
  if (args.includes("--help")) {
    if (sub === "set") {
      showCommandHelp("org set");
    } else {
      showCommandHelp("org");
    }
    process.exit(0);
  }

  if (sub === "set") {
    const agentId = args[2];
    const reportsToArg = args.find(a => a.startsWith("--reports-to="));
    const reportsTo = reportsToArg?.split("=")[1];
    const yesFlag = args.includes("--yes");
    if (!agentId || agentId.startsWith("--") || !reportsTo) {
      console.error("Usage: cf org set <agent> --reports-to <manager|none>");
      process.exit(1);
    }
    cmdOrgSet(agentId, reportsTo, { yes: yesFlag, dryRun });
    process.exit(0);
  }

  // org and org check can use DB optionally
  let orgDb: DatabaseSync | null = null;
  const orgDbPath = path.join(DB_DIR, projectId, "clawforce.db");
  if (fs.existsSync(orgDbPath)) {
    orgDb = new DatabaseSync(orgDbPath, { open: true });
  }

  if (sub === "check") {
    cmdOrgCheck(orgDb, projectId);
  } else {
    const teamArg = args.find(a => a.startsWith("--team="));
    const agentArg = args.find(a => a.startsWith("--agent="));
    cmdOrg(orgDb, projectId, {
      team: teamArg?.split("=")[1],
      agent: agentArg?.split("=")[1],
    });
  }

  if (orgDb) orgDb.close();
  process.exit(0);
}

const db = getDb(projectId);

const hoursArg = args.find(a => a.startsWith("--hours="));
const hours = hoursArg ? parseInt(hoursArg.split("=")[1]!, 10) : undefined;
const byArg = args.find(a => a.startsWith("--by="));
const groupBy = byArg?.split("=")[1];
const agentArg = args.find(a => a.startsWith("--agent="));
const agentFilter = agentArg?.split("=")[1];
const statusArg = args.find(a => a.startsWith("--status="));
const statusFilter = statusArg?.split("=")[1];
const feedbackArg = args.find(a => a.startsWith("--feedback="));
const feedbackValue = feedbackArg?.split("=").slice(1).join("=");
const expandFlag = args.includes("--expand");

// ─── Unknown flag detection ──────────────────────────────────────────

const KNOWN_FLAGS: Record<string, string[]> = {
  _global: ["--domain", "--project", "--json", "--dry-run", "-n", "--help", "--expand"],
  status: ["--json"],
  tasks: ["--json"],
  costs: ["--by", "--hours", "--json"],
  queue: ["--json"],
  transitions: ["--hours"],
  errors: ["--hours"],
  agents: ["--json"],
  streams: [],
  query: [],
  dashboard: ["--hours", "--json"],
  sessions: ["--hours", "--agent", "--json"],
  session: [],
  proposals: ["--status", "--hours", "--json"],
  flows: ["--hours", "--agent", "--expand"],
  metrics: ["--hours", "--json"],
  budget: ["--json"],
  trust: ["--json"],
  inbox: ["--agent", "--unread", "--expand"],
  approve: [],
  reject: ["--feedback"],
  message: [],
  replay: [],
  watch: ["--reset", "--json"],
  disable: ["--reason"],
  enable: [],
  kill: ["--reason", "--resume"],
  running: [],
  health: [],
  config: ["--global"],
  org: ["--team", "--agent", "--reports-to", "--yes"],
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

if (command && !args.includes("--help")) {
  const cmdFlags = KNOWN_FLAGS[command] ?? [];
  const allKnown = [...KNOWN_FLAGS._global, ...cmdFlags];
  // Extract flag base names (before =)
  const knownBases = allKnown.map(f => f.replace(/=.*$/, ""));

  for (const arg of args.slice(1)) {
    if (!arg.startsWith("--")) continue;
    const flagBase = arg.split("=")[0]!;
    if (knownBases.includes(flagBase)) continue;

    // Find closest match
    let bestMatch = "";
    let bestDist = Infinity;
    for (const known of knownBases) {
      const dist = levenshtein(flagBase, known);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = known;
      }
    }

    const suggestion = bestDist <= 3 ? ` Did you mean ${bestMatch}?` : "";
    console.error(`Warning: unknown flag ${flagBase}.${suggestion}`);
  }
}

// Per-command --help check
if (args.includes("--help") && command && COMMAND_HELP[command]) {
  showCommandHelp(command);
  db.close();
  process.exit(0);
}

// Helper: output JSON and exit, skipping formatted output
let jsonOutput: unknown = null;

switch (command) {
  case "status":
    cmdStatus(db, jsonMode);
    break;
  case "tasks":
    cmdTasks(db, args[1] && !args[1].startsWith("--") ? args[1] : undefined, jsonMode);
    break;
  case "costs":
    cmdCosts(db, groupBy, hours, jsonMode);
    break;
  case "queue":
    cmdQueue(db, jsonMode);
    break;
  case "transitions":
    cmdTransitions(db, hours);
    break;
  case "errors":
    cmdErrors(db, hours);
    break;
  case "agents":
    cmdAgents(db, jsonMode);
    break;
  case "streams":
    cmdStreams(db, projectId);
    break;
  case "query": {
    const sql = args.slice(1).filter(a => !a.startsWith("--")).join(" ");
    if (!sql) { console.error("Usage: query \"SQL statement\""); process.exit(1); }
    cmdQuery(db, sql);
    break;
  }
  case "dashboard":
    cmdDashboard(db, projectId, hours ?? 4, jsonMode);
    break;
  case "sessions":
    cmdSessions(db, projectId, hours ?? 4, agentFilter, jsonMode);
    break;
  case "session": {
    const sessionKey = args[1];
    if (!sessionKey || sessionKey.startsWith("--")) {
      console.error("Usage: cf session <session_key>");
      process.exit(1);
    }
    cmdSessionDetail(db, projectId, sessionKey);
    break;
  }
  case "proposals":
    cmdProposals(db, projectId, statusFilter ?? "pending", hours, jsonMode);
    break;
  case "flows":
    cmdFlows(db, projectId, hours ?? 4, agentFilter, expandFlag);
    break;
  case "metrics":
    cmdMetrics(db, projectId, hours ?? 24, jsonMode);
    break;
  case "budget":
    cmdBudget(db, projectId, jsonMode);
    break;
  case "trust":
    cmdTrust(db, projectId, jsonMode);
    break;
  case "inbox": {
    const unreadFlag = args.includes("--unread");
    cmdInbox(db, projectId, { agent: agentFilter, unread: unreadFlag, expand: expandFlag });
    break;
  }
  case "approve": {
    const approveId = args[1];
    if (!approveId || approveId.startsWith("--")) {
      console.error("Usage: cf approve <proposal_id>");
      process.exit(1);
    }
    cmdApprove(db, projectId, approveId);
    break;
  }
  case "reject": {
    const rejectId = args[1];
    if (!rejectId || rejectId.startsWith("--")) {
      console.error("Usage: cf reject <proposal_id> [--feedback=\"reason\"]");
      process.exit(1);
    }
    cmdReject(db, projectId, rejectId, feedbackValue);
    break;
  }
  case "message": {
    const toAgent = args[1];
    const msgContent = args.slice(2).filter(a => !a.startsWith("--")).join(" ");
    if (!toAgent || toAgent.startsWith("--") || !msgContent) {
      console.error('Usage: cf message <agent> "text"');
      process.exit(1);
    }
    cmdMessage(db, projectId, toAgent, msgContent);
    break;
  }
  case "replay": {
    const replayKey = args[1];
    if (!replayKey || replayKey.startsWith("--")) {
      console.error("Usage: cf replay <session_key>");
      process.exit(1);
    }
    cmdReplay(db, projectId, replayKey);
    break;
  }
  case "watch":
    cmdWatch(db, projectId, args.includes("--reset"), jsonMode);
    break;
  case "disable":
    cmdDisable(db, projectId, args, dryRun);
    break;
  case "enable":
    cmdEnable(db, projectId);
    break;
  case "kill":
    if (args.includes("--resume")) {
      cmdKillResume(db, projectId);
    } else {
      cmdKill(db, projectId, args, dryRun);
    }
    break;
  case "running":
    cmdRunning(db, projectId);
    break;
  case "health":
    cmdHealth(db, projectId);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun with --help for usage.`);
    process.exit(1);
}

void jsonOutput; // suppress unused warning

db.close();

} // end __isMain guard
