import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  detectConfigChange,
  getConfigVersion,
  getConfigHistory,
} = await import("../../src/telemetry/config-tracker.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-telemetry";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("detectConfigChange", () => {
  it("creates a new version on first call", () => {
    const content = "## Agent Config\n\nrole: assistant\n";
    const versionId = detectConfigChange(PROJECT, content, "agent-1", db);

    expect(versionId).toBeDefined();

    const version = getConfigVersion(PROJECT, versionId, db);
    expect(version).not.toBeNull();
    expect(version!.content).toBe(content);
    expect(version!.detectedBy).toBe("agent-1");
    expect(version!.changeSummary).toBe("Initial config version");
  });

  it("returns existing version ID for identical content", () => {
    const content = "## Same Config\n\nrole: worker\n";
    const id1 = detectConfigChange(PROJECT, content, "agent-1", db);
    const id2 = detectConfigChange(PROJECT, content, "agent-2", db);

    expect(id1).toBe(id2);
  });

  it("creates new version when content changes", () => {
    const content1 = "version: 1\nrole: assistant";
    const content2 = "version: 2\nrole: worker";

    const id1 = detectConfigChange(PROJECT, content1, "agent-1", db);
    const id2 = detectConfigChange(PROJECT, content2, "agent-1", db);

    expect(id1).not.toBe(id2);

    const version2 = getConfigVersion(PROJECT, id2, db);
    expect(version2!.previousVersionId).toBe(id1);
    expect(version2!.changeSummary).toBe("Config content changed");
  });

  it("hashes content deterministically", () => {
    const content = "deterministic content";
    const id1 = detectConfigChange(PROJECT, content, undefined, db);
    const id2 = detectConfigChange(PROJECT, content, undefined, db);
    expect(id1).toBe(id2);
  });
});

describe("getConfigVersion", () => {
  it("returns null for non-existent version", () => {
    const result = getConfigVersion(PROJECT, "nonexistent", db);
    expect(result).toBeNull();
  });

  it("decompresses content on retrieval", () => {
    const content = "## Long Config\n\n" + "x".repeat(1000);
    const versionId = detectConfigChange(PROJECT, content, undefined, db);

    const version = getConfigVersion(PROJECT, versionId, db);
    expect(version!.content).toBe(content);
  });
});

describe("getConfigHistory", () => {
  it("returns versions ordered by detection time (newest first)", () => {
    const crypto = require("node:crypto");
    const { deflateSync } = require("node:zlib");
    const baseTime = Date.now() - 30_000;

    // Insert with explicit timestamps to guarantee ordering
    const configs = ["config v1", "config v2", "config v3"];
    let prevId: string | null = null;
    for (let i = 0; i < configs.length; i++) {
      const id = crypto.randomUUID();
      const hash = crypto.createHash("sha256").update(configs[i]!).digest("hex");
      const compressed = deflateSync(Buffer.from(configs[i]!, "utf-8")).toString("base64");
      db.prepare(`
        INSERT INTO config_versions (id, project_id, content_hash, files, content, detected_at, detected_by, previous_version_id, change_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, PROJECT, hash, '["context"]', compressed, baseTime + i * 10_000, null, prevId, `v${i + 1}`);
      prevId = id;
    }

    const history = getConfigHistory(PROJECT, undefined, db);
    expect(history).toHaveLength(3);
    // Newest first
    expect(history[0]!.content).toBe("config v3");
    expect(history[2]!.content).toBe("config v1");
  });

  it("filters by since timestamp", () => {
    const c1 = "early config";
    detectConfigChange(PROJECT, c1, undefined, db);

    // Read the detected_at of the first version to set a midpoint
    const history1 = getConfigHistory(PROJECT, undefined, db);
    const midpoint = history1[0]!.detectedAt + 1;

    const c2 = "later config";
    // Manually insert with a future timestamp to ensure filtering works
    const crypto = require("node:crypto");
    const { deflateSync } = require("node:zlib");
    const contentHash2 = crypto.createHash("sha256").update(c2).digest("hex");
    const compressed2 = deflateSync(Buffer.from(c2, "utf-8")).toString("base64");
    db.prepare(`
      INSERT INTO config_versions (id, project_id, content_hash, files, content, detected_at, detected_by, previous_version_id, change_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), PROJECT, contentHash2, '["context"]', compressed2, midpoint + 100, null, history1[0]!.id, "Config changed");

    const history = getConfigHistory(PROJECT, midpoint, db);
    expect(history).toHaveLength(1);
  });

  it("returns empty array for no history", () => {
    const history = getConfigHistory(PROJECT, undefined, db);
    expect(history).toHaveLength(0);
  });
});
