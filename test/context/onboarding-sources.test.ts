import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("onboarding sources", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE onboarding_state (
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, key)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        state TEXT,
        assigned_to TEXT,
        priority TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE cost_records (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT,
        cost_cents INTEGER,
        created_at INTEGER
      );
      CREATE TABLE audit_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT,
        session_key TEXT,
        status TEXT,
        ended_at INTEGER
      );
      CREATE INDEX idx_audit_runs_agent_ended ON audit_runs(agent_id, ended_at);
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe("welcome source", () => {
    it("returns welcome content for fresh domain", async () => {
      const { resolveWelcomeSource } = await import("../../src/context/sources/onboarding-sources.js");

      const result = resolveWelcomeSource("test-project", db, {
        agentCount: 3,
        domainName: "test-project",
      });

      expect(result).toContain("Welcome");
      expect(result).toContain("3 agents");
    });

    it("returns null after welcome has been delivered", async () => {
      const { resolveWelcomeSource } = await import("../../src/context/sources/onboarding-sources.js");

      // Mark welcome as delivered
      db.prepare(`
        INSERT INTO onboarding_state (project_id, key, value, updated_at)
        VALUES ('test-project', 'welcome_delivered', 'true', ?)
      `).run(Date.now());

      const result = resolveWelcomeSource("test-project", db, {
        agentCount: 3,
        domainName: "test-project",
      });

      expect(result).toBeNull();
    });
  });

  describe("intervention source", () => {
    it("detects idle agents", async () => {
      const { resolveInterventionSource } = await import("../../src/context/sources/onboarding-sources.js");

      // Agent with no completions in 48h
      const twoDaysAgo = Date.now() - 48 * 3600 * 1000 - 1;
      db.prepare(`INSERT INTO tasks (id, project_id, title, state, assigned_to, priority, created_at, updated_at) VALUES ('t1', 'test-project', 'Old task', 'ASSIGNED', 'idle-agent', 'P2', ?, ?)`).run(twoDaysAgo, twoDaysAgo);

      const result = resolveInterventionSource("test-project", db, ["idle-agent"]);
      expect(result).toContain("idle");
    });
  });
});
