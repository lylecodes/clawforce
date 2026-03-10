import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  mergeArrayWithOperators,
  detectCycle,
  BUILTIN_AGENT_PRESETS,
  BUILTIN_JOB_PRESETS,
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

describe("builtin agent presets", () => {
  it("manager preset has coordination enabled", () => {
    const mgr = BUILTIN_AGENT_PRESETS.manager;
    expect(mgr.coordination).toEqual({ enabled: true, schedule: "*/30 * * * *" });
    expect(mgr.compaction).toBe(true);
  });

  it("manager preset has full operational briefing", () => {
    const mgr = BUILTIN_AGENT_PRESETS.manager;
    expect(mgr.briefing).toContain("soul");
    expect(mgr.briefing).toContain("task_board");
    expect(mgr.briefing).toContain("escalations");
    expect(mgr.briefing).toContain("cost_summary");
    expect(mgr.briefing).toContain("resources");
  });

  it("employee preset has task-focused briefing", () => {
    const emp = BUILTIN_AGENT_PRESETS.employee;
    expect(emp.briefing).toContain("soul");
    expect(emp.briefing).toContain("assigned_task");
    expect(emp.briefing).not.toContain("task_board");
    expect(emp.coordination?.enabled).toBe(false);
    expect(emp.compaction).toBe(false);
  });

  it("employee preset has retry performance policy", () => {
    const emp = BUILTIN_AGENT_PRESETS.employee;
    expect(emp.performance_policy.action).toBe("retry");
    expect(emp.performance_policy.max_retries).toBe(3);
  });

  it("has expected presets", () => {
    const keys = Object.keys(BUILTIN_AGENT_PRESETS);
    expect(keys).toContain("manager");
    expect(keys).toContain("employee");
    expect(keys).toContain("assistant");
    expect(keys).toContain("scheduled");
  });
});

describe("builtin job presets", () => {
  it("reflect preset has weekly cron and strategic briefing", () => {
    const reflect = BUILTIN_JOB_PRESETS.reflect;
    expect(reflect.cron).toBe("0 9 * * MON");
    expect(reflect.briefing).toContain("team_performance");
    expect(reflect.briefing).toContain("cost_summary");
    expect(reflect.nudge).toContain("Review");
  });

  it("triage preset has frequent cron and operational briefing", () => {
    const triage = BUILTIN_JOB_PRESETS.triage;
    expect(triage.cron).toBe("*/30 * * * *");
    expect(triage.briefing).toContain("task_board");
    expect(triage.briefing).toContain("escalations");
  });
});
