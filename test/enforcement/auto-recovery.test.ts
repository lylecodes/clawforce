import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

// Mock getAgentConfig to return auto_recovery settings
const mockGetAgentConfig = vi.fn();
vi.mock("../../src/project.js", async () => {
  const actual = await vi.importActual("../../src/project.js");
  return {
    ...(actual as Record<string, unknown>),
    getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
  };
});

const { getMemoryDb } = await import("../../src/db.js");
const { disableAgent, isAgentDisabled, listDisabledAgents } = await import("../../src/enforcement/disabled-store.js");
const { checkAutoRecovery } = await import("../../src/enforcement/auto-recovery.js");
const { listEvents } = await import("../../src/events/store.js");

describe("auto-recovery", () => {
  let db: DatabaseSync;
  const PROJECT = "test-recovery";

  beforeEach(() => {
    db = getMemoryDb();
    mockGetAgentConfig.mockReset();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("does not recover agents without auto_recovery config", () => {
    disableAgent(PROJECT, "agent:worker", "consecutive failures", db);
    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: undefined },
    });

    const result = checkAutoRecovery(PROJECT, db);
    expect(result.recovered).toBe(0);
    expect(isAgentDisabled(PROJECT, "agent:worker", db)).toBe(true);
  });

  it("does not recover agents before cooldown expires", () => {
    disableAgent(PROJECT, "agent:worker", "consecutive failures", db);
    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: { enabled: true, cooldown_minutes: 10 } },
    });

    // Agent was just disabled — cooldown hasn't expired
    const result = checkAutoRecovery(PROJECT, db);
    expect(result.recovered).toBe(0);
    expect(isAgentDisabled(PROJECT, "agent:worker", db)).toBe(true);
  });

  it("recovers agent after cooldown expires", () => {
    // Manually insert a disabled agent with old timestamp
    const pastTime = Date.now() - 15 * 60 * 1000; // 15 minutes ago
    db.prepare(`
      INSERT INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("test-id", PROJECT, "agent:worker", "consecutive failures", pastTime);

    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: { enabled: true, cooldown_minutes: 10 } },
    });

    const result = checkAutoRecovery(PROJECT, db);
    expect(result.recovered).toBe(1);
    expect(isAgentDisabled(PROJECT, "agent:worker", db)).toBe(false);
  });

  it("emits agent_recovered event on recovery", () => {
    const pastTime = Date.now() - 15 * 60 * 1000;
    db.prepare(`
      INSERT INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("test-id-2", PROJECT, "agent:worker", "test failure", pastTime);

    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: { enabled: true, cooldown_minutes: 10 } },
    });

    checkAutoRecovery(PROJECT, db);

    const events = listEvents(PROJECT, { type: "agent_recovered" }, db);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.payload.agentId).toBe("agent:worker");
  });

  it("emits escalation event when disabled > 2x cooldown", () => {
    // Disabled 25 minutes ago with 10-minute cooldown → 2.5x cooldown
    const pastTime = Date.now() - 25 * 60 * 1000;
    db.prepare(`
      INSERT INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("test-id-3", PROJECT, "agent:worker", "repeated failure", pastTime);

    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: { enabled: true, cooldown_minutes: 10 } },
    });

    const result = checkAutoRecovery(PROJECT, db);
    expect(result.recovered).toBe(1);
    expect(result.escalated).toBe(1);

    const events = listEvents(PROJECT, { type: "agent_recovery_escalation" }, db);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("does not recover when auto_recovery.enabled is false", () => {
    const pastTime = Date.now() - 15 * 60 * 1000;
    db.prepare(`
      INSERT INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("test-id-4", PROJECT, "agent:worker", "failures", pastTime);

    mockGetAgentConfig.mockReturnValue({
      config: { auto_recovery: { enabled: false, cooldown_minutes: 10 } },
    });

    const result = checkAutoRecovery(PROJECT, db);
    expect(result.recovered).toBe(0);
    expect(isAgentDisabled(PROJECT, "agent:worker", db)).toBe(true);
  });
});
