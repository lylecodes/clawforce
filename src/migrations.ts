/**
 * Clawforce — SQLite schema migrations
 *
 * Version-tracked migrations. Each version is a function that runs
 * the necessary DDL. The schema_version table tracks which migrations
 * have been applied.
 */

import type { DatabaseSync } from "./sqlite-driver.js";

/** Current schema version. Increment when adding new migrations. */
export const SCHEMA_VERSION = 55;

type Migration = (db: DatabaseSync) => void;

const migrations: Record<number, Migration> = {
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
  5: migrateV5,
  6: migrateV6,
  7: migrateV7,
  8: migrateV8,
  9: migrateV9,
  10: migrateV10,
  11: migrateV11,
  12: migrateV12,
  13: migrateV13,
  14: migrateV14,
  15: migrateV15,
  16: migrateV16,
  17: migrateV17,
  18: migrateV18,
  19: migrateV19,
  20: migrateV20,
  21: migrateV21,
  22: migrateV22,
  23: migrateV23,
  24: migrateV24,
  25: migrateV25,
  26: migrateV26,
  27: migrateV27,
  28: migrateV28,
  29: migrateV29,
  30: migrateV30,
  31: migrateV31,
  32: migrateV32,
  33: migrateV33,
  34: migrateV34,
  35: migrateV35,
  36: migrateV36,
  37: migrateV37,
  38: migrateV38,
  39: migrateV39,
  40: migrateV40,
  41: migrateV41,
  42: migrateV42,
  43: migrateV43,
  44: migrateV44,
  45: migrateV45,
  46: migrateV46,
  47: migrateV47,
  48: migrateV48,
  49: migrateV49,
  50: migrateV50,
  51: migrateV51,
  52: migrateV52,
  53: migrateV53,
  54: migrateV54,
  55: migrateV55,
};

export function runMigrations(db: DatabaseSync): void {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const currentVersion = getCurrentVersion(db);

  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = migrations[v];
    if (migrate) {
      // Wrap each migration + version record in a transaction for atomicity.
      // Re-check the target version after taking the write lock so parallel
      // processes cannot apply the same migration based on stale pre-lock state.
      db.prepare("BEGIN IMMEDIATE").run();
      try {
        const alreadyApplied = db.prepare(
          "SELECT 1 FROM schema_version WHERE version = ? LIMIT 1",
        ).get(v) as Record<string, unknown> | undefined;
        if (alreadyApplied) {
          db.prepare("COMMIT").run();
          continue;
        }
        migrate(db);
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
        db.prepare("COMMIT").run();
      } catch (err) {
        try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
        throw err;
      }
    }
  }
}

export function getCurrentVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as Record<string, unknown> | undefined;
    return (row?.v as number) ?? 0;
  } catch {
    return 0;
  }
}

// --- Migration V1: Initial schema ---

function migrateV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL DEFAULT 'OPEN',
      priority TEXT NOT NULL DEFAULT 'P2',
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deadline INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      tags TEXT,
      workflow_id TEXT,
      workflow_phase INTEGER,
      parent_task_id TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);

    CREATE TABLE IF NOT EXISTS transitions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_signature TEXT,
      reason TEXT,
      evidence_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transitions_task ON transitions(task_id);
    CREATE INDEX IF NOT EXISTS idx_transitions_actor ON transitions(actor);
    CREATE INDEX IF NOT EXISTS idx_transitions_created ON transitions(created_at);

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      attached_by TEXT NOT NULL,
      attached_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phases TEXT NOT NULL,
      current_phase INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id);

    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT,
      key TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_type_key ON metrics(type, key);
    CREATE INDEX IF NOT EXISTS idx_metrics_subject ON metrics(subject);
    CREATE INDEX IF NOT EXISTS idx_metrics_created ON metrics(created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT,
      signature TEXT,
      prev_hash TEXT,
      entry_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    -- Knowledge entries (logged by agents via clawforce_log write)
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      source_agent TEXT,
      source_session TEXT,
      source_task TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);

    -- Audit runs (session outcomes + compliance metrics)
    CREATE TABLE IF NOT EXISTS audit_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      details TEXT,
      artifacts TEXT,
      requirements_met TEXT,
      metrics TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_audit_runs_project ON audit_runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_runs_agent ON audit_runs(agent_id);

    -- Proposals (approval flow)
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      proposed_by TEXT NOT NULL,
      session_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approval_policy_snapshot TEXT,
      user_feedback TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

    -- Enforcement retry attempts (durable counter across sessions)
    CREATE TABLE IF NOT EXISTS enforcement_retries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      outcome TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_enforcement_retries_lookup
      ON enforcement_retries(project_id, agent_id, attempted_at);

    -- Tracked enforcement sessions (crash recovery)
    CREATE TABLE IF NOT EXISTS tracked_sessions (
      session_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      requirements TEXT NOT NULL,
      satisfied TEXT NOT NULL,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      last_persisted_at INTEGER NOT NULL,
      process_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tracked_sessions_project
      ON tracked_sessions(project_id);
  `);
}

// --- Migration V2: Disabled agents table ---

function migrateV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      disabled_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_disabled_agents_project
      ON disabled_agents(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_disabled_agents_lookup
      ON disabled_agents(project_id, agent_id);
  `);
}

// --- Migration V3: Events, dispatch queue, task leases ---

function migrateV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      dedup_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      handled_by TEXT,
      created_at INTEGER NOT NULL,
      processed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_project_status
      ON events(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_type
      ON events(type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup
      ON events(project_id, dedup_key) WHERE dedup_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      leased_by TEXT,
      leased_at INTEGER,
      lease_expires_at INTEGER,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      max_dispatch_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_project_status
      ON dispatch_queue(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_task
      ON dispatch_queue(task_id);
  `);

  // Add lease columns to tasks table
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN lease_holder TEXT`);
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN lease_acquired_at INTEGER`);
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER`);
}

// --- Migration V4: Cost tracking, policies, monitoring, risk tiers ---

function migrateV4(db: DatabaseSync): void {
  db.exec(`
    -- Cost tracking
    CREATE TABLE IF NOT EXISTS cost_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      task_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      source TEXT NOT NULL DEFAULT 'dispatch',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_records_project ON cost_records(project_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_agent ON cost_records(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_task ON cost_records(task_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_created ON cost_records(created_at);

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      daily_limit_cents INTEGER,
      session_limit_cents INTEGER,
      task_limit_cents INTEGER,
      daily_spent_cents INTEGER NOT NULL DEFAULT 0,
      daily_reset_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_budgets_project ON budgets(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_lookup ON budgets(project_id, COALESCE(agent_id, ''));

    -- Runtime policy enforcement
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      target_agent TEXT,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_policies_project ON policies(project_id);
    CREATE INDEX IF NOT EXISTS idx_policies_type ON policies(type);

    CREATE TABLE IF NOT EXISTS policy_violations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      action_attempted TEXT NOT NULL,
      violation_detail TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_policy_violations_project ON policy_violations(project_id);
    CREATE INDEX IF NOT EXISTS idx_policy_violations_policy ON policy_violations(policy_id);

    -- Monitoring feedback loops
    CREATE TABLE IF NOT EXISTS slo_evaluations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slo_name TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      window_ms INTEGER NOT NULL,
      threshold REAL NOT NULL,
      actual REAL,
      passed INTEGER NOT NULL,
      breach_task_id TEXT,
      evaluated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slo_evaluations_project ON slo_evaluations(project_id);
    CREATE INDEX IF NOT EXISTS idx_slo_evaluations_name ON slo_evaluations(slo_name);

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      condition TEXT NOT NULL,
      threshold REAL NOT NULL,
      window_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      action_params TEXT,
      cooldown_ms INTEGER NOT NULL DEFAULT 3600000,
      last_fired_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_alert_rules_project ON alert_rules(project_id);

    -- Risk-tiered autonomy
    CREATE TABLE IF NOT EXISTS risk_assessments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_detail TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      classification_reason TEXT,
      decision TEXT NOT NULL,
      approval_id TEXT,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_risk_assessments_project ON risk_assessments(project_id);
    CREATE INDEX IF NOT EXISTS idx_risk_assessments_tier ON risk_assessments(risk_tier);
  `);

  // Add risk_tier columns to existing tables
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN risk_tier TEXT`);
  safeAlterTable(db, `ALTER TABLE dispatch_queue ADD COLUMN risk_tier TEXT`);
}

// --- Migration V5: Worker assignments table ---

function migrateV5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_assignments (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL
    );
  `);
}

// --- Migration V6: Department and team columns on tasks ---

function migrateV6(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN department TEXT`);
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN team TEXT`);
}

// --- Migration V7: Shared memory table ---

function migrateV7(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'learning',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7,
      source_agent TEXT,
      source_session TEXT,
      source_task TEXT,
      supersedes TEXT,
      deprecated INTEGER NOT NULL DEFAULT 0,
      validation_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
    CREATE INDEX IF NOT EXISTS idx_memory_project_scope ON memory(project_id, scope, deprecated);
  `);
}

// --- Migration V8: Drop memory table (replaced by OpenClaw RAG) ---

function migrateV8(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS memory`);
}

// --- Migration V9: Indexes for audit_runs + hash_version column for audit_log ---

function migrateV9(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_runs_session_key ON audit_runs(session_key);
    CREATE INDEX IF NOT EXISTS idx_audit_runs_ended_at ON audit_runs(ended_at);
  `);
  safeAlterTable(db, `ALTER TABLE audit_log ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1`);
}

// --- Migration V10: Add job_name tracking to audit_runs ---

function migrateV10(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE audit_runs ADD COLUMN job_name TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_runs_job_name ON audit_runs(job_name)`);
}

// --- Migration V11: Add dispatch_context to tracked_sessions ---

function migrateV11(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE tracked_sessions ADD COLUMN dispatch_context TEXT`);
}

// --- Migration V12: Approval channel routing + tool call intents + pre-approvals ---

function migrateV12(db: DatabaseSync): void {
  // Extend proposals table for channel routing
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN channel TEXT`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN notification_message_id TEXT`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN timeout_action TEXT DEFAULT 'reject'`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN timeout_at INTEGER`);

  // Tool call intents — blocked tool calls awaiting approval
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_intents (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      task_id TEXT,
      tool_name TEXT NOT NULL,
      tool_params TEXT NOT NULL,
      category TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tool_intents_proposal ON tool_call_intents(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_tool_intents_task ON tool_call_intents(project_id, task_id, status);
  `);

  // Pre-approvals — single-use allowlist for re-dispatched tasks
  db.exec(`
    CREATE TABLE IF NOT EXISTS pre_approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      expires_at INTEGER,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_pre_approvals_lookup ON pre_approvals(project_id, task_id, tool_name, consumed);
  `);
}

// --- Migration V13: Unified messaging ---

function migrateV13(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      project_id TEXT NOT NULL,
      channel_id TEXT,
      type TEXT NOT NULL DEFAULT 'direct',
      priority TEXT NOT NULL DEFAULT 'normal',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      parent_message_id TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      read_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(project_id, to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(project_id, from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
  `);
}

// --- Migration V14: Protocol support on messages ---

function migrateV14(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE messages ADD COLUMN protocol_status TEXT`);
  safeAlterTable(db, `ALTER TABLE messages ADD COLUMN response_deadline INTEGER`);
  safeAlterTable(db, `ALTER TABLE messages ADD COLUMN metadata TEXT`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_protocol ON messages(project_id, protocol_status);
    CREATE INDEX IF NOT EXISTS idx_messages_deadline ON messages(project_id, response_deadline);
  `);
}

// --- Migration V15: Goals table + goal_id on tasks ---

function migrateV15(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      parent_goal_id TEXT,
      owner_agent_id TEXT,
      department TEXT,
      team TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      achieved_at INTEGER,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
    CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner_agent_id);
  `);

  // Add goal_id column to tasks for direct task-to-goal linkage
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN goal_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id)`);
}

function migrateV16(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'topic',
      members TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      concluded_at INTEGER,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id);
    CREATE INDEX IF NOT EXISTS idx_channels_project_status ON channels(project_id, type, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_name ON channels(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
  `);
}

function migrateV17(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'blocks',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(project_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(project_id, depends_on_task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_deps_pair ON task_dependencies(project_id, task_id, depends_on_task_id);
  `);
}

function migrateV18(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_metadata (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (project_id, key)
    );
  `);
}

// --- Migration V19: Trust evolution ---

function migrateV19(db: DatabaseSync): void {
  // Trust decisions — longitudinal record of every approval/rejection per category
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL,
      decision TEXT NOT NULL,
      agent_id TEXT,
      proposal_id TEXT,
      tool_name TEXT,
      risk_tier TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trust_decisions_category ON trust_decisions(project_id, category, created_at);
    CREATE INDEX IF NOT EXISTS idx_trust_decisions_project ON trust_decisions(project_id, created_at);
  `);

  // Trust overrides — tier adjustments with decay tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS trust_overrides (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL,
      original_tier TEXT NOT NULL,
      override_tier TEXT NOT NULL,
      reason TEXT,
      activated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      decay_after_days INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_overrides_category ON trust_overrides(project_id, category, status);
  `);
}

// --- Migration V20: Preference store ---

function migrateV20(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'explicit',
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_preferences_lookup ON preferences(project_id, agent_id, category, key);
    CREATE INDEX IF NOT EXISTS idx_preferences_agent ON preferences(project_id, agent_id);
  `);
}

// --- Migration V21: Undo registry ---

function migrateV21(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS undo_registry (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_params TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      undo_tool_name TEXT,
      undo_tool_params TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      executed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_undo_project_category ON undo_registry(project_id, category, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_undo_project_status ON undo_registry(project_id, status, expires_at);
  `);
}

// --- Migration V22: Add provider column to cost_records ---

function migrateV22(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE cost_records ADD COLUMN provider TEXT`);
}

// --- Migration V23: Multi-window budget columns ---

function migrateV23(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE budgets ADD COLUMN hourly_limit_cents INTEGER`);
  safeAlterTable(db, `ALTER TABLE budgets ADD COLUMN monthly_limit_cents INTEGER`);
}

// --- Migration V24: Add allocation column to goals ---

function migrateV24(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE goals ADD COLUMN allocation INTEGER`);
}

// --- Migration V25: Goal priority + dispatch_plans table ---

function migrateV25(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE goals ADD COLUMN priority TEXT");

  db.prepare(`
    CREATE TABLE IF NOT EXISTS dispatch_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      planned_items TEXT NOT NULL DEFAULT '[]',
      actual_results TEXT,
      estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
      actual_cost_cents INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_plans_project_agent
    ON dispatch_plans (project_id, agent_id, created_at DESC)
  `).run();
}

// --- Migration V26: Memory knowledge lifecycle tables ---

function migrateV26(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS memory_retrieval_stats (
      content_hash TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content_snippet TEXT NOT NULL,
      retrieval_count INTEGER NOT NULL DEFAULT 1,
      session_count INTEGER NOT NULL DEFAULT 1,
      first_retrieved_at INTEGER NOT NULL,
      last_retrieved_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, project_id, agent_id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS memory_search_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      query_text TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_search_log_session
    ON memory_search_log (session_key, query_hash)
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS promotion_candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_snippet TEXT NOT NULL,
      retrieval_count INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      suggested_target TEXT NOT NULL,
      target_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS knowledge_flags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      flagged_content TEXT NOT NULL,
      correction TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `).run();
}

// --- Migration V27: Onboarding state + audit index ---

function migrateV27(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_audit_runs_agent_ended
    ON audit_runs(agent_id, ended_at)
  `).run();
}

// --- Migration V28: Budget v2 — token/request counters, reservations, window boundaries ---

function migrateV28(db: DatabaseSync): void {
  // Cost spent counters (hourly/monthly — daily already exists)
  // Note: hourly_limit_cents and monthly_limit_cents already exist from V23
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_spent_cents INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_spent_cents INTEGER NOT NULL DEFAULT 0");

  // Token limits and counters
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_limit_tokens INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_spent_tokens INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN daily_limit_tokens INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN daily_spent_tokens INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_limit_tokens INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_spent_tokens INTEGER NOT NULL DEFAULT 0");

  // Request limits and counters
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_limit_requests INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_spent_requests INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN daily_limit_requests INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN daily_spent_requests INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_limit_requests INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_spent_requests INTEGER NOT NULL DEFAULT 0");

  // Window boundaries (daily_reset_at exists)
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN hourly_reset_at INTEGER");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN monthly_reset_at INTEGER");

  // Reservation hold for active plans
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN reserved_cents INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0");
  safeAlterTable(db, "ALTER TABLE budgets ADD COLUMN reserved_requests INTEGER NOT NULL DEFAULT 0");

  // Index for efficient initiative-level cost forecasting
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_tasks_goal_id
    ON tasks(goal_id) WHERE goal_id IS NOT NULL
  `).run();

  // Add started_at to dispatch_plans for reservation crash recovery TTL
  safeAlterTable(db, "ALTER TABLE dispatch_plans ADD COLUMN started_at INTEGER");
}

// --- Migration V29: Trust severity + recency-weighted scoring ---

function migrateV29(db: DatabaseSync): void {
  // Add severity column to trust decisions (0-1, default 1.0)
  safeAlterTable(db, "ALTER TABLE trust_decisions ADD COLUMN severity REAL NOT NULL DEFAULT 1.0");
}

// --- Migration V30: Add job_name to cost_records for per-job budget tracking ---

function migrateV30(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE cost_records ADD COLUMN job_name TEXT DEFAULT NULL");
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_cost_records_job_name
    ON cost_records(project_id, job_name) WHERE job_name IS NOT NULL
  `).run();
}

// --- Migration V31: Session archives table ---

function migrateV31(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_archives (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      context_hash TEXT,
      context_content TEXT,
      transcript TEXT,
      agent_config_snapshot TEXT,
      task_id TEXT,
      queue_item_id TEXT,
      job_name TEXT,
      outcome TEXT NOT NULL,
      exit_signal TEXT,
      compliance_detail TEXT,
      total_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      provider TEXT,
      config_version_id TEXT,
      experiment_variant_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_session_archives_key ON session_archives(session_key);
    CREATE INDEX idx_session_archives_agent ON session_archives(project_id, agent_id, started_at DESC);
    CREATE INDEX idx_session_archives_task ON session_archives(task_id);
  `);
}

// --- Migration V32: Tool call details table ---

function migrateV32(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE tool_call_details (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      action TEXT,
      input TEXT,
      output TEXT,
      sequence_number INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      estimated_cost_cents INTEGER,
      task_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_tool_calls_session ON tool_call_details(session_key, sequence_number);
    CREATE INDEX idx_tool_calls_tool ON tool_call_details(project_id, tool_name, created_at DESC);
  `);
}

// --- Migration V33: Config versions table ---

function migrateV33(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE config_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      files TEXT NOT NULL,
      content TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      detected_by TEXT,
      previous_version_id TEXT,
      change_summary TEXT
    );

    CREATE UNIQUE INDEX idx_config_versions_hash ON config_versions(project_id, content_hash);
    CREATE INDEX idx_config_versions_project ON config_versions(project_id, detected_at DESC);
  `);
}

// --- Migration V34: Manager reviews table ---

function migrateV34(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE manager_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reviewer_agent_id TEXT NOT NULL,
      session_key TEXT,
      verdict TEXT NOT NULL,
      reasoning TEXT,
      criteria_checked TEXT,
      follow_up_task_id TEXT,
      revision_notes TEXT,
      review_duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_reviews_task ON manager_reviews(project_id, task_id);
    CREATE INDEX idx_reviews_verdict ON manager_reviews(project_id, verdict, created_at DESC);
  `);
}

// --- Migration V35: Trust score history table ---

function migrateV35(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE trust_score_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      score REAL NOT NULL,
      tier TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_id TEXT,
      category_scores TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_trust_history_agent ON trust_score_history(project_id, agent_id, created_at DESC);
  `);
}

// --- Migration V36: Experiments tables ---

function migrateV36(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      hypothesis TEXT,
      state TEXT NOT NULL DEFAULT 'draft',
      assignment_strategy TEXT NOT NULL DEFAULT '{"type":"random"}',
      completion_criteria TEXT,
      auto_apply_winner INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      winner_variant_id TEXT,
      metadata TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX idx_experiments_project ON experiments(project_id, state);
    CREATE UNIQUE INDEX idx_experiments_name ON experiments(project_id, name);

    CREATE TABLE experiment_variants (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_control INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      compliant_count INTEGER NOT NULL DEFAULT 0,
      total_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id)
    );

    CREATE INDEX idx_variants_experiment ON experiment_variants(experiment_id);

    CREATE TABLE experiment_sessions (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_name TEXT,
      task_id TEXT,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER,
      outcome TEXT,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id),
      FOREIGN KEY (variant_id) REFERENCES experiment_variants(id)
    );

    CREATE INDEX idx_experiment_sessions_experiment ON experiment_sessions(experiment_id, variant_id);
    CREATE INDEX idx_experiment_sessions_session ON experiment_sessions(session_key);
  `);
}

// --- Migration V37: Hierarchical disabled scopes ---

function migrateV37(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_scopes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      reason TEXT NOT NULL,
      disabled_at INTEGER NOT NULL,
      disabled_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_disabled_scopes_project ON disabled_scopes(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_disabled_scopes_lookup ON disabled_scopes(project_id, scope_type, scope_value);
  `);
}

// --- Migration V38: Add dispatched_at column to dispatch_queue ---

function migrateV38(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE dispatch_queue ADD COLUMN dispatched_at INTEGER`);
}

// --- Migration V39: Add kind column to tasks for task categorization ---

function migrateV39(db: DatabaseSync): void {
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN kind TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`);
}

// --- Migration V40: Origin tracking for proposals and tasks, user messaging support ---

function migrateV40(db: DatabaseSync): void {
  // Proposal origin tracking — distinguish lead_proposal from risk_gate
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN origin TEXT DEFAULT 'risk_gate'`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN reasoning TEXT`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN related_goal_id TEXT`);

  // Task origin tracking — trace every task back to its source
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN origin TEXT`);
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN origin_id TEXT`);

  // Indexes for efficient work stream queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_proposals_origin ON proposals(origin)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id) WHERE origin_id IS NOT NULL`);
}

// --- Migration V41: Performance indexes for cost, dispatch queue, and tasks ---

function migrateV41(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cost_records_project_agent ON cost_records(project_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_created ON cost_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_project_status_created ON dispatch_queue(project_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_state_priority ON tasks(project_id, state, priority);
  `);
}

// --- Migration V42: Change history for operator confidence and safe revert ---

function migrateV42(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'human',
      actor TEXT NOT NULL,
      before_snapshot TEXT,
      after_snapshot TEXT,
      reversible INTEGER NOT NULL DEFAULT 1,
      reverted_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_change_history_project
      ON change_history(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_change_history_resource
      ON change_history(project_id, resource_type, resource_id, created_at DESC);
  `);
}

// --- Migration V43: Native entities + task/goal entity linkage ---

function migrateV43(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      health TEXT,
      owner_agent_id TEXT,
      parent_entity_id TEXT,
      department TEXT,
      team TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_verified_at INTEGER,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entities_project_kind
      ON entities(project_id, kind);
    CREATE INDEX IF NOT EXISTS idx_entities_project_state
      ON entities(project_id, state);
    CREATE INDEX IF NOT EXISTS idx_entities_project_health
      ON entities(project_id, health);
    CREATE INDEX IF NOT EXISTS idx_entities_owner
      ON entities(project_id, owner_agent_id);
    CREATE INDEX IF NOT EXISTS idx_entities_parent
      ON entities(project_id, parent_entity_id);

    CREATE TABLE IF NOT EXISTS entity_transitions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      from_health TEXT,
      to_health TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entity_transitions_entity
      ON entity_transitions(entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_entity_transitions_project
      ON entity_transitions(project_id, created_at);
  `);

  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN entity_type TEXT`);
  safeAlterTable(db, `ALTER TABLE tasks ADD COLUMN entity_id TEXT`);
  safeAlterTable(db, `ALTER TABLE goals ADD COLUMN entity_type TEXT`);
  safeAlterTable(db, `ALTER TABLE goals ADD COLUMN entity_id TEXT`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_entity
      ON tasks(project_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_goals_entity
      ON goals(project_id, entity_type, entity_id);
  `);
}

// --- Migration V44: Entity issues + entity-linked proposals ---

function migrateV44(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_issues (
      id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      project_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      check_id TEXT,
      issue_type TEXT NOT NULL,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL,
      description TEXT,
      field_name TEXT,
      evidence TEXT,
      recommended_action TEXT,
      playbook TEXT,
      owner_agent_id TEXT,
      blocking INTEGER NOT NULL DEFAULT 0,
      approval_required INTEGER NOT NULL DEFAULT 0,
      proposal_id TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_issues_unique_key
      ON entity_issues(project_id, entity_id, issue_key);
    CREATE INDEX IF NOT EXISTS idx_entity_issues_entity_status
      ON entity_issues(project_id, entity_id, status, severity);
    CREATE INDEX IF NOT EXISTS idx_entity_issues_kind
      ON entity_issues(project_id, entity_kind, status);
    CREATE INDEX IF NOT EXISTS idx_entity_issues_proposal
      ON entity_issues(project_id, proposal_id);
  `);

  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN entity_type TEXT`);
  safeAlterTable(db, `ALTER TABLE proposals ADD COLUMN entity_id TEXT`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proposals_entity
      ON proposals(project_id, entity_type, entity_id, status);
  `);
}

// --- Migration V45: Entity check runs ---

function migrateV45(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_check_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      check_id TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      parser_type TEXT,
      exit_code INTEGER NOT NULL,
      issue_count INTEGER NOT NULL DEFAULT 0,
      stdout TEXT,
      stderr TEXT,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entity_check_runs_entity
      ON entity_check_runs(project_id, entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entity_check_runs_check
      ON entity_check_runs(project_id, check_id, created_at DESC);
  `);
}

// --- Migration V46: Durable simulated actions for dry-run execution ---

function migrateV46(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS simulated_actions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain_id TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      task_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      proposal_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      action_type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      payload TEXT,
      policy_decision TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_simulated_actions_project_created
      ON simulated_actions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_simulated_actions_project_status
      ON simulated_actions(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_simulated_actions_entity
      ON simulated_actions(project_id, entity_type, entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_simulated_actions_task
      ON simulated_actions(project_id, task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_simulated_actions_proposal
      ON simulated_actions(project_id, proposal_id, created_at DESC);
  `);
}

// --- Migration V47: Proposal linkage for simulated actions ---

function migrateV47(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE simulated_actions ADD COLUMN proposal_id TEXT;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_simulated_actions_proposal
      ON simulated_actions(project_id, proposal_id, created_at DESC);
  `);
}

// --- Migration V48: Provenance for entity check runs ---

function migrateV48(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE entity_check_runs ADD COLUMN actor TEXT;");
  safeAlterTable(db, "ALTER TABLE entity_check_runs ADD COLUMN trigger TEXT;");
  safeAlterTable(db, "ALTER TABLE entity_check_runs ADD COLUMN source_type TEXT;");
  safeAlterTable(db, "ALTER TABLE entity_check_runs ADD COLUMN source_id TEXT;");
}

// --- Migration V49: Cross-process controller leases ---

function migrateV49(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS controller_leases (
      project_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      purpose TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_controller_leases_expires
      ON controller_leases(expires_at);
  `);
}

// --- Migration V50: Structured review reason codes ---

function migrateV50(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE manager_reviews ADD COLUMN reason_code TEXT;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reviews_reason_code
      ON manager_reviews(project_id, reason_code, created_at DESC);
  `);
}

// --- Migration V51: Controller generation handoff state ---

function migrateV51(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN generation TEXT;");
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN required_generation TEXT;");
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN generation_requested_at INTEGER;");
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN generation_request_reason TEXT;");
  db.exec(`
    UPDATE controller_leases
    SET generation = COALESCE(generation, 'legacy');

    CREATE INDEX IF NOT EXISTS idx_controller_leases_required_generation
      ON controller_leases(required_generation);
  `);
}

// --- Migration V52: Proposal execution tracking ---

function migrateV52(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_status TEXT;");
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_requested_at INTEGER;");
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_updated_at INTEGER;");
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_error TEXT;");
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_task_id TEXT;");
  safeAlterTable(db, "ALTER TABLE proposals ADD COLUMN execution_required_generation TEXT;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proposals_execution_status
      ON proposals(project_id, status, execution_status, resolved_at DESC);
  `);
}

// --- Migration V53: Direct-session process ids on tracked sessions ---

function migrateV53(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE tracked_sessions ADD COLUMN process_id INTEGER;");
}

// --- Migration V54: Durable controller config apply markers ---

function migrateV54(db: DatabaseSync): void {
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN applied_config_version_id TEXT;");
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN applied_config_hash TEXT;");
  safeAlterTable(db, "ALTER TABLE controller_leases ADD COLUMN applied_config_applied_at INTEGER;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_controller_leases_applied_config
      ON controller_leases(project_id, applied_config_applied_at DESC);
  `);
}

// --- Migration V55: Workflow draft sessions for workspace Phase B ---

function migrateV55(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_draft_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      overlay_visibility TEXT NOT NULL DEFAULT 'visible',
      base_workflow_snapshot TEXT NOT NULL,
      draft_workflow_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_draft_sessions_project
      ON workflow_draft_sessions(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_draft_sessions_workflow
      ON workflow_draft_sessions(project_id, workflow_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_draft_sessions_status
      ON workflow_draft_sessions(project_id, status, updated_at DESC);
  `);
}

/** Idempotent ALTER TABLE — ignores "duplicate column name" errors. */
function safeAlterTable(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("duplicate column name")) throw err;
  }
}
