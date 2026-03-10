import { describe, expect, it } from "vitest";
import { buildOnboardingContext, buildExplainContent } from "../../src/context/onboarding.js";

describe("buildOnboardingContext", () => {
  it("returns a short prompt with projectsDir embedded", () => {
    const result = buildOnboardingContext("~/.openclaw/clawforce");

    expect(result).toContain("Clawforce");
    expect(result).toContain("~/.openclaw/clawforce");
  });

  it("mentions the explain action", () => {
    const result = buildOnboardingContext("/tmp/clawforce");

    expect(result).toContain("explain");
    expect(result).toContain("clawforce_setup");
  });

  it("mentions all setup tool actions", () => {
    const result = buildOnboardingContext("/tmp/clawforce");

    expect(result).toContain("explain");
    expect(result).toContain("status");
    expect(result).toContain("validate");
    expect(result).toContain("activate");
  });

  it("tells agent to ask about agent IDs", () => {
    const result = buildOnboardingContext("/tmp/clawforce");

    expect(result).toContain("agent IDs");
  });

  it("is concise — under 30 lines", () => {
    const result = buildOnboardingContext("/tmp/clawforce");
    const lines = result.split("\n").length;

    expect(lines).toBeLessThan(30);
  });
});

describe("buildExplainContent", () => {
  it("includes project.yaml format example", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("extends: manager");
    expect(result).toContain("extends: employee");
    expect(result).toContain("expectations");
    expect(result).toContain("performance_policy");
    expect(result).toContain("briefing");
  });

  it("includes agent role descriptions", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("manager");
    expect(result).toContain("employee");
    expect(result).toContain("scheduled");
  });

  it("includes context source descriptions", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("instructions");
    expect(result).toContain("task_board");
    expect(result).toContain("assigned_task");
    expect(result).toContain("knowledge");
    expect(result).toContain("project_md");
  });

  it("includes enforcement docs", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("expectations");
    expect(result).toContain("retry");
    expect(result).toContain("alert");
    expect(result).toContain("terminate_and_alert");
    expect(result).toContain("reports_to");
  });

  it("includes setup steps", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("validate");
    expect(result).toContain("activate");
  });

  it("includes projectsDir in the content", () => {
    const result = buildExplainContent("~/.openclaw/clawforce");

    expect(result).toContain("~/.openclaw/clawforce");
  });

  it("mentions agent ID guidance", () => {
    const result = buildExplainContent("/tmp/clawforce");

    expect(result).toContain("Agent IDs");
    expect(result).toContain("your platform");
  });
});
