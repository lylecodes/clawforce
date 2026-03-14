import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getInitQuestions, buildConfigFromAnswers } from "../../src/config/init-flow.js";
import type { InitAnswers } from "../../src/config/init-flow.js";

describe("init flow", () => {
  describe("getInitQuestions", () => {
    it("returns a sequence of questions", () => {
      const questions = getInitQuestions();
      expect(questions.length).toBeGreaterThanOrEqual(4);
      expect(questions[0].id).toBe("domain_name");
      expect(questions.every((q) => q.id && q.prompt && q.type)).toBe(true);
    });
  });

  describe("buildConfigFromAnswers", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-initflow-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("builds config from minimal answers", () => {
      const answers: InitAnswers = {
        domain_name: "myproject",
        mission: "Build a SaaS dashboard",
        agents: [
          { name: "lead", title: "Engineering Lead" },
          { name: "dev", title: "Frontend Dev" },
        ],
        reporting: { dev: "lead" },
        budget_cents: 2000,
      };

      const result = buildConfigFromAnswers(answers);

      // Global config has both agents
      expect(Object.keys(result.global.agents!)).toEqual(["lead", "dev"]);
      expect(result.global.agents!.lead.title).toBe("Engineering Lead");
      expect(result.global.agents!.dev.reports_to).toBe("lead");

      // Domain opts matches InitDomainOpts shape
      expect(result.domain.name).toBe("myproject");
      expect(result.domain.agents).toEqual(["lead", "dev"]);
    });

    it("omits reporting structure when single agent", () => {
      const answers: InitAnswers = {
        domain_name: "solo",
        mission: "Do tasks",
        agents: [{ name: "worker", title: "Worker" }],
        reporting: {},
        budget_cents: 1000,
      };

      const result = buildConfigFromAnswers(answers);
      expect(Object.keys(result.global.agents!)).toEqual(["worker"]);
      expect(result.global.agents!.worker.reports_to).toBeUndefined();
    });

    it("includes model override when specified", () => {
      const answers: InitAnswers = {
        domain_name: "custom",
        mission: "Custom models",
        agents: [{ name: "agent", title: "Agent", model: "anthropic/claude-haiku-4-5" }],
        reporting: {},
        budget_cents: 500,
      };

      const result = buildConfigFromAnswers(answers);
      expect(result.global.agents!.agent.model).toBe("anthropic/claude-haiku-4-5");
    });
  });
});
