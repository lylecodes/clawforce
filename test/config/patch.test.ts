import { describe, expect, it } from "vitest";

import {
  applyConfigPatch,
  createArrayAppendPatch,
  createArrayRemoveValuePatch,
  createMergeConfigPatch,
  createPathMergePatch,
  createSectionReplacePatch,
  previewDomainConfigPatch,
  previewGlobalConfigPatch,
} from "../../src/config/patch.js";

describe("config patch", () => {
  it("merges nested objects without mutating the original config", () => {
    const before = {
      agents: {
        bot: {
          extends: "employee",
          memory: { recall: { enabled: true, intensity: "low" } },
        },
      },
    };

    const preview = previewGlobalConfigPatch(
      before,
      createMergeConfigPatch({
        agents: {
          bot: {
            memory: { recall: { intensity: "high" } },
          },
        },
      }),
    );

    expect(preview.valid).toBe(true);
    expect((preview.after.agents as Record<string, unknown>).bot).toEqual({
      extends: "employee",
      memory: { recall: { enabled: true, intensity: "high" } },
    });
    expect((before.agents.bot.memory as { recall: { intensity: string } }).recall.intensity).toBe("low");
  });

  it("replaces a top-level section and preserves the domain identity", () => {
    const before = {
      domain: "proj",
      agents: ["a"],
      budget: { project: { dailyCents: 100 } },
    };

    const preview = previewDomainConfigPatch(
      before,
      "proj",
      createSectionReplacePatch("budget", { project: { dailyCents: 500 } }),
    );

    expect(preview.valid).toBe(true);
    expect(preview.after.domain).toBe("proj");
    expect(preview.after.budget).toEqual({ project: { dailyCents: 500 } });
    expect(preview.before.budget).toEqual({ project: { dailyCents: 100 } });
  });

  it("supports removing nested fields through explicit patch operations", () => {
    const after = applyConfigPatch(
      {
        domain: "proj",
        agents: ["a"],
        manager: {
          enabled: true,
          agentId: "a",
        },
      },
      {
        ops: [{ op: "remove", path: ["manager", "agentId"] }],
      },
    );

    expect(after.manager).toEqual({ enabled: true });
  });

  it("supports path-targeted merges without replacing sibling fields", () => {
    const after = applyConfigPatch(
      {
        agents: {
          bot: {
            extends: "employee",
            title: "Worker",
          },
        },
      },
      createPathMergePatch(["agents", "bot"], { title: "Lead", model: "opus" }),
    );

    expect(after.agents).toEqual({
      bot: {
        extends: "employee",
        title: "Lead",
        model: "opus",
      },
    });
  });

  it("supports array append and remove-by-value operations", () => {
    const appended = applyConfigPatch(
      {
        domain: "proj",
        agents: ["a"],
      },
      createArrayAppendPatch(["agents"], "b"),
    );

    expect(appended.agents).toEqual(["a", "b"]);

    const removed = applyConfigPatch(
      appended,
      createArrayRemoveValuePatch(["agents"], "a"),
    );

    expect(removed.agents).toEqual(["b"]);
  });
});
