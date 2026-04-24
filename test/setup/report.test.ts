import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import { parseWorkforceConfigContent, registerWorkforceConfig, resetEnforcementConfigForTest } from "../../src/project.js";
import { runMigrations } from "../../src/migrations.js";

const {
  acquireControllerLease,
  resetControllerIdentityForTest,
} = await import("../../src/runtime/controller-leases.js");
const { initializeAllDomains, syncManagedDomainRoots } = await import("../../src/config/init.js");
const { clearRegistry } = await import("../../src/config/registry.js");
const { shutdownClawforce } = await import("../../src/lifecycle.js");
const { resetManagerConfigForTest } = await import("../../src/manager-config.js");
const { resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
const { resetCustomTopicsForTest } = await import("../../src/skills/registry.js");

const {
  buildSetupReport,
  buildSetupExplanation,
  renderSetupExplain,
  renderSetupStatus,
  renderSetupValidate,
  resolveSetupRoot,
} = await import("../../src/setup/report.js");

describe("setup/report", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-setup-report-"));
  });

  afterEach(async () => {
    resetControllerIdentityForTest();
    await shutdownClawforce();
    syncManagedDomainRoots([]);
    clearRegistry();
    resetEnforcementConfigForTest();
    resetManagerConfigForTest();
    resetPolicyRegistryForTest();
    resetCustomTopicsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGlobal(content: Record<string, unknown>) {
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), YAML.stringify(content), "utf-8");
  }

  function writeDomain(domainId: string, content: Record<string, unknown>) {
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "domains", `${domainId}.yaml`),
      YAML.stringify({ domain: domainId, ...content }),
      "utf-8",
    );
  }

  it("resolves a repo root that contains .clawforce", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const cfRoot = path.join(repoRoot, ".clawforce");
    fs.mkdirSync(cfRoot, { recursive: true });
    fs.writeFileSync(path.join(cfRoot, "config.yaml"), "agents: {}\n", "utf-8");

    expect(resolveSetupRoot(repoRoot)).toBe(cfRoot);
  });

  it("builds a clean report for a valid domain", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        worker: {
          extends: "employee",
          jobs: {
            sweep: {
              cron: "*/15 * * * *",
            },
          },
        },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead", "worker"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const report = buildSetupReport(tmpDir, "test");

    expect(report.valid).toBe(true);
    expect(report.issueCounts.errors).toBe(0);
    expect(report.domains).toHaveLength(1);
    expect(report.domains[0]?.loaded).toBe(true);
    expect(report.domains[0]?.jobCount).toBe(1);
    expect(report.checks.some((check) => check.id === "global:workflow-steward" && check.status === "ok")).toBe(true);
    expect(renderSetupStatus(report)).toContain("## Setup Status");
    expect(renderSetupStatus(report)).toContain("job worker.sweep cron=*/15 * * * *");
    expect(renderSetupValidate(report)).toContain("## Setup Validate");
    expect(renderSetupExplain(report)).toContain("Normal user path:");
    expect(renderSetupExplain(report)).toContain("Current diagnosis:");
    expect(buildSetupExplanation(report).summary).toContain("warning");
  });

  it("includes runtime-injected coordination jobs for registered manager agents", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("coord-test", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
      operational_profile: "medium",
    });

    const workforce = parseWorkforceConfigContent(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    registerWorkforceConfig("coord-test", workforce, tmpDir);

    const report = buildSetupReport(tmpDir, "coord-test");

    expect(report.domains[0]?.jobCount).toBeGreaterThanOrEqual(5);
    expect(report.domains[0]?.jobs.find((job) => job.jobId === "coordination")).toMatchObject({
      agentId: "lead",
      jobId: "coordination",
      cron: "*/30 * * * *",
    });
    expect(renderSetupStatus(report)).toContain("job lead.coordination cron=*/30 * * * *");
  });

  it("preserves normalized manager override jobs when runtime agent config is already registered", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("coord-runtime", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      operational_profile: "medium",
      paths: [tmpDir],
    });

    const workforce = parseWorkforceConfigContent(fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"));
    registerWorkforceConfig("coord-runtime", workforce, tmpDir);

    const report = buildSetupReport(tmpDir, "coord-runtime");
    const jobIds = report.domains[0]?.jobs.map((job) => job.jobId) ?? [];

    expect(jobIds).toContain("coordination");
    expect(renderSetupStatus(report)).toContain("job lead.coordination cron=*/30 * * * *");
  });

  it("surfaces missing target domains as actionable setup errors", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });

    const report = buildSetupReport(tmpDir, "ghost");

    expect(report.valid).toBe(false);
    expect(report.checks.some((check) => check.id === "global:target-domain" && check.status === "error")).toBe(true);
    expect(report.nextSteps.some((step) => step.includes("ghost.yaml"))).toBe(true);
    expect(report.domains[0]).toMatchObject({
      id: "ghost",
      exists: false,
      loaded: false,
      enabled: false,
    });
  });

  it("filters unrelated global agent suggestions out of target-domain reports", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        orphan: { extends: "employee" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("target", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const report = buildSetupReport(tmpDir, "target");
    const validationCheck = report.checks.find((check) => check.id === "global:validation");

    expect(report.issueCounts.suggestions).toBe(0);
    expect(report.issues.some((issue) => issue.agentId === "orphan")).toBe(false);
    expect(validationCheck?.detail).toBeUndefined();
  });

  it("warns when a domain has no manager or paths", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    writeDomain("test", {
      agents: ["lead"],
    });

    const report = buildSetupReport(tmpDir, "test");

    expect(report.valid).toBe(true);
    expect(report.checks.some((check) => check.id === "domain:test:manager" && check.status === "warn")).toBe(true);
    expect(report.checks.some((check) => check.id === "domain:test:paths" && check.status === "warn")).toBe(true);
  });

  it("warns when direct codex agents request a stricter tool envelope than the native runtime supports", () => {
    writeGlobal({
      adapter: "codex",
      agents: {
        worker: {
          extends: "employee",
          runtime: {
            allowed_tools: ["Read"],
          },
        },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      paths: [tmpDir],
    });

    const report = buildSetupReport(tmpDir, "test");
    const scopeCheck = report.checks.find((check) => check.id === "domain:test:runtime-scope");

    expect(scopeCheck?.status).toBe("warn");
    expect(scopeCheck?.detail).toContain("worker -> codex");
    expect(scopeCheck?.fix).toContain("stricter tool filtering");
  });

  it("keeps the same warning when a domain explicitly pins codex for strict tool-filtered agents", () => {
    writeGlobal({
      adapter: "codex",
      agents: {
        worker: {
          extends: "employee",
          runtime: {
            allowed_tools: ["Read"],
          },
        },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      paths: [tmpDir],
      dispatch: {
        executor: "codex",
      },
    });

    const report = buildSetupReport(tmpDir, "test");
    const scopeCheck = report.checks.find((check) => check.id === "domain:test:runtime-scope");

    expect(scopeCheck?.status).toBe("warn");
    expect(scopeCheck?.detail).toContain("worker -> codex");
    expect(scopeCheck?.fix).toContain("stricter tool filtering");
  });

  it("applies nested manager override runtime scope without requiring legacy aliases", () => {
    writeGlobal({
      adapter: "codex",
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead"],
      paths: [tmpDir],
      manager_overrides: {
        lead: {
          runtime: {
            allowed_tools: ["Read"],
            workspace_paths: [tmpDir],
          },
        },
      },
    });

    const report = buildSetupReport(tmpDir, "test");
    const scopeCheck = report.checks.find((check) => check.id === "domain:test:runtime-scope");

    expect(scopeCheck?.status).toBe("warn");
    expect(scopeCheck?.detail).toContain("lead -> codex");
  });

  it("still honors top-level manager override runtime aliases via the runtime normalizer", () => {
    writeGlobal({
      adapter: "codex",
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead"],
      paths: [tmpDir],
      manager_overrides: {
        lead: {
          allowed_tools: ["Read"],
          workspace_paths: [tmpDir],
        },
      },
    });

    const report = buildSetupReport(tmpDir, "test");
    const scopeCheck = report.checks.find((check) => check.id === "domain:test:runtime-scope");

    expect(scopeCheck?.status).toBe("warn");
    expect(scopeCheck?.detail).toContain("lead -> codex");
  });

  it("treats disabled manager routing as no manager in setup reports", () => {
    writeGlobal({ agents: { lead: { extends: "manager" } } });
    writeDomain("test", {
      agents: ["lead"],
      manager: { enabled: false, agentId: "lead" },
      paths: [tmpDir],
    });

    const report = buildSetupReport(tmpDir, "test");
    const managerCheck = report.checks.find((check) => check.id === "domain:test:manager");

    expect(report.domains[0]?.managerAgentId).toBeNull();
    expect(managerCheck?.status).toBe("warn");
    expect(managerCheck?.summary).toContain("has no manager.agentId configured");
  });

  it("warns when a declared data-source-onboarding workflow is missing required jobs", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
      workflows: ["data-source-onboarding"],
    });

    const report = buildSetupReport(tmpDir, "test");
    const workflowCheck = report.checks.find((check) => check.id === "domain:test:workflow:data-source-onboarding");

    expect(workflowCheck?.status).toBe("warn");
    expect(workflowCheck?.summary).toContain("missing");
    expect(workflowCheck?.fix).toContain("--workflow=data-source-onboarding");
  });

  it("marks a declared data-source-onboarding workflow ready when required jobs are present", () => {
    writeGlobal({
      agents: {
        director: {
          extends: "manager",
          jobs: {
            "intake-triage": { cron: "*/20 * * * *" },
          },
        },
        steward: {
          extends: "employee",
          jobs: {
            "onboarding-backlog-sweep": { cron: "*/5 * * * *" },
          },
        },
        integrity: {
          extends: "employee",
          jobs: {
            "integrity-sweep": { cron: "*/30 * * * *" },
          },
        },
        sentinel: {
          extends: "employee",
          jobs: {
            "production-watch": { cron: "0 * * * *" },
          },
        },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["director", "steward", "integrity", "sentinel"],
      manager: { agentId: "director" },
      paths: [tmpDir],
      workflows: ["data-source-onboarding"],
    });

    const report = buildSetupReport(tmpDir, "test");
    const workflowCheck = report.checks.find((check) => check.id === "domain:test:workflow:data-source-onboarding");

    expect(workflowCheck?.status).toBe("ok");
    expect(renderSetupStatus(report)).toContain("workflows=data-source-onboarding");
    expect(buildSetupExplanation(report).domains[0]?.highlights[0]).toContain("declared workflows");
  });

  it("does not suggest waiting on never-run jobs that are only scheduled for the future", () => {
    writeGlobal({
      agents: {
        lead: {
          extends: "manager",
          jobs: {
            annual_review: { cron: "0 0 1 1 *" },
          },
        },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE tracked_sessions (
          session_key TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          requirements TEXT,
          satisfied INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          last_persisted_at INTEGER,
          dispatch_context TEXT,
          process_id INTEGER
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          acquired_at INTEGER,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          metadata TEXT,
          generation TEXT,
          required_generation TEXT,
          generation_requested_at INTEGER,
          generation_request_reason TEXT
        );
      `);
      db.prepare(`
        INSERT INTO controller_leases (
          project_id, owner_id, owner_label, purpose, acquired_at, heartbeat_at, expires_at, metadata, generation, required_generation, generation_requested_at, generation_request_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
      `).run(
        "test",
        "controller:test",
        "test-controller",
        "controller",
        Date.now() - 5_000,
        Date.now() - 1_000,
        Date.now() + 60_000,
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(report.valid).toBe(true);
    expect(report.nextSteps.some((step) => step.includes("move beyond \"never run\""))).toBe(false);
  });

  it("shows the live controller as current after initialization records the applied config hash", () => {
    const domainId = "current-check";
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain(domainId, {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, domainId);
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      runMigrations(db);
      acquireControllerLease(domainId, {
        purpose: "controller",
        ttlMs: 60_000,
      }, db);
    } finally {
      db.close();
    }

    initializeAllDomains(tmpDir);

    const report = buildSetupReport(tmpDir, domainId);
    const controllerConfigCheck = report.checks.find((check) => check.id === `domain:${domainId}:controller-config`);

    expect(report.domains[0]?.controller).toMatchObject({
      state: "live",
      configStatus: "current",
    });
    expect(controllerConfigCheck?.status).toBe("ok");
    expect(controllerConfigCheck?.summary).toContain("confirmed the current config revision");
    expect(renderSetupStatus(report)).toContain("config=current");
  });

  it("warns when on-disk config drifts past the live controller's confirmed hash", () => {
    const domainId = "stale-check";
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
        "workflow-steward": { extends: "manager" },
      },
    });
    writeDomain(domainId, {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, domainId);
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      runMigrations(db);
      acquireControllerLease(domainId, {
        purpose: "controller",
        ttlMs: 60_000,
      }, db);
    } finally {
      db.close();
    }

    initializeAllDomains(tmpDir);
    const extraPath = path.join(tmpDir, "extra-workspace");
    fs.mkdirSync(extraPath, { recursive: true });
    writeDomain(domainId, {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir, extraPath],
    });

    const report = buildSetupReport(tmpDir, domainId);
    const controllerConfigCheck = report.checks.find((check) => check.id === `domain:${domainId}:controller-config`);

    expect(report.domains[0]?.controller).toMatchObject({
      state: "live",
      configStatus: "stale",
    });
    expect(controllerConfigCheck?.status).toBe("warn");
    expect(controllerConfigCheck?.summary).toContain("older config revision");
    expect(renderSetupStatus(report)).toContain("config=stale");
    expect(renderSetupValidate(report)).toContain("Caller-side reload feedback is not enough");
  });

  it("surfaces active worker activity when no controller lease is present", () => {
    writeGlobal({
      agents: {
        lead: { extends: "manager" },
      },
    });
    writeDomain("test", {
      agents: ["lead"],
      manager: { agentId: "lead" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          acquired_at INTEGER,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          metadata TEXT,
          generation TEXT,
          required_generation TEXT,
          generation_requested_at INTEGER,
          generation_request_reason TEXT
        );
        CREATE TABLE tracked_sessions (
          session_key TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          requirements TEXT,
          satisfied TEXT,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          last_persisted_at INTEGER NOT NULL,
          dispatch_context TEXT,
          process_id INTEGER
        );
        CREATE TABLE dispatch_queue (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id TEXT,
          status TEXT NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO tracked_sessions (
          session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context, process_id
        ) VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, ?, ?)
      `).run(
        "dispatch:worker-only",
        "workflow-steward",
        "test",
        Date.now() - 5_000,
        Date.now() - 5_000,
        JSON.stringify({ taskId: "task-1", queueItemId: "queue-1" }),
        12345,
      );
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, status)
        VALUES (?, ?, ?, ?)
      `).run("queue-1", "test", "task-1", "leased");
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");
    const controllerCheck = report.checks.find((check) => check.id === "domain:test:controller");

    expect(report.domains[0]?.controller).toMatchObject({
      state: "none",
      activeSessionCount: 1,
      activeDispatchCount: 1,
    });
    expect(controllerCheck?.summary).toContain("active worker activity under a shared or lease-less controller path");
    expect(controllerCheck?.detail).toContain("active_sessions=1");
    expect(controllerCheck?.detail).toContain("active_dispatches=1");
    expect(controllerCheck?.fix).toContain("Inspect cf running --domain=test");
    expect(renderSetupStatus(report)).toContain("controller state=none active_sessions=1 active_dispatches=1");
  });

  it("surfaces active recurring jobs before never-run jobs", () => {
    writeGlobal({
      agents: {
        worker: {
          extends: "employee",
          jobs: {
            active_job: { cron: "*/5 * * * *" },
            idle_job: { cron: "0 6 * * *" },
          },
        },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      manager: { agentId: "worker" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          generation INTEGER,
          required_generation INTEGER,
          requested_by TEXT,
          requested_reason TEXT,
          request_metadata TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE tracked_sessions (
          session_key TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          requirements TEXT,
          satisfied INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          last_persisted_at INTEGER,
          dispatch_context TEXT,
          process_id INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO project_metadata (project_id, key, value)
        VALUES (?, ?, ?)
      `).run("test", "recurring_job:worker:active_job:last_scheduled_at", String(Date.now()));
      db.prepare(`
        INSERT INTO tasks (id, project_id, state, metadata, created_at)
        VALUES (?, ?, 'ASSIGNED', ?, ?)
      `).run(
        "active-task-id",
        "test",
        JSON.stringify({ recurringJob: { agentId: "worker", jobName: "active_job" } }),
        Date.now(),
      );
      db.prepare(`
        INSERT INTO tracked_sessions (
          session_key, agent_id, project_id, started_at, tool_call_count, last_persisted_at, dispatch_context
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(
        "dispatch:active-job",
        "worker",
        "test",
        Date.now(),
        Date.now(),
        JSON.stringify({ taskId: "active-task-id", queueItemId: "queue-1" }),
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(report.domains[0]?.jobs[0]).toMatchObject({
      agentId: "worker",
      jobId: "active_job",
      activeTaskId: "active-task-id",
    });
    expect(renderSetupStatus(report)).toContain("job worker.active_job cron=*/5 * * * * state=running");
  });

  it("warns when a recurring job has an active task but no live session", () => {
    writeGlobal({
      agents: {
        worker: {
          extends: "employee",
          jobs: {
            active_job: { cron: "*/5 * * * *" },
          },
        },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      manager: { agentId: "worker" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          generation INTEGER,
          required_generation INTEGER,
          requested_by TEXT,
          requested_reason TEXT,
          request_metadata TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO project_metadata (project_id, key, value)
        VALUES (?, ?, ?)
      `).run("test", "recurring_job:worker:active_job:last_scheduled_at", String(Date.now()));
      db.prepare(`
        INSERT INTO tasks (id, project_id, state, metadata, created_at)
        VALUES (?, ?, 'IN_PROGRESS', ?, ?)
      `).run(
        "orphaned-task-id",
        "test",
        JSON.stringify({ recurringJob: { agentId: "worker", jobName: "active_job" } }),
        Date.now(),
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(report.checks.some((check) => check.id.includes(":orphaned") && check.status === "warn")).toBe(true);
    expect(report.issueCounts.errors).toBe(0);
    expect(report.issueCounts.warnings).toBeGreaterThan(0);
    expect(renderSetupStatus(report)).toMatch(/errors=0 warnings=[1-9]/);
    expect(renderSetupStatus(report)).toContain("state=orphaned");
    expect(renderSetupValidate(report)).toContain("stranded with task");
    expect(renderSetupExplain(report)).toContain("Immediate actions:");
    expect(renderSetupExplain(report)).toContain("why: The controller no longer has an active worker session");
  });

  it("shows queued recurring jobs as queued instead of orphaned", () => {
    writeGlobal({
      agents: {
        worker: {
          extends: "employee",
          jobs: {
            queued_job: { cron: "*/5 * * * *" },
          },
        },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      manager: { agentId: "worker" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          generation INTEGER,
          required_generation INTEGER,
          requested_by TEXT,
          requested_reason TEXT,
          request_metadata TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE dispatch_queue (
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
          dispatched_at INTEGER,
          completed_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO project_metadata (project_id, key, value)
        VALUES (?, ?, ?)
      `).run("test", "recurring_job:worker:queued_job:last_scheduled_at", String(Date.now()));
      db.prepare(`
        INSERT INTO tasks (id, project_id, state, metadata, created_at)
        VALUES (?, ?, 'ASSIGNED', ?, ?)
      `).run(
        "queued-task-id",
        "test",
        JSON.stringify({ recurringJob: { agentId: "worker", jobName: "queued_job" } }),
        Date.now(),
      );
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
        VALUES (?, ?, ?, 2, 'queued', 0, 3, ?)
      `).run(
        "queue-item-1",
        "test",
        "queued-task-id",
        Date.now(),
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(report.checks.some((check) => check.id.includes(":orphaned") && check.status === "warn")).toBe(false);
    expect(renderSetupStatus(report)).toContain("state=queued");
  });

  it("warns when a leased recurring job only has a stale session heartbeat", () => {
    writeGlobal({
      agents: {
        worker: {
          extends: "employee",
          jobs: {
            leased_job: { cron: "*/5 * * * *" },
          },
        },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      manager: { agentId: "worker" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          generation INTEGER,
          required_generation INTEGER,
          requested_by TEXT,
          requested_reason TEXT,
          request_metadata TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE tracked_sessions (
          session_key TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          requirements TEXT,
          satisfied INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          last_persisted_at INTEGER,
          dispatch_context TEXT,
          process_id INTEGER
        );
        CREATE TABLE dispatch_queue (
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
          dispatched_at INTEGER,
          completed_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO project_metadata (project_id, key, value)
        VALUES (?, ?, ?)
      `).run("test", "recurring_job:worker:leased_job:last_scheduled_at", String(Date.now()));
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, metadata, created_at)
        VALUES (?, ?, ?, 'ASSIGNED', ?, ?)
      `).run(
        "leased-task-id",
        "test",
        "Run recurring workflow worker.leased_job",
        JSON.stringify({ recurringJob: { agentId: "worker", jobName: "leased_job" } }),
        Date.now(),
      );
      db.prepare(`
        INSERT INTO tracked_sessions (
          session_key, agent_id, project_id, started_at, tool_call_count, last_persisted_at, dispatch_context
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(
        "dispatch:leased-job",
        "worker",
        "test",
        Date.now() - 120_000,
        Date.now() - 120_000,
        JSON.stringify({ taskId: "leased-task-id", queueItemId: "queue-item-1" }),
      );
      db.prepare(`
        INSERT INTO dispatch_queue (
          id, project_id, task_id, priority, status, leased_by, leased_at, lease_expires_at,
          dispatch_attempts, max_dispatch_attempts, created_at
        ) VALUES (?, ?, ?, 2, 'leased', ?, ?, ?, 1, 3, ?)
      `).run(
        "queue-item-1",
        "test",
        "leased-task-id",
        "dispatcher:dead",
        Date.now() - 120_000,
        Date.now() - 60_000,
        Date.now() - 120_000,
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(report.checks.some((check) => check.id.includes(":stalled") && check.status === "warn")).toBe(true);
    expect(renderSetupStatus(report)).toContain("state=stalled");
    expect(renderSetupValidate(report)).toContain("leased to a stale session");
  });

  it("explains blocked recurring jobs with task title and latest block reason", () => {
    writeGlobal({
      agents: {
        worker: {
          extends: "employee",
          jobs: {
            blocked_job: { cron: "*/20 * * * *" },
          },
        },
      },
    });
    writeDomain("test", {
      agents: ["worker"],
      manager: { agentId: "worker" },
      paths: [tmpDir],
    });

    const dbDir = path.join(tmpDir, "test");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, "clawforce.db"), { open: true });
    try {
      db.exec(`
        CREATE TABLE project_metadata (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (project_id, key)
        );
        CREATE TABLE controller_leases (
          project_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          owner_label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          generation INTEGER,
          required_generation INTEGER,
          requested_by TEXT,
          requested_reason TEXT,
          request_metadata TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT,
          state TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE transitions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO project_metadata (project_id, key, value)
        VALUES (?, ?, ?)
      `).run("test", "recurring_job:worker:blocked_job:last_scheduled_at", String(Date.now()));
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, metadata, created_at)
        VALUES (?, ?, ?, 'BLOCKED', ?, ?)
      `).run(
        "blocked-task-id",
        "test",
        "Run recurring workflow worker.blocked_job",
        JSON.stringify({ recurringJob: { agentId: "worker", jobName: "blocked_job" } }),
        Date.now(),
      );
      db.prepare(`
        INSERT INTO transitions (id, task_id, from_state, to_state, actor, reason, created_at)
        VALUES (?, ?, ?, 'BLOCKED', ?, ?, ?)
      `).run(
        "transition-1",
        "blocked-task-id",
        "ASSIGNED",
        "system:router",
        "Dispatch retries exhausted; operator review required",
        Date.now(),
      );
    } finally {
      db.close();
    }

    const report = buildSetupReport(tmpDir, "test");

    expect(renderSetupStatus(report)).toContain('title="Run recurring workflow worker.blocked_job"');
    expect(renderSetupStatus(report)).toContain('reason="Dispatch retries exhausted; operator review required"');
    expect(renderSetupValidate(report)).toContain('Latest reason: Dispatch retries exhausted; operator review required.');
    expect(renderSetupExplain(report)).toContain("diagnosis=attention-needed");
    expect(renderSetupExplain(report)).toContain("state=blocked");
  });
});
