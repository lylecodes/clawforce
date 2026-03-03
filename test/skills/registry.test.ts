import { describe, expect, it } from "vitest";
import { SKILL_TOPICS, getTopicList, resolveSkillSource } from "../../src/skills/registry.js";
import { TASK_STATES, EVIDENCE_TYPES } from "../../src/types.js";
import { BUILTIN_PROFILES } from "../../src/profiles.js";
import { MEMORY_ACTIONS, MEMORY_CATEGORIES } from "../../src/tools/memory-tool.js";

describe("skill system registry", () => {
  describe("SKILL_TOPICS", () => {
    it("has all expected topics", () => {
      const ids = SKILL_TOPICS.map((t) => t.id);
      expect(ids).toContain("roles");
      expect(ids).toContain("tasks");
      expect(ids).toContain("accountability");
      expect(ids).toContain("context_sources");
      expect(ids).toContain("memory");
      expect(ids).toContain("tools");
      expect(ids).toContain("workflows");
      expect(ids).toContain("org");
      expect(ids).toContain("policies");
      expect(ids).toContain("budgets");
      expect(ids).toContain("risk");
      expect(ids).toContain("approval");
      expect(ids).toContain("config");
    });
  });

  describe("topic generation", () => {
    for (const topic of SKILL_TOPICS) {
      it(`topic "${topic.id}" generates non-empty content`, () => {
        const content = topic.generate();
        expect(content.length).toBeGreaterThan(50);
      });
    }
  });

  describe("content correctness", () => {
    it("roles topic mentions all three roles", () => {
      const content = resolveSkillSource("manager", "roles")!;
      expect(content).toContain("manager");
      expect(content).toContain("employee");
      expect(content).toContain("scheduled");
    });

    it("roles topic reflects actual profile expectations", () => {
      const content = resolveSkillSource("manager", "roles")!;
      for (const exp of BUILTIN_PROFILES.manager.expectations) {
        expect(content).toContain(exp.tool);
      }
    });

    it("tasks topic mentions all task states", () => {
      const content = resolveSkillSource("manager", "tasks")!;
      for (const state of TASK_STATES) {
        expect(content).toContain(state);
      }
    });

    it("tasks topic mentions all evidence types", () => {
      const content = resolveSkillSource("manager", "tasks")!;
      for (const type of EVIDENCE_TYPES) {
        expect(content).toContain(type);
      }
    });

    it("memory topic mentions all memory actions", () => {
      const content = resolveSkillSource("manager", "memory")!;
      for (const action of MEMORY_ACTIONS) {
        expect(content).toContain(action);
      }
    });

    it("memory topic mentions all memory categories", () => {
      const content = resolveSkillSource("manager", "memory")!;
      for (const cat of MEMORY_CATEGORIES) {
        expect(content).toContain(cat);
      }
    });

    it("tools topic mentions clawforce_memory", () => {
      const content = resolveSkillSource("manager", "tools")!;
      expect(content).toContain("clawforce_memory");
    });

    it("tools topic mentions clawforce_task", () => {
      const content = resolveSkillSource("manager", "tools")!;
      expect(content).toContain("clawforce_task");
    });
  });

  describe("getTopicList", () => {
    it("returns more topics for manager than employee", () => {
      const managerTopics = getTopicList("manager");
      const employeeTopics = getTopicList("employee");
      expect(managerTopics.length).toBeGreaterThan(employeeTopics.length);
    });

    it("employee sees core topics", () => {
      const topics = getTopicList("employee");
      const ids = topics.map((t) => t.id);
      expect(ids).toContain("roles");
      expect(ids).toContain("tasks");
      expect(ids).toContain("accountability");
      expect(ids).toContain("context_sources");
      expect(ids).toContain("memory");
      expect(ids).toContain("tools");
    });

    it("employee does not see manager-only topics", () => {
      const topics = getTopicList("employee");
      const ids = topics.map((t) => t.id);
      expect(ids).not.toContain("workflows");
      expect(ids).not.toContain("org");
      expect(ids).not.toContain("policies");
      expect(ids).not.toContain("budgets");
    });

    it("scheduled sees core topics", () => {
      const topics = getTopicList("scheduled");
      const ids = topics.map((t) => t.id);
      expect(ids).toContain("roles");
      expect(ids).toContain("accountability");
      expect(ids).toContain("memory");
      expect(ids).toContain("tools");
    });

    it("manager sees all topics", () => {
      const topics = getTopicList("manager");
      expect(topics.length).toBe(SKILL_TOPICS.length);
    });
  });

  describe("resolveSkillSource", () => {
    it("returns table of contents without topic", () => {
      const content = resolveSkillSource("manager")!;
      expect(content).toContain("System Knowledge");
      expect(content).toContain("roles");
      expect(content).toContain("tasks");
      expect(content).toContain("memory");
    });

    it("returns topic content with valid topic", () => {
      const content = resolveSkillSource("manager", "roles")!;
      expect(content).toContain("Agent Roles");
    });

    it("returns error for unknown topic", () => {
      const content = resolveSkillSource("manager", "nonexistent")!;
      expect(content).toContain("Unknown skill topic");
      expect(content).toContain("nonexistent");
    });

    it("returns error for role-restricted topic", () => {
      const content = resolveSkillSource("scheduled", "workflows")!;
      expect(content).toContain("not available");
      expect(content).toContain("scheduled");
    });

    it("employee table of contents is role-filtered", () => {
      const content = resolveSkillSource("employee")!;
      expect(content).toContain("roles");
      expect(content).toContain("memory");
      expect(content).not.toContain("— Proposals"); // approval topic description
    });
  });
});
