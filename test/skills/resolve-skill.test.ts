import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILL_TOPICS,
  getTopicList,
  resolveSkillSource,
  registerCustomSkills,
  getCustomTopics,
  resetCustomTopicsForTest,
} from "../../src/skills/registry.js";

describe("resolveSkillSource — extended coverage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-resolve-test-"));
  });

  afterEach(() => {
    resetCustomTopicsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Topic lookup edge cases ---

  it("returns error when querying unknown topic without projectId", () => {
    const result = resolveSkillSource("manager", "totally_bogus");
    expect(result).toContain("Unknown skill topic");
    expect(result).toContain("totally_bogus");
    // Should list available topic IDs
    expect(result).toContain("roles");
    expect(result).toContain("tasks");
  });

  it("returns error when querying unknown topic with projectId", () => {
    registerCustomSkills("proj-x", {
      my_topic: { title: "My Topic", description: "test", path: "my.md" },
    }, tmpDir);
    // my_topic doesn't exist on disk so won't register, so querying it should fail
    const result = resolveSkillSource("manager", "my_topic", undefined, "proj-x");
    expect(result).toContain("Unknown skill topic");
  });

  it("lists custom topic IDs in error for unknown topic when projectId given", () => {
    fs.writeFileSync(path.join(tmpDir, "real.md"), "Real content", "utf-8");
    registerCustomSkills("proj-y", {
      real_topic: { title: "Real", description: "desc", path: "real.md" },
    }, tmpDir);

    const result = resolveSkillSource("manager", "nonexistent", undefined, "proj-y");
    expect(result).toContain("Unknown skill topic");
    expect(result).toContain("real_topic");
  });

  // --- Custom topic preset filtering ---

  it("blocks access to custom topic for wrong preset", () => {
    fs.writeFileSync(path.join(tmpDir, "restricted.md"), "Restricted content", "utf-8");
    registerCustomSkills("proj-r", {
      restricted_topic: {
        title: "Restricted",
        description: "Manager only",
        path: "restricted.md",
        presets: ["manager"],
      },
    }, tmpDir);

    const result = resolveSkillSource("employee", "restricted_topic", undefined, "proj-r");
    expect(result).toContain("not available");
    expect(result).toContain("employee");
  });

  it("allows access to custom topic with matching preset", () => {
    fs.writeFileSync(path.join(tmpDir, "allowed.md"), "Allowed content for employee", "utf-8");
    registerCustomSkills("proj-a", {
      allowed_topic: {
        title: "Allowed",
        description: "For employees",
        path: "allowed.md",
        presets: ["employee"],
      },
    }, tmpDir);

    const result = resolveSkillSource("employee", "allowed_topic", undefined, "proj-a");
    expect(result).toContain("Allowed content for employee");
  });

  it("allows access to custom topic with empty presets (universal)", () => {
    fs.writeFileSync(path.join(tmpDir, "universal.md"), "Universal content", "utf-8");
    registerCustomSkills("proj-u", {
      universal_topic: {
        title: "Universal",
        description: "For all",
        path: "universal.md",
      },
    }, tmpDir);

    const result = resolveSkillSource("employee", "universal_topic", undefined, "proj-u");
    expect(result).toContain("Universal content");
  });

  // --- Custom topic file edge cases ---

  it("returns error when custom topic file cannot be read", () => {
    // Register with a file that exists at registration time
    fs.writeFileSync(path.join(tmpDir, "temp.md"), "Temp content", "utf-8");
    registerCustomSkills("proj-t", {
      temp_topic: { title: "Temp", description: "Will be deleted", path: "temp.md" },
    }, tmpDir);

    // Delete the file after registration
    fs.unlinkSync(path.join(tmpDir, "temp.md"));

    const result = resolveSkillSource("manager", "temp_topic", undefined, "proj-t");
    expect(result).toContain("Failed to read");
  });

  it("returns empty message when custom topic file is empty", () => {
    fs.writeFileSync(path.join(tmpDir, "empty.md"), "", "utf-8");
    registerCustomSkills("proj-e", {
      empty_topic: { title: "Empty", description: "Empty file", path: "empty.md" },
    }, tmpDir);

    const result = resolveSkillSource("manager", "empty_topic", undefined, "proj-e");
    expect(result).toContain("empty");
  });

  it("truncates custom topic content exceeding 10KB", () => {
    const bigContent = "x".repeat(15_000);
    fs.writeFileSync(path.join(tmpDir, "big.md"), bigContent, "utf-8");
    registerCustomSkills("proj-b", {
      big_topic: { title: "Big", description: "Large file", path: "big.md" },
    }, tmpDir);

    const result = resolveSkillSource("manager", "big_topic", undefined, "proj-b")!;
    expect(result).toContain("truncated");
    // Should be capped — header + 10240 chars + truncation marker
    expect(result.length).toBeLessThan(15_000);
  });

  // --- TOC generation edge cases ---

  it("TOC contains description text for each topic", () => {
    const content = resolveSkillSource("manager")!;
    for (const topic of SKILL_TOPICS) {
      expect(content).toContain(topic.description);
    }
  });

  it("excludeTopics with all topics results in empty list", () => {
    const allIds = SKILL_TOPICS.map((t) => t.id);
    const content = resolveSkillSource("manager", undefined, allIds)!;
    expect(content).toContain("System Knowledge");
    // No topic entries
    for (const id of allIds) {
      expect(content).not.toContain(`**${id}**`);
    }
  });

  it("assistant preset sees channels topic", () => {
    const topics = getTopicList("assistant");
    const ids = topics.map((t) => t.id);
    expect(ids).toContain("channels");
    expect(ids).toContain("tasks");
  });

  // --- Custom topic registration ---

  it("registers multiple custom skills for different projects", () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), "Content A", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "b.md"), "Content B", "utf-8");

    registerCustomSkills("proj-1", {
      topic_a: { title: "A", description: "Topic A", path: "a.md" },
    }, tmpDir);
    registerCustomSkills("proj-2", {
      topic_b: { title: "B", description: "Topic B", path: "b.md" },
    }, tmpDir);

    expect(getCustomTopics("proj-1")).toHaveLength(1);
    expect(getCustomTopics("proj-2")).toHaveLength(1);
    expect(getCustomTopics("proj-1")[0]!.id).toBe("topic_a");
    expect(getCustomTopics("proj-2")[0]!.id).toBe("topic_b");
  });

  it("returns empty array for project with no custom topics", () => {
    expect(getCustomTopics("no-such-project")).toHaveLength(0);
  });

  it("does not register when all files are missing", () => {
    registerCustomSkills("proj-empty", {
      missing1: { title: "M1", description: "d", path: "nope1.md" },
      missing2: { title: "M2", description: "d", path: "nope2.md" },
    }, tmpDir);

    expect(getCustomTopics("proj-empty")).toHaveLength(0);
  });

  it("registers only files that exist, skipping missing ones", () => {
    fs.writeFileSync(path.join(tmpDir, "exists.md"), "I exist", "utf-8");

    registerCustomSkills("proj-mixed", {
      exists: { title: "Exists", description: "d", path: "exists.md" },
      missing: { title: "Missing", description: "d", path: "gone.md" },
    }, tmpDir);

    const topics = getCustomTopics("proj-mixed");
    expect(topics).toHaveLength(1);
    expect(topics[0]!.id).toBe("exists");
  });

  it("resetCustomTopicsForTest clears all stored topics", () => {
    fs.writeFileSync(path.join(tmpDir, "c.md"), "Content", "utf-8");
    registerCustomSkills("proj-r", {
      topic_c: { title: "C", description: "d", path: "c.md" },
    }, tmpDir);

    expect(getCustomTopics("proj-r")).toHaveLength(1);
    resetCustomTopicsForTest();
    expect(getCustomTopics("proj-r")).toHaveLength(0);
  });

  // --- Built-in topic preset enforcement ---

  it("blocks built-in topic for wrong preset", () => {
    const result = resolveSkillSource("employee", "org");
    expect(result).toContain("not available");
  });

  it("allows built-in topic for correct preset", () => {
    const result = resolveSkillSource("manager", "org");
    expect(result).not.toContain("not available");
    expect(result!.length).toBeGreaterThan(50);
  });
});
