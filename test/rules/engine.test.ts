import { describe, expect, it } from "vitest";

describe("rule engine", () => {
  it("matches a rule by event type", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed", match: { tags: ["deploy"] } },
        action: { agent: "reviewer", prompt_template: "Review {{task.title}}" },
      },
    ];

    const event = { type: "task.completed", data: { tags: ["deploy"], task: { title: "Ship v2" } } };
    const matched = matchRules(rules, event);

    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("deploy-review");
  });

  it("does not match when event type differs", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed" },
        action: { agent: "reviewer", prompt_template: "Review" },
      },
    ];

    const event = { type: "task.created", data: {} };
    expect(matchRules(rules, event)).toHaveLength(0);
  });

  it("does not match when match criteria fail", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed", match: { tags: ["deploy"] } },
        action: { agent: "reviewer", prompt_template: "Review" },
      },
    ];

    const event = { type: "task.completed", data: { tags: ["bugfix"] } };
    expect(matchRules(rules, event)).toHaveLength(0);
  });

  it("skips disabled rules", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "disabled-rule",
        trigger: { event: "task.completed" },
        action: { agent: "reviewer", prompt_template: "Review" },
        enabled: false,
      },
    ];

    const event = { type: "task.completed", data: {} };
    expect(matchRules(rules, event)).toHaveLength(0);
  });

  it("interpolates prompt template with event data", async () => {
    const { buildPromptFromRule } = await import("../../src/rules/engine.js");

    const rule = {
      name: "test",
      trigger: { event: "task.completed" },
      action: {
        agent: "reviewer",
        prompt_template: "Review the deployment for {{task.title}}. Priority: {{task.priority}}.",
      },
    };

    const eventData = { task: { title: "Ship v2", priority: "high" } };
    const prompt = buildPromptFromRule(rule, eventData);
    expect(prompt).toBe("Review the deployment for Ship v2. Priority: high.");
  });

  it("leaves unmatched template vars as-is", async () => {
    const { buildPromptFromRule } = await import("../../src/rules/engine.js");

    const rule = {
      name: "test",
      trigger: { event: "x" },
      action: { agent: "a", prompt_template: "Hello {{unknown.field}}" },
    };

    const prompt = buildPromptFromRule(rule, {});
    expect(prompt).toBe("Hello {{unknown.field}}");
  });

  it("evaluateRules combines matching and prompt building", async () => {
    const { evaluateRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "greet",
        trigger: { event: "agent.started" },
        action: { agent: "greeter", prompt_template: "Welcome {{agent.name}}!" },
      },
      {
        name: "unrelated",
        trigger: { event: "task.completed" },
        action: { agent: "other", prompt_template: "Done" },
      },
    ];

    const event = { type: "agent.started", data: { agent: { name: "Alice" } } };
    const results = evaluateRules(rules, event);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("greet");
    expect(results[0].prompt).toBe("Welcome Alice!");
  });

  it("matches array contains check", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "tag-match",
        trigger: { event: "task.completed", match: { tags: ["deploy"] } },
        action: { agent: "bot", prompt_template: "test" },
      },
    ];

    // Event data has tags array containing "deploy" among others
    const event = { type: "task.completed", data: { tags: ["deploy", "production", "urgent"] } };
    expect(matchRules(rules, event)).toHaveLength(1);
  });
});
