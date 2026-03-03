/**
 * Clawforce — SQLite schema migrations
 *
 * Version-tracked migrations. Each version is a function that runs
 * the necessary DDL. The schema_version table tracks which migrations
 * have been applied.
 */

import type { DatabaseSync } from "node:sqlite";

/** Current schema version. Increment when adding new migrations. */
export const SCHEMA_VERSION = 7;

type Migration = (db: DatabaseSync) => void;

const migrations: Record<number, Migration> = {
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
  5: migrateV5,
  6: migrateV6,
  7: migrateV7,
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
      migrate(db);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, Date.now());
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
      last_persisted_at INTEGER NOT NULL
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
  db.exec(`ALTER TABLE tasks ADD COLUMN lease_holder TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN lease_acquired_at INTEGER`);
  db.exec(`ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER`);
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
  db.exec(`ALTER TABLE proposals ADD COLUMN risk_tier TEXT`);
  db.exec(`ALTER TABLE dispatch_queue ADD COLUMN risk_tier TEXT`);
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
  db.exec(`ALTER TABLE tasks ADD COLUMN department TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN team TEXT`);
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
