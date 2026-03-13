import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

describe("domain-based lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-lifecycle-"));
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  });

  afterEach(async () => {
    const { closeAllDbs } = await import("../../src/db.js");
    closeAllDbs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates domain database in data directory", async () => {
    const { setDataDir, getDbByDomain } = await import("../../src/db.js");
    setDataDir(path.join(tmpDir, "data"));

    const db = getDbByDomain("rentright");
    expect(db).toBeDefined();

    const dbPath = path.join(tmpDir, "data", "rentright.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("reuses cached domain database", async () => {
    const { setDataDir, getDbByDomain } = await import("../../src/db.js");
    setDataDir(path.join(tmpDir, "data"));

    const db1 = getDbByDomain("cached-test");
    const db2 = getDbByDomain("cached-test");
    expect(db1).toBe(db2);
  });

  it("tracks registered domains", async () => {
    const { registerDomain, unregisterDomain, getActiveDomainIds } = await import("../../src/lifecycle.js");

    registerDomain("alpha");
    registerDomain("beta");
    expect(getActiveDomainIds()).toContain("alpha");
    expect(getActiveDomainIds()).toContain("beta");

    unregisterDomain("alpha");
    expect(getActiveDomainIds()).not.toContain("alpha");
    expect(getActiveDomainIds()).toContain("beta");

    // cleanup
    unregisterDomain("beta");
  });

  it("domain functions are aliases for project functions", async () => {
    const { registerDomain, getActiveProjectIds, registerProject, getActiveDomainIds } = await import("../../src/lifecycle.js");

    registerDomain("via-domain");
    expect(getActiveProjectIds()).toContain("via-domain");

    registerProject("via-project");
    expect(getActiveDomainIds()).toContain("via-project");

    // cleanup
    const { unregisterProject } = await import("../../src/lifecycle.js");
    unregisterProject("via-domain");
    unregisterProject("via-project");
  });
});
