import { describe, expect, it } from "vitest";

const { getInitQuestions, buildConfigFromAnswers } = await import("../../src/config/init-flow.js");

describe("direction init questions", () => {
  it("includes vision question", () => {
    const questions = getInitQuestions();
    const visionQ = questions.find((q: any) => q.id === "vision");
    expect(visionQ).toBeDefined();
    expect(visionQ!.type).toBe("text");
  });

  it("includes autonomy question", () => {
    const questions = getInitQuestions();
    const autoQ = questions.find((q: any) => q.id === "autonomy");
    expect(autoQ).toBeDefined();
    expect(autoQ!.choices).toEqual(["low", "medium", "high"]);
  });

  it("includes template question", () => {
    const questions = getInitQuestions();
    const templateQ = questions.find((q: any) => q.id === "template");
    expect(templateQ).toBeDefined();
    expect(templateQ!.choices).toContain("startup");
  });
});

describe("buildConfigFromAnswers with direction", () => {
  it("generates direction when vision is provided", () => {
    const answers = {
      domain_name: "test-project",
      mission: "Build something cool",
      agents: [{ name: "lead", title: "Lead" }],
      reporting: {},
      budget_cents: 1000,
      vision: "Build a rental compliance SaaS",
      autonomy: "medium" as const,
      template: "startup",
    };

    const result = buildConfigFromAnswers(answers);
    expect(result.direction).toBeDefined();
    expect(result.direction!.vision).toBe("Build a rental compliance SaaS");
    expect(result.direction!.autonomy).toBe("medium");
  });

  it("omits direction when vision is not provided", () => {
    const answers = {
      domain_name: "test-project",
      mission: "Build something",
      agents: [{ name: "lead", title: "Lead" }],
      reporting: {},
      budget_cents: 1000,
    };

    const result = buildConfigFromAnswers(answers);
    expect(result.direction).toBeUndefined();
  });
});
