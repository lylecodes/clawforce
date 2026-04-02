/**
 * CLI org command tests — cf org, cf org check, cf org set
 *
 * These commands read from YAML config files using the HOME-based path constants
 * that are set at module load time. To test them, we mock the fs module to
 * intercept file reads and return our test YAML data.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";

// Mock diagnostics
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

import { runMigrations } from "../../src/migrations.js";

// ─── Helpers ────────────────────────────────────────────────────────

const PROJECT_ID = "test-domain";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedOrgTestData(db: DatabaseSync): void {
  const now = Date.now();

  // Active sessions
  db.prepare(`
    INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
    VALUES (?, ?, ?, ?, '[]', '[]', 10, ?)
  `).run("agent:cf-lead:cron:active-1", "cf-lead", PROJECT_ID, now - 300_000, now);

  // Cost records for today
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, session_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, model, source, created_at)
    VALUES (?, ?, ?, ?, 5000, 2000, 1000, 500, 800, 'claude-opus-4-6', 'dispatch', ?)
  `).run("cost-org-1", PROJECT_ID, "cf-lead", "agent:cf-lead:cron:active-1", midnight.getTime() + 3600_000);

  // Tasks
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
    VALUES (?, ?, 'Org test task', 'IN_PROGRESS', 'P1', 'cf-worker-1', 'system', ?, ?, 0, 3)
  `).run("task-org-1", PROJECT_ID, now - 3600_000, now);
}

// ─── Console capture ────────────────────────────────────────────────

let logOutput: string[];
let errorOutput: string[];
const originalLog = console.log;
const originalError = console.error;

function captureStart(): void {
  logOutput = [];
  errorOutput = [];
  console.log = (...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  };
}

function captureStop(): string {
  console.log = originalLog;
  console.error = originalError;
  return logOutput.join("\n");
}

function getLogOutput(): string {
  return logOutput.join("\n");
}

function getErrorOutput(): string {
  return errorOutput.join("\n");
}

// ─── Standard test org structure ────────────────────────────────────

const STANDARD_AGENTS: Record<string, object> = {
  "cf-lead": {
    extends: "manager",
    title: "Team Lead",
    department: "engineering",
    team: "core",
    reports_to: "parent",
    coordination: { enabled: true },
    observe: [
      { pattern: "task.*", scope: { team: "core" } },
    ],
  },
  "cf-worker-1": {
    extends: "agent",
    title: "Worker 1",
    department: "engineering",
    team: "core",
    reports_to: "cf-lead",
  },
  "cf-worker-2": {
    extends: "agent",
    title: "Worker 2",
    department: "engineering",
    team: "core",
    reports_to: "cf-lead",
  },
  "cf-verifier": {
    extends: "verifier",
    title: "Code Verifier",
    department: "engineering",
    team: "core",
    reports_to: "cf-lead",
  },
};

const STANDARD_DOMAIN_AGENTS = ["cf-lead", "cf-worker-1", "cf-worker-2", "cf-verifier"];

// ─── FS mock setup ──────────────────────────────────────────────────

// The org module reads files from HOME-based paths. We mock fs to intercept.
// We store what config+domain YAML should return.
let mockConfigYaml = "";
let mockDomainYaml = "";
let mockWrittenFiles: Record<string, string> = {};

// Store references to the original fs functions
import fs from "node:fs";
const origExistsSync = fs.existsSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);

function setupFsMocks(agents: Record<string, object>, domainAgents: string[]): void {
  mockConfigYaml = YAML.stringify({ agents });
  mockDomainYaml = YAML.stringify({ agents: domainAgents, enabled: true });
  mockWrittenFiles = {};

  // Override fs functions using vi.spyOn
  vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
    const pathStr = String(p);
    if (pathStr.endsWith("config.yaml")) return true;
    if (pathStr.endsWith(`${PROJECT_ID}.yaml`)) return true;
    if (pathStr.endsWith("domains")) return true;
    return origExistsSync(p);
  });

  vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, options?: unknown) => {
    const pathStr = String(p);
    if (pathStr.endsWith("config.yaml")) {
      // If we wrote to it, return the written content
      if (mockWrittenFiles[pathStr]) return mockWrittenFiles[pathStr]!;
      return mockConfigYaml;
    }
    if (pathStr.endsWith(`${PROJECT_ID}.yaml`)) return mockDomainYaml;
    return origReadFileSync(p, options as BufferEncoding);
  });

  vi.spyOn(fs, "writeFileSync").mockImplementation((p: fs.PathOrFileDescriptor, data: unknown) => {
    mockWrittenFiles[String(p)] = String(data);
  });

  vi.spyOn(fs, "readdirSync").mockImplementation((() => {
    return [`${PROJECT_ID}.yaml`];
  }) as unknown as typeof fs.readdirSync);
}

function clearFsMocks(): void {
  vi.restoreAllMocks();
  mockWrittenFiles = {};
}

import { cmdOrg, cmdOrgCheck, cmdOrgSet } from "../../src/cli/org.js";

// ─── Test Suite ─────────────────────────────────────────────────────

describe("CLI org commands", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    seedOrgTestData(db);
    captureStart();
  });

  afterEach(() => {
    captureStop();
    clearFsMocks();
    try { db.close(); } catch { /* ignore */ }
  });

  // ─── cmdOrg ───────────────────────────────────────────────────

  describe("cmdOrg", () => {
    it("renders the org tree", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(db, PROJECT_ID, {});
      const output = getLogOutput();
      expect(output).toContain(PROJECT_ID);
      expect(output).toContain("cf-lead");
      expect(output).toContain("cf-worker-1");
      expect(output).toContain("manager");
    });

    it("works with null db (no runtime enrichment)", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, {});
      const output = getLogOutput();
      expect(output).toContain("cf-lead");
      expect(output).toContain("idle");
    });

    it("filters by team", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, { team: "core" });
      const output = getLogOutput();
      expect(output).toContain("cf-worker-1");
    });

    it("filters by agent", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, { agent: "cf-worker-1" });
      const output = getLogOutput();
      expect(output).toContain("cf-worker-1");
      // Should also include the parent
      expect(output).toContain("cf-lead");
    });

    it("shows observe rules", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, {});
      const output = getLogOutput();
      expect(output).toContain("observes:");
    });

    it("shows no agents when config is empty", () => {
      setupFsMocks({}, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, {});
      const output = getErrorOutput();
      expect(output).toContain("No agents found in config");
    });

    it("shows no agents when domain has no agents", () => {
      setupFsMocks(STANDARD_AGENTS, []);
      cmdOrg(null, PROJECT_ID, {});
      const output = getErrorOutput();
      expect(output).toContain("No agents found in domain");
    });

    it("shows cost data with DB enrichment", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(db, PROJECT_ID, {});
      const output = getLogOutput();
      // cf-lead has cost data from cost_records
      expect(output).toMatch(/cf-lead.*\$8\.00/);
    });

    it("shows no agents in scope for nonexistent team filter", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, { team: "nonexistent-team" });
      const output = getLogOutput();
      expect(output).toContain("no agents in scope");
    });

    it("shows no agents in scope for nonexistent agent filter", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrg(null, PROJECT_ID, { agent: "nonexistent-agent" });
      const output = getLogOutput();
      expect(output).toContain("no agents in scope");
    });
  });

  // ─── cmdOrgCheck ──────────────────────────────────────────────

  describe("cmdOrgCheck", () => {
    it("runs structural audit", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgCheck(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("org check");
      expect(output).toContain("Structure:");
      expect(output).toContain("No cycles");
    });

    it("works with null db", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      expect(() => cmdOrgCheck(null, PROJECT_ID)).not.toThrow();
    });

    it("detects reporting chain cycles", () => {
      const cyclicAgents: Record<string, object> = {
        "a": { extends: "manager", reports_to: "b" },
        "b": { extends: "agent", reports_to: "a" },
      };
      setupFsMocks(cyclicAgents, ["a", "b"]);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Cycle detected");
    });

    it("detects missing reports_to targets", () => {
      const brokenAgents: Record<string, object> = {
        "orphan": { extends: "agent", reports_to: "nonexistent" },
      };
      setupFsMocks(brokenAgents, ["orphan"]);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("does not exist");
    });

    it("detects teams without verifiers", () => {
      const noVerifierAgents: Record<string, object> = {
        "lead": { extends: "manager", team: "core", reports_to: "parent" },
        "worker": { extends: "agent", team: "core", reports_to: "lead" },
      };
      setupFsMocks(noVerifierAgents, ["lead", "worker"]);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("no verifier");
    });

    it("detects managers with 0 direct reports", () => {
      const lonelyManager: Record<string, object> = {
        "mgr": { extends: "manager", team: "core", reports_to: "parent" },
      };
      setupFsMocks(lonelyManager, ["mgr"]);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("0 direct reports");
    });

    it("shows visibility per manager", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Visibility per manager:");
      expect(output).toContain("cf-lead:");
      expect(output).toContain("Direct reports:");
    });

    it("reports all checks passed on clean org", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("All checks passed");
    });

    it("counts issues for problematic org", () => {
      const problematicAgents: Record<string, object> = {
        "mgr-1": { extends: "manager", team: "alpha", reports_to: "parent" },
        "mgr-2": { extends: "manager", team: "beta", reports_to: "parent" },
        "lone-worker": { extends: "agent", team: "alpha", reports_to: "nonexistent" },
      };
      setupFsMocks(problematicAgents, ["mgr-1", "mgr-2", "lone-worker"]);
      cmdOrgCheck(null, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("issue");
      expect(output).not.toContain("All checks passed");
    });
  });

  // ─── cmdOrgSet ────────────────────────────────────────────────

  describe("cmdOrgSet", () => {
    it("rewires reporting chain (dry run)", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgSet("cf-worker-1", "cf-verifier", { dryRun: true });
      const output = getLogOutput();
      expect(output).toContain("org set");
      expect(output).toContain("cf-lead");
      expect(output).toContain("cf-verifier");
      expect(output).toContain("DRY RUN");
    });

    it("applies change when not dry run", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgSet("cf-worker-1", "cf-verifier", {});
      const output = getLogOutput();
      expect(output).toContain("Applied");

      // Verify the mock writeFileSync was called
      const writtenPaths = Object.keys(mockWrittenFiles);
      expect(writtenPaths.length).toBeGreaterThan(0);

      // Parse the written content
      const writtenContent = Object.values(mockWrittenFiles)[0]!;
      const parsed = YAML.parse(writtenContent) as { agents: Record<string, { reports_to?: string }> };
      expect(parsed.agents["cf-worker-1"]!.reports_to).toBe("cf-verifier");
    });

    it("clears reports_to with 'none'", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgSet("cf-worker-1", "none", {});
      const output = getLogOutput();
      expect(output).toContain("(none)");

      // Verify reports_to was removed
      const writtenContent = Object.values(mockWrittenFiles)[0]!;
      const parsed = YAML.parse(writtenContent) as { agents: Record<string, { reports_to?: string }> };
      expect(parsed.agents["cf-worker-1"]!.reports_to).toBeUndefined();
    });

    it("shows consequences (report count, escalation routing)", () => {
      setupFsMocks(STANDARD_AGENTS, STANDARD_DOMAIN_AGENTS);
      cmdOrgSet("cf-worker-1", "cf-verifier", { dryRun: true });
      const output = getLogOutput();
      expect(output).toContain("This will:");
      expect(output).toContain("Route");
    });
  });
});
