import type { DatabaseSync } from "node:sqlite";
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
const { buildMemoryContext } = await import("../../src/context/sources/memory.js");
import type { AgentConfig } from "../../src/types.js";

describe("memory context source", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  function insertMemory(opts: {
    scope: string;
    title: string;
    content?: string;
    category?: string;
    confidence?: number;
    validation_count?: number;
    deprecated?: boolean;
  }) {
    const id = `mem-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO memory (id, project_id, scope, category, title, content, confidence, validation_count, deprecated, created_at, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, PROJECT,
      opts.scope,
      opts.category ?? "learning",
      opts.title,
      opts.content ?? "Test content",
      opts.confidence ?? 0.7,
      opts.validation_count ?? 1,
      opts.deprecated ? 1 : 0,
      now, now,
    );
    return id;
  }

  const baseConfig: AgentConfig = {
    role: "employee",
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" },
  };

  it("returns null when no memories exist", () => {
    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db);
    expect(result).toBeNull();
  });

  it("returns markdown with matching memories", () => {
    insertMemory({ scope: "agent:my-agent", title: "Personal note" });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db);
    expect(result).not.toBeNull();
    expect(result).toContain("## Shared Memory");
    expect(result).toContain("Personal note");
    expect(result).toContain("Personal (my-agent)");
  });

  it("derives scopes from agent config", () => {
    const config: AgentConfig = {
      ...baseConfig,
      role: "scheduled",
      team: "outreach",
      department: "sales",
    };

    insertMemory({ scope: "agent:lead-gen", title: "Personal" });
    insertMemory({ scope: "team:outreach", title: "Team knowledge" });
    insertMemory({ scope: "dept:sales", title: "Dept knowledge" });
    insertMemory({ scope: "role:scheduled", title: "Role knowledge" });
    insertMemory({ scope: "team:engineering", title: "Wrong team" }); // should not match

    const result = buildMemoryContext(PROJECT, "lead-gen", config, db);
    expect(result).not.toBeNull();
    expect(result).toContain("Personal");
    expect(result).toContain("Team knowledge");
    expect(result).toContain("Dept knowledge");
    expect(result).toContain("Role knowledge");
    expect(result).not.toContain("Wrong team");
  });

  it("excludes deprecated entries", () => {
    insertMemory({ scope: "agent:my-agent", title: "Active memory" });
    insertMemory({ scope: "agent:my-agent", title: "Deprecated memory", deprecated: true });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db);
    expect(result).toContain("Active memory");
    expect(result).not.toContain("Deprecated memory");
  });

  it("orders by quality signal", () => {
    insertMemory({ scope: "agent:my-agent", title: "Low quality", confidence: 0.3, validation_count: 1 });
    insertMemory({ scope: "agent:my-agent", title: "High quality", confidence: 0.9, validation_count: 3 });
    insertMemory({ scope: "agent:my-agent", title: "Medium quality", confidence: 0.7, validation_count: 2 });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db)!;
    const highIdx = result.indexOf("High quality");
    const medIdx = result.indexOf("Medium quality");
    const lowIdx = result.indexOf("Low quality");

    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("groups by scope", () => {
    insertMemory({ scope: "agent:my-agent", title: "Personal learning" });
    insertMemory({ scope: "role:employee", title: "Role learning" });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db)!;
    expect(result).toContain("### Personal (my-agent)");
    expect(result).toContain("### Role: employee");
  });

  it("shows validation count for confirmed memories", () => {
    insertMemory({ scope: "agent:my-agent", title: "Confirmed", validation_count: 5 });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db)!;
    expect(result).toContain("confirmed 5x");
  });

  it("truncates long content", () => {
    const longContent = "x".repeat(300);
    insertMemory({ scope: "agent:my-agent", title: "Long", content: longContent });

    const result = buildMemoryContext(PROJECT, "my-agent", baseConfig, db)!;
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longContent.length + 500);
  });
});
