import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const {
  acquireControllerLease,
  getControllerLease,
  markControllerLeaseConfigApplied,
  requestControllerGeneration,
  resetControllerIdentityForTest,
  releaseControllerLease,
} = await import("../../src/runtime/controller-leases.js");

describe("runtime/controller-leases", () => {
  let db: DatabaseSync;
  const PROJECT = "lease-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    resetControllerIdentityForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("acquires and reads a new lease", () => {
    const acquired = acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "sweep",
    }, db);

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const lease = getControllerLease(PROJECT, db);
    expect(lease?.ownerId).toBe("controller:a");
    expect(lease?.ownerLabel).toBe("owner-a");
    expect(lease?.purpose).toBe("sweep");
  });

  it("blocks a foreign active owner", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "sweep",
      ttlMs: 60_000,
    }, db);

    const blocked = acquireControllerLease(PROJECT, {
      ownerId: "controller:b",
      ownerLabel: "owner-b",
      purpose: "process_and_dispatch",
      ttlMs: 60_000,
    }, db);

    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.lease.ownerId).toBe("controller:a");
  });

  it("allows takeover after expiry", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "sweep",
      ttlMs: -1,
    }, db);

    const takeover = acquireControllerLease(PROJECT, {
      ownerId: "controller:b",
      ownerLabel: "owner-b",
      purpose: "process_and_dispatch",
    }, db);

    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.lease.ownerId).toBe("controller:b");
  });

  it("records applied config markers for the active owner", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "controller",
      generation: "gen-a",
    }, db);

    const marked = markControllerLeaseConfigApplied(PROJECT, "version-1", "hash-abc", {
      ownerId: "controller:a",
      appliedAt: 1234,
    }, db);

    expect(marked?.appliedConfigVersionId).toBe("version-1");
    expect(marked?.appliedConfigHash).toBe("hash-abc");
    expect(marked?.appliedConfigAppliedAt).toBe(1234);
    expect(getControllerLease(PROJECT, db)?.appliedConfigHash).toBe("hash-abc");
  });

  it("clears applied config markers when a new owner takes over", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "controller",
      generation: "gen-a",
      ttlMs: -1,
    }, db);
    markControllerLeaseConfigApplied(PROJECT, "version-1", "hash-abc", {
      ownerId: "controller:a",
      appliedAt: 1234,
    }, db);

    const takeover = acquireControllerLease(PROJECT, {
      ownerId: "controller:b",
      ownerLabel: "owner-b",
      purpose: "controller",
      generation: "gen-b",
      ttlMs: 60_000,
    }, db);

    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.lease.appliedConfigHash).toBeNull();
    expect(takeover.lease.appliedConfigVersionId).toBeNull();
    expect(takeover.lease.appliedConfigAppliedAt).toBeNull();
  });

  it("releases only the matching owner lease", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:a",
      ownerLabel: "owner-a",
      purpose: "sweep",
    }, db);

    expect(releaseControllerLease(PROJECT, "controller:b", db)).toBe(false);
    expect(getControllerLease(PROJECT, db)?.ownerId).toBe("controller:a");
    expect(releaseControllerLease(PROJECT, "controller:a", db)).toBe(true);
    expect(getControllerLease(PROJECT, db)).toBeNull();
  });

  it("forces a generation handoff when a newer generation is required", () => {
    acquireControllerLease(PROJECT, {
      ownerId: "controller:old",
      ownerLabel: "owner-old",
      purpose: "lifecycle",
      ttlMs: 60_000,
      generation: "gen-old",
    }, db);

    const requested = requestControllerGeneration(PROJECT, {
      generation: "gen-new",
      reason: "proposal_approved:proposal-1",
    }, db);
    expect(requested.requiredGeneration).toBe("gen-new");

    const blocked = acquireControllerLease(PROJECT, {
      ownerId: "controller:old",
      ownerLabel: "owner-old",
      purpose: "lifecycle",
      ttlMs: 60_000,
      generation: "gen-old",
    }, db);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.lease.requiredGeneration).toBe("gen-new");

    const takeover = acquireControllerLease(PROJECT, {
      ownerId: "controller:new",
      ownerLabel: "owner-new",
      purpose: "process_and_dispatch",
      ttlMs: 60_000,
      generation: "gen-new",
    }, db);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.lease.ownerId).toBe("controller:new");
    expect(takeover.lease.generation).toBe("gen-new");
    expect(takeover.lease.requiredGeneration).toBe("gen-new");
  });

  it("preserves the generation floor after a current controller releases", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, status, risk_tier, created_at,
        execution_status, execution_requested_at, execution_updated_at, execution_required_generation
      ) VALUES (?, ?, ?, ?, ?, 'approved', 'medium', ?, 'pending', ?, ?, ?)
    `).run(
      "proposal-pending",
      PROJECT,
      "Pending workflow mutation",
      "Still waiting for execution",
      "workflow-steward",
      now,
      now,
      now,
      "gen-current",
    );

    requestControllerGeneration(PROJECT, {
      generation: "gen-current",
      reason: "proposal_approved:proposal-2",
    }, db);

    const acquired = acquireControllerLease(PROJECT, {
      ownerId: "controller:current",
      ownerLabel: "owner-current",
      purpose: "process_and_dispatch",
      ttlMs: 60_000,
      generation: "gen-current",
    }, db);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(releaseControllerLease(PROJECT, "controller:current", db)).toBe(true);
    const pending = getControllerLease(PROJECT, db);
    expect(pending?.ownerId).toBe("controller:handoff-pending");
    expect(pending?.requiredGeneration).toBe("gen-current");

    const blockedOld = acquireControllerLease(PROJECT, {
      ownerId: "controller:old",
      ownerLabel: "owner-old",
      purpose: "lifecycle",
      ttlMs: 60_000,
      generation: "gen-old",
    }, db);
    expect(blockedOld.ok).toBe(false);
  });

  it("allows takeover after expiry when the generation floor is stale", () => {
    requestControllerGeneration(PROJECT, {
      generation: "gen-old",
      reason: "proposal_approved:proposal-stale",
    }, db);

    const oldLease = acquireControllerLease(PROJECT, {
      ownerId: "controller:old",
      ownerLabel: "owner-old",
      purpose: "sweep",
      ttlMs: -1,
      generation: "gen-old",
    }, db);
    expect(oldLease.ok).toBe(true);

    const takeover = acquireControllerLease(PROJECT, {
      ownerId: "controller:new",
      ownerLabel: "owner-new",
      purpose: "process_and_dispatch",
      ttlMs: 60_000,
      generation: "gen-new",
    }, db);

    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;
    expect(takeover.lease.ownerId).toBe("controller:new");
    expect(takeover.lease.requiredGeneration).toBeNull();
  });
});
