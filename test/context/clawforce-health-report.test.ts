import type { DatabaseSync } from "../../src/sqlite-driver.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { buildClawforceHealthReport } = await import(
  "../../src/context/sources/clawforce-health-report.js"
);

describe("clawforce-health-report", () => {
  let db: DatabaseSync;
  let tmpDir: string;
  const PROJECT = "cf-health-test";

  beforeEach(() => {
    db = getMemoryDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-health-"));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders basic health report with empty DB", () => {
    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).not.toBeNull();
    expect(result).toContain("## ClawForce Health Report");
    expect(result).toContain("**Compliance:** 0%");
    expect(result).toContain("**Completion:** 0%");
    expect(result).toContain("**Avg cost:** $0.00/session");
    expect(result).toContain("**Evidence rate:** 0%");
    expect(result).toContain("**TODOs:** 0");
  });

  it("calculates compliance rate from audit_runs", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, status, ended_at) VALUES (?, ?, ?, ?, ?)",
    ).run("a1", PROJECT, "worker-1", "compliant", now - 1000);
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, status, ended_at) VALUES (?, ?, ?, ?, ?)",
    ).run("a2", PROJECT, "worker-1", "compliant", now - 2000);
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, status, ended_at) VALUES (?, ?, ?, ?, ?)",
    ).run("a3", PROJECT, "worker-1", "non_compliant", now - 3000);
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, status, ended_at) VALUES (?, ?, ?, ?, ?)",
    ).run("a4", PROJECT, "worker-1", "non_compliant", now - 4000);

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).toContain("**Compliance:** 50%");
  });

  it("calculates task completion rate", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t1", PROJECT, "Task 1", "DONE", "P2", "test", now, now);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t2", PROJECT, "Task 2", "DONE", "P2", "test", now, now);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t3", PROJECT, "Task 3", "IN_PROGRESS", "P1", "test", now, now);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t4", PROJECT, "Task 4", "OPEN", "P2", "test", now, now);

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).toContain("**Completion:** 50%");
  });

  it("calculates average cost per session", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO cost_records (id, project_id, agent_id, cost_cents, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("c1", PROJECT, "worker-1", 50, now - 1000);
    db.prepare(
      "INSERT INTO cost_records (id, project_id, agent_id, cost_cents, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("c2", PROJECT, "worker-1", 30, now - 2000);

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    // Average of 50 and 30 = 40 cents = $0.40
    expect(result).toContain("**Avg cost:** $0.40/session");
  });

  it("counts TODOs from source tree", () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "file1.ts"),
      "// TODO: fix this\n// FIXME: broken\nconst x = 1;\n// TODO another",
    );
    fs.writeFileSync(path.join(srcDir, "file2.ts"), "// clean file\nconst y = 2;");

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).toContain("**TODOs:** 3");
  });

  it("lists unimplemented specs", () => {
    const specsDir = path.join(tmpDir, "docs", "superpowers", "specs");
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, "fancy-feature.md"), "# Spec");
    fs.writeFileSync(path.join(specsDir, "another-spec.md"), "# Another");

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).toContain("### Unimplemented Specs");
    expect(result).toContain("- fancy-feature.md");
    expect(result).toContain("- another-spec.md");
  });

  it("shows recent issues from non-compliant audit runs", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO audit_runs (id, project_id, agent_id, status, summary, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("a1", PROJECT, "worker-1", "non_compliant", "Missing evidence", now - 1000);

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).toContain("### Recent Issues");
    expect(result).toContain("**worker-1**: Missing evidence");
  });

  it("stays under 2KB", () => {
    const now = Date.now();
    // Insert plenty of data
    for (let i = 0; i < 20; i++) {
      db.prepare(
        "INSERT INTO audit_runs (id, project_id, agent_id, status, summary, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(`a${i}`, PROJECT, `worker-${i}`, "non_compliant", `Issue ${i}: something went wrong`, now - i * 1000);
    }

    const specsDir = path.join(tmpDir, "docs", "superpowers", "specs");
    fs.mkdirSync(specsDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(specsDir, `spec-${i}.md`), "# Spec");
    }

    const result = buildClawforceHealthReport(PROJECT, tmpDir, db);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(2048);
  });

  it("works without projectDir", () => {
    const result = buildClawforceHealthReport(PROJECT, undefined, db);
    expect(result).not.toBeNull();
    expect(result).toContain("## ClawForce Health Report");
    expect(result).toContain("**TODOs:** 0");
  });
});
