import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  mergeArrayWithOperators,
  detectCycle,
} from "../src/presets.js";

describe("preset resolution engine", () => {
  describe("mergeArrayWithOperators", () => {
    it("plain array replaces parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["x", "y"],
      );
      expect(result).toEqual(["x", "y"]);
    });

    it("+ operator appends to parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["+d", "+e"],
      );
      expect(result).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("- operator removes from parent", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["-b"],
      );
      expect(result).toEqual(["a", "c"]);
    });

    it("mixed + and - operators", () => {
      const result = mergeArrayWithOperators(
        ["a", "b", "c"],
        ["+d", "-b"],
      );
      expect(result).toEqual(["a", "c", "d"]);
    });

    it("no parent array treats + items as plain", () => {
      const result = mergeArrayWithOperators(undefined, ["+a", "+b"]);
      expect(result).toEqual(["a", "b"]);
    });
  });

  describe("detectCycle", () => {
    it("returns null for no cycle", () => {
      const lookup = (name: string) => {
        if (name === "a") return { extends: "b" };
        if (name === "b") return { extends: "c" };
        if (name === "c") return {};
        return undefined;
      };
      expect(detectCycle("a", lookup)).toBeNull();
    });

    it("returns cycle path when cycle exists", () => {
      const lookup = (name: string) => {
        if (name === "a") return { extends: "b" };
        if (name === "b") return { extends: "a" };
        return undefined;
      };
      const cycle = detectCycle("a", lookup);
      expect(cycle).toBeDefined();
      expect(cycle).toContain("a");
      expect(cycle).toContain("b");
    });
  });

  describe("resolveConfig", () => {
    const presets = {
      base: {
        compaction: false,
        briefing: ["soul", "tools_reference"],
        expectations: [
          { tool: "clawforce_log", action: "write", min_calls: 1 },
        ],
        performance_policy: { action: "retry" as const, max_retries: 3 },
      },
      manager: {
        extends: "base",
        compaction: true,
        briefing: ["soul", "tools_reference", "task_board", "escalations"],
        coordination: { enabled: true, schedule: "*/30 * * * *" },
      },
    };

    it("resolves single-level extends", () => {
      const config = { extends: "base", title: "My Agent" };
      const resolved = resolveConfig(config, presets);
      expect(resolved.compaction).toBe(false);
      expect(resolved.briefing).toEqual(["soul", "tools_reference"]);
      expect(resolved.title).toBe("My Agent");
    });

    it("resolves chained extends", () => {
      const config = { extends: "manager", title: "Eng Lead" };
      const resolved = resolveConfig(config, presets);
      expect(resolved.compaction).toBe(true);
      expect(resolved.coordination).toEqual({ enabled: true, schedule: "*/30 * * * *" });
      expect(resolved.title).toBe("Eng Lead");
    });

    it("child scalar overrides parent", () => {
      const config = { extends: "manager", compaction: false };
      const resolved = resolveConfig(config, presets);
      expect(resolved.compaction).toBe(false);
    });

    it("child array with operators merges with parent", () => {
      const config = {
        extends: "manager",
        briefing: ["+cost_summary", "-escalations"],
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.briefing).toContain("soul");
      expect(resolved.briefing).toContain("cost_summary");
      expect(resolved.briefing).not.toContain("escalations");
    });

    it("child plain array replaces parent", () => {
      const config = {
        extends: "manager",
        briefing: ["soul", "assigned_task"],
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.briefing).toEqual(["soul", "assigned_task"]);
    });

    it("deep merges objects", () => {
      const config = {
        extends: "manager",
        coordination: { schedule: "0 9 * * MON" },
      };
      const resolved = resolveConfig(config, presets);
      expect(resolved.coordination).toEqual({
        enabled: true,
        schedule: "0 9 * * MON",
      });
    });

    it("throws on cycle", () => {
      const cyclicPresets = {
        a: { extends: "b" },
        b: { extends: "a" },
      };
      expect(() => resolveConfig({ extends: "a" }, cyclicPresets)).toThrow(
        /circular/i,
      );
    });

    it("throws on unknown preset", () => {
      expect(() => resolveConfig({ extends: "nonexistent" }, {})).toThrow(
        /not found/i,
      );
    });

    it("returns config as-is when no extends", () => {
      const config = { title: "Solo Agent", compaction: true };
      const resolved = resolveConfig(config, {});
      expect(resolved).toEqual(config);
    });
  });
});
