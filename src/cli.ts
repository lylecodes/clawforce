#!/usr/bin/env npx tsx
/**
 * clawforce CLI — operational diagnostics + experiment analysis
 *
 * Usage: npx tsx src/cli.ts <command> [options]
 *
 * Commands:
 *   status          System vitals — gateway, budget, task counts, queue
 *   tasks           Active tasks with states and assignees
 *   costs           Cost breakdown by agent, task, or time window
 *   queue           Dispatch queue health and failure reasons
 *   transitions     Recent state transitions (catches silent failures)
 *   errors          Recent errors, failed dispatches, swallowed exceptions
 *   agents          Agent session status and activity
 *   streams         List available data streams
 *   query           Raw SQL query against the project DB
 */

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const HOME = process.env.HOME ?? "/tmp";
const DEFAULT_PROJECT = "clawforce-dev";
const DB_DIR = path.join(HOME, ".clawforce");

function getDb(projectId: string): DatabaseSync {
  const dbPath = path.join(DB_DIR, projectId, "clawforce.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
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

// ─── Commands ────────────────────────────────────────────────────────

function cmdStatus(db: DatabaseSync) {
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

function cmdTasks(db: DatabaseSync, filter?: string) {
  const where = filter
    ? `WHERE state = '${filter.toUpperCase()}'`
    : "WHERE state NOT IN ('DONE', 'CANCELLED')";

  const tasks = db.prepare(`
    SELECT id, title, state, assigned_to, priority,
           datetime(created_at/1000, 'unixepoch') as created,
           datetime(updated_at/1000, 'unixepoch') as updated
    FROM tasks ${where} ORDER BY state, created_at
  `).all() as Array<Record<string, unknown>>;

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

function cmdCosts(db: DatabaseSync, groupBy?: string, hours?: number) {
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

  console.log(`## Costs by Agent (since ${sinceStr})\n`);
  for (const r of rows) {
    const pct = Math.round(((r.cost as number) / total) * 100);
    console.log(`${fmt$((r.cost as number)).padStart(8)} (${pct.toString().padStart(2)}%)  ${r.agent_id}  ${r.model}`);
    console.log(`           ${r.calls} calls | out: ${r.output_tok} | cache_read: ${r.cache_read} | cache_write: ${r.cache_write}`);
  }
  console.log(`\n   Total: ${fmt$(total)}`);
}

function cmdQueue(db: DatabaseSync) {
  // Status counts
  const counts = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM dispatch_queue GROUP BY status"
  ).all() as Array<{ status: string; cnt: number }>;

  console.log("## Dispatch Queue\n");
  for (const r of counts) {
    console.log(`  ${r.status.padEnd(14)} ${r.cnt}`);
  }

  // Failure reasons
  const failures = db.prepare(`
    SELECT last_error, COUNT(*) as cnt
    FROM dispatch_queue WHERE status = 'failed'
    GROUP BY last_error ORDER BY cnt DESC LIMIT 10
  `).all() as Array<{ last_error: string | null; cnt: number }>;

  if (failures.length > 0) {
    console.log("\nFailure reasons:");
    for (const f of failures) {
      console.log(`  ${f.cnt.toString().padStart(4)}x  ${f.last_error ?? "(no error message)"}`);
    }
  }

  // Recent dispatches
  const recent = db.prepare(`
    SELECT dq.task_id, t.title, dq.status, dq.last_error,
           datetime(dq.created_at/1000, 'unixepoch') as created
    FROM dispatch_queue dq LEFT JOIN tasks t ON dq.task_id = t.id
    WHERE dq.created_at > ?
    ORDER BY dq.created_at DESC LIMIT 10
  `).all(Date.now() - 3600_000) as Array<Record<string, unknown>>;

  if (recent.length > 0) {
    console.log("\nRecent (last hour):");
    for (const r of recent) {
      const title = r.title ? ` "${(r.title as string).slice(0, 40)}"` : "";
      const err = r.last_error ? ` — ${(r.last_error as string).slice(0, 60)}` : "";
      console.log(`  [${r.status}] ${r.created}${title}${err}`);
    }
  }
}

function cmdTransitions(db: DatabaseSync, hours?: number) {
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

function cmdErrors(db: DatabaseSync, hours?: number) {
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

function cmdAgents(db: DatabaseSync) {
  const agents = db.prepare(`
    SELECT agent_id,
           COUNT(*) as total_sessions,
           SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) as recent_sessions,
           SUM(cost_cents) as total_cost,
           SUM(CASE WHEN created_at > ? THEN cost_cents ELSE 0 END) as recent_cost,
           MAX(created_at) as last_active
    FROM cost_records GROUP BY agent_id ORDER BY last_active DESC
  `).all(Date.now() - 3600_000, Date.now() - 3600_000) as Array<Record<string, unknown>>;

  console.log("## Agents\n");
  for (const a of agents) {
    const age = Date.now() - (a.last_active as number);
    console.log(`${a.agent_id}`);
    console.log(`  Last active: ${fmtAge(age)} ago | Today: ${fmt$((a.recent_cost as number))} (${a.recent_sessions} sessions) | Total: ${fmt$((a.total_cost as number))} (${a.total_sessions} sessions)`);
  }

  // Tasks per agent
  const assignments = db.prepare(`
    SELECT assigned_to, state, COUNT(*) as cnt
    FROM tasks WHERE state NOT IN ('DONE', 'CANCELLED') AND assigned_to IS NOT NULL
    GROUP BY assigned_to, state ORDER BY assigned_to, state
  `).all() as Array<Record<string, unknown>>;

  if (assignments.length > 0) {
    console.log("\nActive assignments:");
    for (const a of assignments) {
      console.log(`  ${a.assigned_to}: ${a.cnt} ${a.state}`);
    }
  }
}

function cmdStreams(db: DatabaseSync) {
  // This reads from the builtin manifest — just list what's available
  console.log("## Available Data Streams\n");
  console.log("Use context sources in agent briefings or export via webhook.\n");

  const streams = [
    ["cost_summary", "Cost tracking summary for the project"],
    ["cost_forecast", "Budget exhaustion projection"],
    ["budget_guidance", "Budget utilization, remaining sessions, forecast"],
    ["task_board", "Current task board with status, priority, assignee"],
    ["velocity", "Task completion velocity and trends"],
    ["team_performance", "Performance metrics per team member"],
    ["trust_scores", "Trust evolution scores per action category"],
    ["agent_status", "Status of all agents in the team"],
    ["health_status", "System health indicators"],
    ["sweep_status", "Automated sweep findings"],
    ["initiative_status", "Initiative allocation vs spend"],
    ["weekly_digest", "Weekly performance summary"],
    ["intervention_suggestions", "Pattern-detected recommendations"],
  ];

  for (const [name, desc] of streams) {
    console.log(`  ${name.padEnd(28)} ${desc}`);
  }
}

function cmdQuery(db: DatabaseSync, sql: string) {
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

// ─── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const projectId = (args.find(a => a.startsWith("--project="))?.split("=")[1]) ?? DEFAULT_PROJECT;

if (!command || command === "help" || command === "--help") {
  console.log(`
clawforce CLI — operational diagnostics + experiment analysis

Usage: npx tsx src/cli.ts <command> [options]

Commands:
  status                    System vitals — gateway, budget, task counts, queue
  tasks [STATE]             Active tasks (or filter by state: ASSIGNED, REVIEW, etc)
  costs [--by=agent|task|day] [--hours=N]  Cost breakdown (default: by agent, last 24h)
  queue                     Dispatch queue health and failure reasons
  transitions [--hours=N]   Recent state transitions
  errors [--hours=N]        Recent errors, failed dispatches, stuck transitions
  agents                    Agent activity and assignments
  streams                   List available data streams
  query "SQL"               Raw SQL query against the project DB

Options:
  --project=ID              Project ID (default: clawforce-dev)
`);
  process.exit(0);
}

const db = getDb(projectId);

const hoursArg = args.find(a => a.startsWith("--hours="));
const hours = hoursArg ? parseInt(hoursArg.split("=")[1]!, 10) : undefined;
const byArg = args.find(a => a.startsWith("--by="));
const groupBy = byArg?.split("=")[1];

switch (command) {
  case "status":
    cmdStatus(db);
    break;
  case "tasks":
    cmdTasks(db, args[1] && !args[1].startsWith("--") ? args[1] : undefined);
    break;
  case "costs":
    cmdCosts(db, groupBy, hours);
    break;
  case "queue":
    cmdQueue(db);
    break;
  case "transitions":
    cmdTransitions(db, hours);
    break;
  case "errors":
    cmdErrors(db, hours);
    break;
  case "agents":
    cmdAgents(db);
    break;
  case "streams":
    cmdStreams(db);
    break;
  case "query": {
    const sql = args.slice(1).filter(a => !a.startsWith("--")).join(" ");
    if (!sql) { console.error("Usage: query \"SQL statement\""); process.exit(1); }
    cmdQuery(db, sql);
    break;
  }
  default:
    console.error(`Unknown command: ${command}\nRun with --help for usage.`);
    process.exit(1);
}

db.close();
