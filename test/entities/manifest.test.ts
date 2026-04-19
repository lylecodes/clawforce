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

const dbModule = await import("../../src/db.js");
const { getMemoryDb } = dbModule;
const projectModule = await import("../../src/project.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = projectModule;
const entityOps = await import("../../src/entities/ops.js");
const taskOps = await import("../../src/tasks/ops.js");
const manifestModule = await import("../../src/entities/manifest.js");

describe("entities/manifest", () => {
  const PROJECT = "manifest-test";
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      agents: {},
      entities: {
        jurisdiction: {
          states: {
            bootstrapping: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            { from: "bootstrapping", to: "shadow" },
            { from: "shadow", to: "active", reasonRequired: true },
          ],
          health: { values: ["healthy", "warning", "blocked"], default: "warning" },
          relationships: { parent: { enabled: true, allowedKinds: ["jurisdiction"] } },
          metadataSchema: {
            slug: { type: "string", required: true },
            layer: { type: "string", required: true },
            activation_blockers: { type: "array" },
          },
        },
      },
    });
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
    try { db.close(); } catch { /* ignore */ }
  });

  it("normalizes a generic manifest shape", () => {
    const manifest = manifestModule.normalizeEntityManifest({
      version: 1,
      kind: "jurisdiction",
      match: { metadataField: "slug" },
      items: [
        {
          key: "los-angeles",
          title: "Los Angeles",
          state: "shadow",
          health: "warning",
          ownerAgentId: "los-angeles-owner",
          parentKey: "california",
          metadata: {
            slug: "los-angeles",
            layer: "city",
            activation_blockers: ["pending"],
          },
          tasks: [
            { title: "Stand up shadow governance for Los Angeles", priority: "P1" },
          ],
        },
      ],
    });

    expect(manifest.match?.metadataField).toBe("slug");
    expect(manifest.items[0]!.key).toBe("los-angeles");
    expect(manifest.items[0]!.tasks).toHaveLength(1);
  });

  it("syncs entities structurally while preserving live state and health by default", () => {
    const california = entityOps.createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "California old",
      state: "shadow",
      health: "warning",
      ownerAgentId: "old-california",
      createdBy: "seed",
      metadata: { slug: "california", layer: "state", activation_blockers: [] },
    }, db);

    const losAngeles = entityOps.createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles old",
      state: "active",
      health: "healthy",
      ownerAgentId: "old-la",
      createdBy: "seed",
      metadata: { slug: "los-angeles", layer: "city", activation_blockers: [] },
    }, db);

    const legacyTask = taskOps.createTask({
      projectId: PROJECT,
      title: "Stand up shadow governance for Los Angeles",
      createdBy: "seed",
      assignedTo: "los-angeles-owner",
    }, db);

    const manifest = manifestModule.normalizeEntityManifest({
      version: 1,
      kind: "jurisdiction",
      match: { metadataField: "slug" },
      sync: { preserveState: true, preserveHealth: true },
      items: [
        {
          key: "california",
          title: "California",
          state: "shadow",
          health: "warning",
          ownerAgentId: "california-owner",
          department: "jurisdictions",
          team: "california",
          metadata: { slug: "california", layer: "state", activation_blockers: ["pending"] },
        },
        {
          key: "los-angeles",
          title: "Los Angeles",
          state: "shadow",
          health: "warning",
          ownerAgentId: "los-angeles-owner",
          parentKey: "california",
          department: "jurisdictions",
          team: "los-angeles",
          metadata: { slug: "los-angeles", layer: "city", activation_blockers: ["pending"] },
          tasks: [
            { title: "Stand up shadow governance for Los Angeles", priority: "P1", assignedTo: "los-angeles-owner" },
          ],
        },
      ],
    });

    const result = manifestModule.syncEntityManifest(PROJECT, manifest, {
      actor: "cli:test",
      dbOverride: db,
    });

    expect(result.syncReport).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "updated_entity", key: "california", entityId: california.id }),
      expect.objectContaining({ action: "updated_entity", key: "los-angeles", entityId: losAngeles.id }),
      expect.objectContaining({ action: "updated_parent", key: "los-angeles", parentKey: "california" }),
      expect.objectContaining({ action: "linked_task", key: "los-angeles", taskId: legacyTask.id }),
    ]));

    const updatedLa = entityOps.getEntity(PROJECT, losAngeles.id, db)!;
    expect(updatedLa.title).toBe("Los Angeles");
    expect(updatedLa.ownerAgentId).toBe("los-angeles-owner");
    expect(updatedLa.parentEntityId).toBe(california.id);
    expect(updatedLa.state).toBe("active");
    expect(updatedLa.health).toBe("healthy");

    const rows = manifestModule.collectEntityManifestStatus(PROJECT, manifest, db);
    const laRow = rows.find((row) => row.key === "los-angeles")!;
    expect(laRow.parentKey).toBe("california");
    expect(laRow.liveState).toBe("active");
    expect(laRow.tasks[0]!.id).toBe(legacyTask.id);
  });
});
