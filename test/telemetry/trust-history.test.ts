import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  snapshotTrustScore,
  getTrustTimeline,
} = await import("../../src/telemetry/trust-history.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-telemetry";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("snapshotTrustScore", () => {
  it("creates a trust score snapshot", () => {
    const snapshot = snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-1",
      score: 0.85,
      tier: "high",
      triggerType: "trust_decision",
      triggerId: "decision-1",
      categoryScores: { "email:send": 0.9, "code:deploy": 0.8 },
    }, db);

    expect(snapshot.id).toBeDefined();
    expect(snapshot.score).toBe(0.85);
    expect(snapshot.tier).toBe("high");
    expect(snapshot.triggerType).toBe("trust_decision");
    expect(snapshot.createdAt).toBeGreaterThan(0);
  });

  it("stores category scores as JSON", () => {
    snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-1",
      score: 0.75,
      tier: "medium",
      triggerType: "trust_decision",
      categoryScores: { "file:write": 0.95, "email:send": 0.55 },
    }, db);

    const timeline = getTrustTimeline(PROJECT, "agent-1", undefined, db);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.categoryScores).toEqual({
      "file:write": 0.95,
      "email:send": 0.55,
    });
  });

  it("handles snapshot without agent ID", () => {
    const snapshot = snapshotTrustScore({
      projectId: PROJECT,
      score: 0.9,
      tier: "high",
      triggerType: "manual",
    }, db);

    expect(snapshot.agentId).toBeUndefined();
  });
});

describe("getTrustTimeline", () => {
  it("returns snapshots in chronological order", () => {
    // Insert with explicit timestamps to guarantee ordering
    const baseTime = Date.now() - 30_000;
    const crypto = require("node:crypto");

    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, trigger_id, category_scores, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, "agent-1", 0.7, "medium", "trust_decision", null, null, baseTime);
    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, trigger_id, category_scores, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, "agent-1", 0.8, "high", "trust_decision", null, null, baseTime + 10_000);
    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, trigger_id, category_scores, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, "agent-1", 0.6, "medium", "trust_decision", null, null, baseTime + 20_000);

    const timeline = getTrustTimeline(PROJECT, "agent-1", undefined, db);
    expect(timeline).toHaveLength(3);
    expect(timeline[0]!.score).toBe(0.7);
    expect(timeline[1]!.score).toBe(0.8);
    expect(timeline[2]!.score).toBe(0.6);
  });

  it("filters by agent ID", () => {
    snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-a",
      score: 0.9,
      tier: "high",
      triggerType: "trust_decision",
    }, db);
    snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-b",
      score: 0.5,
      tier: "medium",
      triggerType: "trust_decision",
    }, db);

    const timelineA = getTrustTimeline(PROJECT, "agent-a", undefined, db);
    expect(timelineA).toHaveLength(1);
    expect(timelineA[0]!.agentId).toBe("agent-a");
  });

  it("returns all agents when agentId is not specified", () => {
    snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-a",
      score: 0.9,
      tier: "high",
      triggerType: "trust_decision",
    }, db);
    snapshotTrustScore({
      projectId: PROJECT,
      agentId: "agent-b",
      score: 0.5,
      tier: "medium",
      triggerType: "trust_decision",
    }, db);

    const timeline = getTrustTimeline(PROJECT, undefined, undefined, db);
    expect(timeline).toHaveLength(2);
  });

  it("filters by since timestamp", () => {
    const crypto = require("node:crypto");
    const baseTime = Date.now() - 20_000;

    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, trigger_id, category_scores, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, "agent-1", 0.7, "medium", "trust_decision", null, null, baseTime);

    const midpoint = baseTime + 5_000;

    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, trigger_id, category_scores, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, "agent-1", 0.9, "high", "trust_decision", null, null, baseTime + 10_000);

    const filtered = getTrustTimeline(PROJECT, "agent-1", midpoint, db);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.score).toBe(0.9);
  });

  it("returns empty array for no snapshots", () => {
    const timeline = getTrustTimeline(PROJECT, undefined, undefined, db);
    expect(timeline).toHaveLength(0);
  });
});
