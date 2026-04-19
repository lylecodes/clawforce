import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

describe("knowledge demotion flags", () => {
  let db: DatabaseSync;
  const PROJECT = "demotion-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a knowledge flag", async () => {
    const { createFlag, getFlag } = await import("../../src/memory/demotion.js");

    const flag = createFlag({
      projectId: PROJECT,
      agentId: "frontend",
      sourceType: "soul",
      sourceRef: "SOUL.md",
      flaggedContent: "Always use REST APIs",
      correction: "GraphQL is preferred for this project",
      severity: "high",
    }, db);

    expect(flag.status).toBe("pending");
    const fetched = getFlag(PROJECT, flag.id, db);
    expect(fetched!.flaggedContent).toContain("REST");
    expect(fetched!.correction).toContain("GraphQL");
  });

  it("resolves and dismisses flags", async () => {
    const { createFlag, resolveFlag, dismissFlag, getFlag } = await import("../../src/memory/demotion.js");

    const f1 = createFlag({ projectId: PROJECT, agentId: "frontend", sourceType: "skill", sourceRef: "api-patterns", flaggedContent: "X", correction: "Y", severity: "medium" }, db);
    const f2 = createFlag({ projectId: PROJECT, agentId: "frontend", sourceType: "skill", sourceRef: "api-patterns", flaggedContent: "A", correction: "B", severity: "low" }, db);

    resolveFlag(PROJECT, f1.id, db);
    dismissFlag(PROJECT, f2.id, db);

    expect(getFlag(PROJECT, f1.id, db)!.status).toBe("resolved");
    expect(getFlag(PROJECT, f2.id, db)!.status).toBe("dismissed");
  });

  it("lists pending flags", async () => {
    const { createFlag, resolveFlag, listFlags } = await import("../../src/memory/demotion.js");

    createFlag({ projectId: PROJECT, agentId: "a", sourceType: "soul", sourceRef: "SOUL.md", flaggedContent: "X", correction: "Y", severity: "high" }, db);
    const f2 = createFlag({ projectId: PROJECT, agentId: "a", sourceType: "soul", sourceRef: "SOUL.md", flaggedContent: "A", correction: "B", severity: "low" }, db);
    resolveFlag(PROJECT, f2.id, db);

    const pending = listFlags(PROJECT, "pending", db);
    expect(pending).toHaveLength(1);
  });
});
