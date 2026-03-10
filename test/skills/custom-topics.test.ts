import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerCustomSkills,
  getCustomTopics,
  getTopicList,
  resolveSkillSource,
  resetCustomTopicsForTest,
} from "../../src/skills/registry.js";

describe("custom skill topics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-skills-test-"));
    // Create test skill files
    fs.writeFileSync(path.join(tmpDir, "api-conventions.md"), "# API Conventions\n\nUse REST.", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "coding-standards.md"), "# Coding Standards\n\nUse TypeScript.", "utf-8");
  });

  afterEach(() => {
    resetCustomTopicsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers custom skills from project config", () => {
    registerCustomSkills("proj1", {
      api_conventions: {
        title: "API Conventions",
        description: "Our REST patterns",
        path: "api-conventions.md",
        roles: ["employee"],
      },
    }, tmpDir);

    const topics = getCustomTopics("proj1");
    expect(topics).toHaveLength(1);
    expect(topics[0]!.id).toBe("api_conventions");
    expect(topics[0]!.title).toBe("API Conventions");
  });

  it("skips files that don't exist", () => {
    registerCustomSkills("proj1", {
      missing: {
        title: "Missing File",
        description: "Does not exist",
        path: "nonexistent.md",
      },
    }, tmpDir);

    expect(getCustomTopics("proj1")).toHaveLength(0);
  });

  it("prevents path traversal", () => {
    registerCustomSkills("proj1", {
      evil: {
        title: "Evil",
        description: "Path traversal",
        path: "../../../etc/passwd",
      },
    }, tmpDir);

    expect(getCustomTopics("proj1")).toHaveLength(0);
  });

  it("getTopicList includes custom topics when projectId is provided", () => {
    registerCustomSkills("proj1", {
      api_conventions: {
        title: "API Conventions",
        description: "Our REST patterns",
        path: "api-conventions.md",
        roles: ["employee"],
      },
    }, tmpDir);

    const topics = getTopicList("employee", "proj1");
    const customTopic = topics.find((t) => t.id === "api_conventions");
    expect(customTopic).toBeTruthy();
    expect(customTopic!.title).toBe("API Conventions");
  });

  it("getTopicList excludes custom topics for wrong role", () => {
    registerCustomSkills("proj1", {
      api_conventions: {
        title: "API Conventions",
        description: "Our REST patterns",
        path: "api-conventions.md",
        roles: ["manager"],
      },
    }, tmpDir);

    const topics = getTopicList("employee", "proj1");
    const customTopic = topics.find((t) => t.id === "api_conventions");
    expect(customTopic).toBeUndefined();
  });

  it("resolveSkillSource returns custom topic content", () => {
    registerCustomSkills("proj1", {
      api_conventions: {
        title: "API Conventions",
        description: "Our REST patterns",
        path: "api-conventions.md",
      },
    }, tmpDir);

    const content = resolveSkillSource("employee", "api_conventions", undefined, "proj1");
    expect(content).toContain("API Conventions");
    expect(content).toContain("Use REST.");
  });

  it("resolveSkillSource includes custom topics in TOC", () => {
    registerCustomSkills("proj1", {
      api_conventions: {
        title: "API Conventions",
        description: "Our REST patterns",
        path: "api-conventions.md",
      },
    }, tmpDir);

    const toc = resolveSkillSource("employee", undefined, undefined, "proj1");
    expect(toc).toContain("api_conventions");
  });
});
