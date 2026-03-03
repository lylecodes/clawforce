import { describe, expect, it } from "vitest";
import {
  buildCompactionInstructions,
  deriveCompactionTargets,
  isCompactionEnabled,
  resolveCompactionConfig,
} from "../../src/context/sources/compaction.js";
import type { AgentConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    role: "orchestrator",
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" },
    ...overrides,
  };
}

describe("resolveCompactionConfig", () => {
  it("returns null for undefined", () => {
    expect(resolveCompactionConfig(undefined)).toBeNull();
  });

  it("converts boolean true to { enabled: true }", () => {
    expect(resolveCompactionConfig(true)).toEqual({ enabled: true });
  });

  it("converts boolean false to { enabled: false }", () => {
    expect(resolveCompactionConfig(false)).toEqual({ enabled: false });
  });

  it("passes through CompactionConfig as-is", () => {
    const config = { enabled: true, files: ["docs/arch.md"] };
    expect(resolveCompactionConfig(config)).toEqual(config);
  });
});

describe("isCompactionEnabled", () => {
  it("returns false when compaction is undefined", () => {
    expect(isCompactionEnabled(makeConfig({}))).toBe(false);
  });

  it("returns true when compaction is true", () => {
    expect(isCompactionEnabled(makeConfig({ compaction: true }))).toBe(true);
  });

  it("returns false when compaction is false", () => {
    expect(isCompactionEnabled(makeConfig({ compaction: false }))).toBe(false);
  });

  it("returns true when compaction config has enabled: true", () => {
    expect(isCompactionEnabled(makeConfig({ compaction: { enabled: true } }))).toBe(true);
  });

  it("returns false when compaction config has enabled: false", () => {
    expect(isCompactionEnabled(makeConfig({ compaction: { enabled: false } }))).toBe(false);
  });
});

describe("deriveCompactionTargets", () => {
  it("returns PROJECT.md for project_md source", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [{ source: "project_md" }],
    });
    expect(deriveCompactionTargets(config)).toEqual(["PROJECT.md"]);
  });

  it("returns file paths from file sources", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [
        { source: "file", path: "docs/architecture.md" },
        { source: "file", path: "docs/status.md" },
      ],
    });
    expect(deriveCompactionTargets(config)).toEqual([
      "docs/architecture.md",
      "docs/status.md",
    ]);
  });

  it("derives from both project_md and file sources", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [
        { source: "project_md" },
        { source: "task_board" },
        { source: "file", path: "docs/notes.md" },
      ],
    });
    expect(deriveCompactionTargets(config)).toEqual([
      "PROJECT.md",
      "docs/notes.md",
    ]);
  });

  it("ignores non-file sources", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [
        { source: "task_board" },
        { source: "knowledge" },
        { source: "escalations" },
      ],
    });
    expect(deriveCompactionTargets(config)).toEqual([]);
  });

  it("uses explicit files when provided", () => {
    const config = makeConfig({
      compaction: { enabled: true, files: ["custom/doc.md"] },
      briefing: [{ source: "project_md" }],
    });
    // Explicit files override derivation
    expect(deriveCompactionTargets(config)).toEqual(["custom/doc.md"]);
  });

  it("falls back to derivation when explicit files is empty", () => {
    const config = makeConfig({
      compaction: { enabled: true, files: [] },
      briefing: [{ source: "project_md" }],
    });
    expect(deriveCompactionTargets(config)).toEqual(["PROJECT.md"]);
  });
});

describe("buildCompactionInstructions", () => {
  it("returns null when compaction is disabled", () => {
    const config = makeConfig({ compaction: false });
    expect(buildCompactionInstructions(config, "/tmp/project")).toBeNull();
  });

  it("returns null when compaction is undefined", () => {
    const config = makeConfig({});
    expect(buildCompactionInstructions(config, "/tmp/project")).toBeNull();
  });

  it("returns null when no projectDir", () => {
    const config = makeConfig({ compaction: true, briefing: [{ source: "project_md" }] });
    expect(buildCompactionInstructions(config)).toBeNull();
  });

  it("returns null when no compactable targets", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [{ source: "task_board" }],
    });
    expect(buildCompactionInstructions(config, "/tmp/project")).toBeNull();
  });

  it("generates instructions for project_md source", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [{ source: "project_md" }],
    });
    const result = buildCompactionInstructions(config, "/tmp/project");
    expect(result).toContain("Session Compaction");
    expect(result).toContain("PROJECT.md");
    expect(result).toContain("clawforce_compact");
    expect(result).toContain("update_doc");
    expect(result).toContain("read_doc");
  });

  it("generates instructions for file sources", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [{ source: "file", path: "docs/architecture.md" }],
    });
    const result = buildCompactionInstructions(config, "/tmp/project");
    expect(result).toContain("docs/architecture.md");
    expect(result).toContain("Architectural patterns");
  });

  it("includes multiple targets", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [
        { source: "project_md" },
        { source: "file", path: "docs/summary.md" },
      ],
    });
    const result = buildCompactionInstructions(config, "/tmp/project");
    expect(result).toContain("PROJECT.md");
    expect(result).toContain("docs/summary.md");
  });

  it("describes conversation/summary targets appropriately", () => {
    const config = makeConfig({
      compaction: true,
      briefing: [{ source: "file", path: "conversation-summary.md" }],
    });
    const result = buildCompactionInstructions(config, "/tmp/project");
    expect(result).toContain("Session summary");
  });
});
